/**
 * 会话注册表 —— 维护所有会话的内部记录，并把状态机结果投影为 SessionView
 * 零 electron 依赖，可单测。内部保留：state / flags / 元信息 / 事件环形缓冲
 *
 * P2-8 事件历史持久化：环形缓冲经 HistoryStore 落盘（注入式存储钩子，
 * core 层不碰 fs/electron；主进程启动时 loadHistory、退出/定时 saveHistory）
 */
import { transitionState } from './state-machine'
import {
  AgentEvent,
  AgentType,
  SessionFlags,
  SessionHistoryItem,
  SessionState,
  SessionView,
  sessionKey
} from '../shared/events'
import { EVENT_RING_BUFFER_SIZE, DONE_HOLD_MS_DEFAULT, RESTORED_RETENTION_MS, SESSION_ENDED_RETENTION_MS } from '../shared/constants'

/** 历史持久化钩子（P2-8）：由上层注入实现，core 保持零 IO */
export interface HistoryStore {
  load(): SessionHistoryItem[] | null
  save(items: SessionHistoryItem[]): void
}

/** 内部会话记录 */
interface SessionRecord {
  key: string
  agentType: AgentType
  sessionId: string
  state: SessionState
  flags: SessionFlags
  cwd?: string
  currentTool?: string
  turnStartedAt?: number
  lastEventAt: number
  title?: string
  pid?: number
  /** 保留"上一非错误态"，error 恢复显示用（暂存，MVP 不深用） */
  prevState: SessionState
  /**
   * v0.5.0 完成保持：turn_completed 的时刻。
   * 视图投影时若 now - doneAt < DONE_HOLD_MS 则 state 显示为 'done'
   * （状态机仍落 idle，推断引擎不受影响）——修复 done 展示态自 v0.4.2 起不可达的问题。
   */
  doneAt?: number
  /** 事件环形缓冲（每会话最近 N 条，MVP 存内存不落盘） */
  events: AgentEvent[]

  /** 仅来自历史恢复（P2-8）：不出现在会话列表，直到收到新事件 */
  restoredOnly?: boolean

  /**
   * session_ended 的时刻：到期由 prune() 清除会话（消除托盘常驻下的内存单调增长）。
   * 会话复活（任何非 heartbeat 事件到达）即清除。
   */
  endedAt?: number
}

/** 由 cwd 推导展示名（目录名），无 cwd 时回退会话 ID 前缀 */
function deriveTitle(sessionId: string, cwd?: string): string {
  if (cwd) {
    const norm = cwd.replace(/[\\/]+$/, '')
    const seg = norm.split(/[\\/]/).pop()
    if (seg && seg !== norm) return seg
  }
  // 会话 id 常含 uuid/时间戳，取前 12 字符作兜底标题
  return sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId
}

export class SessionRegistry {
  private sessions = new Map<string, SessionRecord>()
  private historyStore: HistoryStore | null = null
  /** 脏标记：有新事件才落盘（saveHistory 幂等可安全重复调用） */
  private historyDirty = false

  /** 注入历史持久化钩子并恢复上次退出前的历史（P2-8） */
  setHistoryStore(store: HistoryStore): void {
    this.historyStore = store
    try {
      const saved = store.load()
      if (saved && saved.length > 0) this.restoreHistory(saved)
    } catch {
      /* 恢复失败不阻塞启动 */
    }
  }

  /** 从持久化条目重建环形缓冲（只回填 events，不重放状态机） */
  private restoreHistory(items: SessionHistoryItem[]): void {
    for (const it of items) {
      const key = sessionKey(it.agentType, it.sessionId)
      let rec = this.sessions.get(key)
      if (!rec) {
        rec = {
          key,
          agentType: it.agentType,
          sessionId: it.sessionId,
          state: 'idle',
          flags: { timeout: false, disconnected: false },
          lastEventAt: it.timestamp,
          title: it.title,
          prevState: 'idle',
          restoredOnly: true,
          events: []
        }
        this.sessions.set(key, rec)
      }
      rec.events.push({
        source: 'history-restore',
        agentType: it.agentType,
        sessionId: it.sessionId,
        eventType: it.eventType,
        timestamp: it.timestamp,
        payload: { toolName: it.toolName, errorMessage: it.errorMessage }
      })
      if (rec.events.length > EVENT_RING_BUFFER_SIZE) {
        rec.events.splice(0, rec.events.length - EVENT_RING_BUFFER_SIZE)
      }
    }
  }

