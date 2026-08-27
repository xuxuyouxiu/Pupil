/**
 * 主进程入口 —— 仅装配，禁止业务逻辑（架构文档第 6 节）
 */
import { app, ipcMain, BrowserWindow, Menu } from 'electron'
import { ConfigStore } from './config'
import { MonitoringCore } from './monitoring-core'
import { WindowManager } from './window-manager'
import { GazeTracker } from './gaze-tracker'
import { BubbleTracker, eventToBubbleKind } from './bubble-tracker'
import { TrayManager } from './tray'
import { Notifier } from './notifier'
import { AutoLaunch } from './auto-launch'
import { ensureCliShim, ensureCliOnPath } from './paths'
import { FileHistoryStore } from './history-store'
import { activateSessionWindow } from '../integrations/win32-window'
import { Updater } from './updater'
import { IPC } from '../shared/ipc-channels'
import { sessionKey } from '../shared/events'

// 轻量常驻工具：关闭硬件加速（软件渲染足够，避免 VM/沙箱/RDP 下 GPU 进程崩溃）
app.disableHardwareAcceleration()
// 受限环境（CI/沙箱/无特权进程）下 Chromium 进程沙箱初始化失败会导致 GPU 进程连环崩溃
app.commandLine.appendSwitch('no-sandbox')

