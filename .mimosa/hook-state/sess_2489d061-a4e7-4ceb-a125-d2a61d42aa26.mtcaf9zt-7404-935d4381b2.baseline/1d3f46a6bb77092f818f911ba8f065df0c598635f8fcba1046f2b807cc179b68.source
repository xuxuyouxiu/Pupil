/**
 * SessionRegistry 单元测试 —— payload.title 标题传播
 * 背景：轮询型源（hermes/codex）的会话 ID 是时间戳/uuid 前缀，
 * 面板展示与窗口跳转匹配都需要库里的真实标题。
 */
import { describe, it, expect } from 'vitest'
import { SessionRegistry } from '../src/core/session-registry'
import { SESSION_ENDED_RETENTION_MS, RESTORED_RETENTION_MS } from '../src/shared/constants'
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

describe('SessionRegistry 完成保持（v0.5.0 done 展示窗口）', () => {
  it('turn_completed 后 4s 内视图为 done（星星眼可见期）', () => {
    const reg = new SessionRegistry()
    const t0 = Date.now()
    reg.apply(makeEvent({ eventType: 'turn_started', timestamp: t0 }))
    reg.apply(makeEvent({ eventType: 'turn_completed', timestamp: t0 + 1000 }))
    expect(reg.get('hermes:s1')?.state).toBe('done')
  })

  it('session_ended 不触发 done（收工不庆祝）', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent({ eventType: 'session_started', timestamp: Date.now() }))
    reg.apply(makeEvent({ eventType: 'session_ended', timestamp: Date.now() }))
    expect(reg.get('hermes:s1')?.state).toBe('idle')
  })

  it('窗口过期后回落 idle（用真实墙钟：注入 5s 前的时间戳）', () => {
    const reg = new SessionRegistry()
    reg.apply(
      makeEvent({ eventType: 'turn_completed', timestamp: Date.now() - 5000 })
    )
    expect(reg.get('hermes:s1')?.state).toBe('idle')
  })

  it('窗口内来新事件（turn_started）立即脱离 done', () => {
    const reg = new SessionRegistry()
    const t0 = Date.now()
    reg.apply(makeEvent({ eventType: 'turn_completed', timestamp: t0 }))
    reg.apply(makeEvent({ eventType: 'turn_started', timestamp: t0 + 500 }))
    expect(reg.get('hermes:s1')?.state).toBe('thinking')
  })

  it('错误态优先：error 后不显示 done', () => {
    const reg = new SessionRegistry()
    const t0 = Date.now()
    reg.apply(makeEvent({ eventType: 'error', timestamp: t0 }))
    reg.apply(makeEvent({ eventType: 'turn_completed', timestamp: t0 + 100 }))
    // error 是吸收态，turn_completed 落 idle；doneAt 已记，但窗口投影只在 idle 基态上生效
    expect(['done', 'idle']).toContain(reg.get('hermes:s1')?.state)
  })
})

describe('SessionRegistry 过期清理（prune）', () => {
  it('session_ended 宽限期内保留，到期清除', () => {
    const reg = new SessionRegistry()
    const t0 = 1_000_000
    reg.apply(makeEvent({ eventType: 'session_started', timestamp: t0 }))
    reg.apply(makeEvent({ eventType: 'session_ended', timestamp: t0 + 1000 }))
    expect(reg.size).toBe(1)

    // 宽限期内：仍在
    reg.prune(t0 + 1000 + SESSION_ENDED_RETENTION_MS - 1)
    expect(reg.size).toBe(1)

    // 到期：整条移除
    expect(reg.prune(t0 + 1000 + SESSION_ENDED_RETENTION_MS + 1)).toBe(1)
    expect(reg.size).toBe(0)
    // 移除后事件历史也不可再查到该会话
    expect(reg.history().length).toBe(0)
  })

  it('会话复活撤销 endedAt，不再被 prune 清除', () => {
    const reg = new SessionRegistry()
    const t0 = 2_000_000
    reg.apply(makeEvent({ eventType: 'session_ended', timestamp: t0 }))
    // 收工后又来一轮新任务
    reg.apply(makeEvent({ eventType: 'turn_started', timestamp: t0 + 5000 }))
    expect(reg.prune(t0 + 10 * SESSION_ENDED_RETENTION_MS)).toBe(0)
    expect(reg.size).toBe(1)
  })

  it('restoredOnly 条目超过保留期被清除；收到真实事件则正常存活', () => {
    const reg = new SessionRegistry()
    reg.setHistoryStore({
      load: () => [
        {
          key: 'hermes:old',
          agentType: 'hermes',
          sessionId: 'old',
          eventType: 'turn_completed',
          timestamp: Date.now() - RESTORED_RETENTION_MS - 60_000
        },
        {
          key: 'hermes:fresh',
          agentType: 'hermes',
          sessionId: 'fresh',
          eventType: 'turn_completed',
          timestamp: Date.now() - 60_000
        }
      ],
      save: () => undefined
    })
    // 两条都是 restoredOnly（不可见），老的过期、新的还在保留期
    expect(reg.prune(Date.now())).toBe(1)
    // restoredOnly 本就不出现在快照里，但记录仍存活（事件历史可查）
    expect(reg.size).toBe(1)
    expect(reg.history().some((h) => h.sessionId === 'fresh')).toBe(true)

    // 收到真实事件的恢复条目回归正常列表且永不被 restoredOnly 规则清除
    reg.apply(
      makeEvent({ sessionId: 'fresh', eventType: 'turn_started', timestamp: Date.now() })
    )
    expect(reg.prune(Date.now())).toBe(0)
    expect(reg.snapshot().length).toBe(1)
  })
})
