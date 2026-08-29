/**
 * Hermes sqlite adapter —— 通道 A（兜底 + 会话发现）
 * 对应架构文档 3.3 第 4 项：%LOCALAPPDATA%/hermes/state.db 只读轮询。
 *
 * 数据源（本机实测 schema）：
 *   sessions(id, cwd, title, started_at REAL, ended_at REAL, last_activity_at REAL, archived, hidden)
 *   messages(id 自增, session_id, role, tool_name, finish_reason, timestamp REAL)
 *
 * 映射（粗粒度，兜底语义）：
 *   role=user                      -> turn_started
 *   role=assistant finish_reason=stop -> turn_completed
 *   role=tool tool_name=X          -> tool_call_started（以此展示当前工具）
 *   新会话 / ended_at 置值           -> session_started / session_ended
 * 时间戳为 Unix 秒（REAL），乘 1000 转毫秒。
 */
import * as fs from 'fs'
import * as path from 'path'
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentEvent, AgentType } from '../../shared/events'
import { SqliteDb } from '../sqlite'
import { sanitizePrompt } from '../../shared/format'

const ID = 'hermes-sqlite'
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 5_000

function dbPath(): string {
  return path.join(process.env.LOCALAPPDATA ?? '', 'hermes', 'state.db')
}

interface SessionRow {
  id: string
  cwd?: string
  title?: string
  started_at?: number
  ended_at?: number | null
  last_activity_at?: number
  /** v1.0.3 用量与真实成本（sessions 表自带） */
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  estimated_cost_usd?: number
  actual_cost_usd?: number
}

interface MessageRow {
  id: number
  session_id: string
  role: string
  content?: string | null
  tool_name?: string | null
  tool_calls?: string | null
  finish_reason?: string | null
  timestamp?: number
}

/** 判定一条 assistant 消息是否携带工具调用（turn 中间消息） */
function hasToolCalls(m: { tool_calls?: string | null }): boolean {
  return !!(m.tool_calls && m.tool_calls !== '')
}

/**
 * 错误轮次识别（纯函数，可单测）：assistant 消息内容呈现 API/连接错误特征。
 * 本机 36k 条消息实测：正常回复（含讨论 error 的）零误伤，错误轮次 8/8 命中。
 */
export function isErrorTurn(content: string | null | undefined): boolean {
  if (!content) return false
  if (/Error code: \d{3}/.test(content)) return true // OpenAI 风格：Error code: 400/429/500...
  if (/APIConnectionError|APITimeoutError/.test(content)) return true
  // 请求中断（连接不稳定，等待模型响应时断开）
  if (/Operation interrupted: waiting for model response/.test(content)) return true
  // 行首 Error/Traceback 开头的短消息（限长防误伤长正文中引用的错误）
  return content.length < 2000 && /(?:^|\n)\s*(?:Error|Traceback)/.test(content)
}

/** 提取错误摘要（Toast/面板展示用） */
function summarizeError(content: string | null | undefined): string {
  if (!content) return '模型连接错误'
  const m = content.match(/Error code: \d{3}[\s\S]{0,180}/)?.[0]
  return (m ?? content).slice(0, 200)
}

/**
 * 消息 → 归一化事件（纯函数，可单测；返回 null = 不产生事件）。
 *
 * v0.5.1 修正「完成判定」：此前用 finish_reason === 'stop' 判定回合结束，
 * 但 Hermes 实际写库的形态是——带工具调用的 assistant 消息 finish_reason='tool_calls'，
 * 正常最终回复 'stop'，被截断/中断回合的最终回复 finish_reason=NULL（如迭代上限）。
 * 权威判据是 tool_calls 字段：assistant 消息不带工具调用 = 回合最终回复（无论 stop/None）；
 * 带工具调用 = turn 中间消息（忽略，球保持 running）。
 */
export function mapHermesMessage(
  m: Pick<MessageRow, 'role' | 'tool_name' | 'tool_calls' | 'finish_reason' | 'content'>,
  base: Omit<AgentEvent, 'eventType' | 'payload'>
): AgentEvent | null {
  if (!m.role || m.role === 'session_meta') return null
  if (m.role === 'user') {
    const prompt = sanitizePrompt(m.content)
    return { ...base, eventType: 'turn_started', payload: { raw: m, ...(prompt ? { prompt } : {}) } }
  }
  if (m.role === 'tool' && m.tool_name) {
    return { ...base, eventType: 'tool_call_started', payload: { toolName: m.tool_name, raw: m } }
  }
  if (m.role === 'assistant') {
    if (hasToolCalls(m)) return null // turn 中间（工具调用消息），不产生事件
    // 模型方连接错误形态：assistant + finish_reason=NULL + 错误文本（v0.4.1）
    if (m.finish_reason == null && isErrorTurn(m.content)) {
      return {
        ...base,
        eventType: 'error',
        payload: { errorMessage: summarizeError(m.content), raw: m }
      }
    }
    // 无工具调用的 assistant 消息 = 回合最终回复（stop 或 NULL 皆可）→ 完成
    return { ...base, eventType: 'turn_completed', payload: { raw: m } }
  }
  return null
}

