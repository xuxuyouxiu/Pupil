/**
 * Codex 日志/状态 adapter —— 通道 A（兜底 + 会话发现）
 * 对应架构文档 3.3 第 3 项。双路径同一 adapter 内做能力探测：
 *   1. 桌面版：`~/.codex/state_5.sqlite`（threads 表）只读轮询 —— 本机实测为桌面版
 *   2. 经典 CLI：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 增量 tail
 *
 * 桌面版 sqlite 无细粒度事件流，故只做粗粒度：会话发现（session_started）
 * 与活动脉冲（updated_at_ms/tokens_used 变化 -> turn_started），由推断引擎补超时。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentEvent, AgentType } from '../../shared/events'
import { SqliteDb } from '../sqlite'

const ID = 'codex-log'
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 5_000

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

export class CodexLogAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType = 'codex'
  readonly capabilities = ['lifecycle', 'tool-events'] as const

  private emit: ((e: AgentEvent) => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private seen = new Map<string, { updated: number; tokens: number }>()
  private mode: 'sqlite' | 'rollout' | 'none' = 'none'
  private stopped = false

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    this.stopped = false

    if (fs.existsSync(sqlitePath())) {
      this.mode = 'sqlite'
    } else if (fs.existsSync(rolloutRoot())) {
      this.mode = 'rollout'
      // MVP：rollout jsonl 由 log-adapter 同款 tail 处理（此处预留，见 reconcile 注释）
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
  }

  private pollSqlite(): void {
    const db = SqliteDb.open(sqlitePath())
    if (!db) return
    try {
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
          this.seen.set(r.id, { updated, tokens })
          // 仅最近活跃的线程进入监控
          if (now - updated <= ACTIVE_WINDOW_MS) {
            this.emitSessionStarted(r)
          }
          continue
        }

        // 活动脉冲：updated_at_ms 或 tokens 变化
        if (updated !== prev.updated || tokens !== prev.tokens) {
          this.seen.set(r.id, { updated, tokens })
          this.emit?.({
            source: ID,
            agentType: 'codex',
            sessionId: r.id,
            cwd: r.cwd,
            eventType: 'turn_started',
            timestamp: now,
            payload: { raw: { updated, tokens } }
          })
        }
      }
    } finally {
      db.close()
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
      payload: { raw: { title: r.title } }
    })
  }
}

export const codexLogAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => fs.existsSync(sqlitePath()) || fs.existsSync(rolloutRoot()),
  create: () => new CodexLogAdapter()
}
