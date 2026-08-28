/**
 * 诊断性回归：ZCode 真实事件序列 -> SessionRegistry -> SessionView.usage
 * 复现用户场景：v1.1.0 面板不显示 ZCode 用量
 */
import { describe, it, expect } from 'vitest'
import { SessionRegistry } from '../src/core/session-registry'
import type { AgentEvent } from '../src/shared/events'

const T0 = 1_756_000_000_000
const base = (over: Partial<AgentEvent>): AgentEvent => ({
  source: 'zcode-rollout',
  agentType: 'zcode',
  sessionId: 'sess_x',
  timestamp: T0,
  ...over
})

describe('ZCode 用量累计链路（v1.1.0 用户场景）', () => {
  it('thinking 带 usage -> view.usage 出现累计值', () => {
    const reg = new SessionRegistry()
    reg.apply(base({ eventType: 'session_started' }))
    reg.apply(base({ eventType: 'turn_started', timestamp: T0 + 1 }))
    reg.apply(
      base({
        eventType: 'thinking',
        timestamp: T0 + 2,
        payload: { usage: { inputTokens: 100, outputTokens: 50 } }
      })
    )
    const view = reg.get('zcode:sess_x')
    expect(view?.usage).toBeDefined()
    expect(view?.usage?.totalIn).toBe(100)
    expect(view?.usage?.totalOut).toBe(50)
  })

  it('带缓存的 usage：totalIn 含缓存读/写，turnIn 只含真实输入+缓存写', () => {
    const reg = new SessionRegistry()
    reg.apply(base({ eventType: 'turn_started' }))
    reg.apply(
      base({
        eventType: 'thinking',
        payload: {
          usage: { inputTokens: 2254, outputTokens: 619, cacheReadTokens: 556_672, cacheCreationTokens: 100 }
        }
      })
    )
    const v = reg.get('zcode:sess_x')?.usage
    expect(v?.totalIn).toBe(2254 + 556_672 + 100)
    expect(v?.turnIn).toBe(2254 + 100)
  })

  it('turn_started 重置本轮但不减总额（跨轮累计保留）', () => {
    const reg = new SessionRegistry()
    reg.apply(base({ eventType: 'turn_started' }))
    reg.apply(base({ eventType: 'thinking', payload: { usage: { inputTokens: 100, outputTokens: 10 } } }))
    reg.apply(base({ eventType: 'turn_started', timestamp: T0 + 10 }))
    reg.apply(base({ eventType: 'thinking', payload: { usage: { inputTokens: 200, outputTokens: 20 } } }))
    const v = reg.get('zcode:sess_x')?.usage
    expect(v?.turnIn).toBe(200)
    expect(v?.totalIn).toBe(300)
  })

  it('会话重启恢复场景：session_started 直接带 usage（Hermes/CodeX 模式）也入账', () => {
    const reg = new SessionRegistry()
    reg.apply(base({ eventType: 'session_started', payload: { usage: { inputTokens: 5000, outputTokens: 300 } } }))
    expect(reg.get('zcode:sess_x')?.usage?.totalIn).toBe(5000)
  })
})
