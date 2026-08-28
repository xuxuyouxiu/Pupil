/**
 * ZCode rollout 映射单元测试 —— v1.0.3 真实信号版（turnId / finishReason / usage）
 */
import { describe, it, expect } from 'vitest'
import { mapModelIoLine, deriveSessionId } from '../src/adapters/zcode/log-adapter'

const T0 = 1_756_000_000_000

/** 造一行 model_io */
function modelIo(opts: {
  turnId?: string
  finishReason?: string
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  error?: unknown
  completedAt?: unknown
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: 'model_io',
    requestId: 'req-1',
    attempt: 1,
    model: 'glm-test',
    request: { messages: [] }
  }
  if ('turnId' in opts) line.turnId = opts.turnId
  if (opts.usage) {
    line.response = {
      finishReason: opts.finishReason,
      usage: opts.usage
    }
  } else if (opts.finishReason !== undefined) {
    line.response = { finishReason: opts.finishReason }
  }
  if (opts.error !== undefined) line.error = opts.error
  if ('completedAt' in opts) line.completedAt = opts.completedAt
  return line
}

function types(line: Record<string, unknown>, prevTurnId: string | undefined): string[] {
  return mapModelIoLine(line, prevTurnId).events.map((e) => e.eventType)
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

describe('mapModelIoLine 轮次边界（turnId）', () => {
  it('turnId 首见 -> turn_started', () => {
    expect(types(modelIo({ turnId: 't1', finishReason: 'tool-calls' }), undefined)).toContain(
      'turn_started'
    )
  })

  it('同一 turnId 的续行不再触发 turn_started', () => {
    expect(
      types(modelIo({ turnId: 't1', finishReason: 'tool-calls' }), 't1')
    ).not.toContain('turn_started')
  })

  it('turnId 变化 -> 新一轮 turn_started', () => {
    expect(types(modelIo({ turnId: 't2', finishReason: 'tool-calls' }), 't1')).toContain(
      'turn_started'
    )
  })

  it('无 turnId 的行不触发轮次开始（stop 收敛后不再有活动脉冲）', () => {
    const events = types(modelIo({ finishReason: 'stop' }), 't1')
    expect(events).not.toContain('turn_started')
    expect(events).toEqual(['turn_completed']) // 收敛行只有完成事件，不再跟脉冲
  })
})

describe('mapModelIoLine 完成判定（finishReason）', () => {
  it('finishReason=stop -> 即刻 turn_completed（修复：答完还显示思考一两分钟）', () => {
    expect(types(modelIo({ turnId: 't1', finishReason: 'stop' }), 't1')).toContain(
      'turn_completed'
    )
  })

  it('finishReason=end_turn / length 同样视为收敛', () => {
    for (const fr of ['end_turn', 'length']) {
      expect(types(modelIo({ turnId: 't1', finishReason: fr }), 't1')).toContain(
        'turn_completed'
      )
    }
  })

  it('finishReason=tool-calls -> 工具续行，不完成（等工具结果回传）', () => {
    expect(
      types(modelIo({ turnId: 't1', finishReason: 'tool-calls' }), 't1')
    ).not.toContain('turn_completed')
  })

  it('finishReason 缺失 -> 不判定完成（adapter 静默启发式兜底）', () => {
    expect(types(modelIo({ turnId: 't1' }), 't1')).not.toContain('turn_completed')
  })
})

describe('mapModelIoLine 用量提取（response.usage）', () => {
  it('inputTokens 已含缓存读/写时正确拆回各分量（usage 挂在收敛事件上）', () => {
    const mapped = mapModelIoLine(
      modelIo({
        turnId: 't1',
        finishReason: 'stop',
        usage: { inputTokens: 558_926, outputTokens: 619, cacheReadTokens: 556_672, cacheWriteTokens: 100 }
      }),
      't1'
    )
    // v1.1.2：收敛行只发 turn_completed（无脉冲），usage 挂在它上面
    const usageEv = mapped.events.find((e) => e.payload?.usage)
    expect(usageEv?.eventType).toBe('turn_completed')
    expect(usageEv?.payload?.usage).toMatchObject({
      inputTokens: 558_926 - 556_672 - 100, // 真实输入 = 总输入 - 缓存读 - 缓存写
      outputTokens: 619,
      cacheReadTokens: 556_672,
      cacheCreationTokens: 100
    })
  })

  it('tool-calls 续行（回合进行中）的 usage 挂在 thinking 脉冲上', () => {
    const mapped = mapModelIoLine(
      modelIo({
        turnId: 't1',
        finishReason: 'tool-calls',
        usage: { inputTokens: 900, outputTokens: 40 }
      }),
      't1'
    )
    const usageEv = mapped.events.find((e) => e.payload?.usage)
    expect(usageEv?.eventType).toBe('thinking')
    expect(usageEv?.payload?.usage).toMatchObject({ inputTokens: 900, outputTokens: 40 })
  })

  it('全零用量不产出 usage 载荷', () => {
    const mapped = mapModelIoLine(
      modelIo({ turnId: 't1', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }),
      't1'
    )
    expect(mapped.events.every((e) => !e.payload?.usage)).toBe(true)
  })
})

describe('mapModelIoLine 其他', () => {
  it('error 字段 -> error 事件并透出 message', () => {
    const events = types(modelIo({ turnId: 't1', error: { message: 'rate limited' } }), 't1')
    expect(events).toContain('error')
    const mapped = mapModelIoLine(
      modelIo({ turnId: 't1', error: { message: 'rate limited' } }),
      't1'
    )
    const errEv = mapped.events.find((e) => e.eventType === 'error')
    expect(errEv?.payload?.errorMessage).toBe('rate limited')
  })

  it('completedAt 缺失/畸形不抛错（回退当前时间）', () => {
    const before = Date.now()
    const mapped = mapModelIoLine(modelIo({}), undefined)
    for (const ev of mapped.events) expect(ev.timestamp).toBeGreaterThanOrEqual(before)
    const [ev] = mapModelIoLine(modelIo({ completedAt: 'garbage' }), undefined).events
    expect(Number.isFinite(ev.timestamp)).toBe(true)
  })

  it('秒级时间戳被放大为毫秒', () => {
    const mapped = mapModelIoLine(modelIo({ completedAt: 1_756_000_000 }), undefined)
    expect(mapped.events[0].timestamp).toBe(1_756_000_000_000)
  })
})
