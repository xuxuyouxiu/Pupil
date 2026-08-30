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
import { zcodeRolloutAdapterFactory } from '../adapters/zcode/log-adapter'
import { geminiCliAdapterFactory } from '../adapters/gemini/log-adapter'
import { opencodeLogAdapterFactory } from '../adapters/opencode/log-adapter'
import { HooksInstaller, buildHookCommand } from '../adapters/claude-code/hooks-installer'
import { SessionRegistry } from '../core/session-registry'
import { InferenceEngine } from '../core/inference'
import { resolveStrategy, notifyAllowed } from '../core/notify-rules'
import { DailyDigest, DigestSummary } from '../core/digest'
import { RecapEngine, TaskCard, RecapTotals } from '../core/recap'
import { ProcessActivityTracker } from '../core/process-activity'
import { AgentEvent, AgentType, ModelPricing, NotifyFilter, NOTIFY_FILTER_DEFAULTS, SessionHistoryItem, SessionView, sessionKey } from '../shared/events'
import { t } from '../shared/i18n'
import { SettingsSnapshot, AdapterStatus } from '../shared/ipc-channels'
import { ConfigStore } from './config'

/** adapter id -> 展示名（设置面板用） */
const ADAPTER_LABELS: Record<string, string> = {
  'http-ingest': 'HTTP 接收端点（通用 / 自研）',
  'claude-code-hooks': 'Claude Code Hooks（主通道）',
  'claude-code-log': 'Claude Code 日志（兜底）',
  'codex-log': 'Codex',
  'hermes-sqlite': 'Hermes',
  'dsh-api': 'DSH（Web API）',
  'zcode-rollout': 'ZCode（会话记录）',
  'gemini-cli': 'Gemini CLI',
  'opencode-log': 'OpenCode'
}

/**
 * v0.11.0 内置单价（美元/百万 token）。仅列出有把握的 claude 系参考价；
 * 其他 agent 或自定义模型请用 config.json 的 `pricing` 覆盖（不配置则不显示成本）
 */
