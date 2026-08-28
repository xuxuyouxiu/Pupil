/**
 * 推断引擎 + 通知规则单元测试
 */
import { describe, it, expect } from 'vitest'
import { SessionRegistry } from '../src/core/session-registry'
import { InferenceEngine } from '../src/core/inference'
import { resolveStrategy, notifyAllowed } from '../src/core/notify-rules'
import type { AgentEvent, AgentEventType } from '../src/shared/events'

function makeEvent(
  eventType: AgentEventType,
  overrides: Partial<AgentEvent> = {}
): AgentEvent {
  return {
    source: 'test',
    agentType: 'custom',
    sessionId: 's1',
    eventType,
    timestamp: 1_000_000,
    ...overrides
  }
}

function makeRegistry(): SessionRegistry {
  const reg = new SessionRegistry()
  reg.apply(makeEvent('turn_started'))
  return reg
}

describe('InferenceEngine', () => {
  it('未超阈值不打标记', () => {
    const reg = makeRegistry()
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    const changed = eng.tick(1_000_000 + 10_000)
    expect(changed).toHaveLength(0)
  })

  it('超过 disconnect 阈值打 disconnected', () => {
    const reg = makeRegistry()
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    const changed = eng.tick(1_000_000 + 31_000)
    expect(changed).toHaveLength(1)
    expect(changed[0].flags.disconnected).toBe(true)
    expect(changed[0].flags.timeout).toBe(false)
  })

  it('非 idle 超过 timeout 阈值：timeout + disconnected 同时成立', () => {
    const reg = makeRegistry()
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    const changed = eng.tick(1_000_000 + 11 * 60 * 1000)
    expect(changed[0].flags.timeout).toBe(true)
    expect(changed[0].flags.disconnected).toBe(true)
  })

  it('idle 会话静默不打任何标记（等下一句是正常等待）', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent('session_started'))
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    const changed = eng.tick(1_000_000 + 20 * 60 * 1000)
    expect(changed).toHaveLength(0) // idle 静默既不超时也不断连
  })

  it('waiting_input 静默不打断连标记（等用户确认是正常等待）', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent('turn_started'))
    reg.apply(makeEvent('waiting_input'))
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    const changed = eng.tick(1_000_000 + 60_000)
    expect(changed).toHaveLength(0)
  })

  it('waiting_input 超过 timeout 阈值也不打超时标记（挂机未确认 ≠ 卡死）', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent('turn_started'))
    reg.apply(makeEvent('waiting_input'))
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    const changed = eng.tick(1_000_000 + 11 * 60 * 1000)
    expect(changed).toHaveLength(0)
  })

  it('error 态静默不再叠加超时通知（报错时已提醒过，避免二次响铃）', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent('turn_started'))
    reg.apply(makeEvent('error', { payload: { errorMessage: 'boom' } }))
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    const changed = eng.tick(1_000_000 + 11 * 60 * 1000)
    expect(changed).toHaveLength(0)
  })

  it('运行中静默超阈值才打 disconnected', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent('turn_started'))
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    const changed = eng.tick(1_000_000 + 31_000)
    expect(changed).toHaveLength(1)
    expect(changed[0].flags.disconnected).toBe(true)
    expect(changed[0].state).toBe('thinking')
  })

  it('新事件清除叠加标记（恢复即清除）', () => {
    const reg = makeRegistry()
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    eng.tick(1_000_000 + 31_000)
    const view = reg.apply(makeEvent('thinking', { timestamp: 1_050_000 }))
    expect(view.flags.timeout).toBe(false)
    expect(view.flags.disconnected).toBe(false)
  })

  it('heartbeat 续期清除 disconnected', () => {
    const reg = makeRegistry()
    const eng = new InferenceEngine(reg, {
      timeoutThresholdMs: 10 * 60 * 1000,
      disconnectThresholdMs: 30 * 1000
    })
    eng.tick(1_000_000 + 31_000)
    const view = reg.heartbeat('custom:s1', 1_100_000)
    expect(view?.flags.disconnected).toBe(false)
    expect(view?.lastEventAt).toBe(1_100_000)
  })
})

