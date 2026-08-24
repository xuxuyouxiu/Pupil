/**
 * Adapter 注册表 —— 按工厂注册、启动全部已探测通过的 adapter
 * 对应架构文档 3.3："在 registry 注册一行，不改动任何上层代码"
 * 支持 per-adapter 运行时启停（供设置面板开关）。
 */
import { AdapterFactory, AgentAdapter } from './types'
import { AgentEvent } from '../shared/events'

interface Entry {
  factory: AdapterFactory
  adapter: AgentAdapter | null
  running: boolean
}

export class AdapterRegistry {
  private entries: Entry[] = []

  register(factory: AdapterFactory): void {
    this.entries.push({ factory, adapter: null, running: false })
  }

  /** 取 factory 的 id（优先静态 id，其次 create 一次取 adapter.id） */
  private idOf(entry: Entry): string {
    if (entry.factory.id) return entry.factory.id
    if (entry.adapter) return entry.adapter.id
    return ''
  }

  /** 启动全部（跳过用户禁用的 id） */
  async startAll(
    emit: (e: AgentEvent) => void,
    disabledIds: Set<string> = new Set()
  ): Promise<AgentAdapter[]> {
    const started: AgentAdapter[] = []
    for (const entry of this.entries) {
      try {
        const id = entry.factory.id ?? ''
        if (id && disabledIds.has(id)) continue // 用户禁用
        if (entry.factory.detect) {
          const ok = await entry.factory.detect()
          if (!ok) continue
        }
        const adapter = entry.factory.create()
        await adapter.start(emit)
        entry.adapter = adapter
        entry.running = true
        started.push(adapter)
      } catch (err) {
        // 单适配器故障不影响整体（架构验收：适配器隔离）
        console.error('[adapters] a factory failed to start (skipped, others continue)', err)
      }
    }
    return started
  }

  /** 运行时启停单个 adapter；返回是否发生了状态变化 */
  async setEnabled(
    id: string,
    enabled: boolean,
    emit: (e: AgentEvent) => void
  ): Promise<boolean> {
    const entry = this.entries.find((e) => this.idOf(e) === id || e.adapter?.id === id)
    if (!entry) return false

    if (enabled && !entry.running) {
      try {
        if (entry.factory.detect) {
          const ok = await entry.factory.detect()
          if (!ok) return false // 数据源不存在，无法启动
        }
        const adapter = entry.factory.create()
        await adapter.start(emit)
        entry.adapter = adapter
        entry.running = true
        return true
      } catch (err) {
        console.error(`[adapters] failed to start ${id}`, err)
        return false
      }
    }

    if (!enabled && entry.running) {
      try {
        await entry.adapter?.stop()
      } catch {
        /* 忽略停止异常 */
      }
      entry.running = false
      return true
    }

    return false
  }

  /** 探测某 adapter 的数据源是否可用 */
  async detect(id: string): Promise<boolean> {
    const entry = this.entries.find((e) => this.idOf(e) === id)
    if (!entry || !entry.factory.detect) return true // 无 detect 视为始终可用
    try {
      return await entry.factory.detect()
    } catch {
      return false
    }
  }

  /** 是否正在运行 */
  isRunning(id: string): boolean {
    return this.entries.some((e) => e.running && (this.idOf(e) === id || e.adapter?.id === id))
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.entries.filter((e) => e.running).map((e) => e.adapter?.stop()))
    this.entries = []
  }

  get active(): AgentAdapter[] {
    return this.entries.filter((e) => e.running && e.adapter).map((e) => e.adapter as AgentAdapter)
  }
}
