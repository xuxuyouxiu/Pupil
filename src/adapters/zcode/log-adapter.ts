/**
 * ZCode 会话记录 adapter —— 通道 A（轮询 tail）
 * 数据源：~/.zcode/cli/rollout/model-io-sess_*.jsonl（每个 ZCode 会话一个文件，实时追加）
 * 行格式（model_io，每行 = 一次已完成的模型请求）：
 *   { completedAt, durationMs, requestId, attempt, model,
 *     request: { messages: [{role:'user'|'assistant'|'tool', content}, ...],
 *                messageCount, messagesKind }, error? }
 *
 * 映射：
 *   新发现文件           -> session_started
 *   累计 user 文本消息数增加 -> turn_started（会话快照是全量上下文，按计数差值判定）
 *   每条完成请求          -> thinking 活动脉冲
 *   行带 error            -> error
 *   发过运行脉冲后静默超阈值 -> turn_completed（无权威结束标记，与 codex 同启发式）
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentEvent } from '../../shared/events'
import { readUtf8Incremental } from '../incremental'
import { safeJoin } from '../safe-path'

const ID = 'zcode-rollout'
const ACTIVE_WINDOW_MS = 60 * 60 * 1000
const POLL_INTERVAL_MS = 5_000
/** 静默完成启发式阈值：与 codex 桌面版一致的自我修复式判定 */
const QUIET_COMPLETE_MS = 3 * 60 * 1000

function rolloutDir(): string {
  return path.join(os.homedir(), '.zcode', 'cli', 'rollout')
}

/** 文件名 -> 会话 ID：model-io-sess_2489d061-….jsonl -> 2489d061-…；subagent 文件名自然保有其前缀 */
export function deriveSessionId(filePath: string): string {
  const base = path.basename(filePath)
  return base.replace(/^model-io-sess_/, '').replace(/\.jsonl$/i, '')
}

/** 判断一条消息是否为"用户提交的 prompt"（排除工具结果伪装成 user 轮次的场景） */
function isUserPrompt(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  let hasText = false
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    const t = typeof b.type === 'string' ? b.type : ''
    if (t === 'tool_result' || t === 'tool_use_id' || t === 'image') return false
    if (t === 'text') hasText = true
  }
  return hasText
}

/** 统计快照里累计的 user prompt 数量 */
function countPrompts(line: Record<string, unknown>): number {
  const req = line.request as Record<string, unknown> | undefined
  const msgs = req?.messages
  if (!Array.isArray(msgs)) return 0
  let n = 0
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const msg = m as Record<string, unknown>
    if (msg.role !== 'user') continue
    if (isUserPrompt(msg.content)) n++
  }
  return n
}

