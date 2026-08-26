/**
 * Preload —— 通过 contextBridge 向 renderer 暴露类型安全 API
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { SessionView, SessionHistoryItem } from '../shared/events'
import { IPC, SettingsSnapshot } from '../shared/ipc-channels'

export interface PupilApi {
  /** 拉取全量会话快照 */
  getSessions(): Promise<SessionView[]>
  /** 订阅快照推送（主进程每次变化全量广播，MVP 简单可靠） */
  onSessions(cb: (views: SessionView[]) => void): () => void
  /** 点击会话行 -> 激活对应窗口 */
  activateWindow(key: string): Promise<{ ok: boolean; reason?: string }>
  /** 勿扰模式 */
  getDnd(): Promise<boolean>
  toggleDnd(): Promise<boolean>
  onDndChanged(cb: (dnd: boolean) => void): () => void
  /** 点击悬浮球 -> 切换详情面板 */
  togglePanel(): Promise<void>
  /** 悬浮球右键 -> 弹出快捷菜单 */
  showBallContext(): void
  /** 悬浮球自定义拖动（替代 app-region，恢复 hover/click） */
  ballDragStart(): void
  ballDragMove(dx: number, dy: number): void
  ballDragEnd(): void
  /** 打开设置（MVP 复用面板） */
  openSettings(): Promise<void>
  /** 打开独立设置窗口（P1-2：面板内设置视图的升级入口，面板让位） */
  openSettingsWindow(): Promise<void>
  /** 设置面板：查询/更新配置与 adapter 状态 */
  getSettings(): Promise<SettingsSnapshot>
  setSettings(patch: {
    dnd?: boolean
    muted?: boolean
    autoLaunch?: boolean
    soundPack?: string
    soundVolume?: number
  }): Promise<SettingsSnapshot>
  setAdapterEnabled(id: string, enabled: boolean): Promise<boolean>
  installHooks(): Promise<boolean>
  uninstallHooks(): Promise<boolean>
  /** 事件历史页签：跨会话合并时间线（时间倒序） */
  getHistory(limit?: number): Promise<SessionHistoryItem[]>
  /** 同步面板视图模式：设置视图下主进程不因失焦自动收起面板 */
  setPanelMode(mode: 'main' | 'settings'): void
  /** 退出应用 */
  quit(): void
  /** 订阅音效播放指令（主进程按通知策略驱动，携带最新音色包/音量） */
  onSoundPlay(cb: (payload: { type: string; pack?: string; volume?: number }) => void): () => void
  /** 订阅全局光标注视方向（眼神跟随；gx/gy 为相对球心单位向量，死区内 0,0） */
  onGaze(cb: (g: { gx: number; gy: number }) => void): () => void
}

const api: PupilApi = {
  getSessions: () => ipcRenderer.invoke(IPC.sessionsGet),
  onSessions: (cb) => {
    const listener = (_e: IpcRendererEvent, views: SessionView[]): void => cb(views)
    ipcRenderer.on(IPC.sessionsSnapshot, listener)
    return () => ipcRenderer.removeListener(IPC.sessionsSnapshot, listener)
  },
  activateWindow: (key) => ipcRenderer.invoke(IPC.windowActivate, key),
  getDnd: () => ipcRenderer.invoke(IPC.dndGet),
  toggleDnd: () => ipcRenderer.invoke(IPC.dndToggle),
  onDndChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, dnd: boolean): void => cb(dnd)
    ipcRenderer.on(IPC.dndChanged, listener)
    return () => ipcRenderer.removeListener(IPC.dndChanged, listener)
  },
  togglePanel: () => ipcRenderer.invoke(IPC.panelToggle),
  showBallContext: () => ipcRenderer.send(IPC.ballContext),
  ballDragStart: () => ipcRenderer.send(IPC.ballDragStart),
  ballDragMove: (dx, dy) => ipcRenderer.send(IPC.ballDragMove, dx, dy),
  ballDragEnd: () => ipcRenderer.send(IPC.ballDragEnd),
  openSettings: () => ipcRenderer.invoke(IPC.settingsOpen),
  openSettingsWindow: () => ipcRenderer.invoke(IPC.settingsWindowOpen),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  setAdapterEnabled: (id, enabled) => ipcRenderer.invoke(IPC.adapterSetEnabled, id, enabled),
  installHooks: () => ipcRenderer.invoke(IPC.hooksInstall),
  uninstallHooks: () => ipcRenderer.invoke(IPC.hooksUninstall),
  getHistory: (limit) => ipcRenderer.invoke(IPC.historyGet, limit),
  setPanelMode: (mode) => ipcRenderer.send(IPC.panelMode, mode),
  quit: () => ipcRenderer.send(IPC.appQuit),
  onSoundPlay: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: { type: string; pack?: string; volume?: number }): void =>
      cb(payload)
    ipcRenderer.on(IPC.soundPlay, listener)
    return () => ipcRenderer.removeListener(IPC.soundPlay, listener)
  },
  onGaze: (cb) => {
    const listener = (_e: IpcRendererEvent, g: { gx: number; gy: number }): void => cb(g)
    ipcRenderer.on(IPC.gazeUpdate, listener)
    return () => ipcRenderer.removeListener(IPC.gazeUpdate, listener)
  }
}

contextBridge.exposeInMainWorld('pupil', api)
