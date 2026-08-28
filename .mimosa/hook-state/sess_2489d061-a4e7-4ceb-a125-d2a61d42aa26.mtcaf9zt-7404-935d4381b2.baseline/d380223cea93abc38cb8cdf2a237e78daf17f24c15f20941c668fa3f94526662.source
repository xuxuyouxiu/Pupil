/**
 * BubbleTracker 气泡触发与去重单测（v0.5.0 事件语义版）
 * 覆盖：事件映射 / 全局同文案去重 / 同会话冷却 / 不同文案互不影响
 */
import { describe, expect, it } from 'vitest'
import {
  BubbleTracker,
  BUBBLE_TEXT,
  eventToBubbleKind
} from '../src/main/bubble-tracker'

describe('eventToBubbleKind 事件映射', () => {
  it('三类语义事件映射到播报', () => {
    expect(eventToBubbleKind('turn_completed')).toBe('done')
    expect(eventToBubbleKind('waiting_input')).toBe('waiting')
    expect(eventToBubbleKind('error')).toBe('error')
  })
  it('其余事件一律不播报（session_ended 有专属收工音，不再弹泡）', () => {
    expect(eventToBubbleKind('session_ended')).toBeNull()
    expect(eventToBubbleKind('thinking')).toBeNull()
    expect(eventToBubbleKind('tool_call_started')).toBeNull()
    expect(eventToBubbleKind('heartbeat')).toBeNull()
    expect(eventToBubbleKind('session_started')).toBeNull()
  })
})

describe('BubbleTracker 去重', () => {
  it('首条播报直接通过', () => {
    const b = new BubbleTracker()
    expect(b.update('done', 'hermes:a', 0)).toBe(BUBBLE_TEXT.done)
  })

  it('全局同文案 1.2s 内去重：多会话同时完成只说一句', () => {
    const b = new BubbleTracker()
    expect(b.update('done', 'hermes:a', 0)).not.toBeNull()
    expect(b.update('done', 'hermes:b', 500)).toBeNull() // 另一会话也完成：吞掉
    expect(b.update('done', 'hermes:c', 1300)).not.toBeNull() // 超窗恢复
  })

  it('不同文案互不挤占：done 后立刻 waiting 照说', () => {
    const b = new BubbleTracker()
    expect(b.update('done', 'hermes:a', 0)).not.toBeNull()
    expect(b.update('waiting', 'hermes:b', 10)).toBe(BUBBLE_TEXT.waiting)
    expect(b.update('error', 'hermes:c', 20)).toBe(BUBBLE_TEXT.error)
  })

  it('同会话同文案 30s 冷却：异常源重复上报不刷屏', () => {
    const b = new BubbleTracker()
    const t0 = 100_000 // 避开与其他用例的全局窗口干扰
    expect(b.update('error', 'hermes:a', t0)).not.toBeNull()
    // 全局窗口(1.2s)已过、但同会话冷却(30s)未过 → 仍吞
    expect(b.update('error', 'hermes:a', t0 + 5000)).toBeNull()
    // 换个会话说同样的 error：不受别人冷却影响（全局窗口也过了）
    expect(b.update('error', 'hermes:b', t0 + 5000)).not.toBeNull()
    // 冷却彻底过期后恢复
    expect(b.update('error', 'hermes:a', t0 + 31_000)).not.toBeNull()
  })

  it('同会话不同文案互不冷却', () => {
    const b = new BubbleTracker()
    const t0 = 200_000
    expect(b.update('done', 'hermes:a', t0)).not.toBeNull()
    expect(b.update('waiting', 'hermes:a', t0 + 100)).toBe(BUBBLE_TEXT.waiting)
  })
})