export class HermesSqliteAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType = 'hermes'
  readonly capabilities = ['lifecycle', 'tool-events'] as const

  private emit: ((e: AgentEvent) => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private lastMessageId = 0
  private activeSessions = new Map<string, boolean>() // id -> 是否已上报 session_started
  /** 会话真实标题（sessions.title），消息差分事件也带上供面板展示/窗口匹配 */
  private titles = new Map<string, string>()
  /** v1.0.3 已上报的会话累计用量（增量上报用） */
  private usageSeen = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>()
  private stopped = false

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    this.stopped = false

    const db = SqliteDb.open(dbPath())
    if (!db) return
    try {
      // schema 守卫（OD#3）：上游改版缺表时优雅降级为不监控
      if (!db.tableExists('sessions') || !db.tableExists('messages')) {
        console.warn('[hermes-sqlite] state.db missing sessions/messages tables (schema changed?) — degraded')
        return
      }
      // 记录当前最大消息 id，避免回放历史（防通知刷屏）
      const mx = db.query('SELECT MAX(id) m FROM messages') as unknown as { m: number | null }[]
      this.lastMessageId = Number(mx[0]?.m ?? 0)

      // 发现活跃会话 + 恢复状态
      const now = Date.now()
      const sessions = db.query(
        `SELECT id, cwd, title, started_at, ended_at, last_activity_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd FROM sessions
         WHERE archived=0 AND hidden=0 AND ended_at IS NULL`
      ) as unknown as SessionRow[]
      for (const s of sessions) {
        if (!s.id) continue
        const lastAct = Number(s.last_activity_at ?? 0) * 1000
        if (now - lastAct > ACTIVE_WINDOW_MS) continue // 历史会话不铺面板
        this.activeSessions.set(s.id, true)
        if (s.title) this.titles.set(s.id, s.title)
        this.emitSession(s, 'session_started', lastAct)
        this.recoverState(db, s, lastAct)
      }
    } finally {
      db.close()
    }

    console.log(`[hermes-sqlite] monitoring ${this.activeSessions.size} active session(s)`)
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async healthCheck(): Promise<AdapterHealth> {
    return fs.existsSync(dbPath()) ? { ok: true } : { ok: false, detail: 'state.db missing' }
  }

  /** 启动时恢复单个会话的当前状态（仅 running 类事件，不触发通知） */
  private recoverState(db: SqliteDb, s: SessionRow, _lastAct: number): void {
    const rows = db.query(
      `SELECT role, tool_name, tool_calls, finish_reason, content FROM messages
       WHERE session_id='${s.id}' AND active=1 ORDER BY id DESC LIMIT 1`
    ) as unknown as MessageRow[]
    const last = rows[0]
    if (!last) return
    // v0.5.1：回合是否仍在进行 = 最后消息是 user，或 assistant 且携带工具调用（中间消息）。
    // 此前按 finish_reason !== 'stop' 判定——被截断回合（finish_reason=NULL 的最终回复）
    // 会被误判为仍在思考，重启后球卡 running。
    const running =
      last.role === 'user' || (last.role === 'assistant' && hasToolCalls(last))
    if (running) {
      this.emit?.({ source: ID, agentType: 'hermes', sessionId: s.id, cwd: s.cwd, eventType: 'turn_started', timestamp: Date.now(), payload: { title: s.title } })
      if (last.tool_name) {
        this.emit?.({ source: ID, agentType: 'hermes', sessionId: s.id, cwd: s.cwd, eventType: 'tool_call_started', timestamp: Date.now(), payload: { toolName: last.tool_name, title: s.title } })
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.emit) return
    const db = SqliteDb.open(dbPath())
    if (!db) return
    try {
      // 1. 新消息差分
      const msgs = db.query(
        `SELECT id, session_id, role, content, tool_name, tool_calls, finish_reason, timestamp FROM messages
         WHERE id > ${this.lastMessageId} ORDER BY id ASC LIMIT 200`
      ) as unknown as MessageRow[]
      for (const m of msgs) {
        this.lastMessageId = Math.max(this.lastMessageId, Number(m.id))
        this.mapMessage(m)
      }

      // 2. 会话发现 / 结束
      const sessions = db.query(
        `SELECT id, cwd, title, started_at, ended_at, last_activity_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd FROM sessions
         WHERE archived=0 AND hidden=0`
      ) as unknown as SessionRow[]
      const now = Date.now()
      for (const s of sessions) {
        if (!s.id) continue
        const lastAct = Number(s.last_activity_at ?? 0) * 1000
        if (s.title && s.title !== this.titles.get(s.id)) {
          // 标题更新（Hermes 首条回复后才生成摘要标题）：重发 session_started 刷新面板
          this.titles.set(s.id, s.title)
          if (this.activeSessions.get(s.id)) {
            this.emitSession(s, 'session_started', lastAct)
          }
        }
        const wasActive = this.activeSessions.get(s.id)
        if (s.ended_at != null) {
          if (wasActive) {
            this.activeSessions.delete(s.id)
            this.emitSession(s, 'session_ended', lastAct)
          }
          continue
        }
        if (!wasActive && now - lastAct <= ACTIVE_WINDOW_MS) {
          this.activeSessions.set(s.id, true)
          this.emitSession(s, 'session_started', lastAct)
        }
        if (this.activeSessions.get(s.id)) {
          this.emitUsageDelta(s)
        }
      }
    } finally {
      db.close()
    }
  }

  private mapMessage(m: MessageRow): void {
    if (!m.session_id) return
    const ts = Number(m.timestamp ?? 0) * 1000
    const title = this.titles.get(m.session_id)
    const base = {
      source: ID,
      agentType: 'hermes' as AgentType,
      sessionId: m.session_id,
      timestamp: ts || Date.now()
    }
    const event = mapHermesMessage(m, base)
    if (!event) return
    const out = event.payload ? { ...event, payload: { ...event.payload, title } } : event
    this.emit?.(out)
  }

  private emitSession(s: SessionRow, eventType: 'session_started' | 'session_ended', ts: number): void {
    this.emit?.({
      source: ID,
      agentType: 'hermes',
      sessionId: s.id,
      cwd: s.cwd,
      eventType,
      timestamp: ts || Date.now(),
      payload: { title: s.title, raw: { title: s.title }, usage: this.takeUsageSnapshot(s) }
    })
  }

  /**
   * v1.0.3 会话累计用量快照：首次把 sessions 表既有累计整体入库，
   * 之后按差值增量上报（heartbeat 携带）。seen 随快照更新。
   */
  private takeUsageSnapshot(s: SessionRow): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number } | undefined {
    const input = Number(s.input_tokens ?? 0)
    const output = Number(s.output_tokens ?? 0) + Number(s.reasoning_tokens ?? 0)
    const cacheRead = Number(s.cache_read_tokens ?? 0)
    const cacheWrite = Number(s.cache_write_tokens ?? 0)
    const cost = Number(s.actual_cost_usd ?? s.estimated_cost_usd ?? 0)
    const prev = this.usageSeen.get(s.id)
    const d = {
      input: Math.max(0, input - (prev?.input ?? 0)),
      output: Math.max(0, output - (prev?.output ?? 0)),
      cacheRead: Math.max(0, cacheRead - (prev?.cacheRead ?? 0)),
      cacheWrite: Math.max(0, cacheWrite - (prev?.cacheWrite ?? 0)),
      cost: Math.max(0, cost - (prev?.cost ?? 0))
    }
    this.usageSeen.set(s.id, { input, output, cacheRead, cacheWrite, cost })
    if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite && !d.cost) return undefined
    return {
      inputTokens: d.input,
      outputTokens: d.output,
      cacheReadTokens: d.cacheRead,
      cacheCreationTokens: d.cacheWrite,
      costUsd: d.cost
    }
  }

  /** v1.0.3 活跃会话用量差值上报（无变化不发声） */
  private emitUsageDelta(s: SessionRow): void {
    if (!this.emit) return
    const usage = this.takeUsageSnapshot(s)
    if (!usage) return
    this.emit?.({
      source: ID,
      agentType: 'hermes',
      sessionId: s.id,
      cwd: s.cwd,
      eventType: 'heartbeat',
      timestamp: Date.now(),
      payload: { title: s.title, usage }
    })
  }
}

export const hermesSqliteAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => fs.existsSync(dbPath()),
  create: () => new HermesSqliteAdapter()
}
