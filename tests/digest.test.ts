/**
 * DailyDigest 单元测试 —— v0.11.0 每日简报纯类（注入时钟）
 */
import { describe, it, expect } from 'vitest'
import { DailyDigest } from '../src/core/digest'

/** 固定起始时刻：2026-08-27 10:00 本地 */
const BASE = new Date(2026, 7, 27, 10, 0, 0).getTime()

function harness(hour: number, start: number = BASE) {
  const fires: ReturnType<DailyDigest['peek']>[] = []
  let now = start
  const d = new DailyDigest(hour, (s) => fires.push(s), () => now)
  return {
    d,
    fires,
    advance(ms: number) {
      now += ms
      d.tick()
    }
  }
}

describe('DailyDigest', () => {
  it('hour 点之前不触发', () => {
    const h = harness(21)
    h.d.onEvent('turn_completed', { runMs: 60_000 })
    h.advance(2 * 3_600_000) // 12:00
    expect(h.fires).toHaveLength(0)
  })

  it('到达 hour 点后首次 tick 触发并清零', () => {
    const h = harness(21)
    h.d.onEvent('turn_completed', { runMs: 60_000 })
    h.d.onEvent('turn_completed', { runMs: 30_000 })
    h.d.onEvent('error')
    h.advance(11 * 3_600_000) // 21:00
    expect(h.fires).toHaveLength(1)
    expect(h.fires[0]).toMatchObject({ completed: 2, errors: 1, runMs: 90_000 })
    expect(h.d.peek()).toMatchObject({ completed: 0, errors: 0 })
  })

  it('同一天只触发一次', () => {
    const h = harness(21)
    h.d.onEvent('turn_completed')
    h.advance(11 * 3_600_000) // 21:00 触发
    h.d.onEvent('turn_completed')
    h.advance(2 * 3_600_000) // 23:00 不再触发
    expect(h.fires).toHaveLength(1)
  })

  it('零计数不触发（无事件的安静日）', () => {
    const h = harness(21)
    h.advance(11 * 3_600_000)
    expect(h.fires).toHaveLength(0)
  })

  it('usage 计入简报（cache 读也算输入侧）', () => {
    const h = harness(21)
    h.d.onEvent('turn_completed', {
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 }
    })
    h.advance(11 * 3_600_000)
    expect(h.fires[0]).toMatchObject({ tokensIn: 1200, tokensOut: 500 })
  })

  it('第二天再次到点会触发（隔日循环）', () => {
    const h = harness(21)
    h.d.onEvent('turn_completed')
    h.advance(11 * 3_600_000) // 第一天 21:00
    h.advance(24 * 3_600_000) // 次日 21:00 前 tick 一次
    h.d.onEvent('turn_completed')
    h.advance(3_600_000)
    expect(h.fires).toHaveLength(2)
  })
})
