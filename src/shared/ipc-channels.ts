/** IPC 通道名常量（main <-> preload <-> renderer 统一引用，防拼写漂移） */

/** 设置面板里的单个 adapter 状态 */
export interface AdapterStatus {
  id: string
  label: string
  enabled: boolean
  available: boolean
  running: boolean
}

/** 设置面板快照（settings:get 返回） */
export interface SettingsSnapshot {
  dnd: boolean
  muted: boolean
  /** 音色包 id（chime/wood/chip/alarm） */
  soundPack: string
  /** 全局音量 0..1 */
  soundVolume: number
  /** 开机自启（打包版生效；dev 下可存偏好但不注册登录项） */
  autoLaunch: boolean
  timeoutThresholdMs: number
  disconnectThresholdMs: number
  hooksInstalled: boolean
  adapters: AdapterStatus[]
}

/** 事件历史条目（跨会话合并，时间倒序） */
export type { SessionHistoryItem } from './events'

export const IPC = {
  /** 主进程 -> renderer：全量会话快照 */
  sessionsSnapshot: 'pupil:sessions:snapshot',
  /** 主进程 -> renderer：会话增量事件 */
  sessionDelta: 'pupil:sessions:delta',
  /** renderer -> 主进程：请求全量快照（面板/球体首次挂载时） */
  sessionsGet: 'pupil:sessions:get',

  /** 主进程 -> renderer：请求播放音效（type: done/waiting/error/timeout/offline） */
  soundPlay: 'pupil:sound:play',

  /** 主进程 -> 球窗：状态播报气泡文案（边沿触发，主进程已做去重与勿扰过滤） */
  speechBubble: 'pupil:speech:bubble',

  /** 主进程 -> 球窗：全局光标相对球心的单位方向 {gx,gy}（眼神跟随，死区内为 0,0） */
  gazeUpdate: 'pupil:gaze:update',

  /** renderer -> 主进程：请求激活某会话对应窗口 */
  windowActivate: 'pupil:window:activate',

  /** renderer -> 主进程：勿扰模式开关 */
  dndToggle: 'pupil:dnd:toggle',
  /** renderer -> 主进程：查询勿扰状态 */
  dndGet: 'pupil:dnd:get',
  /** 主进程 -> renderer：勿扰状态变化广播 */
  dndChanged: 'pupil:dnd:changed',

  /** renderer -> 主进程：切换面板开合 */
  panelToggle: 'pupil:panel:toggle',

  /** renderer -> 主进程：请求弹出悬浮球右键菜单 */
  ballContext: 'pupil:ball:context',

  /** renderer -> 主进程：悬浮球拖动（自定义拖动，替代 app-region 以恢复 hover/click） */
  ballDragStart: 'pupil:ball:drag:start',
  ballDragMove: 'pupil:ball:drag:move',
  ballDragEnd: 'pupil:ball:drag:end',

  /** renderer -> 主进程：打开设置窗口 */
  settingsOpen: 'pupil:settings:open',
  /** renderer -> 主进程：查询设置面板快照 */
  settingsGet: 'pupil:settings:get',
  /** renderer -> 主进程：更新通用设置（dnd/muted/timeout/disconnect） */
  settingsSet: 'pupil:settings:set',
  /** renderer -> 主进程：启停 adapter */
  adapterSetEnabled: 'pupil:adapter:set-enabled',
  /** renderer -> 主进程：安装/卸载 Claude Code hooks */
  hooksInstall: 'pupil:hooks:install',
  hooksUninstall: 'pupil:hooks:uninstall',
  /** renderer -> 主进程：打开独立设置窗口（P1-2） */
  settingsWindowOpen: 'pupil:settings-window:open',
  /** renderer -> 主进程：查询事件历史（环形缓冲投影，时间倒序） */
  historyGet: 'pupil:history:get',
  /** renderer -> 主进程：同步面板视图模式（main/settings，settings 失焦不自动收起） */
  panelMode: 'pupil:panel:mode',
  /** renderer -> 主进程：退出应用 */
  appQuit: 'pupil:app:quit'
} as const
