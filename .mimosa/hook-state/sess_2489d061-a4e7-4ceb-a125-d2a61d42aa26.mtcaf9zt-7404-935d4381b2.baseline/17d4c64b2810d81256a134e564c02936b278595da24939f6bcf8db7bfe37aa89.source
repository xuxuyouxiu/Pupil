/**
 * 状态机单元测试 —— 对应架构文档第 4 节状态图
 */
import { describe, it, expect } from 'vitest'
import { transitionState } from '../src/core/state-machine'
import type { SessionState } from '../src/shared/events'

const ALL_STATES: SessionState[] = ['idle', 'thinking', 'tool_calling', 'waiting_input', 'error']

describe('transitionState 基础转移', () => {
  it('session_started -> idle（任意状态）', () => {
    for (const s of ALL_STATES) {
      expect(transitionState(s, 'session_started')).toBe('idle')
    }
  })

  it('turn_started / thinking -> thinking', () => {
    expect(transitionState('idle', 'turn_started')).toBe('thinking')
    expect(transitionState('idle', 'thinking')).toBe('thinking')
    expect(transitionState('waiting_input', 'turn_started')).toBe('thinking')
  })

  it('tool_call_started -> tool_calling；finished 回 thinking（一轮可连续多工具）', () => {
    expect(transitionState('thinking', 'tool_call_started')).toBe('tool_calling')
    expect(transitionState('tool_calling', 'tool_call_finished')).toBe('thinking')
  })

  it('turn_completed / session_ended -> idle', () => {
    for (const ev of ['turn_completed', 'session_ended'] as const) {
      expect(transitionState('thinking', ev)).toBe('idle')
      expect(transitionState('tool_calling', ev)).toBe('idle')
      expect(transitionState('waiting_input', ev)).toBe('idle')
    }
  })

  it('error -> error；heartbeat 保持当前态', () => {
    expect(transitionState('thinking', 'error')).toBe('error')
    expect(transitionState('tool_calling', 'error')).toBe('error')
    expect(transitionState('thinking', 'heartbeat')).toBe('thinking')
    expect(transitionState('idle', 'heartbeat')).toBe('idle')
  })
})

describe('error 吸收态与恢复', () => {
  it('error 态下无关事件不改变状态', () => {
    expect(transitionState('error', 'heartbeat')).toBe('error')
    expect(transitionState('error', 'tool_call_finished')).toBe('error')
    expect(transitionState('error', 'session_started')).toBe('idle') // 新会话重置
  })

  it('正向事件恢复：turn_started/thinking -> thinking，tool_call_started -> tool_calling', () => {
    expect(transitionState('error', 'turn_started')).toBe('thinking')
    expect(transitionState('error', 'thinking')).toBe('thinking')
    expect(transitionState('error', 'tool_call_started')).toBe('tool_calling')
  })

  it('waiting_input 在 error 态也可达', () => {
    expect(transitionState('error', 'waiting_input')).toBe('waiting_input')
  })

  it('完整生命周期：idle→thinking→tool→waiting→thinking→done(idle)→error→恢复', () => {
    let s: SessionState = 'idle'
    s = transitionState(s, 'session_started'); expect(s).toBe('idle')
    s = transitionState(s, 'turn_started'); expect(s).toBe('thinking')
    s = transitionState(s, 'tool_call_started'); expect(s).toBe('tool_calling')
    s = transitionState(s, 'waiting_input'); expect(s).toBe('waiting_input')
    s = transitionState(s, 'turn_started'); expect(s).toBe('thinking')
    s = transitionState(s, 'turn_completed'); expect(s).toBe('idle')
    s = transitionState(s, 'error'); expect(s).toBe('error')
    s = transitionState(s, 'heartbeat'); expect(s).toBe('error') // error 吸收
    s = transitionState(s, 'turn_started'); expect(s).toBe('thinking') // 恢复
  })
})
