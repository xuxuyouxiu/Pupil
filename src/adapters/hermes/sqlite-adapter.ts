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
}

interface MessageRow {
  id: number
  session_id: string
  role: string
  tool_name?: string | null
  finish_reason?: string | null
  timestamp?: number
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
        `SELECT id, cwd, title, started_at, ended_at, last_activity_at FROM sessions
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
      `SELECT role, tool_name, finish_reason FROM messages
       WHERE session_id='${s.id}' AND active=1 ORDER BY id DESC LIMIT 1`
    ) as unknown as MessageRow[]
    const last = rows[0]
    if (!last) return
    if (last.role === 'user' || (last.role === 'assistant' && last.finish_reason !== 'stop')) {
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
        `SELECT id, session_id, role, tool_name, finish_reason, timestamp FROM messages
         WHERE id > ${this.lastMessageId} ORDER BY id ASC LIMIT 200`
      ) as unknown as MessageRow[]
      for (const m of msgs) {
        this.lastMessageId = Math.max(this.lastMessageId, Number(m.id))
        this.mapMessage(m)
      }

      // 2. 会话发现 / 结束
      const sessions = db.query(
        `SELECT id, cwd, title, started_at, ended_at, last_activity_at FROM sessions
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
      }
    } finally {
      db.close()
    }
  }

  private mapMessage(m: MessageRow): void {
    if (!m.session_id) return
    const ts = Number(m.timestamp ?? 0) * 1000
    const base = {
      source: ID,
      agentType: 'hermes' as AgentType,
      sessionId: m.session_id,
      timestamp: ts || Date.now()
    }
    const title = this.titles.get(m.session_id)
    if (m.role === 'user') {
      this.emit?.({ ...base, eventType: 'turn_started', payload: { title, raw: m } })
    } else if (m.role === 'tool' && m.tool_name) {
      this.emit?.({ ...base, eventType: 'tool_call_started', payload: { toolName: m.tool_name, title, raw: m } })
    } else if (m.role === 'assistant' && m.finish_reason === 'stop') {
      this.emit?.({ ...base, eventType: 'turn_completed', payload: { title, raw: m } })
    }
  }

  private emitSession(s: SessionRow, eventType: 'session_started' | 'session_ended', ts: number): void {
    this.emit?.({
      source: ID,
      agentType: 'hermes',
      sessionId: s.id,
      cwd: s.cwd,
      eventType,
      timestamp: ts || Date.now(),
      payload: { title: s.title, raw: { title: s.title } }
    })
  }
}

export const hermesSqliteAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => fs.existsSync(dbPath()),
  create: () => new HermesSqliteAdapter()
}
