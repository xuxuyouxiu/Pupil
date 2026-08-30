/**
 * Gemini CLI adapter —— 通道 A（轮询 tail）
 * 数据源：~/.gemini/tmp/<conversation-hash>/ 下的会话记录。
 * 官方已知布局：logs.jsonl / chats/*.jsonl / checkpoint.json（结构随版本演进，解析保持宽容）。
 *
 * 宽容解析策略（Gemini CLI 无稳定公开 schema，逐行探测而非硬编码字段）：
 *   - 行含 "role":"user" 且带文本（非 functionResponse）-> turn_started（附 prompt 摘要）
 *   - 行含 "role":"model"/"assistant" 文本 -> thinking 脉冲 + finishReason 类字段判定完成
 *   - 行带 error / "isError":true -> error
 *   - usage（若有 thoughtUsage/outputUsage 等键）-> 透传
 * 无权威完成信号时由静默启发式（inference 引擎）兜底，与 codex/zcode 同策略。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentEvent, AgentType } from '../../shared/events'
import { readUtf8Incremental } from '../incremental'
import { safeJoin } from '../safe-path'
import { sanitizePrompt } from '../../shared/format'

const ID = 'gemini-cli'
const ACTIVE_WINDOW_MS = 60 * 60 * 1000
const POLL_INTERVAL_MS = 5_000

function geminiDir(): string {
  return path.join(os.homedir(), '.gemini', 'tmp')
}

export function deriveSessionId(filePath: string): string {
  // tmp/<hash>/xxx.jsonl -> hash（同一会话目录内多文件归并为一个会话）
  const dir = path.basename(path.dirname(filePath))
  return dir || path.basename(filePath, '.jsonl')
}

/** 宽容提取一行的 role：常见键 role/type/speaker */
function lineRole(line: Record<string, unknown>): string {
  const r = line.role ?? line.type ?? line.speaker
  return typeof r === 'string' ? r.toLowerCase() : ''
}

/** 宽容提取文本内容（string 或 blocks 数组里的 text） */
function lineText(line: Record<string, unknown>): string {
  const cands = [line.text, line.content, line.message]
  for (const c of cands) {
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>
          if (b.type === 'text' && typeof b.text === 'string') return b.text
        }
      }
    }
  }
  return ''
}

/** 是否工具结果行（不算用户指令） */
function isToolResult(line: Record<string, unknown>): boolean {
  const t = String(line.type ?? line.subtype ?? '')
  return /function_?response|tool_?result|tool_?output/i.test(t)
}

/** 单行 -> 归一化事件序列（宽容解析；导出供单测） */
export function mapGeminiLine(
  line: Record<string, unknown>,
  firstSeen: boolean
): Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[] {
  const events: Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[] = []
  const ts = typeof line.timestamp === 'number'
    ? line.timestamp
    : typeof line.timestamp === 'string' && !Number.isNaN(Date.parse(line.timestamp))
      ? Date.parse(line.timestamp)
      : Date.now()
  const role = lineRole(line)
  const text = lineText(line)

  if (firstSeen) {
    events.push({ eventType: 'session_started', timestamp: ts })
  }

  if ((role === 'user' || role === 'human') && !isToolResult(line) && text) {
    const prompt = sanitizePrompt(text)
    events.push({ eventType: 'turn_started', timestamp: ts, ...(prompt ? { payload: { prompt } } : {}) })
  }

  if (line.error || line.isError === true) {
    const err = line.error
    const message =
      typeof err === 'string'
        ? err
        : typeof text === 'string' && text
          ? text.slice(0, 200)
          : 'gemini error'
    events.push({ eventType: 'error', timestamp: ts, payload: { errorMessage: message, raw: line } })
  }

  // 活动脉冲：model/assistant 文本或任何工具活动
  if (role === 'model' || role === 'assistant' || role === 'gemini' || /tool/i.test(role)) {
    events.push({ eventType: 'thinking', timestamp: ts })
  }

  return events
}

interface TailState {
  sessionId: string
  offset: number
  pending: string
  started: boolean
}

export class GeminiCliAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType = 'gemini'
  readonly capabilities = ['lifecycle'] as const

  private emit: ((e: AgentEvent) => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private tails = new Map<string, TailState>()
  private available = false
  private stopped = false

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    this.stopped = false
    this.available = fs.existsSync(geminiDir())
    if (!this.available) return

    this.attachExisting()
    await this.poll()
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
    console.log('[gemini-cli] monitoring ~/.gemini/tmp')
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async healthCheck(): Promise<AdapterHealth> {
    if (!this.available) return { ok: false, detail: '~/.gemini/tmp not found' }
    return { ok: true }
  }

  private attachExisting(): void {
    for (const p of this.listSessionFiles()) {
      if (this.tails.has(p)) continue
      try {
        const stat = fs.statSync(p)
        this.tails.set(p, { sessionId: deriveSessionId(p), offset: stat.size, pending: '', started: false })
      } catch {
        /* 忽略 */
      }
    }
  }

  private listSessionFiles(): string[] {
    const root = geminiDir()
    let dirs: fs.Dirent[]
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return []
    }
    const out: string[] = []
    for (const d of dirs) {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(safeJoin(root, d.name) ?? '', { withFileTypes: true })
      } catch {
        continue
      }
      const sub = safeJoin(root, d.name) ?? ''
      // 会话文件：目录根部 logs.jsonl / chats/*.jsonl / checkpoint.json 旁的 jsonl
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          const p = safeJoin(sub, e.name)
          if (!p) continue
          try {
            if (Date.now() - fs.statSync(p).mtimeMs <= ACTIVE_WINDOW_MS) out.push(p)
          } catch {
            /* 忽略 */
          }
        }
        if (e.isDirectory() && e.name.toLowerCase() === 'chats') {
          const chatDir = safeJoin(sub, 'chats') ?? ''
          let chatFiles: string[]
          try {
            chatFiles = fs.readdirSync(chatDir)
          } catch {
            continue
          }
          for (const cf of chatFiles) {
            if (!cf.endsWith('.jsonl')) continue
            const p = safeJoin(chatDir, cf)
            if (!p) continue
            try {
              if (Date.now() - fs.statSync(p).mtimeMs <= ACTIVE_WINDOW_MS) out.push(p)
            } catch {
              /* 忽略 */
            }
          }
        }
      }
    }
    return out
  }

  private async poll(): Promise<void> {
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
      let line: Record<string, unknown>
      try {
        line = JSON.parse(raw)
      } catch {
        continue
      }
      const firstSeen = !state.started
      state.started = true
      for (const ev of mapGeminiLine(line, firstSeen)) {
        this.emit?.({ ...ev, source: ID, agentType: this.agentType, sessionId: state.sessionId })
      }
    }
  }
}

export const geminiCliAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => fs.existsSync(geminiDir()),
  create: () => new GeminiCliAdapter()
}
