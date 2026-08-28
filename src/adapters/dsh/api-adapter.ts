/**
 * DSH（DeepSeek Harness）Web API adapter —— 通道 C（只读轮询）
 *
 * 不再依赖解析 DSH 的 zstd 会话日志：直接轮询 DSH 自带的 Web API
 *   POST /api/session.list
 * 返回的 SessionSummary 已带权威的 `running` 布尔值（宿主侧 Agent 注册表状态），
 * 这正是"未检测到 agent 运行"所需的信号。DSH web 默认监听 127.0.0.1:3080，
 * 可用环境变量 `DSH_API_BASE`（或 `DSH_WEB_URL`）覆盖。
 *
 * 映射（粗粒度，兜底语义）：
 *   新会话（非 blank）              -> session_started
 *   running false -> true           -> turn_started（球体进入运行态）
 *   running true  -> false          -> turn_completed（完成/空闲）
 *   running 期间周期性 heartbeat     -> 续期 lastEventAt，避免轮询源被误判断连
 *   标题经 projections.values.title 更新 -> heartbeat 携带 title 刷新面板
 *   会话从列表消失                  -> session_ended
 */
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentEvent, AgentType } from '../../shared/events'

const ID = 'dsh-api'
const POLL_INTERVAL_MS = 3_000
const REQUEST_TIMEOUT_MS = 2_000
const HEARTBEAT_INTERVAL_MS = 30_000
/** 与 hermes/codex 相同：只监控最近活跃会话，历史会话不铺满面板 */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_API_BASE = 'http://127.0.0.1:3080'

/** session.list 返回的单个会话摘要（只声明本 adapter 使用的字段） */
export interface DshSessionSummary {
  sessionId: string
  updatedAt?: number
  running?: boolean
  blank?: boolean
  /** 宿主侧细粒度状态（v0.10.0 容错映射：wait/input/approv/confirm/permission 视为等待输入） */
  status?: string
  cwd?: string
  origin?: string
  projections?: {
    values?: {
      title?: string | null
      sessionListMetadata?: { lastPromptAt?: number | null }
    }
  }
}

interface DshListPayload {
  items?: DshSessionSummary[]
}

export interface DshListResponse {
  type?: string
  rpcId?: string
  result?: {
    ok?: boolean
    value?: DshListPayload
  }
}

/** 内部跟踪：一次会话的最近一次观测 */
export interface DshSessionTrack {
  running: boolean
  blank: boolean
  /** v0.10.0：上一观测是否处于等待输入（边沿触发 waiting_input 事件） */
  waiting: boolean
  /** 是否已向 Pupil 上报过 session_started */
  emitted: boolean
  title?: string
  lastUpdatedAt: number
  lastHeartbeatAt: number
}

/** 容错判断宿主状态串是否表示"等用户"（权限确认/输入请求等） */
export function looksLikeWaiting(status?: string): boolean {
  if (!status) return false
  return /wait|input|approv|confirm|permission/i.test(status)
}

export function apiBaseUrl(): string {
  const raw = process.env.DSH_API_BASE ?? process.env.DSH_WEB_URL ?? DEFAULT_API_BASE
  return raw.replace(/\/+$/, '')
}

/** 调用 DSH session.list；失败抛错（detect/health 据判断数据源可用性） */
export async function fetchSessionList(
  base: string = apiBaseUrl(),
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<DshSessionSummary[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `pupil-${Date.now()}`,
        method: 'session.list',
        payload: {}
      }),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`DSH API HTTP ${res.status}`)
    const data = (await res.json()) as DshListResponse
    const items = data.result?.ok === true ? data.result.value?.items : undefined
    return Array.isArray(items) ? items : []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 是否应监控该会话：运行中，或最近活跃（避免历史会话铺满面板）。
 */
export function shouldMonitorDshSession(
  item: Pick<DshSessionSummary, 'running' | 'updatedAt'>,
  now: number,
  activeWindowMs: number = ACTIVE_WINDOW_MS
): boolean {
  return item.running === true || (item.updatedAt !== undefined && now - item.updatedAt <= activeWindowMs)
}

/**
 * 会话快照纯差分：把一条 session.list 摘要映射为归一化事件。
 * 纯函数（除 `now` 外无副作用），供单元测试直接覆盖。
 */
