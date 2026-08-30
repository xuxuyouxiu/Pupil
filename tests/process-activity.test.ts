/**
 * ProcessActivityTracker 单元测试（v1.7.0）—— 进程活性信号的滑动窗口判定
 */
import { describe, it, expect } from 'vitest'
import { ProcessActivityTracker } from '../src/core/process-activity'

describe('ProcessActivityTracker', () => {
  it('持续忙的进程 -> anyBusy true', () => {
    const t = new ProcessActivityTracker()
    // 每秒采样：500ms CPU（多线程 >50% 但 clamp 到 1 → 滑动平均高位）
    for (let i = 0; i <= 5; i++) {
      t.sample([{ pid: 100, cpuMs: i * 1000 + 500 }], 1000 * i)
    }
    expect(t.anyBusy()).toBe(true)
  })

  it('彻底空闲的进程 -> anyBusy false', () => {
    const t = new ProcessActivityTracker()
    // 空闲进程：每秒 CPU 增长 10ms（≈1% 单核占用，低于 5% 阈值）
    for (let i = 0; i <= 5; i++) {
      t.sample([{ pid: 100, cpuMs: 100 + i * 10 }], 1000 * i)
    }
    expect(t.anyBusy()).toBe(false)
  })

  it('忙转闲：滑动平均衰减到阈值以下', () => {
    const t = new ProcessActivityTracker()
    for (let i = 0; i <= 10; i++) {
      t.sample([{ pid: 100, cpuMs: i * 1000 + 800 }], i * 1000)
    }
    expect(t.anyBusy()).toBe(true)
    // 之后 60 秒完全空闲
    for (let i = 1; i <= 60; i++) {
      t.sample([{ pid: 100, cpuMs: 10_800 }], 10_000 + i * 1000)
    }
    expect(t.anyBusy()).toBe(false)
  })

  it('退出的进程从跟踪表清理', () => {
    const t = new ProcessActivityTracker()
    t.sample([{ pid: 1, cpuMs: 100 }], 0)
    expect(t.tracked()).toContain(1)
    t.sample([{ pid: 2, cpuMs: 200 }], 2000) // pid 1 消失
    expect(t.tracked()).not.toContain(1)
    expect(t.tracked()).toContain(2)
  })

  it('CPU 计数器回绕/重置按新进程处理不误判', () => {
    const t = new ProcessActivityTracker()
    t.sample([{ pid: 1, cpuMs: 999_999 }], 0)
    t.sample([{ pid: 1, cpuMs: 5 }], 1000) // 计数器回绕
    expect(t.anyBusy()).toBe(false)
  })
})
