/**
 * Notifier —— 通知策略执行器（主进程侧）
 * - 音效：通过 IPC 通知球窗 renderer 用 Web Audio 合成播放（HTML5 Audio 通道）
 * - 系统通知：Electron Notification（Windows Toast），silent: true 避免系统提示音与自定义音效叠加
 */
import { Notification, BrowserWindow } from 'electron'
import { resolveStrategy } from '../core/notify-rules'
import { AgentEvent, SessionView } from '../shared/events'
import { IPC } from '../shared/ipc-channels'

/** 按展示态选择合成音效类型（renderer 端 Web Audio 合成） */
const SOUND_BY_STATE: Record<string, string> = {
  done: 'done',
  waiting: 'waiting',
  error: 'error',
  timeout: 'timeout',
  offline: 'offline'
}

export class Notifier {
  constructor(private getBall: () => BrowserWindow | null) {}

  /** MonitoringCore 注入的 NotifyExecutor */
  readonly execute = (
    strategy: ReturnType<typeof resolveStrategy>,
    _event: AgentEvent,
    _view?: SessionView
  ): void => {
    // 音效：驱动球窗 renderer 播放
    if (strategy.sound) {
      const ball = this.getBall()
      if (ball && !ball.isDestroyed()) {
        ball.webContents.send(IPC.soundPlay, {
          type: SOUND_BY_STATE[strategy.displayState] ?? 'done'
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
        // 点击通知跳转对应会话窗口（MVP：聚焦球/面板；窗口匹配 Phase 2）
        this.getBall()?.show()
      })
      n.show()
    }
  }

  private iconPath(): string | undefined {
    return undefined // 默认应用图标即可
  }
}
