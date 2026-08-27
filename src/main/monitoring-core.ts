/**
 * MonitoringCore —— 主进程监控内核（装配层与适配器/状态机之间的胶水）
 * 职责：
 *   1. 启动全部 adapter，把事件汇入 SessionRegistry
 *   2. 每事件解析通知策略（NotifyRulesEngine），触发 notifier 回调
 *   3. 周期 tick 推断引擎（timeout/disconnected），变化推给订阅者
 *   4. 向订阅者（球窗/面板窗）广播快照
 */
import { AdapterRegistry } from '../adapters/registry'
import { loadExternalAdapters } from '../adapters/external'
import { HttpIngestAdapter } from '../adapters/http-ingest/server'
import { claudeCodeLogAdapterFactory } from '../adapters/claude-code/log-adapter'
import { claudeCodeHooksAdapterFactory } from '../adapters/claude-code/hooks-adapter'
import { codexLogAdapterFactory } from '../adapters/codex/log-adapter'
import { hermesSqliteAdapterFactory } from '../adapters/hermes/sqlite-adapter'
import { dshApiAdapterFactory } from '../adapters/dsh/api-adapter'
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
  'hermes-sqlite': 'Hermes',
  'dsh-api': 'DSH（Web API）'
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
  /** v0.5.0：上一 tick 是否存在 done 保持态（用于检测窗口到期触发回落广播） */
  private doneHoldActive = false
  private muted = false
  private started = false
  private adapterIds: string[] = []
  private hooksInstaller = new HooksInstaller()

  constructor(private config: ConfigStore, private appVersion: string) {
    this.httpIngest = new HttpIngestAdapter()
    this.dnd = config.get('dnd') ?? false
    this.muted = config.get('muted') ?? false
    this.inference = new InferenceEngine(this.registry, {
      timeoutThresholdMs: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
      disconnectThresholdMs: config.get('disconnectThresholdMs') ?? 30 * 1000,
      // hermes/codex 是 sqlite 轮询源：会话存亡由库跟踪（ended_at），运行中静默
      // 多半是长回复生成中；断连阈值放宽到与超时一致，避免误报"连接中断"
      disconnectThresholdMsByAgent: {
        hermes: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
        codex: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000
      }
    })
    // v0.4.1：超时/断连标记首次翻转 → 音效+Toast（此前只变色不出声）
    this.inference.onFlagNotified = (kind, view) => this.notifyInferredFlag(kind, view)
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
    this.adapters.register(dshApiAdapterFactory) // 通道 C（DSH Web API 只读轮询）

    // P2-6 第三方 adapter 动态加载：%APPDATA%/pupil/adapters/*.js（单文件失败跳过）
    const externals = loadExternalAdapters()
    for (const factory of externals) {
      const extId: string = factory.id ?? `external-${this.adapterIds.length}`
      this.adapters.register({ ...factory, id: extId })
      if (!ADAPTER_LABELS[extId]) {
        ADAPTER_LABELS[extId] = `${extId}（第三方）`
      }
    }

    this.adapterIds = [
      'http-ingest',
      'claude-code-hooks',
      'claude-code-log',
      'codex-log',
      'hermes-sqlite',
      'dsh-api'
    ]

    const disabled = new Set(this.config.get('disabledAdapters') ?? [])
    await this.adapters.startAll((e) => this.onEvent(e), disabled)

    // 第三方 adapter 的 id 追加到面板开关列表（startAll 后统一收集，含运行时生成的兜底 id）
    for (const a of this.adapters.active) {
      if (!this.adapterIds.includes(a.id)) this.adapterIds.push(a.id)
    }

    // 推断 tick：每秒检查一次（仅比较时间戳，开销可忽略）
    this.inferenceTimer = setInterval(() => {
      const changed = this.inference.tick()
      // v0.5.0 完成保持窗口到期：done → idle 的回落没有任何事件，靠此 tick 对比触发广播
      const anyDone = this.registry.snapshot().some((v) => v.state === 'done')
      const doneExpired = this.doneHoldActive && !anyDone
      this.doneHoldActive = anyDone
      if (changed.length > 0 || doneExpired) this.broadcast()
    }, 1000)
  }

  /** 推断标记首次翻转（timeout/disconnected）→ 走完整通知链（v0.4.1 补上此前缺失的声音） */
  private notifyInferredFlag(kind: 'timeout' | 'disconnected', view: SessionView): void {
    if (this.dnd || this.muted) return
    const who = view.title || view.sessionId
    const strategy =
      kind === 'timeout'
        ? {
            displayState: 'timeout' as const,
            sound: true,
            soundType: 'timeout' as const,
            toast: true,
            title: `${who} 已超时`,
            body: `${view.agentType} 会话超过 ${Math.round((this.config.get('timeoutThresholdMs') ?? 600000) / 60000)} 分钟无活动`
          }
        : {
            displayState: 'offline' as const,
            sound: true,
            soundType: 'offline' as const,
            toast: true,
            title: `${who} 连接中断`,
            body: `${view.agentType} 会话运行中静默断连`
          }
    this.notifyExecutor?.(strategy, { source: 'inference', agentType: view.agentType, sessionId: view.sessionId, eventType: 'heartbeat', timestamp: Date.now() }, view)
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
      version: this.appVersion,
      dnd: this.dnd,
      muted: this.muted,
      soundPack: this.config.get('soundPack') ?? 'chime',
      soundVolume: this.config.get('soundVolume') ?? 0.8,
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
