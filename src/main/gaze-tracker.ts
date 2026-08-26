/**
 * GazeTracker —— 全局光标轮询，驱动悬浮球「眼神跟随」（GrokBot 标志动作）
 *
 * 实现参考 bloub（github.com/jeremy-prt/bloub，MIT）对 x.ai 吉祥物的测量结论：
 * 眼睛长在球面上，注视方向 = 光标相对球心的单位向量；平滑交给渲染端 CSS 过渡。
 * 30Hz 轮询 + 死区（贴住球体时回中，避免拖动/点击时斜眼瞪手）+ 变化阈值节流，
 * 只有球窗订阅此通道，面板/设置窗不受影响。
 */
import { BrowserWindow, screen } from 'electron'
import { IPC } from '../shared/ipc-channels'

/** 光标距球心小于该距离时视为「贴着球」，眼神回中 */
const DEAD_ZONE_PX = 70
/** 单位向量变化小于该阈值不重发（渲染端有 130ms 过渡，无需满速率） */
const EMIT_THRESHOLD = 0.02
/** 光标静止超过该时长 → 判定「没在动」：球失去兴趣回中自顾自张望（用户需求：别一直盯着鼠标） */
const POINTER_IDLE_MS = 3500

export class GazeTracker {
  private timer: NodeJS.Timeout | null = null
  private lastGx = Number.NaN
  private lastGy = Number.NaN
  private lastX = Number.NaN
  private lastY = Number.NaN
  private lastMoveAt = 0

  constructor(private readonly getBallWindow: () => BrowserWindow | null) {}

  start(): void {
    if (this.timer) return
    // NaN 初值保证第一次 tick 必发（renderer 拿到初始朝向）
    this.lastGx = Number.NaN
    this.lastGy = Number.NaN
    this.lastMoveAt = 0 // 0 = 启动时视为静止：先自顾自张望，鼠标动了才跟
    this.timer = setInterval(() => this.tick(), 33)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    const win = this.getBallWindow()
    if (!win || win.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    const now = Date.now()
    if (p.x !== this.lastX || p.y !== this.lastY) {
      this.lastX = p.x
      this.lastY = p.y
      this.lastMoveAt = now
    }

    let gx = 0
    let gy = 0
    // 光标静止超阈值 → 视为「没在动」：发 0,0（renderer 自动切到自主张望）
    if (now - this.lastMoveAt < POINTER_IDLE_MS) {
      const b = win.getBounds()
      const dx = p.x - (b.x + b.width / 2)
      const dy = p.y - (b.y + b.height / 2)
      const dist = Math.hypot(dx, dy)
      if (dist > DEAD_ZONE_PX) {
        gx = dx / dist
        gy = dy / dist
      }
    }
    if (
      !Number.isNaN(this.lastGx) &&
      Math.abs(gx - this.lastGx) < EMIT_THRESHOLD &&
      Math.abs(gy - this.lastGy) < EMIT_THRESHOLD
    ) {
      return
    }
    this.lastGx = gx
    this.lastGy = gy
    try {
      win.webContents.send(IPC.gazeUpdate, { gx, gy })
    } catch {
      /* 窗口正在销毁时的竞态：下一 tick 自然恢复 */
    }
  }
}
