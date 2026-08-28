/**
 * adapter 映射函数单元测试：hook-payload-map / claude-code mapLine / codex rollout
 */
import { describe, it, expect } from 'vitest'
import { mapClaudeCodeHook } from '../src/adapters/claude-code/hook-payload-map'
import { mapLine } from '../src/adapters/claude-code/log-adapter'
import { mapRolloutLine } from '../src/adapters/codex/log-adapter'

describe('mapClaudeCodeHook（通道 B）', () => {
  it('UserPromptSubmit -> turn_started', () => {
    const events = mapClaudeCodeHook({
      session_id: 's1',
      cwd: 'D:/work',
      hook_event_name: 'UserPromptSubmit'
    })
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe('turn_started')
    expect(events[0].agentType).toBe('claude-code')
    expect(events[0].cwd).toBe('D:/work')
  })

  it('PreToolUse -> tool_call_started 且带工具名', () => {
    const events = mapClaudeCodeHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash'
    })
    expect(events[0].eventType).toBe('tool_call_started')
    expect(events[0].payload?.toolName).toBe('Bash')
  })

  it('Stop -> turn_completed；SessionStart/SessionEnd 正确映射', () => {
    expect(mapClaudeCodeHook({ session_id: 's', hook_event_name: 'Stop' })[0].eventType).toBe('turn_completed')
    expect(mapClaudeCodeHook({ session_id: 's', hook_event_name: 'SessionStart' })[0].eventType).toBe('session_started')
    expect(mapClaudeCodeHook({ session_id: 's', hook_event_name: 'SessionEnd' })[0].eventType).toBe('session_ended')
  })

  it('PostToolUseFailure/StopFailure -> error', () => {
    for (const ev of ['PostToolUseFailure', 'StopFailure']) {
      const events = mapClaudeCodeHook({ session_id: 's', hook_event_name: ev, tool_name: 'Bash' })
      expect(events[0].eventType).toBe('error')
      expect(events[0].payload?.errorMessage).toContain('Bash')
    }
  })

  it('Notification 仅等待类消息转 waiting_input，其余忽略', () => {
    const wait = mapClaudeCodeHook({
      session_id: 's',
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input'
    })
    expect(wait).toHaveLength(1)
    expect(wait[0].eventType).toBe('waiting_input')

    const 中文 = mapClaudeCodeHook({
      session_id: 's',
      hook_event_name: 'Notification',
      message: '需要你确认权限'
    })
    expect(中文).toHaveLength(1)

    const other = mapClaudeCodeHook({
      session_id: 's',
      hook_event_name: 'Notification',
      message: 'Context low'
    })
    expect(other).toHaveLength(0)
  })

  it('无 session_id 或未映射事件返回空数组', () => {
    expect(mapClaudeCodeHook({ hook_event_name: 'Stop' })).toHaveLength(0)
    expect(mapClaudeCodeHook({ session_id: 's', hook_event_name: 'PreCompact' })).toHaveLength(0)
  })

  it('pid 数字透传进 payload', () => {
    const events = mapClaudeCodeHook({
      session_id: 's',
      hook_event_name: 'UserPromptSubmit',
      pid: 1234
    })
    expect(events[0].payload?.pid).toBe(1234)
  })
})

describe('mapLine（Claude Code 日志 tail）', () => {
  const BASE = { sessionId: 's1', cwd: 'D:/work', timestamp: '2026-08-24T10:00:00Z' }

  it('user 字符串 content -> turn_started', () => {
    const events = mapLine({
      ...BASE,
      type: 'user',
      message: { role: 'user', content: '帮我重构这个模块' }
    })
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe('turn_started')
  })

  it('assistant tool_use 块 -> tool_call_started；end_turn -> turn_completed', () => {
    const started = mapLine({
      ...BASE,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit' }]
      },
      stop_reason: 'tool_use'
    })
    expect(started.map((e) => e.eventType)).toEqual(['tool_call_started'])
    expect(started[0].payload?.toolName).toBe('Edit')

    const done = mapLine({
      ...BASE,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn' }
    })
    expect(done.map((e) => e.eventType)).toEqual(['turn_completed'])
  })

  it('tool_result 数组：正常 -> tool_call_finished；is_error -> error', () => {
    const ok = mapLine({
      ...BASE,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1' }]
      }
    })
    expect(ok[0].eventType).toBe('tool_call_finished')

    const bad = mapLine({
      ...BASE,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'exit code 1' }]
      }
    })
    expect(bad[0].eventType).toBe('error')
    expect(bad[0].payload?.errorMessage).toContain('exit code 1')
  })

  it('缺 sessionId 返回空；时间戳解析失败回退 now', () => {
    expect(mapLine({ type: 'user', message: { content: 'x' } })).toHaveLength(0)
    const events = mapLine({
      sessionId: 's1',
      timestamp: 'not-a-date',
      type: 'user',
      message: { role: 'user', content: 'hello' }
    })
    expect(events[0].timestamp).toBeGreaterThan(0)
  })
})

describe('mapRolloutLine（Codex 经典 CLI rollout jsonl）', () => {
  it('session_meta -> session_started（含 id/cwd）', () => {
    const events = mapRolloutLine({
      timestamp: '2026-08-24T09:00:00Z',
      type: 'session_meta',
      payload: { id: 'roll-1', cwd: 'G:/proj', cli_version: '0.4.0' }
    })
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe('session_started')
    expect(events[0].sessionId).toBe('roll-1')
    expect(events[0].cwd).toBe('G:/proj')
  })

  it('response_item：user/assistant/function_call 三类映射', () => {
    const user = mapRolloutLine({
      timestamp: '2026-08-24T09:01:00Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user' }
    })
    expect(user[0].eventType).toBe('turn_started')

    const assistant = mapRolloutLine({
      timestamp: '2026-08-24T09:02:00Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant' }
    })
    expect(assistant[0].eventType).toBe('turn_completed')

    const call = mapRolloutLine({
      timestamp: '2026-08-24T09:03:00Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell' }
    })
    expect(call[0].eventType).toBe('tool_call_started')
    expect(call[0].payload?.toolName).toBe('shell')
  })

  it('token_count event_msg -> thinking 脉冲', () => {
    const events = mapRolloutLine({
      timestamp: '2026-08-24T09:04:00Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: {} } }
    })
    expect(events[0].eventType).toBe('thinking')
  })

  it('未知类型返回空', () => {
    expect(mapRolloutLine({ type: 'compacted', payload: {} })).toHaveLength(0)
  })
})

describe('mapRolloutLine 审批请求 → waiting_input（v0.10.0）', () => {
  it('exec_approval_request -> waiting_input', () => {
    const events = mapRolloutLine({
      timestamp: '2026-08-27T10:00:00Z',
      type: 'event_msg',
      payload: { type: 'exec_approval_request', command: 'rm -rf /' }
    })
    expect(events.map((e) => e.eventType)).toContain('waiting_input')
  })

  it('input_request / elicitation 同样命中', () => {
    for (const pt of ['input_request', 'elicitation_request']) {
      const events = mapRolloutLine({ type: 'event_msg', payload: { type: pt } })
      expect(events.map((e) => e.eventType)).toContain('waiting_input')
    }
  })

  it('普通 agent_message 不触发 waiting_input', () => {
    const events = mapRolloutLine({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done' }
    })
    expect(events.map((e) => e.eventType)).not.toContain('waiting_input')
  })
})