  /** 落盘当前全部历史（脏时才写；由主进程定时 + 退出时调用） */
  saveHistory(): boolean {
    if (!this.historyStore || !this.historyDirty) return false
    try {
      this.historyStore.save(this.history())
      this.historyDirty = false
      return true
    } catch {
      return false
    }
  }

  /** 应用一个事件，返回：变更后的该会话视图；若 key 变化（新会话）返回新建视图 */
  apply(event: AgentEvent): SessionView {
    const key = sessionKey(event.agentType, event.sessionId)
    let rec = this.sessions.get(key)

    if (!rec) {
      rec = {
        key,
        agentType: event.agentType,
        sessionId: event.sessionId,
        state: 'idle',
        flags: { timeout: false, disconnected: false },
        cwd: event.cwd,
        lastEventAt: event.timestamp,
        pid: event.payload?.pid,
        title: event.payload?.title ?? deriveTitle(event.sessionId, event.cwd),
        prevState: 'idle',
        events: []
      }
      this.sessions.set(key, rec)
    }

    // 状态转移
    rec.state = transitionState(rec.state, event.eventType)

    // 字段更新
    if (event.cwd !== undefined) rec.cwd = event.cwd
    if (event.payload?.pid !== undefined) rec.pid = event.payload.pid
    // 轮询型源（hermes/codex）后发真实标题（如 Hermes 摘要标题）：覆盖 ID 前缀兜底名
    if (event.payload?.title) rec.title = event.payload.title

    switch (event.eventType) {
      case 'turn_started':
        rec.turnStartedAt = event.timestamp
        break
      case 'tool_call_started':
        rec.currentTool = event.payload?.toolName ?? rec.currentTool
        break
      case 'tool_call_finished':
        // 保留当前工具展示直至下一轮/新工具；finished 不立即清空（面板可见性更好）
        break
      case 'turn_completed':
      case 'session_ended':
        rec.currentTool = undefined
        rec.turnStartedAt = undefined
        // v0.5.0 完成保持：只有 turn_completed 触发 done 展示窗口（session_ended 是收工，不庆祝）
        if (event.eventType === 'turn_completed') rec.doneAt = event.timestamp
        break
      case 'waiting_input':
      case 'thinking':
        break
      case 'error':
        rec.currentTool = event.payload?.toolName ?? rec.currentTool
        break
      default:
        break
    }

    // endedAt 生命周期：session_ended 记下时刻供 prune 清除；会话复活（其他事件）即撤销
    if (event.eventType === 'session_ended') {
      rec.endedAt = event.timestamp
    } else if (event.eventType !== 'heartbeat') {
      rec.endedAt = undefined
    }

    // 任何新事件都清除 timeout/disconnected 叠加标记（架构文档：恢复即清除）
    if (event.eventType !== 'heartbeat') {
      rec.flags = { timeout: false, disconnected: false }
    }
    rec.lastEventAt = event.timestamp

    // 从历史恢复的会话收到真实事件 -> 回归正常会话列表
    rec.restoredOnly = false

    // 环形缓冲
    rec.events.push(event)
    if (rec.events.length > EVENT_RING_BUFFER_SIZE) {
      rec.events.splice(0, rec.events.length - EVENT_RING_BUFFER_SIZE)
    }
    this.historyDirty = true

    // session_ended 后由推断 tick 调用 prune() 延迟清除（见 SESSION_ENDED_RETENTION_MS）
    return this.toView(rec)
  }