export function diffSession(
  prev: DshSessionTrack | undefined,
  item: DshSessionSummary,
  now: number
): { events: Omit<AgentEvent, 'source' | 'agentType'>[]; next: DshSessionTrack } {
  const events: Omit<AgentEvent, 'source' | 'agentType'>[] = []
  const running = item.running === true
  const blank = item.blank === true
  const waiting = running && looksLikeWaiting(item.status)
  const title = item.projections?.values?.title ?? undefined
  const cwd = item.cwd
  const updatedAt = item.updatedAt ?? 0
  const base = {
    sessionId: item.sessionId,
    cwd,
    timestamp: now,
    payload: { title, raw: item }
  } as Omit<AgentEvent, 'source' | 'agentType'>

  // 首次观测
  if (!prev) {
    const next: DshSessionTrack = {
      running,
      blank,
      waiting,
      emitted: !blank,
      title,
      lastUpdatedAt: updatedAt,
      lastHeartbeatAt: running ? now : 0
    }
    if (blank) return { events, next }
    events.push({ ...base, eventType: 'session_started' })
    if (running) events.push({ ...base, eventType: 'turn_started' })
    if (waiting) events.push({ ...base, eventType: 'waiting_input' })
    return { events, next }
  }

  const next: DshSessionTrack = {
    ...prev,
    running,
    blank,
    waiting,
    title: title ?? prev.title,
    lastUpdatedAt: updatedAt
  }

  // blank -> 非 blank：新会话开始了（曾为空白会话，现在有了第一轮）
  if (!prev.emitted && !blank) {
    next.emitted = true
    next.lastHeartbeatAt = running ? now : next.lastHeartbeatAt
    events.push({ ...base, eventType: 'session_started' })
    if (running) events.push({ ...base, eventType: 'turn_started' })
    if (waiting) events.push({ ...base, eventType: 'waiting_input' })
    return { events, next }
  }

  // 标题变化：用 heartbeat 携带 title 刷新面板（不改变状态机）
  if (prev.emitted && title && title !== prev.title) {
    events.push({ ...base, eventType: 'heartbeat' })
  }

  // 运行态切换（权威信号来自 DSH 宿主侧 agent 状态）
  if (running && !prev.running) {
    events.push({ ...base, eventType: 'turn_started' })
  } else if (!running && prev.running) {
    next.lastHeartbeatAt = 0
    events.push({ ...base, eventType: 'turn_completed' })
  } else if (running && now - prev.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
    // 轮询源续期：避免长时间 LLM 生成被误判断连
    next.lastHeartbeatAt = now
    events.push({ ...base, eventType: 'heartbeat' })
  }

  // v0.10.0 等待输入边沿：进入等待 -> waiting_input；解除等待但仍在运行 -> 重新 turn_started
  if (running && waiting !== prev.waiting) {
    events.push({ ...base, eventType: waiting ? 'waiting_input' : 'turn_started' })
  }

  return { events, next }
}

export class DshApiAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType = 'dsh'
  readonly capabilities = ['lifecycle'] as const

  private emit: ((e: AgentEvent) => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private tracks = new Map<string, DshSessionTrack>()
  private stopped = false

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    this.stopped = false
    await this.poll()
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
    console.log(`[dsh-api] monitoring DSH web at ${apiBaseUrl()}`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async healthCheck(): Promise<AdapterHealth> {
    try {
      await fetchSessionList()
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'DSH web API unreachable'
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.emit) return
    let items: DshSessionSummary[]
    try {
      items = await fetchSessionList()
    } catch (error) {
      console.warn('[dsh-api] session.list failed:', error instanceof Error ? error.message : error)
      return
    }

    const now = Date.now()
    const seen = new Set<string>()
    for (const item of items) {
      if (!item.sessionId) continue
      seen.add(item.sessionId)
      // 只监控运行中或最近活跃的会话；历史会话不铺面板
      if (!shouldMonitorDshSession(item, now)) {
        const stale = this.tracks.get(item.sessionId)
        if (stale?.emitted) {
          this.tracks.delete(item.sessionId)
          this.emit({
            source: ID,
            agentType: 'dsh',
            sessionId: item.sessionId,
            eventType: 'session_ended',
            timestamp: now
          })
        }
        continue
      }
      const diff = diffSession(this.tracks.get(item.sessionId), item, now)
      this.tracks.set(item.sessionId, diff.next)
      for (const ev of diff.events) {
        this.emit({ ...ev, source: ID, agentType: 'dsh' })
      }
    }

    // 从列表消失的会话（DSH 删除/重命名等）收尾
    for (const [sessionId, track] of this.tracks) {
      if (seen.has(sessionId)) continue
      this.tracks.delete(sessionId)
      if (track.emitted) {
        this.emit({
          source: ID,
          agentType: 'dsh',
          sessionId,
          eventType: 'session_ended',
          timestamp: now
        })
      }
    }
  }
}

export const dshApiAdapterFactory: AdapterFactory = {
  id: ID,
  // 故意不提供 detect：Pupil 可能先于 DSH web 启动（开机自启/登录顺序），
  // 若 detect 在启动时失败，适配器会被跳过且不再重试——这里让适配器始终注册、
  // 每 3s 轮询，DSH web 上线后下一次 poll 即自动恢复会话检测。
  create: () => new DshApiAdapter()
}
