/**
 * 主进程入口 —— 仅装配，禁止业务逻辑（架构文档第 6 节）
 */
import { app, ipcMain, BrowserWindow, Menu, dialog, globalShortcut, clipboard } from 'electron'
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
import { FileRecapStore } from './recap-file-store'
import { activateSessionWindow } from '../integrations/win32-window'
import { Updater } from './updater'
import { IPC } from '../shared/ipc-channels'
import { sessionKey, SoundKind, NotifyFilter } from '../shared/events'
import { setLocale, t } from '../shared/i18n'

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
  // v1.1.0 语言：真正的解析移到 whenReady 之后（app.getLocale 在 ready 前
  // 恒返回 en-US——此前「托盘永远英文、面板中文」对不上的根因）。
  // 用户也可在设置里手动覆盖（config.locale）。
  const config = new ConfigStore()
  const core = new MonitoringCore(config, app.getVersion(), new FileRecapStore())
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
  // v1.2.0 回顾落盘：5s 防抖（引擎内脏标记，幂等）
  const recapSaver = setInterval(() => core.recap.flush(), 5_000)
  // Toast 点击：精准跳转对应会话窗口（P2；失败由 activateSessionWindow 内部降级）
  notifier.setClickHandler((view) => {
    void activateSessionWindow(view)
  })

  // 开机自启：启动时按持久化偏好同步一次（用户在系统侧手动改掉则以此处为准恢复）
  if (config.get('autoLaunch') && app.isPackaged) {
    autoLaunch.set(true)
  }

  // v1.1.0 语言切换出口：持久化 → 主进程文案即时切换 → 广播 → 统一刷新窗口
  const applyLocaleChange = (raw: unknown): void => {
    if (raw !== 'system' && raw !== 'zh' && raw !== 'en') return
    config.set('locale', raw)
    const effective =
      raw === 'system'
        ? app.getLocale().startsWith('zh')
          ? 'zh'
          : 'en'
        : raw
    setLocale(effective)
    tray.refresh()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.localeChanged, effective)
    }
    // 静态文案重载窗口生效（球/面板/设置窗口）
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.reload()
    }
  }
  const resolveEffectiveLocale = (): 'zh' | 'en' => {
    const saved = config.get('locale')
    return saved === 'zh' || saved === 'en'
      ? saved
      : app.getLocale().startsWith('zh')
        ? 'zh'
        : 'en'
  }

  // ---- IPC handlers ----
  ipcMain.handle(IPC.sessionsGet, () => core.snapshot())
  ipcMain.handle(IPC.dndGet, () => core.isDnd)
  ipcMain.handle(IPC.dndFor, (_e, ms: number) =>
    typeof ms === 'number' && Number.isFinite(ms) ? core.setDndFor(ms) : core.dndRemainingMs
  )
  ipcMain.handle(IPC.dndRemaining, () => core.dndRemainingMs)
  ipcMain.handle(IPC.sessionMuteToggle, (_e, key: string) =>
    typeof key === 'string' && key ? core.toggleSessionMuted(key) : false
  )
  ipcMain.handle(IPC.sessionMuteGet, (_e, key: string) =>
    typeof key === 'string' ? core.isSessionMuted(key) : false
  )
  ipcMain.handle(IPC.sessionMuteList, () => core.mutedSessionKeys)
  ipcMain.handle(IPC.dndToggle, () => core.toggleDnd())
  ipcMain.handle(IPC.windowActivate, async (_e, key: string) => {
    const view = core.registry.get(key)
    if (!view) return { ok: false, reason: 'no-session' }
    const ok = await activateSessionWindow(view)
    return { ok, reason: ok ? undefined : 'window-not-found' }
  })
  ipcMain.handle(IPC.panelToggle, () => windows.togglePanel())
  // v0.8.0 面板高度自适应：renderer 用 ResizeObserver 上报内容高度，主进程夹紧后调整窗口
  ipcMain.on(IPC.panelResize, (_e, h: number) => {
    if (typeof h === 'number' && Number.isFinite(h)) windows.resizePanelTo(h)
  })
  ipcMain.handle(IPC.clipboardWrite, (_e, text: string) => {
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) return false
    clipboard.writeText(text)
    return true
  })
  ipcMain.on(IPC.ballContext, () => {
    const remaining = core.dndRemainingMs
    // v1.0.4 恢复明确的勿扰开/关项（此前只有时长项，用户找不到开关）
    const menu = Menu.buildFromTemplate([
      ...(core.isDnd
        ? [
            {
              label:
                remaining !== null
                  ? `${t('turnOff')}${t('dnd')}（剩 ${Math.ceil(remaining / 60000)} 分钟）`
                  : `${t('turnOff')}${t('dnd')}`,
              click: () => core.setDnd(false)
            }
          ]
        : [
            { label: `${t('turnOn')}${t('dnd')}`, click: () => core.setDnd(true) },
            { label: `${t('dnd')} 30 min`, click: () => core.setDndFor(30 * 60_000) },
            { label: `${t('dnd')} 60 min`, click: () => core.setDndFor(60 * 60_000) },
            {
              label: `${t('dnd')} 9:00`,
              click: () => {
                const now = new Date()
                const target = new Date(now)
                target.setDate(now.getDate() + 1)
                target.setHours(9, 0, 0, 0)
                core.setDndFor(target.getTime() - now.getTime())
              }
            }
          ]),
      { label: t('settings'), click: () => windows.openPanel() },
      { type: 'separator' as const },
      // v1.5.0 看电视模式：球与面板全藏，监控与通知照常（托盘勾选/快捷键可召回）
      { label: t('hideToBackground'), click: () => windows.hideToBackground() },
      { type: 'separator' as const },
      { label: t('exit'), click: () => app.quit() }
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
        notifyEvents?: NotifyFilter
        locale?: string
      }
    ) => {
      if (patch.dnd !== undefined) core.setDnd(patch.dnd)
      if (patch.locale !== undefined) applyLocaleChange(patch.locale)
      if (patch.notifyEvents !== undefined && typeof patch.notifyEvents === 'object') {
        core.setNotifyEvents(patch.notifyEvents)
      }
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
      // v0.7.0 补丁：对话框关闭后 Windows 会向面板补发一次迟到的 blur，
      // 立即解除守卫会触发 300ms 自动收起（用户表现「选完文件面板自己关了」）。
      // 先把焦点显式还给面板，守卫延长到缓冲期结束才解除。
      const panel = windows.panelWindow
      if (panel && !panel.isDestroyed()) panel.focus()
      setTimeout(() => windows.resumePanelAutoHide(), 700)
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
  // v1.2.0 回顾查询（date 缺省今天；越界由引擎钳制）
  ipcMain.handle(IPC.recapGet, (_e, date?: string) => core.recapView(date))
  ipcMain.on(IPC.appQuit, () => app.quit())

  app.whenReady().then(() => {
    // v1.1.0：ready 后解析一次生效语言（app.getLocale 此时才可靠）
    setLocale(resolveEffectiveLocale())
    ipcMain.handle(IPC.localeGet, () => resolveEffectiveLocale())
    windows.createBallWindow()
    gaze.start()
    tray.create()
    core.start()
    // v0.8.0 全局快捷键呼出/收起面板：优先 Ctrl+Alt+Space，被占用则退而求其次
    const togglePanelShortcut = (): void => {
      windows.togglePanel()
    }
    let bound: string | null = null
    for (const accelerator of ['Control+Alt+Space', 'Control+Alt+P']) {
      try {
        if (globalShortcut.register(accelerator, togglePanelShortcut)) {
          bound = accelerator
          break
        }
      } catch {
        /* 继续尝试下一个 */
      }
    }
    if (bound) console.log(`[shortcut] 面板开关快捷键: ${bound}`)
    else console.warn('[shortcut] 全局快捷键注册失败（被其他程序占用）')
    // v1.5.0 后台模式切换：Ctrl+Alt+B
    try {
      if (globalShortcut.register('Control+Alt+B', () => windows.toggleBackgroundMode())) {
        console.log('[shortcut] 后台模式快捷键: Control+Alt+B')
      }
    } catch {
      console.warn('[shortcut] Ctrl+Alt+B 注册失败')
    }
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
    clearInterval(recapSaver)
    core.recap.flush()
    core.registry.saveHistory() // 退出前最后一次落盘（P2-8）
    core.stop()
    windows.destroyAll()
    tray.destroy()
  })

  // 一键热更：完全退出前若存在已校验的待装包，拉起 NSIS /S 静默安装（装完自启）
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    updater.consumePendingInstaller()
  })
}
