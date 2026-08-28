/**
 * ZCode rollout 映射单元测试 —— mapModelIoLine / deriveSessionId
 */
import { describe, it, expect } from 'vitest'
import { mapModelIoLine, deriveSessionId } from '../src/adapters/zcode/log-adapter'

const T0 = 1_756_000_000_000

/** 造一行 model_io：messages 为全量上下文快照 */
function modelIo(opts: {
  promptCount?: number
  roles?: string[]
  error?: unknown
  completedAt?: unknown
}): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  for (let i = 0; i < (opts.promptCount ?? 1); i++) {
    messages.push({ role: 'user', content: `第 ${i + 1} 个任务` })
    messages.push({ role: 'assistant', content: '回复' })
    messages.push({ role: 'tool', content: '工具结果' })
  }
  void opts.roles
  return {
    type: 'model_io',
    requestId: 'req-1',
    attempt: 1,
    model: 'glm-test',
    request: { messages },
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    // 仅显式传入 completedAt 时才带该键（undefined 意味着整键缺失，测真实回退路径）
    ...('completedAt' in opts ? { completedAt: opts.completedAt } : {})
  }
}

describe('deriveSessionId', () => {
  it('去掉 model-io-sess_ 前缀与 .jsonl 后缀', () => {
    expect(deriveSessionId('C:/u/.zcode/cli/rollout/model-io-sess_2489d061-abc.jsonl')).toBe(
      '2489d061-abc'
    )
  })

  it('subagent 文件名保有其自身前缀（独立会话身份）', () => {
    expect(deriveSessionId('model-io-sess_subagent_agent_777f-x.jsonl')).toBe(
      'subagent_agent_777f-x'
    )
  })
})

describe('mapModelIoLine', () => {
  it('首个 prompt 行 -> turn_started + thinking 脉冲', () => {
    const events = mapModelIoLine(modelIo({ promptCount: 1 }), 0)
    const types = events.map((e) => e.eventType)
    expect(types).toContain('turn_started')
    expect(types[types.length - 1]).toBe('thinking') // 活动脉冲收尾
  })

  it('后续纯工具/回复行不再触发 turn_started（计数未增）', () => {
    const events = mapModelIoLine(modelIo({ promptCount: 2 }), 2)
    expect(events.map((e) => e.eventType)).not.toContain('turn_started')
    expect(events.map((e) => e.eventType)).toContain('thinking')
  })

  it('第二条 user prompt 出现时再触发一次 turn_started', () => {
    const events = mapModelIoLine(modelIo({ promptCount: 3 }), 2)
    expect(events.filter((e) => e.eventType === 'turn_started')).toHaveLength(1)
  })

  it('工具结果伪装的 user 消息不计入轮次（role=user 但 content 含 tool_result）', () => {
    const line = modelIo({ promptCount: 1 })
    const req = line.request as { messages: unknown[] }
    req.messages.push({ role: 'user', content: [{ type: 'tool_result', content: 'ok' }] })
    // 快照里有这条伪造 user，但计数仍是 1 个真 prompt
    const events = mapModelIoLine(line, 1)
    expect(events.map((e) => e.eventType)).not.toContain('turn_started')
  })

  it('行带 error 时产生 error 事件并透出 message', () => {
    const events = mapModelIoLine(modelIo({ promptCount: 1, error: { message: 'rate limited' } }), 1)
    const errEv = events.find((e) => e.eventType === 'error')
    expect(errEv).toBeDefined()
    expect(errEv?.payload?.errorMessage).toBe('rate limited')
  })

  it('completedAt 缺失或畸形时不抛错、回退当前时间', () => {
    const before = Date.now()
    const events = mapModelIoLine(modelIo({ completedAt: undefined }), 0)
    for (const ev of events) expect(ev.timestamp).toBeGreaterThanOrEqual(before)
    const [ev] = mapModelIoLine(modelIo({ completedAt: 'garbage' as never }), 0)
    expect(Number.isFinite(ev.timestamp)).toBe(true)
  })

  it('秒级时间戳被放大为毫秒', () => {
    const [ev] = mapModelIoLine(modelIo({ completedAt: 1_756_000_000 }), 0)
    expect(ev.timestamp).toBe(1_756_000_000_000)
  })
})
