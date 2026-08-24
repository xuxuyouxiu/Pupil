/**
 * 推断引擎 —— 基于时间阈值叠加 timeout / disconnected 标记
 * 对应架构文档：timeout 与 disconnected 是监控端推断的叠加标记，不是基础状态
 * 零 electron 依赖，可单测。由主进程定时 tick 驱动。
 */
import { SessionRegistry } from './session-registry'
import { SessionView, sessionKey, AgentType } from '../shared/events'

export interface InferenceOptions {
  /** 无事件超过该阈值 -> timeout（默认 10 分钟） */
  timeoutThresholdMs: number
  /** 无事件超过该阈值 -> disconnected（默认 30 秒） */
  disconnectThresholdMs: number
  /** 不参与超时判断的状态（idle 不判定超时） */
  now?: () => number
}

export class InferenceEngine {
  constructor(
    private registry: SessionRegistry,
    private options: InferenceOptions
  ) {}

  /** 对全量会话执行一轮推断，返回发生标记变化的会话视图列表 */
  tick(now: number = this.options.now?.() ?? Date.now()): SessionView[] {
    const changed: SessionView[] = []
    for (const view of this.registry.snapshot()) {
      const elapsed = now - view.lastEventAt
      const next = { ...view.flags }

      // timeout：非 idle 状态且超阈值
      if (view.state !== 'idle' && elapsed >= this.options.timeoutThresholdMs) {
        next.timeout = true
      }
      // disconnected：任何状态超阈值（断连优先判定）
      if (elapsed >= this.options.disconnectThresholdMs) {
        next.disconnected = true
      }

      const cur = view.flags
      if (next.timeout !== cur.timeout || next.disconnected !== cur.disconnected) {
        const updated = this.registry.setFlags(view.key, next)
        if (updated) changed.push(updated)
      }
    }
    return changed
  }

  /** 便捷方法：手动给某个会话打/清断连标记（适配器 healthCheck 失败时调用） */
  markDisconnected(agentType: AgentType, sessionId: string, disconnected: boolean): SessionView | undefined {
    return this.registry.setFlags(sessionKey(agentType, sessionId), { disconnected })
  }
}
