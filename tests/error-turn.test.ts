/**
 * isErrorTurn 单测 —— 用本机 state.db 真实样本锁行为（v0.4.1 根因修复的回归防线）
 * 样本来源：36k 条消息中 assistant+finish_reason=NULL 的全部形态
 */
import { describe, expect, it } from 'vitest'
import { isErrorTurn } from '../src/adapters/hermes/sqlite-adapter'

describe('isErrorTurn 错误轮次识别', () => {
  it('命中：Error code: 4xx/5xx（本机真实 400 样本）', () => {
    expect(
      isErrorTurn(
        `I reached the maximum iterations (60) but couldn't summarize. Error: Error code: 400 - {'error': {'message': 'reasoning.effort: Invalid option: expected one of "max"|"xhigh"|"high"|"medium"|"low"|"minimal"'}}`
      )
    ).toBe(true)
    expect(isErrorTurn('Error code: 429 - rate limit exceeded')).toBe(true)
    expect(isErrorTurn('Error code: 500 - internal server error')).toBe(true)
  })

  it('命中：API 连接类异常', () => {
    expect(isErrorTurn('APIConnectionError: Connection to provider failed')).toBe(true)
    expect(isErrorTurn('APITimeoutError: request timed out')).toBe(true)
  })

  it('命中：等待模型响应时被中断（连接不稳定）', () => {
    expect(isErrorTurn('Operation interrupted: waiting for model response (7.3s elapsed).')).toBe(true)
  })

  it('命中：行首 Error/Traceback 的短消息', () => {
    expect(isErrorTurn('Error: provider unreachable')).toBe(true)
    expect(isErrorTurn('Traceback (most recent call last):\n  File "x"')).toBe(true)
  })

  it('不误伤：正常回复（含讨论 400/429 但无错误消息形态的）', () => {
    expect(isErrorTurn('收到——现在只有「完成」一种提示音，400/429 这类连接错误静默。')).toBe(false)
    expect(isErrorTurn('我把每个项目的详细方案整理成两张详解卡发飞书：')).toBe(false)
    expect(isErrorTurn('')).toBe(false)
    expect(isErrorTurn(null)).toBe(false)
    expect(isErrorTurn(undefined)).toBe(false)
  })

  it('不误伤：长正文中引用错误（>2000 字符且非 Error code 形态）', () => {
    const long = '这是正常回复。'.repeat(400) + '\nError 出现在很靠后的位置'
    expect(long.length).toBeGreaterThan(2000)
    expect(isErrorTurn(long)).toBe(false)
  })

  it('不误伤：hidden/空内容消息', () => {
    expect(isErrorTurn('(empty)')).toBe(false)
  })
})