const DEFAULT_PRICING: Partial<Record<string, ModelPricing>> = {
  'claude-code': { inputPer1M: 3, outputPer1M: 15 }
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
  /** v0.9.0 定时勿扰：到期时间戳（null = 非定时勿扰），0 = 已到期待解除 */
  private dndUntil: number | null = null
  private dndTimer: NodeJS.Timeout | null = null
  /** v0.9.0 单会话静音：sessionKey 集合 */
  private mutedSessions: Set<string>
  /** v0.11.0 每日简报 */
  private digest: DailyDigest
  /** v1.2.0 任务回顾引擎（recap-file-store 注入） */
  readonly recap: RecapEngine
  /** v1.7.0 宿主进程活性跟踪（zcode/gemini/codex/opencode 四个日志滞后型源） */
  private procTracker = new ProcessActivityTracker()
  private procSampleTimer: NodeJS.Timeout | null = null
  private procBusy = false
  /** v0.8.0 通知粒度开关：按事件类别关闭音效+通知（视觉状态不受影响） */
  private notifyFilter: NotifyFilter
  /** v0.5.0：上一 tick 是否存在 done 保持态（用于检测窗口到期触发回落广播） */
  private doneHoldActive = false
  private muted = false
  private started = false
  private adapterIds: string[] = []
  private hooksInstaller = new HooksInstaller()

  constructor(
    private config: ConfigStore,
    private appVersion: string,
    recapStore?: import('../core/recap').RecapStore
  ) {
    this.httpIngest = new HttpIngestAdapter()
    this.dnd = config.get('dnd') ?? false
    this.muted = config.get('muted') ?? false
    this.notifyFilter = config.get('notifyEvents') ?? {}
    this.mutedSessions = new Set(config.get('mutedSessions') ?? [])
    // v0.11.0 定价注入：config.pricing[agentType] 覆盖内置默认（claude-code 系单价）
    const customPricing = config.get('pricing') ?? {}
    this.registry.setPricing((agentType) => customPricing[agentType] ?? DEFAULT_PRICING[agentType])
    // v0.11.0 每日简报：默认每天 21:00（config.digestHour 覆盖）
    this.digest = new DailyDigest(config.get('digestHour') ?? 21, (s) => this.emitDigest(s))
    // v1.2.0 回顾引擎（store 由 main 注入；未注入则用最小空实现保持可构造性）
    this.recap = new RecapEngine(
      recapStore ?? {
        load: () => null,
        save: () => undefined,
        listDates: () => [],
        drop: () => undefined
      }
    )
    this.inference = new InferenceEngine(this.registry, {
      timeoutThresholdMs: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
      disconnectThresholdMs: config.get('disconnectThresholdMs') ?? 30 * 1000,
      // hermes/codex 是 sqlite 轮询源：会话存亡由库跟踪（ended_at），运行中静默
      // 多半是长回复生成中；断连阈值放宽到与超时一致，避免误报"连接中断"
      disconnectThresholdMsByAgent: {
        hermes: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
        codex: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
        // DSH 是 HTTP 轮询源：短暂连接抖动不应把运行中会话误判为断连
        dsh: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
        // ZCode 是会话记录 tail 源：与 codex 同理，请求间隔可能很长
        zcode: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
        gemini: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000,
        opencode: config.get('timeoutThresholdMs') ?? 10 * 60 * 1000
      }
    })
    // v0.4.1：超时/断连标记首次翻转 → 音效+Toast（此前只变色不出声）
    this.inference.onFlagNotified = (kind, view) => this.notifyInferredFlag(kind, view)
    // v1.7.0 进程活性豁免：宿主忙 = 后台命令/模型推理中，不判超时/断连
    this.inference.processBusy = () => this.procBusy
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
    this.adapters.register(zcodeRolloutAdapterFactory) // 通道 A（ZCode 会话记录 tail）
    this.adapters.register(geminiCliAdapterFactory) // 通道 A（Gemini CLI 会话 tail）
    this.adapters.register(opencodeLogAdapterFactory) // 通道 A（OpenCode 日志监控）

    // P2-6 第三方 adapter 动态加载：%APPDATA%/pupil/adapters/*.js（单文件失败跳过）
    const externals = await loadExternalAdapters()
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
      'dsh-api',
      'zcode-rollout',
      'gemini-cli',
      'opencode-log'
    ]

    const disabled = new Set(this.config.get('disabledAdapters') ?? [])
    await this.adapters.startAll((e) => this.onEvent(e), disabled)

    // 第三方 adapter 的 id 追加到面板开关列表（startAll 后统一收集，含运行时生成的兜底 id）
    for (const a of this.adapters.active) {
      if (!this.adapterIds.includes(a.id)) this.adapterIds.push(a.id)
    }

    // v1.2.0 回顾：恢复上次未结卡 + 启动清扫 90 天前文件
    this.recap.recover()
    this.recap.prune(90)
    // v1.7.0 进程活性采样（2s）：四个日志滞后型源的宿主进程集合
    const HARNESS_PROC_PATTERNS = [/^zcode/i, /^gemini/i, /^codex/i, /^opencode/i]
    const sampleProcs = async (): Promise<void> => {
      try {
        const { exec } = await import('child_process')
        const { promisify } = await import('util')
        // tasklist 一次拉全表，本地过滤进程名（无 PowerShell 依赖）
        const out = await promisify(exec)('tasklist /fo csv /nh', { timeout: 5000 })
        const pids: number[] = []
        for (const line of String(out).split('\n')) {
          const m = line.match(/^"([^"]+)","(\d+)"/)
          if (!m) continue
          const name = m[1]
          if (HARNESS_PROC_PATTERNS.some((re) => re.test(name))) pids.push(Number(m[2]))
        }
        const { sampleCpu } = await import('../integrations/proc-activity-win')
        this.procTracker.sample(sampleCpu(pids), Date.now())
        const wasBusy = this.procBusy
        this.procBusy = this.procTracker.anyBusy()
        // 空窗修正：日志显示完成/idle 但进程忙 → 找相关源运行中会话维持广播
        if (this.procBusy && !wasBusy) repairRunningStates()
      } catch {
        /* 采样失败静默：退化回纯日志信号 */
      }
    }

    // v1.7.0 空窗修正：进程转忙 = 用户刚发消息/后台命令在跑。
    // 把该源"已完成/idle"的近期会话修正回 running（注入 thinking 事件由状态机解释），
    // 消除「刚发消息就显示完成」与「后台命令跑着却显示完成」两类误报。
    const repairRunningStates = (): void => {
      const AGENTS_OF_INTEREST: AgentType[] = ['zcode', 'gemini', 'codex', 'opencode']
      const now = Date.now()
      let changed = false
      for (const view of this.registry.snapshot()) {
        if (!AGENTS_OF_INTEREST.includes(view.agentType)) continue
        if (view.state !== 'idle' && view.state !== 'done') continue
        // 只修正最近 30 分钟活跃的会话（避免翻出久远历史）
        if (now - view.lastEventAt > 30 * 60_000) continue
        this.registry.apply({
          source: 'proc-activity',
          agentType: view.agentType,
          sessionId: view.sessionId,
          eventType: 'thinking',
          timestamp: now,
          payload: { raw: { busyRepair: true } }
        })
        changed = true
      }
      if (changed) this.broadcast()
    }

    void sampleProcs()
    this.procSampleTimer = setInterval(() => void sampleProcs(), 2000)
    // 推断 tick：每秒检查一次（仅比较时间戳，开销可忽略）
    this.inferenceTimer = setInterval(() => {
      const changed = this.inference.tick()
      // v0.5.0 完成保持窗口到期：done → idle 的回落没有任何事件，靠此 tick 对比触发广播
      const anyDone = this.registry.snapshot().some((v) => v.state === 'done')
      const doneExpired = this.doneHoldActive && !anyDone
      this.doneHoldActive = anyDone
      // 过期会话清理（session_ended 宽限期 / 历史恢复条目保留期）
      const pruned = this.registry.prune(Date.now())
      // v0.11.0 每日简报：到点触发
      this.digest.tick()
      if (changed.length > 0 || doneExpired || pruned > 0) this.broadcast()
    }, 1000)
  }

  /** 推断标记首次翻转（timeout/disconnected）→ 走完整通知链（v0.4.1 补上此前缺失的声音） */
  private notifyInferredFlag(kind: 'timeout' | 'disconnected', view: SessionView): void {
    if (this.dnd || this.muted) return
    // 通知粒度同样作用于推断出的标记
    if (!notifyAllowed(kind === 'timeout' ? 'timeout' : 'offline', this.notifyFilter)) return
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
    if (this.procSampleTimer) clearInterval(this.procSampleTimer)
    this.recap.recover()
    this.recap.flush()
    await this.adapters.stopAll()
  }

  /** 事件入口（adapter 上报） */
  private onEvent(event: AgentEvent): void {
    const key = sessionKey(event.agentType, event.sessionId)
    // 每日简报入账要在 registry 应用前取上一轮起点（turn_completed 会清 turnStartedAt）
    const prevTurnStartedAt = this.registry.get(key)?.turnStartedAt
    const view = this.registry.apply(event)
    const sessionMuted = this.mutedSessions.has(key)
    // v0.9.0 单会话静音 + v0.8.0 通知粒度：被忽略的路径不发声不弹 Toast（broadcast 照常，视觉保留）
    if (!this.dnd && !sessionMuted && notifyAllowed(event.eventType, this.notifyFilter)) {
      const strategy = resolveStrategy(event, view, { dnd: this.dnd, muted: this.muted })
      // v1.1.3 瞬态错误降级：宿主会自动重试的错误（并发限制/网络抖动）不响出错音、
      // 只发一次轻量 Toast——刺耳的 error 音留给真正的失败
      if (event.eventType === 'error' && event.payload?.transient) {
        strategy.sound = false
        strategy.title = `${view?.title ?? event.sessionId} 瞬态错误（自动重试中）`
      }
      this.notifyExecutor?.(strategy, event, view)
    }
    // v0.11.0 每日简报入账
    this.digest.onEvent(event.eventType, {
      runMs:
        event.eventType === 'turn_completed' && prevTurnStartedAt !== undefined
          ? Math.max(0, event.timestamp - prevTurnStartedAt)
          : 0,
      usage: event.payload?.usage
    })
    // v1.2.0 回顾引擎入账
    this.recap.onEvent(event)
    this.broadcast()
  }

  /** v0.11.0 每日简报出口：勿扰时静默；sound 恒 false（只弹通知） */
  private emitDigest(s: DigestSummary): void {
    if (this.dnd) return
    const hours = Math.floor(s.runMs / 3_600_000)
    const mins = Math.round((s.runMs % 3_600_000) / 60_000)
    const tokens = s.tokensIn + s.tokensOut
    // 符号化正文：语言无关（✓ 完成 ✗ 出错 ⏱ 运行 Σ tokens）
    const body = [
      `✓ ${s.completed}`,
      `✗ ${s.errors}`,
      s.runMs > 0 ? `⏱ ${hours}h ${mins}m` : '',
      tokens > 0 ? `Σ ${(tokens / 1000).toFixed(1)}k` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    this.notifyExecutor?.(
      {
        displayState: 'done',
        sound: false,
        soundType: null,
        toast: true,
        title: t('digestTitle'),
        body
      },
      {
        source: 'digest',
        agentType: 'custom',
        sessionId: 'daily-digest',
        eventType: 'heartbeat',
        timestamp: Date.now()
      },
      undefined
    )
  }

  /** v0.9.0 单会话静音：切换指定会话的通知忽略状态并持久化。返回切换后是否被忽略 */
  toggleSessionMuted(key: string): boolean {
    if (this.mutedSessions.has(key)) {
      this.mutedSessions.delete(key)
    } else {
      this.mutedSessions.add(key)
    }
    this.config.set('mutedSessions', [...this.mutedSessions])
    return this.mutedSessions.has(key)
  }

  isSessionMuted(key: string): boolean {
    return this.mutedSessions.has(key)
  }

  get mutedSessionKeys(): string[] {
    return [...this.mutedSessions]
  }

  private broadcast(): void {
    const snapshot = this.registry.snapshot()
    for (const fn of this.subscribers) fn(snapshot)
  }

  /**
   * DND 变化回调（装配层注入）——勿扰有四条改动路径（面板 IPC、设置面板、托盘菜单、球右键菜单），
   * 统一从 setDnd 发出，保证球的月牙角标与面板指示不与任何一条路径失步。
   */
  onDndChanged: ((value: boolean) => void) | null = null

  setDnd(value: boolean): void {
    this.dnd = value
    if (!value) {
      // 手动关闭时清掉定时（若有），避免计时器到点又把刚解除的勿扰再动一遍
      if (this.dndTimer) clearTimeout(this.dndTimer)
      this.dndTimer = null
      this.dndUntil = null
    }
    this.config.set('dnd', value)
    this.broadcast() // 让球体更新月牙指示
    this.onDndChanged?.(value)
  }

  toggleDnd(): boolean {
    this.setDnd(!this.dnd)
    return this.dnd
  }

  /** v0.9.0 定时勿扰：开启并设置到期时间，到期自动解除广播。返回到期时间戳（ms epoch）；ms<=0 等价关闭 */
  setDndFor(ms: number): number | null {
    if (ms <= 0) {
      this.setDnd(false)
      return null
    }
    this.setDnd(true)
    this.dndUntil = Date.now() + ms
    if (this.dndTimer) clearTimeout(this.dndTimer)
    this.dndTimer = setTimeout(() => {
      this.dndTimer = null
      this.dndUntil = null
      this.setDnd(false)
    }, ms)
    return this.dndUntil
  }

  /** 定时勿扰剩余毫秒；非定时态返回 null */
  get dndRemainingMs(): number | null {
    if (!this.dnd || this.dndUntil === null) return null
    return Math.max(0, this.dndUntil - Date.now())
  }

  setMuted(value: boolean): void {
    this.muted = value
    this.config.set('muted', value)
  }

  /** 更新通知粒度开关并持久化 */
  setNotifyEvents(filter: NotifyFilter): void {
    this.notifyFilter = filter
    this.config.set('notifyEvents', filter)
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
    const customSounds: Record<string, { path: string; name: string }> = {}
    for (const [kind, p] of Object.entries(this.config.get('customSounds') ?? {})) {
      if (typeof p !== 'string' || !p) continue
      customSounds[kind] = { path: p, name: p.split(/[\\/]/).pop() ?? p }
    }
    return {
      version: this.appVersion,
      customSounds,
      dnd: this.dnd,
      muted: this.muted,
      locale: this.config.get('locale') ?? 'system',
      notifyEvents: { ...NOTIFY_FILTER_DEFAULTS, ...this.notifyFilter },
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

  /** v1.2.0 回顾视图（惰性加载 + 打开中卡片合并） */
  recapView(date?: string): { date: string; cards: TaskCard[]; totals: RecapTotals } {
    const today = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const fallback = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
    const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : fallback
    return this.recap.view(d)
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
