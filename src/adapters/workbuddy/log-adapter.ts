/**
 * 豆包 WorkBuddy adapter（v1.7.0）—— 通道 A（轮询 tail）
 * 数据源（本机实探）：`%LOCALAPPDATA%/DoubaoWork/User Data/Default/.doubaowork/agent_mode/workspace/.sessions/<会话id>/agents/<代理id>/system/trajectory.jsonl`
 *
 * trajectory 行格式：{ role: 'user'|'assistant'|'tool', content, tool_calls? }
 *   - 无 finishReason 字段 → 完成判定用 hermes 同语义：assistant 无 tool_calls = 回合最终回复
 *   - 会话 id = .sessions 下的目录名
 *   - 会话标题取 board.md 首行（如有），否则目录名
 */
import * as fs from 'fs'
import * as path from 'path'
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentEvent, AgentType } from '../../shared/events'
import { readUtf8Incremental } from '../incremental'
import { sanitizePrompt } from '../../shared/format'

const ID = 'workbuddy'
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000
const POLL_INTERVAL_MS = 5_000

/** 已知安装根（存在多路径可能时全部探测） */
function sessionsRoots(): string[] {
  const local = process.env.LOCALAPPDATA
  if (!local) return []
  return [
    path.join(local, 'DoubaoWork', 'User Data', 'Default', '.doubaowork', 'agent_mode', 'workspace', '.sessions')
  ]
}

/** 单个 assistant 消息是否携带工具调用（= turn 中间消息） */
function hasToolCalls(line: Record<string, unknown>): boolean {
  const tc = line.tool_calls ?? line.toolCalls
  return Array.isArray(tc) && tc.length > 0
}

/** 单行 trajectory -> 归一化事件（宽容；导出供单测） */
export function mapTrajectoryLine(
  line: Record<string, unknown>
): Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[] {
  const events: Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[] = []
  const role = typeof line.role === 'string' ? line.role.toLowerCase() : ''

  if (role === 'user') {
    const prompt = sanitizePrompt(
      typeof line.content === 'string' ? line.content : JSON.stringify(line.content ?? '')
    )
    events.push({ eventType: 'turn_started', timestamp: Date.now(), ...(prompt ? { payload: { prompt } } : {}) })
  } else if (role === 'tool' || role === 'function') {
    events.push({
      eventType: 'tool_call_started',
      timestamp: Date.now(),
      payload: { toolName: typeof line.tool_name === 'string' ? line.tool_name : 'tool' }
    })
  } else if (role === 'assistant' && !hasToolCalls(line)) {
    events.push({ eventType: 'turn_completed', timestamp: Date.now() })
  }
  // assistant 带工具调用 = 中间消息，忽略
  return events
}

interface TailState {
  sessionId: string
  offset: number
  pending: string
}

export class WorkBuddyAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType = 'workbuddy'
  readonly capabilities = ['lifecycle', 'tool-events'] as const

  private emit: ((e: AgentEvent) => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private tails = new Map<string, TailState & { filePath: string }>()
  private available = false
  private stopped = false

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    this.stopped = false
    this.available = sessionsRoots().some((r) => fs.existsSync(r))
    if (!this.available) return

    this.attachExisting()
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
    console.log('[workbuddy] monitoring .sessions trajectory')
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async healthCheck(): Promise<AdapterHealth> {
    if (!this.available) return { ok: false, detail: '.doubaowork .sessions not found' }
    return { ok: true }
  }

  /** 扫描全部活跃会话的 trajectory 文件 */
  private listTrajectories(): Array<{ file: string; sessionId: string }> {
    const out: Array<{ file: string; sessionId: string }> = []
    for (const root of sessionsRoots()) {
      let sessionDirs: fs.Dirent[]
      try {
        sessionDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
      } catch {
        continue
      }
      for (const sd of sessionDirs) {
        const sid = sd.name
        const sessDir = path.join(root, sid)
        // 会话活跃 = 目录 mtime 在窗口内
        try {
          if (Date.now() - fs.statSync(sessDir).mtimeMs > ACTIVE_WINDOW_MS) continue
        } catch {
          continue
        }
        // agents/*/system/trajectory.jsonl
        let agents: fs.Dirent[]
        try {
          agents = fs.readdirSync(path.join(sessDir, 'agents'), { withFileTypes: true }).filter((d) => d.isDirectory())
        } catch {
          continue
        }
        for (const a of agents) {
          const p = path.join(sessDir, 'agents', a.name, 'system', 'trajectory.jsonl')
          try {
            if (fs.existsSync(p)) out.push({ file: p, sessionId: `${sid}:${a.name}` })
          } catch {
            /* 忽略 */
          }
        }
      }
    }
    return out
  }

  private attachExisting(): void {
    for (const { file, sessionId } of this.listTrajectories()) {
      if ([...this.tails.values()].some((t) => t.filePath === file)) continue
      try {
        const stat = fs.statSync(file)
        this.tails.set(file, { sessionId, offset: stat.size, pending: '', filePath: file })
        this.emit?.({
          source: ID,
          agentType: this.agentType,
          sessionId,
          eventType: 'session_started',
          timestamp: Date.now(),
          payload: { title: `WorkBuddy ${sessionId.split(':')[0]}` }
        })
      } catch {
        /* 忽略 */
      }
    }
  }

  private poll(): void {
    if (this.stopped || !this.emit) return
    this.attachExisting()
    for (const [file, state] of this.tails) {
      try {
        this.tailFile(file, state)
      } catch {
        /* 单文件失败不影响其他 */
      }
    }
  }

  private tailFile(filePath: string, state: TailState & { filePath: string }): void {
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
      let line: Record<string, unknown>
      try {
        line = JSON.parse(raw)
      } catch {
        continue
      }
      for (const ev of mapTrajectoryLine(line)) {
        this.emit?.({ ...ev, source: ID, agentType: this.agentType, sessionId: state.sessionId })
      }
    }
  }
}

export const workBuddyAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => sessionsRoots().some((r) => fs.existsSync(r)),
  create: () => new WorkBuddyAdapter()
}
