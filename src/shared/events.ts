/**
 * 统一事件模型与状态视图 —— main 与 renderer 共享的单一事实来源
 * 对应架构文档 3.4 / 4 节
 */

/** 支持的 Agent 类型 */
export type AgentType = 'claude-code' | 'codex' | 'hermes' | 'dsh' | 'zcode' | 'custom'

/** 归一化事件类型（来自架构文档 3.4） */
export type AgentEventType =
  | 'session_started' // 会话创建/被发现
  | 'session_ended' // 会话结束
  | 'turn_started' // 一轮任务开始（用户提交 prompt）
  | 'thinking' // 模型推理中
  | 'tool_call_started' // 工具调用开始（含工具名）
  | 'tool_call_finished' // 工具调用结束（含成功/失败）
  | 'turn_completed' // 一轮回答完成
  | 'waiting_input' // 等待用户输入/权限确认
  | 'error' // 报错（含错误信息）
  | 'heartbeat' // 数据源心跳

/** 事件附加载荷 */
export interface AgentEventPayload {
  toolName?: string // tool_call_*
  errorMessage?: string // error
  modelName?: string // thinking
  pid?: number // 上报方附带的进程号（用于窗口跳转）
  title?: string // 轮询型源（hermes/codex）附带的真实会话标题（面板展示 + 窗口匹配）
  raw?: unknown // 原始行/事件，调试用
}

/** 统一事件 */
export interface AgentEvent {
  readonly source: string // adapter id
  readonly agentType: AgentType
  readonly sessionId: string // 各源会话标识（归一化键：agentType + ':' + sessionId）
  readonly cwd?: string
  readonly eventType: AgentEventType
  readonly timestamp: number // 毫秒 epoch
  readonly payload?: AgentEventPayload
}

/** 会话基础状态（事件驱动，来自状态机） */
export type SessionState = 'idle' | 'thinking' | 'tool_calling' | 'waiting_input' | 'error' | 'done'

/** 推断叠加标记（非基础状态） */
export interface SessionFlags {
  timeout: boolean
  disconnected: boolean
}

/** 推送给 renderer 的完整会话视图 */
export interface SessionView {
  key: string // agentType + ':' + sessionId
  agentType: AgentType
  sessionId: string
  state: SessionState
  flags: SessionFlags
  cwd?: string
  currentTool?: string
  turnStartedAt?: number // 已运行时长 = now - turnStartedAt
  lastEventAt: number
  title?: string // 展示名（目录名/任务名）
  pid?: number
}

/** 事件历史条目（事件历史页签用，由 SessionRegistry 环形缓冲投影） */
export interface SessionHistoryItem {
  key: string // agentType + ':' + sessionId
  agentType: AgentType
  sessionId: string
  title?: string
  eventType: AgentEventType
  timestamp: number
  toolName?: string
  errorMessage?: string
}

/** 悬浮球展示态（UIUX 文档第 4 节六态系统 + 聚合态） */
export type DisplayState =
  | 'initializing' // 加载中
  | 'running' // 进行中（thinking / tool_calling）
  | 'waiting' // 等待输入
  | 'done' // 完成
  | 'error' // 错误
  | 'timeout' // 超时
  | 'offline' // 断连
  | 'idle' // 空闲

/** 提示音类型（与展示态解耦：session_ended 有专属「收工」音，其余与展示态同名） */
export type SoundKind = 'done' | 'waiting' | 'error' | 'timeout' | 'offline' | 'ended'

/**
 * 通知粒度开关（v0.8.0）：按事件类别关闭「音效 + 系统通知」，视觉状态永远保留。
 * 未提供的键按 NOTIFY_FILTER_DEFAULTS 放行。
 */
export interface NotifyFilter {
  turn_completed?: boolean
  waiting_input?: boolean
  error?: boolean
  timeout?: boolean
  offline?: boolean
  /** 收工音默认关（避免噪音），历史行为保持 */
  session_ended?: boolean
}

export const NOTIFY_FILTER_DEFAULTS: Required<NotifyFilter> = {
  turn_completed: true,
  waiting_input: true,
  error: true,
  timeout: true,
  offline: true,
  session_ended: false
}

/** 状态优先级：高 → 低（error > timeout > offline > waiting > running > done > idle） */
export const DISPLAY_PRIORITY: Record<DisplayState, number> = {
  error: 7,
  timeout: 6,
  offline: 5,
  waiting: 4,
  running: 3,
  done: 2,
  initializing: 1,
  idle: 0
}

/**
 * 把会话基础状态 + 推断标记映射为悬浮球展示态。
 * timeout / disconnected 是叠加标记，优先于基础状态。
 */
export function toDisplayState(view: Pick<SessionView, 'state' | 'flags'>): DisplayState {
  if (view.flags.timeout) return 'timeout'
  if (view.flags.disconnected) return 'offline'
  switch (view.state) {
    case 'error':
      return 'error'
    case 'waiting_input':
      return 'waiting'
    case 'done':
      // v0.5.0：turn_completed 后的完成保持窗口（registry 投影），星星眼/弹跳由此驱动
      return 'done'
    case 'thinking':
    case 'tool_calling':
      return 'running'
    case 'idle':
      return 'idle'
    default:
      return 'idle'
  }
}

/** 会话归一化 key */
export function sessionKey(agentType: AgentType, sessionId: string): string {
  return `${agentType}:${sessionId}`
}
