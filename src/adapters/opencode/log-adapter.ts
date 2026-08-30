/**
 * OpenCode adapter —— 通道 A（日志监控）
 * 数据源：~/.local/share/opencode/log/*.log（本机实测仅日志目录可解析，
 * 会话结构未公开稳定 schema，故走宽容日志探测：会话活动/错误特征行）
 *
 * 解析策略：
 *   - 新日志文件出现 + 增长 -> 会话活动（thinking 脉冲）
 *   - 行含 error 特征 -> error
 *   - 会话身份 = 日志文件名（opencode 以运行实例为单位写日志）
 * 注：OpenCode 亦有 `opencode export` 能力，后续可升级为结构化读取。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentEvent, AgentType } from '../../shared/events'
import { readUtf8Incremental } from '../incremental'
import { safeJoin } from '../safe-path'

const ID = 'opencode-log'
const ACTIVE_WINDOW_MS = 60 * 60 * 1000
const POLL_INTERVAL_MS = 10_000

function logDir(): string {
  // Windows: %LOCALAPPDATA%/opencode/log；*nix: ~/.local/share/opencode/log
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'opencode', 'log')
}

/** 错误特征行（宽容） */
function isErrorLine(text: string): boolean {
  return /"(?:level|severity)"\s*:\s*"(?:error|fatal)"|\bERROR\b|\bFATAL\b/i.test(text)
}

export function deriveSessionId(filePath: string): string {
  return path.basename(filePath).replace(/\.log$/i, '')
}

/** 单行日志 -> 事件（宽容；导出供单测） */
export function mapOpenCodeLine(
  text: string,
  firstSeen: boolean
): Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[] {
  const events: Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[] = []
  if (firstSeen) events.push({ eventType: 'session_started', timestamp: Date.now() })
  if (isErrorLine(text)) {
    events.push({
      eventType: 'error',
      timestamp: Date.now(),
      payload: { errorMessage: text.slice(0, 200) }
    })
  }
  // 活动脉冲：日志增长即实例在活动
  events.push({ eventType: 'thinking', timestamp: Date.now() })
  return events
}

interface TailState {
  sessionId: string
  offset: number
  pending: string
  started: boolean
}

export class OpenCodeLogAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType = 'opencode'
  readonly capabilities = ['lifecycle'] as const

  private emit: ((e: AgentEvent) => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private tails = new Map<string, TailState>()
  private available = false
  private stopped = false

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    this.stopped = false
    this.available = fs.existsSync(logDir())
    if (!this.available) return

    this.attachExisting()
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
    console.log('[opencode-log] monitoring opencode log dir')
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async healthCheck(): Promise<AdapterHealth> {
    if (!this.available) return { ok: false, detail: 'opencode log dir not found' }
    return { ok: true }
  }

  private attachExisting(): void {
    for (const p of this.listLogFiles()) {
      if (this.tails.has(p)) continue
      try {
        const stat = fs.statSync(p)
        this.tails.set(p, { sessionId: deriveSessionId(p), offset: stat.size, pending: '', started: false })
      } catch {
        /* 忽略 */
      }
    }
  }

  private listLogFiles(): string[] {
    let files: string[]
    try {
      files = fs.readdirSync(logDir())
    } catch {
      return []
    }
    const out: string[] = []
    for (const f of files) {
      if (!f.endsWith('.log')) continue
      const p = safeJoin(logDir(), f)
      if (!p) continue
      try {
        if (Date.now() - fs.statSync(p).mtimeMs <= ACTIVE_WINDOW_MS) out.push(p)
      } catch {
        /* 忽略 */
      }
    }
    return out
  }

  private poll(): void {
    if (this.stopped || !this.emit) return
    this.attachExisting()

    for (const [p, state] of this.tails) {
      try {
        this.tailFile(p, state)
      } catch {
        /* 单文件失败不影响其他 */
      }
    }
  }

  private tailFile(filePath: string, state: TailState): void {
    const stat = fs.statSync(filePath)
    if (stat.size < state.offset) {
      state.offset = 0
      state.pending = ''
    }
    if (stat.size === state.offset && !state.pending) return

    const { text, nextOffset } = readUtf8Incremental(filePath, state.offset)
    state.offset = nextOffset
    if (!text) return

    const combined = state.pending + text
    const lines = combined.split('\n')
    state.pending = lines.pop() ?? ''

    for (const raw of lines) {
      if (!raw.trim()) continue
      const firstSeen = !state.started
      state.started = true
      for (const ev of mapOpenCodeLine(raw, firstSeen)) {
        this.emit?.({ ...ev, source: ID, agentType: this.agentType, sessionId: state.sessionId })
      }
    }
  }
}

export const opencodeLogAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => fs.existsSync(logDir()),
  create: () => new OpenCodeLogAdapter()
}
