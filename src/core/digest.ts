/**
 * 每日简报（v0.11.0）—— 纯类，可注入时钟单测
 *
 * 事件计数在内存中按日累计（重启丢失可接受，MVP 决策）；
 * 每天 hour 点后的首次 tick 触发回调并清零。
 */
import { AgentEventType, TokenUsage } from '../shared/events'

export interface DigestSummary {
  completed: number
  errors: number
  /** 累计运行毫秒（turn_started -> turn_completed 的真实时长） */
  runMs: number
  tokensIn: number
  tokensOut: number
}

function emptySummary(): DigestSummary {
  return { completed: 0, errors: 0, runMs: 0, tokensIn: 0, tokensOut: 0 }
}

function dayKeyOf(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export class DailyDigest {
  private firedKey = ''
  private summary: DigestSummary = emptySummary()

  constructor(
    /** 每日触发时刻（0-23，本地时区） */
    private hour: number,
    private onDigest: (s: DigestSummary) => void,
    private nowFn: () => number = Date.now
  ) {}

  /** 事件入账：只累计有意义的两类终结事件与用量 */
  onEvent(
    eventType: AgentEventType,
    opts: { runMs?: number; usage?: TokenUsage } = {}
  ): void {
    if (eventType === 'turn_completed') {
      this.summary.completed++
      this.summary.runMs += Math.max(0, opts.runMs ?? 0)
    } else if (eventType === 'error') {
      this.summary.errors++
    }
    const u = opts.usage
    if (u) {
      this.summary.tokensIn += u.inputTokens + (u.cacheReadTokens ?? 0)
      this.summary.tokensOut += u.outputTokens
    }
  }

  /** 由主进程每秒 tick：到达 hour 点后当天首次 tick 触发回调并重置。
   *  空计数不触发也不标记——之后同日到来的事件仍会在下次 tick 上报 */
  tick(): void {
    const now = this.nowFn()
    const key = dayKeyOf(now)
    if (key === this.firedKey) return
    if (new Date(now).getHours() < this.hour) return
    const s = this.summary
    if (!(s.completed || s.errors || s.runMs || s.tokensIn || s.tokensOut)) return
    this.firedKey = key
    this.summary = emptySummary()
    this.onDigest(s)
  }

  /** 当前未上报的累计（调试/测试用） */
  peek(): DigestSummary {
    return { ...this.summary }
  }
}
