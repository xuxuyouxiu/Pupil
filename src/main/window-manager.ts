/**
 * WindowManager —— 球窗口 + 面板窗口生命周期
 * 架构文档第 5 节：单应用两个 BrowserWindow；面板按需创建、失焦销毁（省内存）
 */
import { BrowserWindow, screen, Display } from 'electron'
import { join } from 'path'
import { BALL_SIZE, PANEL_MAX_HEIGHT, PANEL_WIDTH, SETTINGS_HEIGHT, SETTINGS_WIDTH, BUBBLE_BAND, BALL_WINDOW_INSET_X } from '../shared/constants'
import { ConfigStore } from './config'

const isDev = process.env['ELECTRON_RENDERER_URL'] !== undefined

export class WindowManager {
  private ball: BrowserWindow | null = null
  private panel: BrowserWindow | null = null
  private settingsWin: BrowserWindow | null = null
  private panelHideTimer: NodeJS.Timeout | null = null
  /** 原生对话框打开期间的失焦自动收起挂起计数（可重入） */
  private dialogGuardCount = 0
  /** 应用退出中（区别于用户点设置窗口关闭钮：退出要真销毁，关闭钮只隐藏复用） */
  private quitting = false

  /** v1.5.0 球可见性变化回调（tray 注入，用于勾选状态同步） */
  onBallVisibilityChanged: ((visible: boolean) => void) | null = null

  constructor(private config: ConfigStore) {}

