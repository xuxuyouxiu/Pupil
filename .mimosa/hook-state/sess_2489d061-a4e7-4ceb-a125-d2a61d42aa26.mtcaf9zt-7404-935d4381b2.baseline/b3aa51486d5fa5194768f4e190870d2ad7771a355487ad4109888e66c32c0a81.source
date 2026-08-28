/**
 * 通知规则引擎 —— 事件/状态 -> 提醒策略（颜色 / 音效 / 系统通知 / 无）
 * 对应 UIUX 文档第 4 节"声音与系统通知映射"表。
 * 纯规则，不依赖 electron；主进程拿到策略后执行具体动作（播放音效/发 Toast）。
 */
import {
  AgentEvent,
  AgentEventType,
  DisplayState,
  NotifyFilter,
  NOTIFY_FILTER_DEFAULTS,
  SoundKind,
  toDisplayState,
  SessionView
} from '../shared/events'

/** 提醒策略 */
export interface NotifyStrategy {
  /** 悬浮球展示态（决定颜色与动画） */
  displayState: DisplayState
  /** 是否播放音效 */
  sound: boolean
  /** 音效类型（v0.4.1：与展示态解耦——session_ended 有专属「收工」音；null = 该事件无声） */
  soundType: SoundKind | null
  /** 是否弹系统通知 */
  toast: boolean
  /** 通知标题（Toast 用） */
  title?: string
  /** 通知正文 */
  body?: string
}

/** 触发提醒的事件类型（running/idle 不打扰） */
const NOTIFY_EVENTS = new Set([
  'turn_completed',
  'waiting_input',
  'error',
  'session_ended',
  'heartbeat'
])

/** 事件 -> 展示态（对聚合层有意义的事件） */
function eventToDisplayState(event: AgentEvent): DisplayState | null {
  switch (event.eventType) {
    case 'turn_started':
    case 'thinking':
    case 'tool_call_started':
    case 'tool_call_finished':
      return 'running'
    case 'turn_completed':
      return 'done'
    case 'waiting_input':
      return 'waiting'
    case 'error':
      return 'error'
    case 'session_ended':
      return 'idle'
    case 'heartbeat':
      return null
    default:
      return null
  }
}

/** 由展示态得到通知文案 */
function buildBody(event: AgentEvent, sessionTitle: string, display: DisplayState): { title: string; body: string } {
  const who = sessionTitle || event.sessionId
  switch (display) {
    case 'done':
      return { title: `${who} 已完成`, body: `${event.agentType} 会话 · 点击查看结果` }
    case 'waiting':
      return { title: `${who} 等待你的输入`, body: `${event.agentType} 会话等待确认` }
    case 'error':
      return { title: `${who} 任务失败`, body: event.payload?.errorMessage ?? `${event.agentType} 会话发生错误` }
    case 'timeout':
      return { title: `${who} 已超时`, body: `${event.agentType} 会话运行超时` }
    case 'offline':
      return { title: `${who} 连接中断`, body: `${event.agentType} 会话已退出` }
    default:
      return { title: who, body: event.eventType }
  }
}

/**
 * 计算单个事件的提醒策略。
 * @param event 原始事件
 * @param view 该事件应用后的会话视图（可为 undefined，如事件来自未知会话）
 * @param dnd 勿扰模式是否开启（开启则抑制音效与 Toast，仅保留视觉）
 * @param muted 总静音开关
 */
export function resolveStrategy(
  event: AgentEvent,
  view: SessionView | undefined,
  opts: { dnd?: boolean; muted?: boolean } = {}
): NotifyStrategy {
  // 展示态以"事件语义"为准：turn_completed 应用后视图已变 idle，
  // 若按视图状态算，完成提醒（音效+Toast）会被静默吞掉
  const display = eventToDisplayState(event) ?? (view ? toDisplayState(view) : 'idle')

  // 视觉通道永远保留；dnd/静音只影响 sound 与 toast
  // v0.4.1：音效类型与展示态解耦——session_ended 专属「收工」音，
  // 其余可发声展示态同名；running/idle/initializing 无声
  const soundType: SoundKind | null =
    event.eventType === 'session_ended'
      ? 'ended'
      : display === 'done' || display === 'waiting' || display === 'error' || display === 'timeout' || display === 'offline'
        ? display
        : null
  const strategy: NotifyStrategy = {
    displayState: display,
    sound: false,
    soundType,
    toast: false
  }

  if (!NOTIFY_EVENTS.has(event.eventType)) return strategy
  if (opts.dnd) return strategy

  const { title, body } = buildBody(event, view?.title ?? '', display)
  strategy.title = title
  strategy.body = body

  // 音效：六类结束各有其声——done/waiting/error/timeout/offline/ended
  if (!opts.muted && soundType) {
    strategy.sound = true
  }
  // Toast：与音效同样的事件集（offline 也提示）
  if (display !== 'running' && display !== 'idle') {
    strategy.toast = true
  } else if (event.eventType === 'session_ended') {
    strategy.toast = false // 会话结束只响「收工」音，不弹通知（避免噪音）
  }

  return strategy
}

/**
 * 通知粒度过滤（v0.8.0）：用户按类别关闭提醒。
 * 入参同时接受事件类型与推断标记类别（timeout/offline 并非 AgentEventType 成员）；
 * 可提醒类别外的生命周期/工具事件直接放行（它们本就 sound=false，交给规则引擎处理）。
 */
export function notifyAllowed(
  eventType: AgentEventType | keyof NotifyFilter,
  filter?: NotifyFilter
): boolean {
  if (!(eventType in NOTIFY_FILTER_DEFAULTS)) return true
  const merged = { ...NOTIFY_FILTER_DEFAULTS, ...filter }
  return merged[eventType as keyof NotifyFilter] !== false
}
