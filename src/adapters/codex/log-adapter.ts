/**
 * Codex 日志/状态 adapter —— 通道 A（兜底 + 会话发现）
 * 对应架构文档 3.3 第 3 项。双路径同一 adapter 内做能力探测：
 *   1. 桌面版：`~/.codex/state_5.sqlite`（threads 表）只读轮询
 *   2. 经典 CLI：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 增量 tail
 *
 * 桌面版 sqlite 无细粒度事件流，故只做粗粒度：会话发现（session_started）
 * 与活动脉冲（updated_at_ms/tokens_used 变化 -> turn_started），由推断引擎补超时。
 *
 * rollout jsonl 行格式（Codex CLI 官方 rollout 记录，本机未实测、按官方格式实现）：
 *   {"timestamp":"...ISO...","type":"session_meta","payload":{"id":"<uuid>","cwd":"...","cli_version":"..."}}
 *   {"timestamp":"...","type":"response_item","payload":{"type":"message","role":"user"|"assistant",...}}
 *   {"timestamp":"...","type":"event_msg","payload":{"type":"agent_message"|...
 *     "agent_reasoning..."|"token_count",...}}
 * 映射：session_meta -> session_started；role=user -> turn_started；
 *       assistant 回复 / agent_message -> turn_completed；token_count 变化 -> thinking 脉冲。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentEvent, AgentType } from '../../shared/events'
import { SqliteDb } from '../sqlite'
import { readUtf8Incremental } from '../incremental'

const ID = 'codex-log'
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 5_000
/**
 * 桌面版 sqlite 无权威状态列（threads 表只有 updated_at_ms/tokens_used），activity 脉冲只能发
 * turn_started、永远等不到完成事件——正常结束的任务此前全部演化成 10 分钟「超时」误报。
 * 静默超过该阈值视为本轮已完成；之后若再有活动会重新发 turn_started，误判可自愈。
 */
const QUIET_COMPLETE_MS = 3 * 60 * 1000

function codexDir(): string {
  return path.join(os.homedir(), '.codex')
}

function sqlitePath(): string {
  return path.join(codexDir(), 'state_5.sqlite')
}

function rolloutRoot(): string {
  return path.join(codexDir(), 'sessions')
}

interface ThreadRow {
  id: string
  cwd?: string
  title?: string
  updated_at_ms?: number
  tokens_used?: number
}

/** rollout tail 状态 */
interface RolloutTail {
  sessionId: string
  cwd?: string
  offset: number
  pending: string
}

/** 解析一行 rollout jsonl -> 归一化事件（0..N 条） */
export function mapRolloutLine(line: Record<string, unknown>): Omit<AgentEvent, 'source' | 'agentType'>[] {
  const events: Omit<AgentEvent, 'source' | 'agentType'>[] = []
  const ts = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) || Date.now() : Date.now()
  const type = line.type
  const payload = (line.payload ?? {}) as Record<string, unknown>

  if (type === 'session_meta') {
    const id = payload.id ?? payload.session_id
    if (typeof id === 'string') {
      events.push({
        eventType: 'session_started',
        sessionId: id,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        timestamp: ts,
        payload: { raw: line }
      })
    }
    return events
  }

  if (type === 'response_item') {
    const role = payload.role
    const ptype = payload.type
    // user message -> 新一轮；assistant message -> 一轮完成；function_call -> 工具调用
    if (ptype === 'message' && role === 'user') {
      events.push({ eventType: 'turn_started', sessionId: '', timestamp: ts, payload: { raw: line } })
    } else if (ptype === 'message' && role === 'assistant') {
      events.push({ eventType: 'turn_completed', sessionId: '', timestamp: ts, payload: { raw: line } })
    } else if (ptype === 'function_call') {
      events.push({
        eventType: 'tool_call_started',
        sessionId: '',
        timestamp: ts,
        payload: { toolName: typeof payload.name === 'string' ? payload.name : undefined, raw: line }
      })
    }
    return events
  }

  if (type === 'event_msg') {
    const et = String(payload.type ?? '')
    if (et.startsWith('token_count')) {
      events.push({ eventType: 'thinking', sessionId: '', timestamp: ts, payload: { raw: line } })
    }
    return events
  }

  return events
}

