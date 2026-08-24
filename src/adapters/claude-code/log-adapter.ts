/**
 * Claude Code 日志 tail adapter —— 通道 A（兜底 + 会话发现）
 * 对应架构文档 3.3 第 2 项。
 *
 * 机制：
 *   - tail `~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl`（append-only）
 *   - 启动时扫描既有会话：仅"最近活跃"（mtime 在窗口内）的会话进入监控；
 *     若会话正处进行中（末行是 user 或 stop_reason=tool_use）则补发恢复事件，
 *     让悬浮球立即显示正确状态（running 类事件不触发通知，无打扰）。
 *   - 运行时 fs.watch(recursive) + 定期兜底扫描，从上次 offset 增量续读。
 *
 * 行格式（本机实测）——顶层 type 只有 user/assistant/queue-operation 等；
 * tool_use/tool_result/thinking 是 message.content 内的块类型：
 *   {"type":"user","message":{"role":"user","content":"...文字 prompt..."},...}                     -> turn_started
 *   {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":...}]}}  -> tool_call_finished
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":...}]},"stop_reason":"tool_use"} -> tool_call_started
 *   {"type":"assistant",...,"stop_reason":"end_turn"}                                               -> turn_completed
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentEvent, AgentType } from '../../shared/events'

const ID = 'claude-code-log'

/** 会话视为"活跃"的最后写入窗口（与 timeout 阈值一致，见 constants） */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
/** fs.watch 可能漏报，兜底全量扫描间隔 */
const RESCAN_INTERVAL_MS = 30_000

interface TailState {
  sessionId: string
  cwd?: string
  offset: number
  /** 上一次读取未闭合的半行（jsonl 正在写入时行尾可能不完整） */
  pending: string
}

/** ~/.claude/projects */
function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/** 递归列出 projects 下的全部 .jsonl（会话文件位于转义 cwd 子目录内） */
function listJsonlFiles(root: string): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const sub = path.join(root, e.name)
    let files: string[]
    try {
      files = fs.readdirSync(sub)
    } catch {
      continue
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push(path.join(sub, f))
    }
  }
  return out
}

/** 从 offset 起增量读取文件，返回新增文本与最新 size */
function readNewBytes(filePath: string, offset: number): { text: string; size: number } {
  const size = fs.statSync(filePath).size
  if (size <= offset) return { text: '', size }
  const buf = Buffer.alloc(size - offset)
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.readSync(fd, buf, 0, buf.length, offset)
  } finally {
    fs.closeSync(fd)
  }
  return { text: buf.toString('utf8'), size }
}

/** 读取整个文件（会话发现/状态恢复用） */
function readWholeFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

/**
 * 单行 -> 归一化事件序列。
 * 返回事件按时间语义排序；工具结果可能随 user 行一并出现。
 */
function mapLine(line: Record<string, unknown>): AgentEvent[] {
  const events: AgentEvent[] = []
  const sessionId = typeof line.sessionId === 'string' ? line.sessionId : ''
  if (!sessionId) return events
  const base = {
    source: ID,
    agentType: 'claude-code' as AgentType,
    sessionId,
    cwd: typeof line.cwd === 'string' ? line.cwd : undefined,
    timestamp: typeof line.timestamp === 'string' ? Date.parse(line.timestamp) || Date.now() : Date.now()
  }

  const type = line.type
  const message = line.message as
    | { role?: string; content?: string | Record<string, unknown>[]; stop_reason?: string }
    | undefined

  if (type === 'user') {
    const content = message?.content
    if (typeof content === 'string') {
      // 用户提交 prompt -> 新一轮开始
      events.push({ ...base, eventType: 'turn_started', payload: { raw: line } })
    } else if (Array.isArray(content)) {
      // 工具结果回传 -> 工具调用结束
      for (const block of content) {
        if (block && (block as { type?: string }).type === 'tool_result') {
          const b = block as { tool_use_id?: string; is_error?: boolean; content?: unknown }
          if (b.is_error) {
            events.push({
              ...base,
              eventType: 'error',
              payload: { errorMessage: summarize(b.content), raw: line }
            })
          } else {
            events.push({ ...base, eventType: 'tool_call_finished', payload: { raw: line } })
          }
        }
      }
    }
  } else if (type === 'assistant') {
    const content = message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && (block as { type?: string }).type === 'tool_use') {
          const b = block as { name?: string }
          events.push({
            ...base,
            eventType: 'tool_call_started',
            payload: { toolName: b.name, raw: line }
          })
        }
      }
    }
    if (message?.stop_reason === 'end_turn') {
      events.push({ ...base, eventType: 'turn_completed', payload: { raw: line } })
    }
  }

  return events
}

/** 把 tool_result 的 content 压缩成一行错误摘要 */
function summarize(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 200)
  if (Array.isArray(content)) {
    const first = content.find((c) => typeof c === 'object' && c && (c as { text?: string }).text)
    const t = first ? (first as { text?: string }).text : JSON.stringify(content[0])
    return (t ?? '').slice(0, 200)
  }
  try {
    return JSON.stringify(content).slice(0, 200)
  } catch {
    return ''
  }
}

