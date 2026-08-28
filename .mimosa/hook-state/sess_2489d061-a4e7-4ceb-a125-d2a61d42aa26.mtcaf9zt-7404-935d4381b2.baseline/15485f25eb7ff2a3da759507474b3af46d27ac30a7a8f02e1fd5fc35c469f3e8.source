/**
 * 会话状态机 —— 纯函数，零依赖，可单测
 * 对应架构文档第 4 节状态图：
 *
 *   session_started ──> idle ──(turn_started)──> thinking ──(tool_call_started)──> tool_calling
 *                        ^                          │                        │(tool_call_finished)
 *                        │                          │<───────────────────────┘
 *                        │(turn_completed/          │
 *                        │ session_ended)           │(waiting_input 事件)
 *                        │                          v
 *                        └──────────────── waiting_input
 *                                                     │(turn_started)
 *                                                     └──────> thinking
 *
 *   任意状态 + error 事件 ──> error（保留前态用于恢复显示）
 *   error 恢复：收到 turn_started / thinking 等正向事件即回到运行态
 */
import type { AgentEventType, SessionState } from '../shared/events'

/** 错误态退出时允许恢复到的状态 */
const ERROR_RECOVERY: Partial<Record<AgentEventType, SessionState>> = {
  turn_started: 'thinking',
  thinking: 'thinking',
  tool_call_started: 'tool_calling'
}

/** 纯状态转移函数 */
export function transitionState(
  current: SessionState,
  event: AgentEventType
): SessionState {
  // 新会话开始总是重置（含从 error 吸收态恢复，避免出错后会话重启仍卡在错误态）
  if (event === 'session_started') return 'idle'

  // 错误态是"吸收态"：除非有恢复事件，否则保持 error
  if (current === 'error' && event !== 'error') {
    const recovery = ERROR_RECOVERY[event]
    if (recovery) return recovery
    if (event === 'turn_completed' || event === 'session_ended') return 'idle'
    if (event === 'waiting_input') return 'waiting_input'
    return current // error 态下 heartbeat/tool_call_finished 等不改变状态
  }

  switch (event) {
    case 'turn_started':
    case 'thinking':
      return 'thinking'
    case 'tool_call_started':
      return 'tool_calling'
    case 'tool_call_finished':
      // 工具调用结束回到"思考/输出"而非 idle（一轮对话可能连续调用多个工具）
      return 'thinking'
    case 'turn_completed':
    case 'session_ended':
      return 'idle'
    case 'waiting_input':
      return 'waiting_input'
    case 'error':
      return 'error'
    case 'heartbeat':
      return current
    default:
      return current
  }
}
