/**
 * 豆包 WorkBuddy trajectory 映射单测（v1.7.0）
 */
import { describe, it, expect } from 'vitest'
import { mapTrajectoryLine } from '../src/adapters/workbuddy/log-adapter'

describe('mapTrajectoryLine（hermes 同语义完成判定）', () => {
  it('user 行 -> turn_started + prompt 摘要', () => {
    const r = mapTrajectoryLine({ role: 'user', content: '帮我总结一下今天的工作' })
    expect(r.map((e) => e.eventType)).toEqual(['turn_started'])
    expect(r[0].payload?.prompt).toBe('帮我总结一下今天的工作')
  })

  it('assistant 无 toolCalls -> turn_completed（回合最终回复）', () => {
    const r = mapTrajectoryLine({ role: 'assistant', content: '搞定啦' })
    expect(r.map((e) => e.eventType)).toEqual(['turn_completed'])
  })

  it('assistant 带 tool_calls -> 中间消息不产生事件', () => {
    const r = mapTrajectoryLine({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: '1', function: { name: 'Bash' } }]
    })
    expect(r).toEqual([])
  })

  it('tool 行 -> tool_call_started', () => {
    const r = mapTrajectoryLine({ role: 'tool', tool_name: 'Bash' })
    expect(r.map((e) => e.eventType)).toEqual(['tool_call_started'])
    expect(r[0].payload?.toolName).toBe('Bash')
  })

  it('未知 role 忽略', () => {
    expect(mapTrajectoryLine({ role: 'system', content: 'x' })).toEqual([])
  })
})
