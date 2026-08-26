/**
 * PettingArbiter 手势仲裁单测
 * 用受控时钟验证：单击/双击/三连点/长按摸头/拖动取消/长按吞单击
 */
import { describe, expect, it } from 'vitest'
import { GestureEvent, PettingArbiter } from '../src/renderer/ball/petting'

/** 受控时钟：手动推进的 setTimeout/clearTimeout */
function makeClock() {
  type Job = { fn: () => void; at: number }
  let now = 0
  const jobs: Job[] = []
  return {
    schedule(fn: () => void, ms: number): unknown {
      const job: Job = { fn, at: now + ms }
      jobs.push(job)
      return job
    },
    cancel(t: unknown): void {
      const i = jobs.indexOf(t as Job)
      if (i >= 0) jobs.splice(i, 1)
    },
    advance(ms: number): void {
      const target = now + ms
      for (;;) {
        const next = jobs.filter((j) => j.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        jobs.splice(jobs.indexOf(next), 1)
        now = Math.max(now, next.at)
        next.fn()
      }
      now = target
    }
  }
}

function setup() {
  const clock = makeClock()
  const events: GestureEvent[] = []
  const arbiter = new PettingArbiter(
    (e) => events.push(e),
    {},
    clock.schedule,
    clock.cancel
  )
  return { arbiter, events, ...clock }
}

describe('PettingArbiter 单击', () => {
  it('单次点击在合并窗口结束后发出 click 与 poke', () => {
    const t = setup()
    t.arbiter.pointerDown(10, 10, 0)
    t.advance(50)
    t.arbiter.pointerUp(50)
    // 立即只有 poke，click 要等 260ms 合并窗口
    expect(t.events.map((e) => e.type)).toEqual(['poke'])
    t.advance(260)
    expect(t.events.map((e) => e.type)).toEqual(['poke', 'click'])
  })

  it('拖动（移动超 4px）不产生任何 click', () => {
    const t = setup()
    t.arbiter.pointerDown(10, 10, 0)
    t.arbiter.pointerMove(20, 10, 20)
    t.advance(100)
    t.arbiter.pointerUp(100)
    t.advance(500)
    expect(t.events).toEqual([])
  })
})

describe('PettingArbiter 双击与三连点', () => {
  it('快速两击 → double（立即）+ 无 click', () => {
    const t = setup()
    for (let i = 0; i < 2; i++) {
      t.arbiter.pointerDown(10, 10, i * 120)
      t.advance(30)
      t.arbiter.pointerUp(i * 120 + 30)
    }
    expect(t.events.map((e) => e.type)).toEqual(['poke', 'poke', 'double'])
    t.advance(600)
    expect(t.events.some((e) => e.type === 'click')).toBe(false)
  })

  it('900ms 内三击 → triple', () => {
    const t = setup()
    for (let i = 0; i < 3; i++) {
      t.arbiter.pointerDown(10, 10, i * 150)
      t.advance(25)
      t.arbiter.pointerUp(i * 150 + 25)
    }
    expect(t.events.filter((e) => e.type === 'triple')).toHaveLength(1)
  })

  it('超过 900ms 的第三次点击不算三连点（只是又一轮双击）', () => {
    const t = setup()
    for (const at of [0, 130, 1400]) {
      t.arbiter.pointerDown(10, 10, at)
      t.advance(25)
      t.arbiter.pointerUp(at + 25)
    }
    expect(t.events.filter((e) => e.type === 'triple')).toHaveLength(0)
  })

  it('双击后合并窗口内不再发 click；第二次双击正常触发', () => {
    const t = setup()
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 2; i++) {
        const at = round * 1200 + i * 120 // 轮距 > 三连点窗口(900ms)，两轮独立
        t.arbiter.pointerDown(10, 10, at)
        t.advance(25)
        t.arbiter.pointerUp(at + 25)
      }
    }
    expect(t.events.filter((e) => e.type === 'double')).toHaveLength(2)
    t.advance(2000)
    expect(t.events.some((e) => e.type === 'click')).toBe(false)
  })
})

describe('PettingArbiter 长按摸头', () => {
  it('按住 450ms 触发 petStart，松开发 petEnd 且吞掉 click', () => {
    const t = setup()
    t.arbiter.pointerDown(10, 10, 0)
    t.advance(450)
    expect(t.events.some((e) => e.type === 'petStart')).toBe(true)
    t.advance(2000)
    t.arbiter.pointerUp(2450)
    expect(t.events.some((e) => e.type === 'petEnd')).toBe(true)
    t.advance(600)
    expect(t.events.some((e) => e.type === 'click')).toBe(false)
  })

  it('petStart 后 2500ms 升级 petLove', () => {
    const t = setup()
    t.arbiter.pointerDown(10, 10, 0)
    t.advance(449)
    expect(t.events.some((e) => e.type === 'petLove')).toBe(false)
    t.advance(2501)
    expect(t.events.some((e) => e.type === 'petLove')).toBe(true)
  })

  it('未到 450ms 松手 → 只是普通单击', () => {
    const t = setup()
    t.arbiter.pointerDown(10, 10, 0)
    t.advance(300)
    t.arbiter.pointerUp(300)
    t.advance(300)
    expect(t.events.map((e) => e.type)).toEqual(['poke', 'click'])
    expect(t.events.some((e) => e.type === 'petStart')).toBe(false)
  })

  it('按住期间拖走 → 立即 petEnd', () => {
    const t = setup()
    t.arbiter.pointerDown(10, 10, 0)
    t.advance(500) // 已进入摸头
    t.arbiter.pointerMove(40, 40, 500) // 拖走
    expect(t.events.some((e) => e.type === 'petEnd')).toBe(true)
  })

  it('按下后立刻拖动 → 永远不触发 petStart', () => {
    const t = setup()
    t.arbiter.pointerDown(10, 10, 0)
    t.arbiter.pointerMove(15, 15, 10)
    t.advance(1000)
    expect(t.events).toEqual([])
  })
})
