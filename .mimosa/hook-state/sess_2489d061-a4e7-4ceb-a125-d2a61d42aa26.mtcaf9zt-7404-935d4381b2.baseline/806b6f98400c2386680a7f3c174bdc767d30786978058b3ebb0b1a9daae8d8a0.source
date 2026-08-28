/**
 * PettingArbiter —— 悬浮球左键手势仲裁（纯状态机，定时器注入可测）
 *
 * 四类手势统一裁决（替代分散的 onClick/onDoubleClick）：
 *   单击     = 松开后 clickMergeMs 内无后续点击 → 打开面板
 *   双击     = 第 2 击立即触发 → 跳转会话窗口（保持现语义，不加延迟）
 *   三连点   = tripleWindowMs 内第 3 击 → 戳晕（晕圈眼）
 *   长按摸头 = 按住且移动 ≤4px 达 petHoldMs → 摸头（petLoveMs 后升级爱心眼）
 *
 * 规则：
 *   - 移动超过 MOVE_CANCEL_PX 视为拖动：取消待定判定；摸头进行中则立即结束
 *   - 摸头结束吞掉本次单击（松手不开面板）
 *   - 每次快速点击都发 poke（即时压扁反馈），不影响后续判定
 */

export interface GestureEvent {
  type: 'click' | 'double' | 'triple' | 'poke' | 'petStart' | 'petLove' | 'petEnd'
}

export interface PettingOptions {
  /** 双击合并窗口 ms（浏览器原生节奏） */
  clickMergeMs?: number
  /** 三连点累计窗口 ms */
  tripleWindowMs?: number
  /** 长按摸头触发 ms */
  petHoldMs?: number
  /** 摸头升级爱心眼 ms（自 petStart 起） */
  petLoveMs?: number
}

/** 移动超过该距离（px）判定为拖动，与 Ball 现有拖动阈值一致 */
export const MOVE_CANCEL_PX = 4

type Timer = ReturnType<typeof setTimeout>

export class PettingArbiter {
  private readonly clickMergeMs: number
  private readonly tripleWindowMs: number
  private readonly petHoldMs: number
  private readonly petLoveMs: number

  private down = false
  private movedFar = false
  private startX = 0
  private startY = 0

  /** 最近快速点击时间戳（三连点计数用） */
  private taps: number[] = []
  /** 待发的单击定时器（下一击到来即撤销） */
  private clickTimer: Timer | null = null
  /** 长按检测定时器 */
  private petTimer: Timer | null = null
  /** 爱心眼升级定时器 */
  private loveTimer: Timer | null = null
  private petting = false

  constructor(
    private readonly emit: (e: GestureEvent) => void,
    opts: PettingOptions = {},
    private readonly schedule: ((fn: () => void, ms: number) => Timer) = (fn, ms) => setTimeout(fn, ms),
    private readonly cancel: ((t: Timer | null) => void) = (t) => {
      if (t) clearTimeout(t)
    }
  ) {
    this.clickMergeMs = opts.clickMergeMs ?? 260
    this.tripleWindowMs = opts.tripleWindowMs ?? 900
    this.petHoldMs = opts.petHoldMs ?? 450
    this.petLoveMs = opts.petLoveMs ?? 2500
  }

  /** 是否摸头进行中 */
  get isPetting(): boolean {
    return this.petting
  }

  /** 指针按下（仅左键由调用方过滤） */
  pointerDown(x: number, y: number, _now: number): void {
    if (this.down) return // 已按住（重复 down 忽略）
    this.down = true
    this.movedFar = false
    this.startX = x
    this.startY = y
    this.cancel(this.clickTimer)
    this.clickTimer = null
    this.petTimer = this.schedule(() => {
      this.petTimer = null
      if (this.down && !this.movedFar && !this.petting) {
        this.petting = true
        this.emit({ type: 'petStart' })
        this.loveTimer = this.schedule(() => this.emit({ type: 'petLove' }), this.petLoveMs)
      }
    }, this.petHoldMs)
  }

  /** 指针移动（窗口级监听，未按下时调用无害） */
  pointerMove(x: number, y: number, _now: number): void {
    if (!this.down) return
    if (!this.movedFar) {
      const dx = x - this.startX
      const dy = y - this.startY
      if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) {
        this.movedFar = true
        if (this.petting) {
          this.endPetting() // 摸着摸着拖走了：立刻结束
        } else {
          this.cancel(this.petTimer)
          this.petTimer = null
        }
      }
    }
  }

  /** 指针松起 */
  pointerUp(now: number): void {
    if (!this.down) return
    this.down = false

    if (this.petting) {
      this.endPetting()
      return // 摸头结束吞掉单击
    }
    this.cancel(this.petTimer)
    this.petTimer = null

    if (this.movedFar) return // 拖动不算点击

    // 快速点击登记
    this.taps = this.taps.filter((t) => now - t <= this.tripleWindowMs)
    const n = this.taps.length + 1
    this.taps.push(now)

    this.emit({ type: 'poke' }) // 每击即时反馈
    if (n === 2) {
      this.emit({ type: 'double' }) // 双击立即跳转（保持现语义）
    } else if (n >= 3) {
      this.emit({ type: 'triple' })
      this.taps = []
    }

    // 单击延迟到合并窗口结束：期间来下一击则作废
    const tapAt = now
    this.cancel(this.clickTimer)
    this.clickTimer = this.schedule(() => {
      this.clickTimer = null
      // 仅当没有更新的击键（更新击会重设 clickTimer 并清空本定时器）
      if (this.taps.length > 0 && this.taps[this.taps.length - 1] === tapAt && n === 1) {
        this.emit({ type: 'click' })
      }
    }, this.clickMergeMs)
  }

  /** 释放全部定时器（组件卸载） */
  dispose(): void {
    this.cancel(this.clickTimer)
    this.cancel(this.petTimer)
    this.cancel(this.loveTimer)
    this.clickTimer = this.petTimer = this.loveTimer = null
  }

  private endPetting(): void {
    this.petting = false
    this.cancel(this.loveTimer)
    this.loveTimer = null
    this.emit({ type: 'petEnd' })
  }
}
