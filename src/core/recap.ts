/**
 * 任务回顾引擎（v1.2.0）—— 纯逻辑，零 IO；持久化经注入的 RecapStore 完成
 * 设计详见 docs/ROADMAP-v2.md 批次 A：事件驱动开卡/入账/结卡，按开始日归档
 */
import { AgentEvent } from '../shared/events'
import { sessionKey } from '../shared/events'

export interface TaskCard {
  id: string // `${agentType}:${sessionId}:${startedAt}`
  agentType: string
  sessionTitle?: string
  cwd?: string
  prompt?: string
  tools: Record<string, number>
  files: string[]
  startedAt: number
  endedAt?: number
  errors: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface RecapDay {
  date: string // 'YYYY-MM-DD'（本地时区，任务开始日）
  cards: TaskCard[]
}

export interface RecapTotals {
  tasks: number
  errors: number
  runMs: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}

/** 卡片在内存中的打开状态（持久化时一并写盘，重启后未结卡强制补结） */
export interface OpenCard extends TaskCard {
  key: string
}

export function dayKeyOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function emptyTotals(): RecapTotals {
  return { tasks: 0, errors: 0, runMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }
}

/** 当日合计（卡片集合求和；未结卡按"至今"估时长不参与 runMs） */
export function totalsOf(cards: TaskCard[]): RecapTotals {
  const t = emptyTotals()
  for (const c of cards) {
    t.tasks++
    t.errors += c.errors
    t.tokensIn += c.tokensIn
    t.tokensOut += c.tokensOut
    t.costUsd += c.costUsd
    if (c.endedAt !== undefined) t.runMs += Math.max(0, c.endedAt - c.startedAt)
  }
  return t
}

/** 注入式持久化（主进程实现文件读写；core 保持零 IO 可单测） */
export interface RecapStore {
  load(date: string): RecapDay | null
  save(day: RecapDay): void
  listDates(): string[]
  /** 删除某日期文件（保留期清扫） */
  drop(date: string): void
}

const MAX_CARDS_PER_DAY = 500

export class RecapEngine {
  /** 全部打开中的卡（key -> card），结卡后移入对应日期文件 */
  private open = new Map<string, OpenCard>()
  /** 按日期的已结卡缓存（写入与读取共用；惰性加载由 store 完成） */
  private loaded = new Map<string, RecapDay>()
  private dirty = new Set<string>()

  constructor(
    private store: RecapStore,
    private nowFn: () => number = Date.now
  ) {}

  /** 事件入口（monitoring-core.onEvent 转发全量事件） */
  onEvent(e: AgentEvent): void {
    const key = sessionKey(e.agentType, e.sessionId)
    switch (e.eventType) {
      case 'turn_started':
        // 同 key 上一张未结卡先强制结卡（防幽灵开卡）
        this.forceClose(key)
        this.openCard(key, e)
        break
      case 'tool_call_started':
        this.recordTool(key, e)
        break
      case 'error':
        this.recordError(key)
        break
      case 'turn_completed':
        this.closeCard(key, e.timestamp)
        break
      case 'session_ended':
        this.forceClose(key)
        break
      default:
        break
    }
    // usage/error 无论哪种事件类型都入账（挂载在 thinking/turn_completed 等载体上）
    this.recordUsage(key, e)
  }

  private openCard(key: string, e: AgentEvent): void {
    const startedAt = e.timestamp || this.nowFn()
    const card: OpenCard = {
      key,
      id: `${e.agentType}:${e.sessionId}:${startedAt}`,
      agentType: e.agentType,
      sessionTitle: e.payload?.title,
      cwd: e.cwd,
      prompt: e.payload?.prompt,
      tools: {},
      files: [],
      startedAt,
      errors: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0
    }
    this.open.set(key, card)
    this.lastClosedBy.delete(key)
  }

  private recordTool(key: string, e: AgentEvent): void {
    const card = this.open.get(key)
    if (!card) return
    const name = e.payload?.toolName
    if (name) card.tools[name] = (card.tools[name] ?? 0) + 1
    for (const f of e.payload?.files ?? []) {
      if (!card.files.includes(f) && card.files.length < 12) card.files.push(f)
    }
  }

  private recordError(key: string): void {
    const card = this.open.get(key)
    if (card) card.errors++
  }

  private recordUsage(key: string, e: AgentEvent): void {
    const u = e.payload?.usage
    if (!u) return
    const card = this.open.get(key)
    if (card) {
      card.tokensIn += u.inputTokens
      card.tokensOut += u.outputTokens
      card.costUsd += u.costUsd ?? 0
      return
    }
    // v1.2.0 补挂：turn_completed 自带 usage 时，卡已在 closeCard 移除——
    // 找到该会话"最近结卡"的一张回补（事件同 tick 顺序：close 先于本入账）
    const last = this.lastClosedBy.get(key)
    if (last) {
      last.tokensIn += u.inputTokens
      last.tokensOut += u.outputTokens
      last.costUsd += u.costUsd ?? 0
    }
  }

  /** 结卡：移入按开始日的日期文件 */
  /** 每会话最近结卡的卡（供同 tick 后到的 usage 回补） */
  private lastClosedBy = new Map<string, TaskCard>()

  private closeCard(key: string, endedAt: number): void {
    const card = this.open.get(key)
    if (!card) return
    this.open.delete(key)
    card.endedAt = endedAt || this.nowFn()
    this.lastClosedBy.set(key, card)
    this.appendToDay(dayKeyOf(card.startedAt), card)
  }

  /** 强制结卡（轮次切换/会话结束/重启恢复） */
  forceClose(key: string): void {
    if (!this.open.has(key)) return
    this.closeCard(key, this.nowFn())
  }

  /** 重启恢复：全部未结卡按当前时刻补结 */
  recover(): void {
    for (const key of [...this.open.keys()]) this.forceClose(key)
  }

  private appendToDay(date: string, card: TaskCard): void {
    let day = this.loaded.get(date)
    if (!day) {
      const loaded = this.store.load(date)
      day = loaded ?? { date, cards: [] }
      this.loaded.set(date, day)
    }
    day.cards.push(card)
    if (day.cards.length > MAX_CARDS_PER_DAY) {
      day.cards.splice(0, day.cards.length - MAX_CARDS_PER_DAY)
    }
    this.dirty.add(date)
  }

  /** 脏日期落盘（monitoring-core 定时 + 退出时调用；3s 防抖由调用方控制） */
  flush(): void {
    for (const date of this.dirty) {
      const day = this.loaded.get(date)
      if (day) this.store.save(day)
    }
    this.dirty.clear()
  }

  /** 读取某日回顾（惰性加载 + 与内存打开中卡片合并展示） */
  view(date: string): { date: string; cards: TaskCard[]; totals: RecapTotals } {
    let day = this.loaded.get(date)
    if (!day) {
      day = this.store.load(date) ?? { date, cards: [] }
      this.loaded.set(date, day)
    }
    // 进行中的卡也展示（endedAt 为空的排最后）
    const today = dayKeyOf(this.nowFn())
    const openCards =
      date === today ? [...this.open.values()].map(({ key, ...c }) => c as TaskCard) : []
    const cards = [...day.cards, ...openCards]
    return { date, cards, totals: totalsOf(cards) }
  }

  /** 保留期清扫：删除 store 中早于 keepDays 的日期文件 */
  prune(keepDays: number): void {
    const cutoff = dayKeyOf(this.nowFn() - keepDays * 86_400_000)
    for (const date of this.store.listDates()) {
      if (date < cutoff) this.store.drop(date)
    }
  }
}
