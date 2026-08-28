/**
 * Adapter 插件化接口 —— 新增一个 Agent 类型 = 新增一个 adapter 目录 + registry 注册一行
 * 对应架构文档 3.3 节
 */
import { AgentEvent, AgentType } from '../shared/events'

export type Capability = 'lifecycle' | 'tool-events' | 'tokens' | 'cost'

export interface AdapterHealth {
  ok: boolean
  detail?: string
}

/** 所有 adapter 实现此接口 */
export interface AgentAdapter {
  readonly id: string // 如 'claude-code-hooks'
  readonly agentType: AgentType
  readonly capabilities: readonly Capability[]
  /** 启动并开始上报事件；emit 由 MonitoringCore 注入 */
  start(emit: (e: AgentEvent) => void): Promise<void>
  stop(): Promise<void>
  /** 可选：报告健康状况，供 disconnected 推断 */
  healthCheck?(): Promise<AdapterHealth>
}

export interface AdapterFactory {
  /** 静态 id（与 create() 返回的 adapter.id 一致；供开关/设置管理，缺省时用 create 后的 id） */
  id?: string
  /** 探测本机是否具备该数据源；false 则跳过注册 */
  detect?(): Promise<boolean>
  create(): AgentAdapter
}