export class ClaudeCodeLogAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType = 'claude-code'
  readonly capabilities = ['lifecycle', 'tool-events'] as const

  private dir: string | null = null
  private emit: ((e: AgentEvent) => void) | null = null
  private tails = new Map<string, TailState>()
  private watcher: fs.FSWatcher | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  private reconcileTimer: NodeJS.Timeout | null = null
  private stopped = false

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    this.stopped = false
    this.dir = projectsDir()
    if (!fs.existsSync(this.dir)) return

    await this.reconcile()

    console.log(
      `[claude-code-log] tailing ${this.tails.size} active session(s) in ${this.dir}`
    )

    // fs.watch(recursive) 捕获新文件/追加（Windows 支持 recursive）
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, () => this.scheduleReconcile())
    } catch {
      this.watcher = null
    }

    // 兜底：周期全量扫描（watch 漏报 / 网络盘等场景）
    this.rescanTimer = setInterval(() => this.scheduleReconcile(), RESCAN_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.watcher) this.watcher.close()
    if (this.rescanTimer) clearInterval(this.rescanTimer)
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    this.watcher = null
    this.rescanTimer = null
    this.reconcileTimer = null
  }

  async healthCheck(): Promise<AdapterHealth> {
    if (!this.dir || !fs.existsSync(this.dir)) {
      return { ok: false, detail: 'projects dir missing' }
    }
    return { ok: true }
  }

  /** 防抖触发 reconcile */
  private scheduleReconcile(): void {
    if (this.stopped || this.reconcileTimer) return
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      void this.reconcile()
    }, 500)
  }

  private async reconcile(): Promise<void> {
    if (!this.dir || !this.emit) return
    const files = listJsonlFiles(this.dir)
    for (const f of files) {
      try {
        const existing = this.tails.get(f)
        if (existing) {
          this.tail(f, existing)
        } else {
          this.attach(f)
        }
      } catch {
        // 单文件读取失败不影响其他会话
      }
    }
  }

  /** 新会话发现：读全文件，发 session_started + 状态恢复 */
  private attach(filePath: string): void {
    const stat = fs.statSync(filePath)
    // 仅最近活跃的会话进入监控，避免历史会话铺满面板
    if (Date.now() - stat.mtimeMs > ACTIVE_WINDOW_MS) return

    const text = readWholeFile(filePath)
    let sessionId = ''
    let cwd: string | undefined
    let lastUserPrompt = false
    let lastStopReason = ''
    let lastToolName: string | undefined
    let lastTimestamp = Date.now()

    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      let line: Record<string, unknown>
      try {
        line = JSON.parse(raw)
      } catch {
        continue
      }
      if (!sessionId && typeof line.sessionId === 'string') sessionId = line.sessionId
      if (!cwd && typeof line.cwd === 'string') cwd = line.cwd
      if (typeof line.timestamp === 'string') {
        const t = Date.parse(line.timestamp)
        if (!Number.isNaN(t)) lastTimestamp = t
      }
      if (line.type === 'user') {
        const content = (line.message as { content?: unknown })?.content
        // 字符串 content = 真用户 prompt；数组 = 工具结果
        lastUserPrompt = typeof content === 'string'
        lastStopReason = ''
      } else if (line.type === 'assistant') {
        lastUserPrompt = false
        lastStopReason = ((line.message as { stop_reason?: string })?.stop_reason) ?? ''
        const blocks = (line.message as { content?: Record<string, unknown>[] })?.content
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if ((b as { type?: string }).type === 'tool_use') {
              lastToolName = (b as { name?: string }).name
            }
          }
        }
      }
    }

    if (!sessionId) return // 空/损坏文件，跳过
    this.tails.set(filePath, { sessionId, cwd, offset: stat.size, pending: '' })

    const base = {
      source: ID,
      agentType: 'claude-code' as AgentType,
      sessionId,
      cwd,
      timestamp: lastTimestamp
    }
    this.emit?.({ ...base, eventType: 'session_started', payload: { raw: { filePath } } })

    // 状态恢复（running 类事件不触发音效/通知，无打扰）
    if (lastUserPrompt) {
      this.emit?.({ ...base, eventType: 'turn_started' })
    } else if (lastStopReason === 'tool_use') {
      this.emit?.({ ...base, eventType: 'turn_started' })
      this.emit?.({ ...base, eventType: 'tool_call_started', payload: { toolName: lastToolName } })
    }
    // end_turn -> idle，无需额外事件
  }

  /** 增量续读：从上次 offset 读新行并映射 */
  private tail(filePath: string, state: TailState): void {
    const stat = fs.statSync(filePath)
    // 文件被截断/轮转（size 回退）：从头重读
    if (stat.size < state.offset) {
      state.offset = 0
      state.pending = ''
    }
    const { text, size } = readNewBytes(filePath, state.offset)
    state.offset = size
    if (!text) return

    const combined = state.pending + text
    const lines = combined.split('\n')
    // 末段可能是不完整行，留待下次
    state.pending = lines.pop() ?? ''

    for (const raw of lines) {
      if (!raw.trim()) continue
      let line: Record<string, unknown>
      try {
        line = JSON.parse(raw)
      } catch {
        continue // 半行或损坏，跳过
      }
      for (const event of mapLine(line)) {
        this.emit?.(event)
      }
    }
  }
}

/** 工厂：探测本机是否存在 Claude Code 会话目录 */
export const claudeCodeLogAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => fs.existsSync(projectsDir()),
  create: () => new ClaudeCodeLogAdapter()
}
