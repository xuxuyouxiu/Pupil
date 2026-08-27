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
  /** 应用退出中（区别于用户点设置窗口关闭钮：退出要真销毁，关闭钮只隐藏复用） */
  private quitting = false

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

    win.once('ready-to-show', () => win.show())
    // 拖动后记忆位置（节流：moved 事件已足够低频）
    win.on('moved', () => {
      const pos = win.getPosition()
      this.config.set('ballPosition', { x: pos[0], y: pos[1] })
    })
    win.on('closed', () => {
      this.ball = null
    })

    this.ball = win
    return win
  }

  get ballWindow(): BrowserWindow | null {
    return this.ball
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
    const win = this.ball
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition()
      // 存窗口原点（含气泡带），与 createBallWindow 读入语义一致
      this.config.set('ballPosition', { x, y })
    }
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

  /** 面板失焦后 300ms 收起；主列表与设置视图统一策略（用户要求一致，2026-08-27 收回 v0.2.0 的设置视图例外） */
  private schedulePanelHide(): void {
    if (this.panelHideTimer) clearTimeout(this.panelHideTimer)
    this.panelHideTimer = setTimeout(() => {
      if (this.panel && !this.panel.isDestroyed()) this.panel.close()
      this.panelHideTimer = null
    }, 300)
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