/** 行时间戳：completedAt 为毫秒 epoch 数字或 ISO 字符串；异常时回退当前时间 */
function lineTimestamp(completedAt: unknown): number {
  if (typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0) {
    // 秒级时间戳兼容
    return completedAt < 1e12 ? completedAt * 1000 : completedAt
  }
  if (typeof completedAt === 'string') {
    const parsed = Date.parse(completedAt)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

/**
 * 单行 model_io -> 归一化事件序列（导出供单元测试）
 * prevUserTurns 为该文件此前累计的 prompt 数；计数增长即视为新一轮任务开始。
 */
export function mapModelIoLine(
  line: Record<string, unknown>,
  prevUserTurns: number
): Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[] {
  const events: Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[] = []
  const ts = lineTimestamp(line.completedAt)

  // 用户 prompt 计数差值 -> turn_started（严格大于防重放/乱序重复触发）
  const turns = countPrompts(line)
  if (turns > prevUserTurns) {
    events.push({ eventType: 'turn_started', timestamp: ts })
  }

  // error：attempt 重试 / 请求失败均在此暴露，转成 error 事件（payload 带原始信息）
  if (line.error) {
    const err = line.error
    const message =
      typeof err === 'string'
        ? err
        : err instanceof Object && typeof (err as Record<string, unknown>).message === 'string'
          ? ((err as Record<string, unknown>).message as string)
          : JSON.stringify(err).slice(0, 200)
    events.push({ eventType: 'error', timestamp: ts, payload: { errorMessage: message, raw: line } })
  }

  // 活动脉冲：任何完成的请求都证明会话在动
  events.push({ eventType: 'thinking', timestamp: ts })
  return events
}

interface RolloutTailState {
  sessionId: string
  offset: number
  pending: string
  /** 截至上次解析累计的 user prompt 数（新行计数增长 => turn_started） */
  userTurns: number
  /** 本轮已发运行脉冲且未发过静默完成 */
  pulsing: boolean
  lastChangedAt: number
}

export class ZcodeRolloutAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType_ = 'zcode'
  readonly capabilities = ['lifecycle', 'tool-events'] as const

  private emit: ((e: AgentEvent) => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private tails = new Map<string, RolloutTailState>()
  private available = false
  private stopped = false

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    this.stopped = false
    this.available = fs.existsSync(rolloutDir())
    if (!this.available) return

    this.attachExistingRollouts()
    await this.poll()
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
    console.log('[zcode-rollout] monitoring ~/.zcode/cli/rollout')
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async healthCheck(): Promise<AdapterHealth> {
    if (!this.available) return { ok: false, detail: '~/.zcode/cli/rollout not found' }
    return { ok: true }
  }

  /** 启动时附加既有会话：只解析到基线（不回放历史避免通知刷屏），从文件尾继续 */
  private attachExistingRollouts(): void {
    for (const p of this.listRolloutFiles()) {
      try {
        const stat = fs.statSync(p)
        const text = readWholeFileBaseline(p)
        // 基线 = 已有内容的最后一个 prompt 计数（粗读：逐行取最后成功行的计数）
        let baselineTurns = 0
        for (const raw of text.split('\n')) {
          if (!raw.trim()) continue
          try {
            const line = JSON.parse(raw) as Record<string, unknown>
            baselineTurns = Math.max(baselineTurns, countPrompts(line))
          } catch {
            /* 半行忽略 */
          }
        }
        this.tails.set(p, {
          sessionId: deriveSessionId(p),
          offset: stat.size,
          pending: '',
          userTurns: baselineTurns,
          pulsing: false,
          lastChangedAt: Date.now()
        })
        this.emit?.({
          source: ID,
          agentType: 'zcode',
          sessionId: deriveSessionId(p),
          eventType: 'session_started',
          timestamp: Date.now(),
          payload: { raw: { filePath: p } }
        })
      } catch {
        /* 单文件失败不影响其他 */
      }
    }
  }

  private listRolloutFiles(): string[] {
    const root = rolloutDir()
    let files: string[]
    try {
      files = fs.readdirSync(root)
    } catch {
      return []
    }
    const out: string[] = []
    for (const f of files) {
      if (!f.startsWith('model-io-sess_') || !f.endsWith('.jsonl')) continue
      const p = safeJoin(root, f)
      if (!p) continue
      try {
        if (Date.now() - fs.statSync(p).mtimeMs <= ACTIVE_WINDOW_MS) out.push(p)
      } catch {
        /* 忽略 */
      }
    }
    return out
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.emit) return
    const now = Date.now()

    // 新发现的运行中文件：记 offset 从尾部开始（历史不回放）
    for (const p of this.listRolloutFiles()) {
      if (!this.tails.has(p)) {
        try {
          const size = fs.statSync(p).size
          this.tails.set(p, {
            sessionId: deriveSessionId(p),
            offset: size,
            pending: '',
            userTurns: 0,
            pulsing: false,
            lastChangedAt: now
          })
          this.emit?.({
            source: ID,
            agentType: 'zcode',
            sessionId: deriveSessionId(p),
            eventType: 'session_started',
            timestamp: now
          })
        } catch {
          /* 忽略 */
        }
      }
    }

    for (const [p, state] of this.tails) {
      try {
        this.tailFile(p, state, now)
      } catch {
        /* 单文件失败不影响其他（含文件被清理） */
      }
    }

    // 静默完成：发过运行脉冲的会话静默超阈值 -> 视为本轮已完成（一次性）；之后再有活动自然重新脉冲
    for (const state of this.tails.values()) {
      if (state.pulsing && now - state.lastChangedAt >= QUIET_COMPLETE_MS) {
        state.pulsing = false
        this.emit?.({
          source: ID,
          agentType: 'zcode',
          sessionId: state.sessionId,
          eventType: 'turn_completed',
          timestamp: now
        })
      }
    }
  }

  private tailFile(filePath: string, state: RolloutTailState, now: number): void {
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
      for (const ev of mapModelIoLine(line, state.userTurns)) {
        this.emit?.({ ...ev, source: ID, agentType: 'zcode', sessionId: state.sessionId })
      }
      const turns = countPrompts(line)
      if (turns > state.userTurns) state.userTurns = turns
      // 有真实内容到达即算活动（不带事件的行同样续期静默计时）
      state.pulsing = true
      state.lastChangedAt = now
    }
  }
}

type AgentType_ = import('../../shared/events').AgentType

function readWholeFileBaseline(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

export const zcodeRolloutAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => fs.existsSync(rolloutDir()),
  create: () => new ZcodeRolloutAdapter()
}
