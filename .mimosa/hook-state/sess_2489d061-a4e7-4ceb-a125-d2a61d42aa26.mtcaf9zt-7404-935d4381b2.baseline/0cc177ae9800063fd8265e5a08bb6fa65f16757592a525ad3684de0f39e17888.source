/**
 * DSH Web API adapter 映射单测 —— 覆盖 diffSession 的纯差分逻辑
 */
import { describe, it, expect } from 'vitest'
import {
  diffSession,
  shouldMonitorDshSession,
  DshSessionSummary,
  DshSessionTrack
} from '../src/adapters/dsh/api-adapter'

const NOW = 1_700_000_000_000

function item(overrides: Partial<DshSessionSummary> = {}): DshSessionSummary {
  return {
    sessionId: 'session-abc',
    updatedAt: NOW,
    running: false,
    blank: false,
    cwd: 'G:\\Pupil',
    ...overrides
  }
}

function track(overrides: Partial<DshSessionTrack> = {}): DshSessionTrack {
  return {
    running: false,
    blank: false,
    emitted: true,
    title: 't',
    lastUpdatedAt: NOW,
    lastHeartbeatAt: 0,
    ...overrides
  }
}

function types(events: { eventType: string }[]): string[] {
  return events.map((e) => e.eventType)
}

describe('dsh diffSession', () => {
  it('首次发现运行中的会话 -> session_started + turn_started', () => {
    const r = diffSession(undefined, item({ running: true }), NOW)
    expect(types(r.events)).toEqual(['session_started', 'turn_started'])
    expect(r.next.running).toBe(true)
    expect(r.next.emitted).toBe(true)
  })

  it('首次发现空闲会话 -> 仅 session_started', () => {
    const r = diffSession(undefined, item({ running: false }), NOW)
    expect(types(r.events)).toEqual(['session_started'])
    expect(r.next.running).toBe(false)
  })

  it('空白会话首次观测不发事件，转为非 blank 后补发', () => {
    const first = diffSession(undefined, item({ blank: true, running: false }), NOW)
    expect(first.events).toEqual([])
    expect(first.next.emitted).toBe(false)

    const second = diffSession(first.next, item({ blank: false, running: true }), NOW + 1)
    expect(types(second.events)).toEqual(['session_started', 'turn_started'])
    expect(second.next.emitted).toBe(true)
  })

  it('running -> 空闲 发 turn_completed', () => {
    const prev = track({ running: true, lastHeartbeatAt: NOW })
    const r = diffSession(prev, item({ running: false }), NOW + 5_000)
    expect(types(r.events)).toEqual(['turn_completed'])
    expect(r.next.running).toBe(false)
  })

  it('空闲 -> running 发 turn_started', () => {
    const prev = track({ running: false })
    const r = diffSession(prev, item({ running: true }), NOW + 5_000)
    expect(types(r.events)).toEqual(['turn_started'])
    expect(r.next.running).toBe(true)
  })

  it('标题变化通过 heartbeat 携带新标题刷新（不改变状态）', () => {
    const prev = track({ running: true, title: '旧标题', lastHeartbeatAt: NOW })
    const r = diffSession(prev, item({ running: true, projections: { values: { title: '新标题' } } }), NOW + 1)
    expect(types(r.events)).toEqual(['heartbeat'])
    expect(r.events[0].payload).toMatchObject({ title: '新标题' })
  })

  it('只监控运行中或最近活跃会话，历史会话跳过', () => {
    expect(shouldMonitorDshSession({ running: true, updatedAt: NOW - 99 * 60 * 1000 }, NOW)).toBe(true)
    expect(shouldMonitorDshSession({ running: false, updatedAt: NOW - 1_000 }, NOW)).toBe(true)
    expect(shouldMonitorDshSession({ running: false, updatedAt: NOW - 11 * 60 * 1000 }, NOW)).toBe(false)
    expect(shouldMonitorDshSession({ running: false, updatedAt: undefined }, NOW)).toBe(false)
  })

  it('运行中超过心跳间隔才补 heartbeat，避免每轮刷屏', () => {
    const prev = track({ running: true, lastHeartbeatAt: NOW })
    const within = diffSession(prev, item({ running: true }), NOW + 1_000)
    expect(within.events).toEqual([])

    const due = diffSession(prev, item({ running: true }), NOW + 31_000)
    expect(types(due.events)).toEqual(['heartbeat'])
    expect(due.next.lastHeartbeatAt).toBe(NOW + 31_000)
  })
})