  /**
   * 过期会话清理（MonitoringCore 推断 tick 每秒调用）：
   *  - session_ended 宽限期到期的会话整条移除（含环形缓冲）
   *  - 仅来自历史恢复的条目超过保留期后清除（防托盘常驻内存单调膨胀）
   * @returns 本次移除的会话数（>0 时上层需广播刷新面板）
   */
  prune(now: number): number {
    let removed = 0
    for (const [key, rec] of this.sessions) {
      const endedExpired =
        rec.endedAt !== undefined && now - rec.endedAt > SESSION_ENDED_RETENTION_MS
      const restoredExpired =
        rec.restoredOnly === true && now - rec.lastEventAt > RESTORED_RETENTION_MS
      if (endedExpired || restoredExpired) {
        this.sessions.delete(key)
        removed++
      }
    }
    return removed
  }

  /** 按 key 强制设置推断标记（InferenceEngine 调用） */
  setFlags(key: string, flags: Partial<SessionFlags>): SessionView | undefined {
    const rec = this.sessions.get(key)
    if (!rec) return undefined
    rec.flags = { ...rec.flags, ...flags }
    return this.toView(rec)
  }

  /** 心跳续期：更新 lastEventAt 并清除 disconnected */
  heartbeat(key: string, timestamp: number): SessionView | undefined {
    const rec = this.sessions.get(key)
    if (!rec) return undefined
    rec.lastEventAt = timestamp
    if (rec.flags.disconnected) rec.flags = { ...rec.flags, disconnected: false }
    return this.toView(rec)
  }

  /** 删除会话（如 session_ended 后超时清理） */
  remove(key: string): void {
    this.sessions.delete(key)
  }

  /** 全量快照（按优先级排序：error > waiting > running > idle） */
  snapshot(): SessionView[] {
    const views = [...this.sessions.values()]
      .filter((r) => !r.restoredOnly)
      .map((r) => this.toView(r))
    const prio = { error: 0, waiting_input: 1, tool_calling: 2, thinking: 3, done: 4, idle: 5 } as const
    views.sort((a, b) => {
      const pa = prio[a.state] ?? 5
      const pb = prio[b.state] ?? 5
      if (pa !== pb) return pa - pb
      return b.lastEventAt - a.lastEventAt
    })
    return views
  }

  /**
   * 事件历史投影：全部会话的环形缓冲合并为一条时间线（时间倒序）。
   * @param limit 最多返回条数（默认取环形缓冲总量，避免面板一次渲染过重）
   */
  history(limit: number = EVENT_RING_BUFFER_SIZE * 4): SessionHistoryItem[] {
    const items: SessionHistoryItem[] = []
    for (const rec of this.sessions.values()) {
      for (const e of rec.events) {
        items.push({
          key: rec.key,
          agentType: rec.agentType,
          sessionId: rec.sessionId,
          title: rec.title,
          eventType: e.eventType,
          timestamp: e.timestamp,
          toolName: e.payload?.toolName,
          errorMessage: e.payload?.errorMessage
        })
      }
    }
    items.sort((a, b) => b.timestamp - a.timestamp)
    return items.slice(0, Math.max(1, limit))
  }

  get(key: string): SessionView | undefined {
    const rec = this.sessions.get(key)
    return rec ? this.toView(rec) : undefined
  }

  get size(): number {
    return this.sessions.size
  }

  /** 内部记录 → 渲染视图（不暴露事件缓冲）。now 注入可测 */
  private toView(rec: SessionRecord, now: number = Date.now()): SessionView {
    const view: SessionView = {
      key: rec.key,
      agentType: rec.agentType,
      sessionId: rec.sessionId,
      state: rec.state,
      flags: { ...rec.flags },
      cwd: rec.cwd,
      currentTool: rec.currentTool,
      turnStartedAt: rec.turnStartedAt,
      lastEventAt: rec.lastEventAt,
      title: rec.title,
      pid: rec.pid
    }
    // v0.5.0 完成保持投影：turn_completed 后 DONE_HOLD_MS 内（墙钟）视图显示 done。
    // 状态机仍落 idle；timeout/disconnected 标记优先级更高（toDisplayState 先看 flags）。
    if (rec.state === 'idle' && rec.doneAt !== undefined && now < rec.doneAt + DONE_HOLD_MS_DEFAULT) {
      view.state = 'done'
    }
    return view
  }
}
