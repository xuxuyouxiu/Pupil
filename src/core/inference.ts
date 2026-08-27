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
  /**
   * 按 agent 覆盖断连阈值：
   * sqlite 轮询类源（hermes/codex）的会话生命周期由库本身跟踪（ended_at/archived），
   * 运行中静默多半是"长回复生成中"而非断连，需放宽（主进程默认给到与 timeout 一致）
   */
  disconnectThresholdMsByAgent?: Partial<Record<AgentType, number>>
  /** 不参与超时判断的状态：仅运行中（thinking/tool_calling）静默才判定超时 */
  now?: () => number
}

/** 推断出的叠加标记种类 */
export type InferredFlag = 'timeout' | 'disconnected'

export class InferenceEngine {
  /**
   * v0.4.1：标记首次翻转时的通知回调——timeout/disconnected 此前只变色不出声，
   * 用户要求「每种结束都有不同的声音提醒」。引擎只保证「从无到有」时恰好调一次，
   * 去重/勿扰/静音判断在回调执行端。
   */
  onFlagNotified: ((kind: InferredFlag, view: SessionView) => void) | null = null

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
      /** 本轮新翻的标记（上一轮没有、这一轮有）——只有首次翻转才通知，避免每秒重复响 */
      let kind: InferredFlag | null = null

      // timeout：仅"运行中"（thinking/tool_calling）静默超阈值才算超时——
      // idle（等用户下一句）、waiting_input（等用户确认权限）、done 保持窗口内的静默
      // 都是正常等待而非卡死；此前 state !== 'idle' 会把挂机未确认的会话也报"已超时"
      if (
        (view.state === 'thinking' || view.state === 'tool_calling') &&
        elapsed >= this.options.timeoutThresholdMs
      ) {
        if (!view.flags.timeout) kind = 'timeout'
        next.timeout = true
      }
      // disconnected：仅"运行中"（thinking/tool_calling）静默超阈值才算断连——
      // idle（等用户下一句）与 waiting_input（等用户确认）的静默是正常等待，不是断连，
      // 否则打开面板满眼"连接中断"，且 waiting 会被 offline 高优先级遮住
      const threshold =
        this.options.disconnectThresholdMsByAgent?.[view.agentType] ??
        this.options.disconnectThresholdMs
      if (
        (view.state === 'thinking' || view.state === 'tool_calling') &&
        elapsed >= threshold
      ) {
        // timeout 与断连同时命中时 timeout 优先（更严重的语义）
        if (!view.flags.disconnected && kind === null) kind = 'disconnected'
        next.disconnected = true
      }

      const cur = view.flags
      if (next.timeout !== cur.timeout || next.disconnected !== cur.disconnected) {
        const updated = this.registry.setFlags(view.key, next)
        if (updated) {
          changed.push(updated)
          if (kind) this.onFlagNotified?.(kind, updated)
        }
      }
    }
    return changed
  }

  /** 便捷方法：手动给某个会话打/清断连标记（适配器 healthCheck 失败时调用） */
  markDisconnected(agentType: AgentType, sessionId: string, disconnected: boolean): SessionView | undefined {
    return this.registry.setFlags(sessionKey(agentType, sessionId), { disconnected })
  }
}
