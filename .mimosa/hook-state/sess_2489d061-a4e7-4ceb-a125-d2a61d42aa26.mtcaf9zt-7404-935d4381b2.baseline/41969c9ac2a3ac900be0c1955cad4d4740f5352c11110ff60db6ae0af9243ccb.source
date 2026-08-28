/**
 * 事件历史持久化测试（P2-8）—— 注入式 HistoryStore 往返
 */
import { describe, it, expect } from 'vitest'
import { SessionRegistry, HistoryStore } from '../src/core/session-registry'
import type { AgentEvent, SessionHistoryItem } from '../src/shared/events'

/** 内存版存储：模拟 %APPDATA%/pupil/history.json 的行为 */
class MemStore implements HistoryStore {
  items: SessionHistoryItem[] | null = null
  load(): SessionHistoryItem[] | null {
    return this.items
  }
  save(items: SessionHistoryItem[]): void {
    this.items = items
  }
}

let n = 0
function ev(eventType: AgentEvent['eventType'], ts: number): AgentEvent {
  return { source: 'test', agentType: 'hermes', sessionId: 's1', eventType, timestamp: ts, ...(n++, {}) }
}

describe('事件历史持久化', () => {
  it('保存后新实例可恢复历史；恢复项不占会话列表，收到新事件即回归', () => {
    const store = new MemStore()
    const reg = new SessionRegistry()
    reg.setHistoryStore(store)

    reg.apply(ev('turn_started', 1_000))
    reg.apply(ev('turn_completed', 2_000))
    expect(reg.saveHistory()).toBe(true)
    expect(store.items).toHaveLength(2)

    // 新实例：恢复历史
    const reg2 = new SessionRegistry()
    reg2.setHistoryStore(store)
    expect(reg2.history()).toHaveLength(2) // 时间线可见
    expect(reg2.snapshot()).toHaveLength(0) // 不出现在会话列表

    // 收到真实事件 -> 回归会话列表
    reg2.apply(ev('turn_started', 3_000))
    expect(reg2.snapshot()).toHaveLength(1)
    expect(reg2.get('hermes:s1')?.state).toBe('thinking')

    // 落盘一次后变干净：第二次调用跳过（脏标记生效）
    expect(reg2.saveHistory()).toBe(true)
    expect(reg2.saveHistory()).toBe(false)
  })

  it('未注入存储时 save 为无操作', () => {
    const reg = new SessionRegistry()
    reg.apply(ev('turn_started', 1_000))
    expect(reg.saveHistory()).toBe(false)
  })
})
