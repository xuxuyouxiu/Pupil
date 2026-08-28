/**
 * Claude Code hook 上报载荷 -> 归一化事件映射（通道 B）
 * 对应架构文档 3.4 事件映射表。hook 进程通过 stdin 收到的 JSON 字段：
 *   session_id / transcript_path / cwd / hook_event_name / tool_name /
 *   tool_input / tool_use_id / permission_mode（PowerShell 脚本可能附加 pid）
 */
import { AgentEvent, AgentEventType, AgentType } from '../../shared/events'

export interface ClaudeCodeHookPayload {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: unknown
  tool_use_id?: string
  permission_mode?: string
  /** hook 脚本尽力附加的宿主终端 pid */
  pid?: number
  /** Notification 事件的消息内容 */
  message?: string
  [key: string]: unknown
}

const SOURCE = 'claude-code-hooks'

/** hook_event_name -> 归一化事件类型 */
const EVENT_MAP: Record<string, AgentEventType> = {
  SessionStart: 'session_started',
  SessionEnd: 'session_ended',
  UserPromptSubmit: 'turn_started',
  PreToolUse: 'tool_call_started',
  PostToolUse: 'tool_call_finished',
  PostToolUseFailure: 'error',
  Stop: 'turn_completed',
  StopFailure: 'error',
  TaskCreated: 'turn_started',
  TaskCompleted: 'turn_completed',
  SubagentStart: 'tool_call_started',
  SubagentStop: 'tool_call_finished'
}

/** 把单个 hook 载荷映射为归一化事件（可能 0 或 1 个；Notification 无等待语义时跳过） */
export function mapClaudeCodeHook(payload: ClaudeCodeHookPayload): AgentEvent[] {
  const sessionId = payload.session_id
  if (!sessionId) return []

  const hookEvent = payload.hook_event_name ?? ''
  const base = {
    source: SOURCE,
    agentType: 'claude-code' as AgentType,
    sessionId,
    cwd: payload.cwd,
    timestamp: Date.now()
  }

  // Notification：仅"等待输入"类消息转 waiting_input，其余忽略
  if (hookEvent === 'Notification') {
    const msg = String(payload.message ?? '')
    if (/waiting/i.test(msg) || /input/i.test(msg) || /确认|等待|输入/.test(msg)) {
      return [{ ...base, eventType: 'waiting_input', payload: { raw: payload } }]
    }
    return []
  }

  const eventType = EVENT_MAP[hookEvent]
  if (!eventType) return [] // 未映射的事件（如 PreCompact 等）忽略

  const detail = eventType === 'error' ? (payload.tool_name ? `${payload.tool_name} 调用失败` : hookEvent) : undefined
  const event: AgentEvent = {
    ...base,
    eventType,
    payload: {
      toolName: payload.tool_name,
      errorMessage: detail,
      pid: typeof payload.pid === 'number' ? payload.pid : undefined,
      raw: payload
    }
  }

  return [event]
}
