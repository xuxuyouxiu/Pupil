/**
 * Gemini CLI / OpenCode 映射单测（v1.6.0）
 */
import { describe, it, expect } from 'vitest'
import { mapGeminiLine, deriveSessionId } from '../src/adapters/gemini/log-adapter'
import { mapOpenCodeLine, deriveSessionId as ocDerive } from '../src/adapters/opencode/log-adapter'

describe('gemini deriveSessionId', () => {
  it('tmp/<hash>/logs.jsonl -> hash（同目录多文件归并）', () => {
    expect(deriveSessionId('C:/u/.gemini/tmp/abc123/logs.jsonl')).toBe('abc123')
  })
})

describe('mapGeminiLine（宽容解析）', () => {
  it('user 文本行 -> turn_started + prompt 摘要', () => {
    const r = mapGeminiLine({ role: 'user', content: '帮我修面板', timestamp: 1756000000000 }, true)
    const types = r.map((e) => e.eventType)
    expect(types).toContain('session_started')
    expect(types).toContain('turn_started')
    const ts = r.find((e) => e.eventType === 'turn_started')
    expect(ts?.payload?.prompt).toBe('帮我修面板')
  })

  it('functionResponse 工具结果不算用户指令', () => {
    const r = mapGeminiLine(
      { role: 'user', type: 'functionResponse', content: 'ok', timestamp: 1756000000000 },
      true
    )
    expect(r.map((e) => e.eventType)).not.toContain('turn_started')
  })

  it('model 行 -> thinking 脉冲', () => {
    const r = mapGeminiLine({ role: 'model', text: '回复', timestamp: 1756000000000 }, false)
    expect(r.map((e) => e.eventType)).toContain('thinking')
  })

  it('error 字段/isError -> error 事件', () => {
    const r1 = mapGeminiLine({ role: 'model', error: 'boom' }, false)
    expect(r1.map((e) => e.eventType)).toContain('error')
    const r2 = mapGeminiLine({ role: 'model', isError: true, text: 'rate limited' }, false)
    expect(r2.map((e) => e.eventType)).toContain('error')
    const err2 = r2.find((e) => e.eventType === 'error')
    expect(err2?.payload?.errorMessage).toContain('rate limited')
  })

  it('畸形时间戳回退当前时间', () => {
    const r = mapGeminiLine({ role: 'user', content: 'x', timestamp: 'garbage' }, false)
    expect(r[0].timestamp).toBeGreaterThan(0)
  })
})

describe('mapOpenCodeLine（日志宽容解析）', () => {
  it('首行附带 session_started', () => {
    const r = mapOpenCodeLine('server started', true)
    expect(r[0].eventType).toBe('session_started')
  })

  it('error 特征行 -> error 事件', () => {
    const r = mapOpenCodeLine('2026-08-28 ERROR provider timeout', false)
    expect(r.map((e) => e.eventType)).toContain('error')
  })

  it('普通日志行 -> 活动脉冲', () => {
    const r = mapOpenCodeLine('session tick ok', false)
    expect(r.map((e) => e.eventType)).toEqual(['thinking'])
  })
})

describe('opencode deriveSessionId', () => {
  it('日志文件名去 .log 后缀', () => {
    expect(ocDerive('C:/logs/opencode-abc.log')).toBe('opencode-abc')
  })
})
