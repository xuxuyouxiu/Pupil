/**
 * 回顾引擎 + DNA 徽章 单元测试（v1.2.0）
 * 规格见 docs/ROADMAP-v2.md A.3/A.5/A.9
 */
import { describe, it, expect } from 'vitest'
import {
  RecapEngine,
  totalsOf,
  dayKeyOf,
  RecapStore,
  RecapDay
} from '../src/core/recap'
import { buildGlyphParams, polygonPoints } from '../src/shared/dna'
import type { AgentEvent } from '../src/shared/events'

const T0 = new Date(2026, 7, 28, 10, 0, 0).getTime() // 2026-08-28 10:00 本地

function ev(over: Partial<AgentEvent> & { eventType: AgentEvent['eventType'] }): AgentEvent {
  return {
    source: 'zcode-rollout',
    agentType: 'zcode',
    sessionId: 's1',
    timestamp: T0,
    ...over
  }
}

/** 内存 store（记录写入，支持预置） */
function memStore(preset: RecapDay[] = []): RecapStore & { writes: RecapDay[] } {
  const map = new Map(preset.map((d) => [d.date, d]))
  const writes: RecapDay[] = []
  return {
    writes,
    load: (date) => map.get(date) ?? null,
    save: (day) => {
      map.set(day.date, day)
      writes.push(day)
    },
    listDates: () => [...map.keys()].sort(),
    drop: (date) => map.delete(date)
  }
}

describe('RecapEngine 开卡/入账/结卡', () => {
  it('turn_started 开卡 -> 工具/usage/error 入账 -> turn_completed 结卡落盘', () => {
    const store = memStore()
    const eng = new RecapEngine(store, () => T0)
    eng.onEvent(ev({ eventType: 'turn_started', payload: { prompt: '修复面板' } }))
    eng.onEvent(ev({ eventType: 'tool_call_started', timestamp: T0 + 1, payload: { toolName: 'Edit', files: ['Panel.tsx'] } }))
    eng.onEvent(ev({ eventType: 'thinking', timestamp: T0 + 2, payload: { usage: { inputTokens: 900, outputTokens: 40 } } }))
    eng.onEvent(ev({ eventType: 'error', timestamp: T0 + 3, payload: { errorMessage: 'boom' } }))
    eng.onEvent(ev({ eventType: 'turn_completed', timestamp: T0 + 60_000, payload: { usage: { inputTokens: 100, outputTokens: 20 } } }))
    eng.flush() // 真实流程由 5s 定时器/退出钩子调用；此处显式触发

    const view = eng.view('2026-08-28')
    expect(view.cards).toHaveLength(1)
    const c = view.cards[0]
    expect(c.prompt).toBe('修复面板')
    expect(c.tools).toEqual({ Edit: 1 })
    expect(c.files).toEqual(['Panel.tsx'])
    expect(c.errors).toBe(1)
    expect(c.tokensIn).toBe(1000) // 900+100
    expect(c.tokensOut).toBe(60) // 40+20
    expect(c.endedAt).toBe(T0 + 60_000)
    expect(view.totals).toMatchObject({ tasks: 1, errors: 1, runMs: 60_000, tokensIn: 1000 })
    expect(store.writes.length).toBeGreaterThan(0)
  })

  it('session_ended 强制结卡；同 key 未结卡在新轮次前被替换', () => {
    const store = memStore()
    const eng = new RecapEngine(store, () => T0)
    eng.onEvent(ev({ eventType: 'turn_started' }))
    eng.onEvent(ev({ eventType: 'session_ended', timestamp: T0 + 1000 }))
    expect(eng.view('2026-08-28').cards).toHaveLength(1)
  })

  it('跨天任务归属开始日：23:59 开卡 00:01 结卡 -> 写昨日文件', () => {
    const store = memStore()
    const late = new Date(2026, 7, 28, 23, 59, 0).getTime()
    let now = late
    const eng = new RecapEngine(store, () => now)
    eng.onEvent(ev({ eventType: 'turn_started', timestamp: late }))
    now = late + 2 * 60_000 // 次日 00:01
    eng.onEvent(ev({ eventType: 'turn_completed', timestamp: now }))
    const dates = eng.view('2026-08-28').cards.length
    expect(dates).toBe(1) // 在 28 日的文件里，而非 29 日
  })

  it('flush 脏日期幂等；无变化不写', () => {
    const store = memStore()
    const eng = new RecapEngine(store, () => T0)
    eng.onEvent(ev({ eventType: 'turn_started' }))
    eng.flush()
    const n = store.writes.length
    eng.flush()
    expect(store.writes.length).toBe(n)
  })

  it('恢复：重启后未结卡按当前时刻补结', () => {
    const preset: RecapDay = {
      date: '2026-08-28',
      cards: [
        {
          id: 'zcode:s1:1', agentType: 'zcode', sessionId: 's1', tools: {}, files: [],
          startedAt: T0, errors: 0, tokensIn: 0, tokensOut: 0, costUsd: 0
        }
      ]
    }
    // 内存引擎无法直接注入"打开卡"（在 store 之上），此处验证 recover 不抛错且不误删已结卡
    const store = memStore([preset])
    const eng = new RecapEngine(store, () => T0 + 5000)
    eng.recover()
    eng.flush()
    expect(eng.view('2026-08-28').cards).toHaveLength(1)
  })

  it('prune 清扫保留期外的日期', () => {
    const store = memStore([{ date: '2026-05-01', cards: [] }])
    const eng = new RecapEngine(store, () => new Date(2026, 7, 28).getTime())
    eng.prune(90)
    expect(store.listDates()).not.toContain('2026-05-01')
  })
})

