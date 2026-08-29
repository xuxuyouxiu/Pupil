/**
 * 闲时杂技状态机 单元测试（v1.4.0）—— 注入时钟
 * 规格见 docs/ROADMAP-v2.md 批次 C
 */
import { describe, it, expect } from 'vitest'
import { JuggleScheduler, DEFAULT_JUGGLE_CONFIG } from '../src/renderer/ball/juggle'

const T0 = 1_756_000_000_000
const CFG = { idleThresholdMs: 1000, minIntervalMs: 2000, maxIntervalMs: 3000, durationMs: 500 }

describe('JuggleScheduler', () => {
  it('空闲不足阈值不触发', () => {
    const s = new JuggleScheduler(CFG)
    expect(s.tick(true, T0)).toBe(false)
    expect(s.tick(true, T0 + 900)).toBe(false)
  })

  it('空闲超阈值进入 armed，到随机时点触发 performing', () => {
    const s = new JuggleScheduler(CFG, () => 0) // 随机恒 0 → 间隔=min=2000
    s.tick(true, T0)
    s.tick(true, T0 + 1000) // armed，nextAt=T0+1000+2000
    expect(s.tick(true, T0 + 2000)).toBe(false)
    expect(s.tick(true, T0 + 3000)).toBe(true) // performing
    expect(s.currentPhase).toBe('performing')
  })

  it('performing 满 duration 后回落 armed 并重新调度', () => {
    const s = new JuggleScheduler(CFG, () => 0)
    s.tick(true, T0)
    s.tick(true, T0 + 1000)
    s.tick(true, T0 + 3000) // 触发
    expect(s.tick(true, T0 + 3400)).toBe(true) // 700ms 内仍 performing
    expect(s.tick(true, T0 + 3600)).toBe(false) // 超时回落
  })

  it('非空闲立即打断并清零计时', () => {
    const s = new JuggleScheduler(CFG, () => 0)
    s.tick(true, T0)
    s.tick(true, T0 + 1000)
    s.tick(false, T0 + 2000) // 有会话在跑
    expect(s.currentPhase).toBe('idle')
    s.tick(true, T0 + 2500) // 重新计 1s（未满）
    expect(s.tick(true, T0 + 3000)).toBe(false) // 空闲仅 500ms
  })

  it('用户交互 poke 强制重新冷却', () => {
    const s = new JuggleScheduler(CFG, () => 0)
    s.tick(true, T0)
    s.tick(true, T0 + 1000) // armed
    s.poke(T0 + 1500) // 摸了一下球
    expect(s.currentPhase).toBe('idle')
    s.tick(true, T0 + 2200) // 空闲仅 700ms
    expect(s.currentPhase).toBe('idle')
  })

  it('默认配置值符合 ROADMAP 规格', () => {
    expect(DEFAULT_JUGGLE_CONFIG).toMatchObject({
      idleThresholdMs: 90_000,
      minIntervalMs: 120_000,
      maxIntervalMs: 300_000,
      durationMs: 7_000
    })
  })
})