  /** 创建球窗口（常驻）。v0.5.0：窗口 64×76 —— 上 20px 气泡带 + 下 56px 球体，左右各 4px 留白 */
  createBallWindow(): BrowserWindow {
    const saved = this.config.get('ballPosition')
    const display = screen.getPrimaryDisplay()
    const { height: sh } = display.workAreaSize
    const winW = BALL_SIZE + BALL_WINDOW_INSET_X * 2
    const winH = BALL_SIZE + BUBBLE_BAND

    // 默认：主屏左侧垂直居中。坐标语义 = 窗口原点（含气泡带）
    const defX = Math.round(display.workArea.x + 16)
    const defY = Math.round(display.workArea.y + (sh - BALL_SIZE) / 2 - BUBBLE_BAND)
    let x = saved?.x ?? defX
    let y = saved?.y ?? defY
    if (saved && !this.config.get('bubbleBandMigrated')) {
      // v0.4.x 存的是 56×56 窗口原点 = 球体原点；新版窗口上扩气泡带，一次性补偿
      y += BUBBLE_BAND
      this.config.set('bubbleBandMigrated', true)
    }
    // v0.8.0 越界校正：显示器拔除/分辨率变更后存档位置可能落在屏幕外，
    // 球永远找不回来（托盘"显示悬浮球"也救不了），恢复时夹紧到主屏工作区
    {
      const wa = display.workArea
      x = Math.min(Math.max(x, wa.x), wa.x + wa.width - winW)
      y = Math.min(Math.max(y, wa.y), wa.y + wa.height - winH)
    }

    const win = new BrowserWindow({
      x,
      y,
      width: winW,
      height: winH,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        backgroundThrottling: false, // 保证球体动画常驻不冻结
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    win.setAlwaysOnTop(true, 'screen-saver')
    // 透明窗口不抢焦点（点击时才交互）
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    this.loadRenderer(win, 'ball/index.html')

    // 更快显示：页面加载完成即显示，ready-to-show（等首个绘制帧）作为兜底——
    // 普通桌面开启硬件加速后首帧很快，提前显示可省下等待时间
    let ballShown = false
    const showBall = (): void => {
      if (ballShown || win.isDestroyed()) return
      ballShown = true
      win.show()
    }
    win.once('ready-to-show', showBall)
    win.webContents.once('did-finish-load', () => setTimeout(showBall, 0))
    // v1.9.0 显示兜底：ready-to-show 偶发不发（渲染卡顿/杀软拦截）导致球永不出来——
    // 1.5s 强制显示。透明窗口此时可能空白一瞬，但远好过"托盘在球不在"的困惑
    setTimeout(showBall, 1500)
    // v1.5.0 球可见性变化回调（tray 勾选状态同步；后台模式入口统一走 hideToBackground/restore）
    win.on('show', () => this.onBallVisibilityChanged?.(true))
    win.on('hide', () => this.onBallVisibilityChanged?.(false))
    // 拖动后记忆位置：moved 事件在拖动期间高频触发，节流 500ms 合并写盘（v0.9.0）；
    // 结束拖动时立即补一次最终位置，不丢尾
    win.on('moved', () => this.scheduleBallSave())
    win.on('closed', () => {
      this.ball = null
    })

    this.ball = win
    return win
  }

  get ballWindow(): BrowserWindow | null {
    return this.ball
  }

  /** 面板窗口访问器（原生对话框需挂父窗口，避免夺焦收起竞态） */
  get panelWindow(): BrowserWindow | null {
    return this.panel && !this.panel.isDestroyed() ? this.panel : null
  }

  /**
   * 自定义拖动（替代 -webkit-app-region: drag）：
   * delta 由 renderer 用 pointer 事件的 screenX/Y 差值计算（统一 DIP 坐标），
   * 主进程只做 win0 + delta，避免 getCursorScreenPoint 坐标源不一致。
   */
  private dragState: { win: { x: number; y: number } } | null = null

  startDrag(): void {
    const win = this.ball
    if (!win || win.isDestroyed()) return
    const [wx, wy] = win.getPosition()
    this.dragState = { win: { x: wx, y: wy } }
  }

  moveDrag(dx: number, dy: number): void {
    const win = this.ball
    if (!win || !this.dragState) return
    if (dx === 0 && dy === 0) return
    // delta 是指针位移，窗口 1:1 跟随——与窗口/球壳原点无关（v0.5.0 曾在此加
    // INSET/BAND 补偿，属画蛇添足：零 delta 的 pointermove 会让窗口瞬移并污染存档，已撤）
    win.setPosition(this.dragState.win.x + dx, this.dragState.win.y + dy)
  }

  endDrag(): void {
    if (!this.dragState) return
    this.dragState = null
    // 存窗口原点（含气泡带），与 createBallWindow 读入语义一致；立即落盘不丢尾
    this.scheduleBallSave()
  }

  /** 球位置保存节流（v0.9.0）：拖动期间 moved 高频触发，500ms 合并一次写盘 */
  private ballSaveTimer: NodeJS.Timeout | null = null
  private scheduleBallSave(): void {
    if (this.ballSaveTimer) return
    this.ballSaveTimer = setTimeout(() => {
      this.ballSaveTimer = null
      const win = this.ball
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition()
        this.config.set('ballPosition', { x, y })
      }
    }, 500)
  }

  /** 打开面板（若已存在则聚焦）；返回是否新建 */
  openPanel(): boolean {
    if (this.panel && !this.panel.isDestroyed()) {
      this.panel.show()
      this.panel.focus()
      return false
    }
    const ball = this.ball
    // v0.5.0：锚点用球体屏幕矩形（窗口原点 + 气泡带偏移 + 左右留白）
    const b = ball && !ball.isDestroyed() ? ball.getBounds() : null
    const anchor = b
      ? { x: b.x + BALL_WINDOW_INSET_X, y: b.y + BUBBLE_BAND, width: BALL_SIZE, height: BALL_SIZE }
      : { x: 0, y: 0, width: BALL_SIZE, height: BALL_SIZE }
    const { x: px, y: py } = this.clampPanelPosition(anchor)

    const win = new BrowserWindow({
      x: px,
      y: py,
      width: PANEL_WIDTH,
      height: Math.min(PANEL_MAX_HEIGHT, 420),
      show: false,
      frame: false,
      // 面板不透明：透明窗口在 Windows 上禁用 ClearType，文字发虚看不清（用户反馈）。
      // 圆角由 CSS 内部裁切呈现，四角以底色填充。
      transparent: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#0d1117',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    this.loadRenderer(win, 'panel/index.html')
    win.once('ready-to-show', () => win.show())
    win.on('blur', () => this.schedulePanelHide())
    win.on('closed', () => {
      if (this.panelHideTimer) clearTimeout(this.panelHideTimer)
      this.panel = null
    })
    this.panel = win
    return true
  }

  /** 切换面板开合：返回切换后是否处于打开状态 */
  togglePanel(): boolean {
    if (this.panel && !this.panel.isDestroyed()) {
      this.closePanel()
      return false
    }
    this.openPanel()
    return true
  }

  /**
   * 面板高度自适应（v0.8.0）：renderer ResizeObserver 上报内容高度，
   * 夹紧到 [240, PANEL_MAX_HEIGHT] 后调整窗口；宽度和位置保持不变。
   */
  resizePanelTo(contentHeight: number): void {
    const win = this.panel
    if (!win || win.isDestroyed()) return
    const clamped = Math.max(240, Math.min(PANEL_MAX_HEIGHT, Math.round(contentHeight)))
    const [width] = win.getSize()
    if (Math.abs(win.getBounds().height - clamped) < 2) return // 抖动抑制
    win.setSize(width, clamped)
  }

  /**
   * 面板失焦后 300ms 收起；主列表与设置视图统一策略（用户要求一致，2026-08-27 收回 v0.2.0 的设置视图例外）。
   * 原生对话框（选自定义音效等）打开期间挂起：对话框必然夺焦触发 blur，属预期交互而非"点外面"。
   */
  private schedulePanelHide(): void {
    if (this.dialogGuardCount > 0) return
    if (this.panelHideTimer) clearTimeout(this.panelHideTimer)
    this.panelHideTimer = setTimeout(() => {
      if (this.panel && !this.panel.isDestroyed()) this.panel.close()
      this.panelHideTimer = null
    }, 300)
  }

  /** 挂起面板失焦自动收起（可重入；打开原生对话框前调用） */
  suspendPanelAutoHide(): void {
    this.dialogGuardCount++
    if (this.panelHideTimer) {
      clearTimeout(this.panelHideTimer)
      this.panelHideTimer = null
    }
  }

  /** 解除挂起（对话框关闭后调用） */
  resumePanelAutoHide(): void {
    this.dialogGuardCount = Math.max(0, this.dialogGuardCount - 1)
  }


  cancelPanelHide(): void {
    if (this.panelHideTimer) {
      clearTimeout(this.panelHideTimer)
      this.panelHideTimer = null
    }
  }

  /**
   * 独立设置窗口（P1-2）：面板内设置视图的升级替代入口。
   * 常驻隐藏复用（不销毁）：保留滚动位置与表单状态，二次打开零创建开销；
   * 失焦仅隐藏不销毁（设置窗口由用户显式关闭，不受面板防误触策略约束）。
   */
  openSettingsWindow(): void {
    if (this.settingsWin && !this.settingsWin.isDestroyed()) {
      this.settingsWin.show()
      this.settingsWin.focus()
      return
    }
    const display = screen.getPrimaryDisplay()
    const area = display.workArea

    const win = new BrowserWindow({
      width: SETTINGS_WIDTH,
      height: SETTINGS_HEIGHT,
      show: false,
      frame: false,
      // 与面板同理：不透明窗口保 ClearType 清晰渲染（用户反馈文字发虚）
      transparent: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: '#0d1117',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    // 居中于工作区（独立窗口不跟随球锚点）
    win.setPosition(
      Math.round(area.x + (area.width - SETTINGS_WIDTH) / 2),
      Math.round(area.y + (area.height - SETTINGS_HEIGHT) / 2)
    )

    this.loadRenderer(win, 'settings/index.html')
    win.once('ready-to-show', () => win.show())
    win.on('close', (e) => {
      // 首次点关闭 → 隐藏复用；托盘退出走 destroyAll() 时 isDestroyed 前置已处理
      if (!this.quitting) {
        e.preventDefault()
        win.hide()
      }
    })
    this.settingsWin = win
  }

  closeSettingsWindow(): void {
    if (this.settingsWin && !this.settingsWin.isDestroyed()) this.settingsWin.hide()
  }

  closePanel(): void {
    if (this.panel && !this.panel.isDestroyed()) this.panel.close()
  }

  /**
   * v1.5.0 后台模式（看电视模式）：球 + 面板全部隐藏，监控与通知照常。
   * 与托盘「显示悬浮球」勾选同一状态源（ballWindow.isVisible），互相同步。
   */
  hideToBackground(): void {
    this.closePanel()
    const win = this.ball
    if (win && !win.isDestroyed()) win.hide()
  }

  restoreFromBackground(): void {
    const win = this.ball
    if (win && !win.isDestroyed()) win.show()
  }

  get isBackgrounded(): boolean {
    const win = this.ball
    return !win || win.isDestroyed() || !win.isVisible()
  }

  /** v1.9.0 向球窗补发最新会话快照（core.start 完成后回填，避免球窗错过初始广播） */
  refreshBallSnapshot(): void {
    // 实际广播由 monitoring-core 的订阅回调完成；此处通过触发一次空广播实现解耦
    if (this.onCoreReady) this.onCoreReady()
  }

  /** core.start 完成回调（index.ts 注入） */
  onCoreReady: (() => void) | null = null

  /** v1.5.0 一键切换后台模式（全局快捷键 Ctrl+Alt+B） */
  toggleBackgroundMode(): void {
    if (this.isBackgrounded) this.restoreFromBackground()
    else this.hideToBackground()
  }

  /** 面板位置：球右侧，保证不超出工作区 */
  private clampPanelPosition(ball: { x: number; y: number; width: number; height: number }) {
    const display = screen.getDisplayNearestPoint({
      x: ball.x + ball.width / 2,
      y: ball.y + ball.height / 2
    })
    const area = display.workArea
    let x = ball.x + ball.width + 8
    let y = ball.y
    if (x + PANEL_WIDTH > area.x + area.width) {
      x = ball.x - PANEL_WIDTH - 8 // 放不下则移到球左侧
    }
    if (y + 420 > area.y + area.height) {
      y = area.y + area.height - 420
    }
    if (y < area.y) y = area.y
    return { x: Math.round(x), y: Math.round(y) }
  }

  private loadRenderer(win: BrowserWindow, file: string): void {
    if (isDev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${file}`)
    } else {
      win.loadFile(join(__dirname, `../renderer/${file}`))
    }
  }

  destroyAll(): void {
    this.quitting = true
    this.closePanel()
    if (this.settingsWin && !this.settingsWin.isDestroyed()) this.settingsWin.destroy()
    this.settingsWin = null
    this.ball?.destroy()
  }
}

/** 从 display 对象取工作区（保留给后续多显示器逻辑） */
export function workAreaOf(display: Display) {
  return display.workArea
}
