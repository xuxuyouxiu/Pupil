/**
 * 主进程入口 —— 仅装配，禁止业务逻辑（架构文档第 6 节）
 */
import { app, ipcMain, BrowserWindow, Menu, dialog } from 'electron'
import * as fs from 'fs'
import { basename } from 'path'
import { pathToFileURL } from 'node:url'
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
import { sessionKey, SoundKind } from '../shared/events'

// 轻量常驻工具：受限环境（CI/沙箱/无特权进程）下 GPU 进程易崩、Chromium 沙箱初始化失败——
// 仅在这些环境关闭硬件加速与沙箱；普通桌面保留硬件加速（悬浮球更快出现、渲染更流畅）
const restrictedEnv =
  process.env.PUPIL_SOFTWARE_RENDER === '1' ||
  process.env.DSH_SANDBOX === '1' ||
  process.env.CI === 'true' ||
  process.env.WORKBUDDY !== undefined ||
  process.env.ELECTRON_RUN_AS_NODE !== undefined
if (restrictedEnv) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('no-sandbox')
}

// 单实例锁（防多开）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // 常驻托盘应用的最后防线：单个异常请求/异步错误不应把悬浮球整个带崩。
  // 只记录不上抛（进程退出会让所有会话监控静默失效，比"继续跑但缺一次事件"更糟）。
  process.on('uncaughtException', (err) => {
    console.error('[pupil] uncaught exception (kept alive):', err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[pupil] unhandled rejection (kept alive):', reason)
  })
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

  // 勿扰统一出口（四条改动路径共用）：窗口指示同步 + 托盘菜单刷新
  core.onDndChanged = (value) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.dndChanged, value)
    }
    tray.refresh()
  }

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
  ipcMain.handle(IPC.dndToggle, () => core.toggleDnd())
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
        click: () => core.toggleDnd()
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
  ipcMain.handle(IPC.updateStatus, () => updater.current)
  ipcMain.handle(IPC.updateDownload, () => updater.startDownload())
  ipcMain.handle(IPC.updateOpenPage, () => {
    updater.openReleasePage()
    return true
  })
  ipcMain.handle(IPC.hooksInstall, () => core.installHooks())
  ipcMain.handle(IPC.hooksUninstall, () => core.uninstallHooks())
  /** SoundKind 白名单：kind 同时用作 customSounds 配置键，拒绝任意键注入 config.json */
  const isSoundKind = (k: string): k is SoundKind =>
    ['done', 'ended', 'waiting', 'error', 'timeout', 'offline'].includes(k)

  ipcMain.handle(IPC.customSoundPick, async (_e, kind: string) => {
    if (!isSoundKind(kind)) return core.getSettingsSnapshot()
    // 对话框以面板为父窗口 + 挂起失焦收起：原生对话框夺焦会让面板在 300ms 后销毁，
    // 结果返回时窗口已不存在（用户表现「点了选择没反应」）
    windows.suspendPanelAutoHide()
    try {
      const options = {
        title: '选择自定义音效',
        properties: ['openFile' as const],
        filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma'] }]
      }
      const parent = windows.panelWindow
      const res = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (!res.canceled && res.filePaths[0]) {
        const custom = { ...(config.get('customSounds') ?? {}) }
        custom[kind] = res.filePaths[0]
        config.set('customSounds', custom)
      }
    } finally {
      windows.resumePanelAutoHide()
    }
    return core.getSettingsSnapshot()
  })
  ipcMain.handle(IPC.customSoundClear, (_e, kind: string) => {
    if (!isSoundKind(kind)) return core.getSettingsSnapshot()
    const custom = { ...(config.get('customSounds') ?? {}) }
    delete custom[kind]
    config.set('customSounds', custom)
    return core.getSettingsSnapshot()
  })
  ipcMain.handle(IPC.customSoundPreview, (_e, kind: string) => {
    const file = config.get('customSounds')?.[kind]
    if (!file || !fs.existsSync(file)) return false
    try {
      windows.ballWindow?.webContents.send(IPC.soundPlay, {
        type: kind,
        pack: config.get('soundPack') ?? 'chime',
        volume: config.get('soundVolume') ?? 0.8,
        custom: { name: basename(file), url: pathToFileURL(file).toString() }
      })
      return true
    } catch {
      return false
    }
  })
  // 独立设置窗口（P1-2）：面板内「查看接入指引」/ 设置按钮的升级入口
  ipcMain.handle(IPC.settingsWindowOpen, () => {
    windows.openSettingsWindow()
    // 面板让位：避免两窗叠加遮挡（设置信息密度更高）
    windows.closePanel()
  })
  ipcMain.handle(IPC.historyGet, (_e, limit?: number) =>
    core.history(typeof limit === 'number' ? limit : undefined)
  )
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

  // 一键热更：完全退出前若存在已校验的待装包，拉起 NSIS /S 静默安装（装完自启）
  app.on('will-quit', () => {
    updater.consumePendingInstaller()
  })
}
