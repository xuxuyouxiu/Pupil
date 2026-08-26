/**
 * BubbleTracker —— 状态播报气泡的触发与去重（纯逻辑）
 *
 * 数据源是【事件语义】而非快照差分：状态机把 turn_completed 直接落回 idle，
 * 快照里永远看不到 done——只有事件本身携带语义（turn_completed/waiting_input/error），
 * 且事件天生就是边沿（差分轮询只报变化），不存在持续态复读问题。
 *
 * 去重两层：
 *   - 全局同文案 1.2s 内只说一句（多会话同时完成/等待/出错）
 *   - 同会话同文案 30s 冷却（防御异常源重复发同类事件）
 *
 * 勿扰过滤在发送侧（main/index.ts），本类不管。
 */

export type BubbleKind = 'done' | 'waiting' | 'error'

export const BUBBLE_TEXT: Record<BubbleKind, string> = {
  done: '搞定啦✓',
  waiting: '该你啦～',
  error: '呜…炸了…'
}

export const BUBBLE_DEDUPE_MS = 1200
/** 同会话同文案冷却（防异常数据源重复上报） */
export const BUBBLE_KEY_COOLDOWN_MS = 30_000

/** 事件类型 → 播报语义；null = 该事件不播报 */
export function eventToBubbleKind(eventType: string): BubbleKind | null {
  switch (eventType) {
    case 'turn_completed':
      return 'done'
    case 'waiting_input':
      return 'waiting'
    case 'error':
      return 'error'
    default:
      return null
  }
}

export class BubbleTracker {
  private lastGlobalAt = new Map<BubbleKind, number>()
  private lastKeyAt = new Map<string, number>()

  /**
   * 报告一次语义事件，返回应播报的文案（被去重抑制时返回 null）。
   * @param kind 播报类型（来自 eventToBubbleKind）
   * @param key 会话归一化 key
   * @param now 当前时间戳 ms
   */
  update(kind: BubbleKind, key: string, now: number): string | null {
    const gLast = this.lastGlobalAt.get(kind)
    if (gLast !== undefined && now - gLast < BUBBLE_DEDUPE_MS) return null
    const kTag = `${key}|${kind}`
    const kLast = this.lastKeyAt.get(kTag)
    if (kLast !== undefined && now - kLast < BUBBLE_KEY_COOLDOWN_MS) return null

    this.lastGlobalAt.set(kind, now)
    this.lastKeyAt.set(kTag, now)
    return BUBBLE_TEXT[kind]
  }
}
