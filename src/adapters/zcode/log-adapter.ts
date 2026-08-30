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
import { AgentEvent, TokenUsage } from '../../shared/events'
import { readUtf8Incremental } from '../incremental'
import { sanitizePrompt, basenameOf } from '../../shared/format'
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

/** 单次请求的响应侧信号（finishReason / usage） */
export interface ModelIoSignals {
  events: Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[]
  /** 本行的轮次 id（供 adapter 维护分轮状态） */
  turnId: string | undefined
}

/**
 * v1.0.3 单行 model_io -> 归一化事件序列（真实信号版，导出供单元测试）：
 * - turnId 变化（含首见） -> turn_started——宿主原生轮次分组，零猜测
 * - response.finishReason 非 tool-calls（stop/end_turn/length…） -> turn_completed 即刻收敛，
 *   替代旧的 3 分钟静默启发式（那是「答完一两分钟才停下」的根因）
 * - response.usage 提取 token 用量（inputTokens 已含缓存读/写，拆回各分量）
 * - 行带 error -> error 事件
 */
export function mapModelIoLine(
  line: Record<string, unknown>,
  prevTurnId: string | undefined
): ModelIoSignals {
  const events: Omit<AgentEvent, 'source' | 'agentType' | 'sessionId'>[] = []
  const ts = lineTimestamp(line.completedAt)
  const turnId = typeof line.turnId === 'string' && line.turnId ? line.turnId : undefined

  // 轮次边界：turnId 首见/变化即新一轮。v1.2.0 附带本轮用户指令摘要（回顾系统任务标题）
  if (turnId && turnId !== prevTurnId) {
    const prompt = extractPrompt(line)
    events.push({ eventType: 'turn_started', timestamp: ts, ...(prompt ? { payload: { prompt } } : {}) })
  }

  const resp = (line.response ?? {}) as Record<string, unknown>

  // error 分级（v1.1.3）：
  //   1. 打断类（preempt/terminat/abort/cancel/interrupt）= 用户插话/主动取消的正常行为
  //      → 不发 error，只当轮次边界（下一条 user 消息随后就到）
  //   2. 瞬态类（concurrency/网络/timeout/rate）= 会自动重试 → 发 error 但标记 transient，
  //      前端可静音处理；保留通知供感知
  //   3. 其余 → 正常 error
  if (line.error) {
    const err = line.error
    const message =
      typeof err === 'string'
        ? err
        : err instanceof Object && typeof (err as Record<string, unknown>).message === 'string'
          ? ((err as Record<string, unknown>).message as string)
          : JSON.stringify(err).slice(0, 200)
    if (isInterruptError(message)) {
      // 用户插话打断当前轮：不发 error（错误音效误导），归为 thinking 脉冲即可
      events.push({ eventType: 'thinking', timestamp: ts, payload: { raw: line } })
    } else {
      const transient = isTransientError(message)
      events.push({
        eventType: 'error',
        timestamp: ts,
        payload: { errorMessage: message, transient, raw: line }
      })
    }
  }

  // 完成：finishReason 存在且非工具调用续行 => 本轮真正收敛。
  // v1.1.2 关键：收敛行【不再追加 thinking 活动脉冲】——此前脉冲排在完成事件之后，
  // 会把状态机从 idle/done 又推回 thinking：done 弹窗被打断、turnStartedAt 被清空后
  // 时长永远 --:--、球在答完后仍显示思考（用户报告的两个残留症状同根因）。
  // 本行 usage 挂在 turn_completed 上（随事件流照常入账）
  const finishReason = typeof resp.finishReason === 'string' ? resp.finishReason : ''
  const turnEnded = !!finishReason && !/tool/i.test(finishReason)
  if (turnEnded) {
    const usage = extractUsage(resp)
    events.push({
      eventType: 'turn_completed',
      timestamp: ts,
      payload: { raw: line, ...(usage ? { usage } : {}) }
    })
    return { events, turnId }
  }

  // 活动脉冲：回合进行中的每次请求。v1.2.0 顺带提取 toolCalls 的文件轨迹
  const files = extractFiles(resp)
  events.push({
    eventType: 'thinking',
    timestamp: ts,
    payload: { usage: extractUsage(resp), ...(files.length > 0 ? { files } : {}) }
  })

  return { events, turnId }
}