describe('SessionRegistry 历史投影', () => {
  it('history 返回跨会话合并时间线（倒序）', () => {
    const reg = new SessionRegistry()
    reg.apply(makeEvent('turn_started', { sessionId: 'a', timestamp: 100 }))
    reg.apply(makeEvent('turn_completed', { sessionId: 'a', timestamp: 300 }))
    reg.apply(makeEvent('turn_started', { sessionId: 'b', timestamp: 200 }))

    const h = reg.history()
    expect(h.map((x) => x.timestamp)).toEqual([300, 200, 100])
  })

  it('环形缓冲截断：每会话最多保留 EVENT_RING_BUFFER_SIZE 条', async () => {
    const { EVENT_RING_BUFFER_SIZE } = await import('../src/shared/constants')
    const reg = new SessionRegistry()
    for (let i = 0; i < EVENT_RING_BUFFER_SIZE + 50; i++) {
      reg.apply(makeEvent('heartbeat', { timestamp: i }))
    }
    const h = reg.history()
    expect(h).toHaveLength(EVENT_RING_BUFFER_SIZE)
  })

  it('limit 参数生效', () => {
    const reg = new SessionRegistry()
    for (let i = 0; i < 10; i++) {
      reg.apply(makeEvent('heartbeat', { timestamp: i }))
    }
    expect(reg.history(3)).toHaveLength(3)
    // 取的是最新 3 条
    expect(reg.history(3).map((x) => x.timestamp)).toEqual([9, 8, 7])
  })
})

describe('resolveStrategy 通知规则', () => {
  it('running/idle 类事件不触发音效与 Toast', () => {
    const view = new SessionRegistry().apply(makeEvent('turn_started'))
    for (const ev of ['turn_started', 'thinking', 'tool_call_started'] as AgentEventType[]) {
      const s = resolveStrategy(makeEvent(ev), view, { dnd: false, muted: false })
      expect(s.sound).toBe(false)
      expect(s.toast).toBe(false)
    }
  })

  it('done 触发音效 + Toast', () => {
    const reg = new SessionRegistry()
    const view = reg.apply(makeEvent('turn_started'))
    const s = resolveStrategy(makeEvent('turn_completed'), view, { dnd: false, muted: false })
    expect(s.displayState).toBe('done')
    expect(s.sound).toBe(true)
    expect(s.toast).toBe(true)
    expect(s.title).toContain('已完成')
  })

  it('waiting/error 触发强提醒', () => {
    const reg = new SessionRegistry()
    const v1 = reg.apply(makeEvent('waiting_input'))
    const s1 = resolveStrategy(makeEvent('waiting_input'), v1, { dnd: false, muted: false })
    expect(s1.sound).toBe(true)
    expect(s1.toast).toBe(true)

    const errEvent = makeEvent('error', { payload: { errorMessage: 'boom' } })
    const v2 = reg.apply(errEvent)
    const s2 = resolveStrategy(errEvent, v2, { dnd: false, muted: false })
    expect(s2.sound).toBe(true)
    expect(s2.body).toBe('boom')
  })

  it('勿扰模式抑制音效与 Toast，仅保留视觉', () => {
    const view = new SessionRegistry().apply(makeEvent('turn_started'))
    const s = resolveStrategy(makeEvent('waiting_input'), view, { dnd: true, muted: false })
    expect(s.sound).toBe(false)
    expect(s.toast).toBe(false)
  })

  it('静音关音效但保留 Toast', () => {
    const view = new SessionRegistry().apply(makeEvent('turn_started'))
    const s = resolveStrategy(makeEvent('waiting_input'), view, { dnd: false, muted: true })
    expect(s.sound).toBe(false)
    expect(s.toast).toBe(true)
  })

  it('session_ended 不弹通知（避免噪音）', () => {
    const view = new SessionRegistry().apply(makeEvent('turn_started'))
    const s = resolveStrategy(makeEvent('session_ended'), view, { dnd: false, muted: false })
    expect(s.toast).toBe(false)
  })
})

describe('notifyAllowed 通知粒度（v0.8.0）', () => {
  it('默认放行五类可提醒事件', () => {
    expect(notifyAllowed('turn_completed')).toBe(true)
    expect(notifyAllowed('waiting_input')).toBe(true)
    expect(notifyAllowed('error')).toBe(true)
    expect(notifyAllowed('timeout')).toBe(true)
    expect(notifyAllowed('offline')).toBe(true)
  })

  it('session_ended 默认关闭（收工音默认不响）', () => {
    expect(notifyAllowed('session_ended')).toBe(false)
  })

  it('用户显式关闭的类别被拦截，打开的放行', () => {
    const filter = { turn_completed: false, timeout: true }
    expect(notifyAllowed('turn_completed', filter)).toBe(false)
    expect(notifyAllowed('timeout', filter)).toBe(true)
  })

  it('生命周期/工具事件不经过粒度过滤（规则引擎本就不为它们发声）', () => {
    expect(notifyAllowed('turn_started')).toBe(true)
    expect(notifyAllowed('tool_call_started')).toBe(true)
    expect(notifyAllowed('heartbeat')).toBe(true)
  })
})
