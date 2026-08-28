/**
 * 系统托盘 —— 显示/隐藏悬浮球、勿扰、设置、退出
 * v1.0.4：图标恢复原始静态（状态色已上悬浮球本体，托盘通常隐藏 coloring 无意义），
 * 悬停摘要保留
 */
import { Menu, Tray, nativeImage, app } from 'electron'
import { MonitoringCore } from './monitoring-core'
import { WindowManager } from './window-manager'
import { resourcePath } from './paths'
import { DisplayState, toDisplayState } from '../shared/events'
import { t } from '../shared/i18n'

const STATE_LABEL_KEYS: Partial<Record<DisplayState, 'stateRunning' | 'stateWaiting' | 'stateDone' | 'stateError' | 'stateTimeout' | 'stateOffline'>> = {
  running: 'stateRunning',
  waiting: 'stateWaiting',
  done: 'stateDone',
  error: 'stateError',
  timeout: 'stateTimeout',
  offline: 'stateOffline'
}

export class TrayManager {
  private tray: Tray | null = null
  private unsubscribe: (() => void) | null = null
  /** 上次渲染的悬停摘要签名：无变化不重设 */
  private lastTooltip = ''

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

    // 悬停摘要：订阅快照（内部有签名去重）
    this.unsubscribe = this.core.subscribe(() => this.refreshTooltip())
  }

  /** 悬停摘要：「2 运行 · 1 等待 · 1 完成」，勿扰时前缀 🌙 */
  private refreshTooltip(): void {
    if (!this.tray) return
    const views = this.core.snapshot()
    const counts = new Map<DisplayState, number>()
    for (const v of views) {
      const d = toDisplayState(v)
      if (d === 'initializing') continue
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }

    const parts: string[] = []
    for (const d of ['running', 'waiting', 'done', 'error', 'timeout', 'offline'] as DisplayState[]) {
      const n = counts.get(d) ?? 0
      if (n > 0) parts.push(`${n} ${t(STATE_LABEL_KEYS[d] ?? 'stateIdle')}`)
    }

    const dnd = this.core.isDnd
    const tooltip = `Pupil — ${dnd ? `🌙 ${t('dnd')} · ` : ''}${parts.length ? parts.join(' · ') : t('noActiveSessions')}`
    if (tooltip === this.lastTooltip) return
    this.lastTooltip = tooltip
    this.tray.setToolTip(tooltip)
  }

  refresh(): void {
    this.tray?.setContextMenu(this.buildMenu())
  }

  private buildMenu(): Menu {
    const ball = this.windows.ballWindow
    return Menu.buildFromTemplate([
      {
        label: t('trayShowBall'),
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
        label: t('dnd'),
        // onDndChanged 回调统一负责窗口同步与托盘刷新
        click: () => this.core.toggleDnd()
      },
      { type: 'separator' },
      {
        label: t('settings'),
        click: () => this.windows.openPanel()
      },
      { type: 'separator' },
      {
        label: t('exit'),
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