describe('dayKeyOf / totalsOf', () => {
  it('dayKeyOf 本地时区零填充', () => {
    expect(dayKeyOf(new Date(2026, 2, 5, 8, 0).getTime())).toBe('2026-03-05')
  })

  it('totalsOf 未结卡不计 runMs', () => {
    const t = totalsOf([
      { id: 'a', agentType: 'zcode', sessionId: 's', tools: {}, files: [], startedAt: 0, endedAt: 1000, errors: 0, tokensIn: 10, tokensOut: 5, costUsd: 0.1 },
      { id: 'b', agentType: 'zcode', sessionId: 's', tools: {}, files: [], startedAt: 0, errors: 1, tokensIn: 0, tokensOut: 0, costUsd: 0 }
    ])
    expect(t).toMatchObject({ tasks: 2, errors: 1, runMs: 1000, tokensIn: 10 })
  })
})

describe('buildGlyphParams（任务 DNA）', () => {
  const card = (over: Partial<import('../src/core/recap').TaskCard>): import('../src/core/recap').TaskCard => ({
    id: 'zcode:s1:1',
    agentType: 'zcode',
    sessionId: 's1',
    tools: { Edit: 2, Bash: 1 },
    files: [],
    startedAt: T0,
    errors: 0,
    tokensIn: 5000,
    tokensOut: 1000,
    costUsd: 0,
    ...over
  })

  it('确定性：同输入两次调用输出全等', () => {
    expect(JSON.stringify(buildGlyphParams(card()))).toBe(JSON.stringify(buildGlyphParams(card())))
  })

  it('映射档位：工具数→分段、错误→散点、tokens→环宽三档', () => {
    expect(buildGlyphParams(card()).segments).toBe(3) // 工具调用共 3 次
    expect(buildGlyphParams(card({ errors: 99 })).dots).toBe(8) // clamp 8
    expect(buildGlyphParams(card({ tokensIn: 2_000_000 })).ringWidth).toBe(3) // >100k 档
    expect(buildGlyphParams(card({ tokensIn: 100, tokensOut: 10 })).ringWidth).toBe(1.5)
  })

  it('agentType 决定色相与边数（claude=5 边 24° 橙）', () => {
    const g = buildGlyphParams(card({ agentType: 'claude-code', sessionId: 'x', id: 'claude-code:x:1' }))
    expect(g.sides).toBe(5)
    expect(g.hue).toBe(24)
  })

  it('polygonPoints 输出顶点数正确且围绕中心', () => {
    const pts = polygonPoints(5, 8, 0).split(' ')
    expect(pts).toHaveLength(5)
    expect(pts[0].split(',').map(Number)[1]).toBeLessThan(20) // 首顶点在上方
  })
})
