/**
 * mapHermesMessage 单测 —— v0.5.1「回合完成判定」回归防线。
 *
 * 用本机 state.db 真实样本锁定行为（2026-08-26 实测）：
 *   - assistant + tool_calls 非空（finish_reason='tool_calls'）→ turn 中间，不产生事件
 *   - assistant + tool_calls 空 + finish_reason='stop' → 正常最终回复 → turn_completed
 *   - assistant + tool_calls 空 + finish_reason=NULL + 非错误 → 截断/中断回合的最终回复
 *     （如迭代上限后的总结，样本 id=49302）→ turn_completed（v0.5.0 被静默忽略 → 球卡 running）
 *   - assistant + finish_reason=NULL + 错误文本 → error（v0.4.1 行为保留）
 */
import { describe, expect, it } from 'vitest'
import { mapHermesMessage } from '../src/adapters/hermes/sqlite-adapter'

const base = {
  source: 'hermes-sqlite',
  agentType: 'hermes' as const,
  sessionId: 's1',
  timestamp: 1787754000000
}

describe('mapHermesMessage 回合判定', () => {
  it('role=user → turn_started', () => {
    const ev = mapHermesMessage({ role: 'user', tool_name: null, tool_calls: null, finish_reason: null, content: '你好' }, base)
    expect(ev?.eventType).toBe('turn_started')
  })

  it('role=tool 带 tool_name → tool_call_started', () => {
    const ev = mapHermesMessage({ role: 'tool', tool_name: 'terminal', tool_calls: null, finish_reason: null, content: '' }, base)
    expect(ev?.eventType).toBe('tool_call_started')
    expect(ev?.payload).toMatchObject({ toolName: 'terminal' })
  })

  it('role=tool 无 tool_name → 不产生事件', () => {
    const ev = mapHermesMessage({ role: 'tool', tool_name: null, tool_calls: null, finish_reason: null, content: '' }, base)
    expect(ev).toBeNull()
  })

  it('assistant 带工具调用（finish_reason=tool_calls）→ 忽略（turn 中间）', () => {
    const ev = mapHermesMessage(
      { role: 'assistant', tool_name: null, tool_calls: '[{"id":"t1"}]', finish_reason: 'tool_calls', content: '我去查一下' },
      base
    )
    expect(ev).toBeNull()
  })

  it('assistant 无工具调用 + finish_reason=stop → turn_completed', () => {
    const ev = mapHermesMessage(
      { role: 'assistant', tool_name: null, tool_calls: null, finish_reason: 'stop', content: '好的，完成了' },
      base
    )
    expect(ev?.eventType).toBe('turn_completed')
  })

  it('assistant 无工具调用 + finish_reason=NULL + 正常文本 → turn_completed（v0.5.1 修复：截断回合也算完成）', () => {
    // 真实样本 id=49302：迭代上限后的总结回复
    const ev = mapHermesMessage(
      { role: 'assistant', tool_name: null, tool_calls: null, finish_reason: null, content: '主人，我先说明：这个会话我接的是上个会话被中断的问题' },
      base
    )
    expect(ev?.eventType).toBe('turn_completed')
  })

  it('assistant + finish_reason=NULL + 错误文本 → error（保留 v0.4.1 行为）', () => {
    const ev = mapHermesMessage(
      { role: 'assistant', tool_name: null, tool_calls: null, finish_reason: null, content: 'Error code: 429 - rate limit exceeded' },
      base
    )
    expect(ev?.eventType).toBe('error')
    expect(ev?.payload).toMatchObject({ errorMessage: expect.stringContaining('Error code: 429') })
  })

  it('session_meta / 空 role → 不产生事件', () => {
    expect(mapHermesMessage({ role: 'session_meta', tool_name: null, tool_calls: null, finish_reason: null, content: '' }, base)).toBeNull()
    expect(mapHermesMessage({ role: null, tool_name: null, tool_calls: null, finish_reason: null, content: '' }, base)).toBeNull()
  })

  it('空内容 assistant（真空消息，样本 id=49158）→ 也视为回合结束', () => {
    const ev = mapHermesMessage(
      { role: 'assistant', tool_name: null, tool_calls: null, finish_reason: null, content: '' },
      base
    )
    expect(ev?.eventType).toBe('turn_completed')
  })
})
