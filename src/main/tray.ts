/**
 * 系统托盘 —— 显示/隐藏悬浮球、勿扰、设置、退出
 * v0.10.0：托盘图标跟随最高优先级状态着色，悬停显示「N 运行 · N 等待 …」摘要
 */
import { Menu, Tray, nativeImage, app } from 'electron'
import { MonitoringCore } from './monitoring-core'
import { WindowManager } from './window-manager'
import { resourcePath } from './paths'
import { DisplayState, DISPLAY_PRIORITY, toDisplayState } from '../shared/events'

/** 与 theme.css 状态色保持一致 */
const STATE_COLORS: Record<DisplayState, string> = {
  running: '#3b82f6',
  waiting: '#d29922',
  done: '#3fb950',
  error: '#f85149',
  timeout: '#db6d28',
  offline: '#8b949e',
  initializing: '#8b949e',
  idle: '#8b949e'
}

const STATE_LABELS: Record<DisplayState, string> = {
  running: '运行',
  waiting: '待输入',
  done: '完成',
  error: '错误',
  timeout: '超时',
  offline: '断连',
  initializing: '加载',
  idle: '空闲'
}

/** 勿扰时托盘一律灰色（不泄露状态细节，符合"勿扰"语义） */
const DND_COLOR = '#8b949e'

/** 生成 16×16 实心圆托盘图标（BGRA 原点位图） */
function stateIcon(hex: string): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inside = (x - c) ** 2 + (y - c) ** 2 <= (size / 2 - 1.2) ** 2
      if (inside) {
        buf[i] = b
        buf[i + 1] = g
        buf[i + 2] = r
        buf[i + 3] = 0xff
      }
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size })
  return img.isEmpty() ? nativeImage.createEmpty() : img
}

export class TrayManager {
  private tray: Tray | null = null
  private unsubscribe: (() => void) | null = null
  /** 上次渲染的状态签名：无变化不重绘（订阅回调可能高频触发） */
  private lastSignature = ''

  constructor(
    private core: MonitoringCore,
    private windows: WindowManager
  ) {}

  create(): void {
    const icon = nativeImage.createFromPath(resourcePath('icon.ico'))
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    this.tray.setToolTip('Pupil — Agent 状态监控')
    this.tray.setContextMenu(this.buildMenu())

    // 左键单击 = 打开/聚焦面板（Windows 上 tray click 事件）
    this.tray.on('click', () => {
      this.windows.openPanel()
    })

    // v0.10.0 状态化：订阅快照，着色 + 摘要（内部有签名去重）
    this.unsubscribe = this.core.subscribe(() => this.refreshState())
    this.refreshState()
  }

  /** 按最高优先级状态着色 + 悬停摘要 */
  refreshState(): void {
    if (!this.tray) return
    const views = this.core.snapshot()
    const counts = new Map<DisplayState, number>()
    let top: DisplayState = 'idle'
    for (const v of views) {
      const d = toDisplayState(v)
      if (d === 'initializing') continue
      counts.set(d, (counts.get(d) ?? 0) + 1)
      if (d !== 'idle' && DISPLAY_PRIORITY[d] > DISPLAY_PRIORITY[top]) top = d
    }

    const parts: string[] = []
    for (const d of ['running', 'waiting', 'done', 'error', 'timeout', 'offline'] as DisplayState[]) {
      const n = counts.get(d) ?? 0
      if (n > 0) parts.push(`${n} ${STATE_LABELS[d]}`)
    }

    const dnd = this.core.isDnd
    const tooltip = dnd
      ? `Pupil — 勿扰中 · ${parts.length ? parts.join(' · ') : '无活跃会话'}`
      : `Pupil — ${parts.length ? parts.join(' · ') : '无活跃会话'}`

    const signature = `${dnd ? 'dnd:' : ''}${top}:${tooltip}`
    if (signature === this.lastSignature) return
    this.lastSignature = signature

    const color = dnd ? DND_COLOR : STATE_COLORS[top]
    this.tray.setImage(stateIcon(color))
    this.tray.setToolTip(tooltip)
  }

  refresh(): void {
    this.tray?.setContextMenu(this.buildMenu())
  }

  private buildMenu(): Menu {
    const ball = this.windows.ballWindow
    return Menu.buildFromTemplate([
      {
        label: '显示悬浮球',
        type: 'checkbox',
        checked: !!ball && !ball.isDestroyed() && ball.isVisible(),
        click: (item) => {
          if (ball && !ball.isDestroyed()) {
            if (item.checked) ball.show()
            else ball.hide()
          }
        }
      },
      {
        label: this.core.isDnd ? '关闭勿扰模式' : '开启勿扰模式',
        // onDndChanged 回调统一负责窗口同步与托盘刷新
        click: () => this.core.toggleDnd()
      },
      { type: 'separator' },
      {
        label: '设置',
        click: () => this.windows.openPanel()
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => app.quit()
      }
    ])
  }

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.tray?.destroy()
    this.tray = null
  }
}
