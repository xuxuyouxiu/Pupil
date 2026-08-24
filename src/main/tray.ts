/**
 * 系统托盘 —— 显示/隐藏悬浮球、勿扰、设置、退出
 */
import { Menu, Tray, nativeImage, app } from 'electron'
import { MonitoringCore } from './monitoring-core'
import { WindowManager } from './window-manager'
import { resourcePath } from './paths'

export class TrayManager {
  private tray: Tray | null = null

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
        click: () => {
          this.core.toggleDnd()
          this.refresh()
        }
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
    this.tray?.destroy()
    this.tray = null
  }
}