/** v1.2.0 本轮用户指令摘要：request.messages 中最后一条 user 的文本 content */
function extractPrompt(line: Record<string, unknown>): string | undefined {
  const req = line.request as Record<string, unknown> | undefined
  const msgs = req?.messages
  if (!Array.isArray(msgs)) return undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as Record<string, unknown> | undefined
    if (!m || m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return sanitizePrompt(c)
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block && (block as Record<string, unknown>).type === 'text') {
          return sanitizePrompt((block as Record<string, unknown>).text)
        }
      }
    }
    return undefined
  }
  return undefined
}

/** v1.2.0 文件轨迹：response.toolCalls[].input 的 file_path/path（basename，去重） */
function extractFiles(resp: Record<string, unknown>): string[] {
  const tcs = resp.toolCalls as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(tcs)) return []
  const out: string[] = []
  for (const tc of tcs) {
    const input = tc.input as Record<string, unknown> | undefined
    if (!input || typeof input !== 'object') continue
    for (const key of ['file_path', 'path', 'filePath']) {
      const base = basenameOf(input[key])
      if (base && !out.includes(base) && out.length < 12) out.push(base)
    }
  }
  return out
}

/** 打断类错误：用户插话/主动取消导致的轮次终止（正常行为，非故障） */
export function isInterruptError(message: string): boolean {
  return /preempt|terminat|abort|cancel|interrupt/i.test(message)
}

/** 瞬态错误：并发限制/网络抖动/限速——宿主会自动重试 */
export function isTransientError(message: string): boolean {
  return /concurrency|network|网络|timeout|timed out|rate limit|ECONN|fetch failed/i.test(message)
}

/** response.usage 形态：{ inputTokens(含缓存读/写), outputTokens, cacheReadTokens, cacheWriteTokens } */
function extractUsage(resp: Record<string, unknown>): TokenUsage | undefined {
  const u = resp.usage as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return undefined
  const cacheRead = Number(u.cacheReadTokens ?? 0)
  const cacheWrite = Number(u.cacheWriteTokens ?? 0)
  const totalInput = Number(u.inputTokens ?? 0)
  const output = Number(u.outputTokens ?? 0)
  const realInput = Math.max(0, totalInput - cacheRead - cacheWrite)
  if (!realInput && !output && !cacheRead && !cacheWrite) return undefined
  return {
    inputTokens: realInput,
    outputTokens: output,
    cacheReadTokens: cacheRead || undefined,
    cacheCreationTokens: cacheWrite || undefined
  }
}

interface RolloutTailState {
  sessionId: string
  offset: number
  pending: string
  /** 最近一次解析到的轮次 id（变化 => turn_started） */
  lastTurnId: string | undefined
  /** 本轮已发运行脉冲且未发过静默完成（finishReason 缺失时的兜底） */
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
        // 基线 = 最后一行的 turnId；若其 finishReason 为工具续行（或缺失），视为回合仍开着
        let lastTurnId: string | undefined
        let openTurn = false
        for (const raw of text.split('\n')) {
          if (!raw.trim()) continue
          try {
            const line = JSON.parse(raw) as Record<string, unknown>
            const tid = typeof line.turnId === 'string' ? line.turnId : undefined
            if (tid) {
              lastTurnId = tid
              const resp = (line.response ?? {}) as Record<string, unknown>
              const fr = typeof resp.finishReason === 'string' ? resp.finishReason : ''
              openTurn = !fr || /tool/i.test(fr)
            }
          } catch {
            /* 半行忽略 */
          }
        }
        this.tails.set(p, {
          sessionId: deriveSessionId(p),
          offset: stat.size,
          pending: '',
          lastTurnId,
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
        // 恢复运行中回合：时长从重启时刻起算（好于 --:--）
        if (openTurn) {
          this.emit?.({
            source: ID,
            agentType: 'zcode',
            sessionId: deriveSessionId(p),
            eventType: 'turn_started',
            timestamp: Date.now()
          })
        }
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
            lastTurnId: undefined,
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
      const mapped = mapModelIoLine(line, state.lastTurnId)
      for (const ev of mapped.events) {
        this.emit?.({ ...ev, source: ID, agentType: 'zcode', sessionId: state.sessionId })
      }
      if (mapped.turnId) state.lastTurnId = mapped.turnId
      // 有真实内容到达即算活动；finishReason 已覆盖正常收敛，
      // 静默启发式（3 分钟）保留为旧行缺 finishReason 时的兜底
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
