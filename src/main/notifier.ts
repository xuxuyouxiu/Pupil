/**
 * Notifier —— 通知策略执行器（主进程侧）
 * - 音效：通过 IPC 通知球窗 renderer 用 Web Audio 合成播放（HTML5 Audio 通道），
 *   每条指令携带当前音色包/音量（config 实时读取，改设置即刻生效）
 * - 系统通知：Electron Notification（Windows Toast），silent: true 避免系统提示音与自定义音效叠加
 * - 点击 Toast：优先跳转对应会话窗口，找不到则回退聚焦悬浮球
 */
import { Notification, BrowserWindow } from 'electron'
import { resolveStrategy } from '../core/notify-rules'
import { AgentEvent, SessionView } from '../shared/events'
import { IPC } from '../shared/ipc-channels'
import { ConfigStore } from './config'

/** Toast 点击行为回调（由 main 注入：激活会话对应终端窗口） */
export type ToastClickHandler = (view: SessionView) => void

export class Notifier {
  private onClick: ToastClickHandler | null = null

  constructor(
    private getBall: () => BrowserWindow | null,
    private config?: ConfigStore
  ) {}

  /** 注入 Toast 点击处理（依赖 WindowManager 与 win32 激活链路） */
  setClickHandler(fn: ToastClickHandler): void {
    this.onClick = fn
  }

  /** MonitoringCore 注入的 NotifyExecutor */
  readonly execute = (
    strategy: ReturnType<typeof resolveStrategy>,
    _event: AgentEvent,
    view?: SessionView
  ): void => {
    // 音效：驱动球窗 renderer 播放（指令携带最新音色包/音量）
    // v0.4.1：soundType 与展示态解耦（session_ended → 专属「收工」音），由规则引擎显式给出
    if (strategy.sound) {
      const ball = this.getBall()
      if (ball && !ball.isDestroyed()) {
        ball.webContents.send(IPC.soundPlay, {
          type: strategy.soundType ?? 'done',
          pack: this.config?.get('soundPack') ?? 'chime',
          volume: this.config?.get('soundVolume') ?? 0.8
        })
      }
    }

    // 系统通知（Toast）
    if (strategy.toast && strategy.title) {
      const n = new Notification({
        title: strategy.title,
        body: strategy.body ?? '',
        silent: true, // 关闭系统提示音，避免双重声音
        icon: this.iconPath()
      })
      n.on('click', () => {
        if (view && this.onClick) {
          this.onClick(view)
        } else {
          this.getBall()?.show() // 回退：至少把球带到眼前
        }
      })
      n.show()
    }
  }

  private iconPath(): string | undefined {
    return undefined // 默认应用图标即可
  }
}