// 单实例锁（防多开）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  const config = new ConfigStore()
  const core = new MonitoringCore(config, app.getVersion())
  const updater = new Updater()
  const windows = new WindowManager(config)
  const notifier = new Notifier(() => windows.ballWindow, config)
  const tray = new TrayManager(core, windows)
  const autoLaunch = new AutoLaunch(config)
  // 眼神跟随：全局光标方向 → 球窗（GrokBot 式「它活着」）
  const gaze = new GazeTracker(() => windows.ballWindow)
  // v0.5.0 状态播报去重器
  const bubbles = new BubbleTracker()
  // 快照广播：订阅者（球窗/面板窗）
  core.subscribe((views) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.sessionsSnapshot, views)
      }
    }
  })

  // v0.5.0 状态播报：挂在通知执行器上——
  // 事件语义即边沿（turn_completed/waiting_input/error 天生一次性），零复读；
  // 勿扰/静音时 MonitoringCore.onEvent 直接跳过执行器，气泡天然静默。
  core.setNotifyExecutor((strategy, event, view) => {
    notifier.execute(strategy, event, view)
    const kind = eventToBubbleKind(event.eventType)
    if (!kind || !view) return
    const text = bubbles.update(kind, sessionKey(view.agentType, view.sessionId), Date.now())
    if (text) {
      const ball = windows.ballWindow
      if (ball && !ball.isDestroyed()) ball.webContents.send(IPC.speechBubble, text)
    }
  })

  // P2-8 事件历史持久化：启动恢复 + 60s 节流落盘（有新事件才写）
  core.registry.setHistoryStore(new FileHistoryStore())
  const historySaver = setInterval(() => core.registry.saveHistory(), 60_000)
  // Toast 点击：精准跳转对应会话窗口（P2；失败由 activateSessionWindow 内部降级）
  notifier.setClickHandler((view) => {
    void activateSessionWindow(view)
  })

  // 开机自启：启动时按持久化偏好同步一次（用户在系统侧手动改掉则以此处为准恢复）
  if (config.get('autoLaunch') && app.isPackaged) {
    autoLaunch.set(true)
  }

  // ---- IPC handlers ----
  ipcMain.handle(IPC.sessionsGet, () => core.snapshot())
  ipcMain.handle(IPC.dndGet, () => core.isDnd)
  ipcMain.handle(IPC.dndToggle, () => {
    const next = core.toggleDnd()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.dndChanged, next)
    }
    tray.refresh()
    return next
  })
  ipcMain.handle(IPC.windowActivate, async (_e, key: string) => {
    const view = core.registry.get(key)
    if (!view) return { ok: false, reason: 'no-session' }
    const ok = await activateSessionWindow(view)
    return { ok, reason: ok ? undefined : 'window-not-found' }
  })
  ipcMain.handle(IPC.panelToggle, () => windows.togglePanel())
  ipcMain.on(IPC.ballContext, () => {
    const menu = Menu.buildFromTemplate([
      {
        label: core.isDnd ? '关闭勿扰模式' : '开启勿扰模式',
        click: () => {
          core.toggleDnd()
          tray.refresh()
        }
      },
      { label: '设置', click: () => windows.openPanel() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
    menu.popup({ window: windows.ballWindow ?? undefined })
  })
  ipcMain.on(IPC.ballDragStart, () => windows.startDrag())
  ipcMain.on(IPC.ballDragMove, (_e, dx: number, dy: number) => windows.moveDrag(dx, dy))
  ipcMain.on(IPC.ballDragEnd, () => windows.endDrag())
  ipcMain.handle(IPC.settingsOpen, () => {
    windows.openPanel() // MVP：设置并入面板（独立设置窗口 P1）
  })
  ipcMain.handle(IPC.settingsGet, () => core.getSettingsSnapshot())
  ipcMain.handle(
    IPC.settingsSet,
    (
      _e,
      patch: {
        dnd?: boolean
        muted?: boolean
        autoLaunch?: boolean
        soundPack?: string
        soundVolume?: number
      }
    ) => {
      if (patch.dnd !== undefined) core.setDnd(patch.dnd)
      if (patch.muted !== undefined) core.setMuted(patch.muted)
      if (patch.autoLaunch !== undefined) autoLaunch.set(patch.autoLaunch)
      if (patch.soundPack !== undefined) config.set('soundPack', patch.soundPack)
      if (patch.soundVolume !== undefined) {
        const v = Math.min(1, Math.max(0, Number(patch.soundVolume)))
        if (Number.isFinite(v)) config.set('soundVolume', v)
      }
      return core.getSettingsSnapshot()
    }
  )
  ipcMain.handle(IPC.adapterSetEnabled, (_e, id: string, enabled: boolean) =>
    core.setAdapterEnabled(id, enabled)
  )
  ipcMain.handle(IPC.updateCheck, () => updater.check(true))
  ipcMain.handle(IPC.updateDownload, () => updater.downloadAndOpen())
  ipcMain.handle(IPC.updateOpenPage, () => {
    updater.openReleasePage()
    return true
  })
  ipcMain.handle(IPC.hooksInstall, () => core.installHooks())
  ipcMain.handle(IPC.hooksUninstall, () => core.uninstallHooks())
  // 独立设置窗口（P1-2）：面板内「查看接入指引」/ 设置按钮的升级入口
  ipcMain.handle(IPC.settingsWindowOpen, () => {
    windows.openSettingsWindow()
    // 面板让位：避免两窗叠加遮挡（设置信息密度更高）
    windows.closePanel()
  })
  ipcMain.handle(IPC.historyGet, (_e, limit?: number) =>
    core.history(typeof limit === 'number' ? limit : undefined)
  )
  // 面板视图模式同步（设置视图失焦不自动收起）
  ipcMain.on(IPC.panelMode, (_e, mode: 'main' | 'settings') => {
    windows.setPanelMode(mode)
  })
  ipcMain.on(IPC.appQuit, () => app.quit())

  app.whenReady().then(() => {
    windows.createBallWindow()
    gaze.start()
    tray.create()
    core.start()
    // 启动 15s 后自动检查一次更新（dev/非打包由 Updater 内部跳过）
    setTimeout(() => void updater.check(false), 15_000)
    // 打包版：写 %LOCALAPPDATA%/Pupil/bin/pupil.cmd（pupil send 命令，无需系统 Node）
    const binDir = ensureCliShim()
    if (binDir) {
      console.log(`[cli] pupil.cmd ready at ${binDir}`)
      // P1-4：bin 目录注册进用户 PATH（幂等），任意终端直接敲 `pupil`
      void ensureCliOnPath(binDir)
    }
  })

  // 单实例：再次启动时聚焦球窗
  app.on('second-instance', () => {
    windows.ballWindow?.show()
  })

  // 托盘应用：关闭所有窗口不退出（托盘菜单退出）
  app.on('window-all-closed', () => {
    // 保持运行
  })

  app.on('before-quit', () => {
    gaze.stop()
    clearInterval(historySaver)
    core.registry.saveHistory() // 退出前最后一次落盘（P2-8）
    core.stop()
    windows.destroyAll()
    tray.destroy()
  })
}
