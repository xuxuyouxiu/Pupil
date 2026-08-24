/**
 * MonitoringCore —— 主进程监控内核（装配层与适配器/状态机之间的胶水）
 * 职责：
 *   1. 启动全部 adapter，把事件汇入 SessionRegistry
 *   2. 每事件解析通知策略（NotifyRulesEngine），触发 notifier 回调
 *   3. 周期 tick 推断引擎（timeout/disconnected），变化推给订阅者
 *   4. 向订阅者（球窗/面板窗）广播快照
 */
import { AdapterRegistry } from '../adapters/registry'
import { HttpIngestAdapter } from '../adapters/http-ingest/server'
import { claudeCodeLogAdapterFactory } from '../adapters/claude-code/log-adapter'
import { claudeCodeHooksAdapterFactory } from '../adapters/claude-code/hooks-adapter'
import { codexLogAdapterFactory } from '../adapters/codex/log-adapter'
import { hermesSqliteAdapterFactory } from '../adapters/hermes/sqlite-adapter'
import { HooksInstaller, buildHookCommand } from '../adapters/claude-code/hooks-installer'
import { SessionRegistry } from '../core/session-registry'
import { InferenceEngine } from '../core/inference'
import { resolveStrategy } from '../core/notify-rules'
import { AgentEvent, SessionHistoryItem, SessionView } from '../shared/events'
import { SettingsSnapshot, AdapterStatus } from '../shared/ipc-channels'
import { ConfigStore } from './config'

/** adapter id -> 展示名（设置面板用） */
const ADAPTER_LABELS: Record<string, string> = {
  'http-ingest': 'HTTP 接收端点（通用 / 自研）',
  'claude-code-hooks': 'Claude Code Hooks（主通道）',
  'claude-code-log': 'Claude Code 日志（兜底）',
  'codex-log': 'Codex',
  'hermes-sqlite': 'Hermes'
}

/** 通知策略执行器（由 main 注入：播放音效 + 弹 Toast） */
export interface NotifyExecutor {
  (strategy: ReturnType<typeof resolveStrategy>, event: AgentEvent, view?: SessionView): void
}

export class MonitoringCore {
  readonly registry = new SessionRegistry()
  readonly adapters = new AdapterRegistry()
  readonly inference: InferenceEngine
  readonly httpIngest: HttpIngestAdapter

  private subscribers = new Set<(views: SessionView[]) => void>()
  private notifyExecutor: NotifyExecutor | null = null
  private inferenceTimer: NodeJS.Timeout | null = null
  private dnd = false
  private muted = false
  private started = false
  private adapterIds: string[] = []
  private hooksInstaller = new HooksInstaller()

  constructor(private config: ConfigStore) {
    this.httpIngest = new HttpIngestAdapter()
    this.dnd = config.get('dnd') ?? false
    this.muted = config.get('muted') ?? false
    this.inference = new InferenceEngine(this.registry, {
      timeoutThresholdMs: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
      disconnectThresholdMs: config.get('disconnectThresholdMs') ?? 30 * 1000
    })
  }

  /** 订阅快照广播；返回取消订阅函数 */
  subscribe(fn: (views: SessionView[]) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  setNotifyExecutor(fn: NotifyExecutor): void {
    this.notifyExecutor = fn
  }

  get isDnd(): boolean {
    return this.dnd
  }
  get isMuted(): boolean {
    return this.muted
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // 注册内置 adapter（顺序：HTTP 端点先起，供 hook 安装与转发依赖其端口/token）
    this.adapters.register({ id: 'http-ingest', create: () => this.httpIngest }) // 通道 C
    this.adapters.register(claudeCodeHooksAdapterFactory) // 通道 B（主通道）
    this.adapters.register(claudeCodeLogAdapterFactory) // 通道 A 兜底
    this.adapters.register(codexLogAdapterFactory) // 通道 A
    this.adapters.register(hermesSqliteAdapterFactory) // 通道 A
    this.adapterIds = [
      'http-ingest',
      'claude-code-hooks',
      'claude-code-log',
      'codex-log',
      'hermes-sqlite'
    ]

    const disabled = new Set(this.config.get('disabledAdapters') ?? [])
    await this.adapters.startAll((e) => this.onEvent(e), disabled)

    // 推断 tick：每秒检查一次（仅比较时间戳，开销可忽略）
    this.inferenceTimer = setInterval(() => {
      const changed = this.inference.tick()
      if (changed.length > 0) this.broadcast()
    }, 1000)
  }

  async stop(): Promise<void> {
    if (this.inferenceTimer) clearInterval(this.inferenceTimer)
    await this.adapters.stopAll()
  }

  /** 事件入口（adapter 上报） */
  private onEvent(event: AgentEvent): void {
    const view = this.registry.apply(event)
    if (!this.dnd) {
      const strategy = resolveStrategy(event, view, { dnd: this.dnd, muted: this.muted })
      this.notifyExecutor?.(strategy, event, view)
    }
    this.broadcast()
  }

  private broadcast(): void {
    const snapshot = this.registry.snapshot()
    for (const fn of this.subscribers) fn(snapshot)
  }

  setDnd(value: boolean): void {
    this.dnd = value
    this.config.set('dnd', value)
    this.broadcast() // 让球体更新月牙指示
  }

  toggleDnd(): boolean {
    this.setDnd(!this.dnd)
    return this.dnd
  }

  setMuted(value: boolean): void {
    this.muted = value
    this.config.set('muted', value)
  }

  /** 组装设置面板快照（含 adapter 开关状态） */
  async getSettingsSnapshot(): Promise<SettingsSnapshot> {
    const disabled = new Set(this.config.get('disabledAdapters') ?? [])
    const adapters: AdapterStatus[] = []
    for (const id of this.adapterIds) {
      adapters.push({
        id,
        label: ADAPTER_LABELS[id] ?? id,
        enabled: !disabled.has(id),
        available: await this.adapters.detect(id),
        running: this.adapters.isRunning(id)
      })
    }
    return {
      dnd: this.dnd,
      muted: this.muted,
      autoLaunch: this.config.get('autoLaunch') ?? false,
      timeoutThresholdMs: this.config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
      disconnectThresholdMs: this.config.get('disconnectThresholdMs') ?? 30 * 1000,
      hooksInstalled: this.hooksInstaller.isInstalled(),
      adapters
    }
  }

  /** 事件历史（跨会话合并时间线，倒序） */
  history(limit?: number): SessionHistoryItem[] {
    return this.registry.history(limit)
  }

  /** 运行时启停 adapter，并把状态持久化到 config */
  async setAdapterEnabled(id: string, enabled: boolean): Promise<boolean> {
    const changed = await this.adapters.setEnabled(id, enabled, (e) => this.onEvent(e))
    if (changed) {
      const disabled = new Set(this.config.get('disabledAdapters') ?? [])
      if (enabled) disabled.delete(id)
      else disabled.add(id)
      this.config.set('disabledAdapters', [...disabled])
      this.broadcast()
    }
    return changed
  }

  /** hooks 安装/卸载（通道 B 的 settings.json 管理） */
  installHooks(): boolean {
    const ok = this.hooksInstaller.install(buildHookCommand())
    return ok
  }

  uninstallHooks(): boolean {
    return this.hooksInstaller.uninstall()
  }

  isHooksInstalled(): boolean {
    return this.hooksInstaller.isInstalled()
  }

  snapshot(): SessionView[] {
    return this.registry.snapshot()
  }
}