export class CodexLogAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType = 'codex'
  readonly capabilities = ['lifecycle', 'tool-events'] as const

  private emit: ((e: AgentEvent) => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private seen = new Map<
    string,
    { updated: number; tokens: number; /** 本轮已发运行脉冲且未发过完成 */ pulsing?: boolean; /** 最近一次活动变化时间 */ lastChangedAt: number }
  >()
  /** rollout jsonl tails：文件路径 -> 状态 */
  private rollouts = new Map<string, RolloutTail>()
  private mode: 'sqlite' | 'rollout' | 'none' = 'none'
  private stopped = false
  /** schema 降级告警只打一次 */
  private schemaWarned = false

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    this.stopped = false

    if (fs.existsSync(sqlitePath())) {
      this.mode = 'sqlite'
    } else if (fs.existsSync(rolloutRoot())) {
      this.mode = 'rollout'
      this.attachRecentRollouts()
    } else {
      this.mode = 'none'
      return
    }

    await this.poll()
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
    console.log(`[codex-log] monitoring via ${this.mode}`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async healthCheck(): Promise<AdapterHealth> {
    if (this.mode === 'none') return { ok: false, detail: 'no codex data source' }
    return { ok: true }
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.emit) return
    if (this.mode === 'sqlite') this.pollSqlite()
    else if (this.mode === 'rollout') this.pollRollouts()
  }

  private pollSqlite(): void {
    const db = SqliteDb.open(sqlitePath())
    if (!db) return
    try {
      // schema 守卫（OD#3）：threads 表缺失（上游改版）时优雅降级为不监控，不做无效查询
      if (!db.tableExists('threads')) {
        if (!this.schemaWarned) {
          console.warn('[codex-log] state_5.sqlite has no threads table (schema changed?) — degraded')
          this.schemaWarned = true
        }
        return
      }
      const now = Date.now()
      const rows = db.query(
        `SELECT id, cwd, title, updated_at_ms, tokens_used FROM threads WHERE archived=0 ORDER BY updated_at_ms DESC`
      ) as unknown as ThreadRow[]

      for (const r of rows) {
        if (!r.id) continue
        const updated = Number(r.updated_at_ms ?? 0)
        const tokens = Number(r.tokens_used ?? 0)
        const prev = this.seen.get(r.id)

        if (!prev) {
          this.seen.set(r.id, { updated, tokens, lastChangedAt: now })
          // 仅最近活跃的线程进入监控
          if (now - updated <= ACTIVE_WINDOW_MS) {
            this.emitSessionStarted(r)
          }
          continue
        }

        // 活动脉冲：updated_at_ms 或 tokens 变化 -> 本轮开始（重置静默计时）
        if (updated !== prev.updated || tokens !== prev.tokens) {
          this.seen.set(r.id, { updated, tokens, pulsing: true, lastChangedAt: now })
          this.emit?.({
            source: ID,
            agentType: 'codex',
            sessionId: r.id,
            cwd: r.cwd,
            eventType: 'turn_started',
            timestamp: now,
            payload: { title: r.title, raw: { updated, tokens } }
          })
          continue
        }

        // 静默完成：发过运行脉冲的线程静默超阈值 -> 视为本轮已完成（一次性）
        if (prev.pulsing && now - prev.lastChangedAt >= QUIET_COMPLETE_MS) {
          this.seen.set(r.id, { ...prev, pulsing: false })
          this.emit?.({
            source: ID,
            agentType: 'codex',
            sessionId: r.id,
            cwd: r.cwd,
            eventType: 'turn_completed',
            timestamp: now,
            payload: { title: r.title, raw: { quietMs: now - prev.lastChangedAt } }
          })
        }
      }
    } finally {
      db.close()
    }
  }

  // ---- rollout jsonl（经典 CLI）----

  /** 最近 N 天的 rollout 文件（按目录日期结构 YYYY/MM/DD 扫描，仅 mtime 在活跃窗口内） */
  private listRolloutFiles(): string[] {
    const out: string[] = []
    const root = rolloutRoot()
    let dirs: fs.Dirent[]
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return out
    }
    for (const month of dirs) {
      let days: fs.Dirent[]
      try {
        days = fs.readdirSync(path.join(root, month.name), { withFileTypes: true }).filter((d) => d.isDirectory())
      } catch {
        continue
      }
      for (const day of days) {
        const dir = path.join(root, month.name, day.name)
        let files: string[]
        try {
          files = fs.readdirSync(dir)
        } catch {
          continue
        }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue
          const p = path.join(dir, f)
          try {
            if (Date.now() - fs.statSync(p).mtimeMs <= ACTIVE_WINDOW_MS) out.push(p)
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    return out
  }

  /** 启动时附加既有 rollout：读全量恢复状态，从末尾继续 tail */
  private attachRecentRollouts(): void {
    for (const p of this.listRolloutFiles()) {
      try {
        const stat = fs.statSync(p)
        const text = fs.readFileSync(p, 'utf8')
        const lines = text.split('\n')
        let meta: { id?: string; cwd?: string } = {}
        /** 语义 = "最后一条 user 消息之后还没有 assistant 回复"（与 claude-code 恢复逻辑一致）：
         *  整文件级 sawAssistantEnd 会因历史轮次的 assistant 记录恒为真，重启后永远恢复不了运行中会话 */
        let awaitingReply = false
        for (const raw of lines) {
          if (!raw.trim()) continue
          let line: Record<string, unknown>
          try {
            line = JSON.parse(raw)
          } catch {
            continue
          }
          if (!meta.id && line.type === 'session_meta') {
            const pl = (line.payload ?? {}) as Record<string, unknown>
            if (typeof pl.id === 'string') {
              meta = { id: pl.id, cwd: typeof pl.cwd === 'string' ? pl.cwd : undefined }
            }
          }
          if (line.type === 'response_item') {
            const pl = (line.payload ?? {}) as Record<string, unknown>
            if (pl.type === 'message' && pl.role === 'user') awaitingReply = true
            if (pl.type === 'message' && pl.role === 'assistant') awaitingReply = false
          }
        }
        if (!meta.id) continue
        this.rollouts.set(p, { sessionId: meta.id, cwd: meta.cwd, offset: stat.size, pending: '' })
        this.emit?.({
          source: ID,
          agentType: 'codex',
          sessionId: meta.id,
          cwd: meta.cwd,
          eventType: 'session_started',
          timestamp: Date.now(),
          payload: { raw: { filePath: p } }
        })
        // 状态恢复（running 类事件，不触发通知）：最后是 user 且无 assistant 回复 => 进行中
        if (awaitingReply) {
          this.emit?.({
            source: ID,
            agentType: 'codex',
            sessionId: meta.id,
            cwd: meta.cwd,
            eventType: 'turn_started',
            timestamp: Date.now()
          })
        }
      } catch {
        /* 单文件失败不影响其他 */
      }
    }
  }

  /** 周期扫描：新文件 attach + 已有文件增量续读 */
  private pollRollouts(): void {
    for (const p of this.listRolloutFiles()) {
      if (!this.rollouts.has(p)) {
        this.attachSingleRollout(p)
      }
    }
    for (const [p, state] of this.rollouts) {
      try {
        this.tailRollout(p, state)
      } catch {
        /* 单文件失败不影响其他 */
      }
    }
  }

  /** 运行中新发现：只记 offset 从尾部开始（历史不回放，避免通知刷屏） */
  private attachSingleRollout(p: string): void {
    try {
      const text = fs.readFileSync(p, 'utf8')
      // 仅解析首行拿 session 元信息（session_meta 是第一行约定）
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue
        let line: Record<string, unknown>
        try {
          line = JSON.parse(raw)
        } catch {
          continue
        }
        if (line.type === 'session_meta') {
          const pl = (line.payload ?? {}) as Record<string, unknown>
          if (typeof pl.id === 'string') {
            const size = fs.statSync(p).size
            this.rollouts.set(p, {
              sessionId: pl.id,
              cwd: typeof pl.cwd === 'string' ? pl.cwd : undefined,
              offset: size,
              pending: ''
            })
            this.emit?.({
              source: ID,
              agentType: 'codex',
              sessionId: pl.id,
              cwd: typeof pl.cwd === 'string' ? pl.cwd : undefined,
              eventType: 'session_started',
              timestamp: Date.now(),
              payload: { raw: { filePath: p } }
            })
          }
          break // 只看第一行元信息
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  private tailRollout(filePath: string, state: RolloutTail): void {
    const stat = fs.statSync(filePath)
    if (stat.size < state.offset) {
      state.offset = 0
      state.pending = ''
    }
    if (stat.size === state.offset && !state.pending) return
    // readUtf8Incremental：末尾被写了一半的多字节字符留待下次，避免 U+FFFD 污染整行 JSON
    const { text, nextOffset } = readUtf8Incremental(filePath, state.offset)
    state.offset = nextOffset

    const combined = state.pending + text
    const lines = combined.split('\n')
    state.pending = lines.pop() ?? ''

    for (const raw of lines) {
      if (!raw.trim()) continue
      let line: Record<string, unknown>
      try {
        line = JSON.parse(raw)
      } catch {
        continue
      }
      for (const ev of mapRolloutLine(line)) {
        this.emit?.({
          ...ev,
          source: ID,
          agentType: 'codex',
          sessionId: ev.sessionId || state.sessionId,
          cwd: ev.cwd ?? state.cwd
        })
      }
    }
  }

  private emitSessionStarted(r: ThreadRow): void {
    this.emit?.({
      source: ID,
      agentType: 'codex',
      sessionId: r.id,
      cwd: r.cwd,
      eventType: 'session_started',
      timestamp: Date.now(),
      payload: { title: r.title, raw: { title: r.title } }
    })
  }
}

export const codexLogAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => fs.existsSync(sqlitePath()) || fs.existsSync(rolloutRoot()),
  create: () => new CodexLogAdapter()
}
