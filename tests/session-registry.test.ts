/**
 * SessionRegistry 单元测试 —— payload.title 标题传播
 * 背景：轮询型源（hermes/codex）的会话 ID 是时间戳/uuid 前缀，
 * 面板展示与窗口跳转匹配都需要库里的真实标题。
 */
import { describe, it, expect } from 'vitest'
import { SessionRegistry } from '../src/core/session-registry'
import type { AgentEvent } from '../src/shared/events'

function makeEvent(overrides: Partial<AgentEvent>): AgentEvent {
  return {
    source: 'test',
    agentType: 'hermes',
    sessionId: 's1',
    eventType: 'session_started',
    timestamp: 1_000_000,
    ...overrides
  }
}

describe('SessionRegistry 标题传播', () => {
  it('首个事件带 payload.title 时直接采用（不落到 ID 前缀兜底）', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent({ payload: { title: 'Pupil 面板空白修复' } }))
    expect(reg.get('hermes:s1')?.title).toBe('Pupil 面板空白修复')
  })

  it('无 payload.title 时回退 ID 兜底名', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent({}))
    expect(reg.get('hermes:s1')?.title).toBe('s1')
  })

  it('后续事件带来真实标题时更新既有会话（Hermes 首条回复后才生成摘要标题）', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent({ eventType: 'turn_started' }))
    expect(reg.get('hermes:s1')?.title).toBe('s1') // 先是兜底名
    reg.apply(
      makeEvent({
        eventType: 'tool_call_started',
        timestamp: 2_000_000,
        payload: { toolName: 'Bash', title: '真实摘要标题' }
      })
    )
    expect(reg.get('hermes:s1')?.title).toBe('真实摘要标题')
  })
})
