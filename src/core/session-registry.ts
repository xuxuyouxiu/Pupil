/**
 * 会话注册表 —— 维护所有会话的内部记录，并把状态机结果投影为 SessionView
 * 零 electron 依赖，可单测。内部保留：state / flags / 元信息 / 事件环形缓冲
 */
import { transitionState } from './state-machine'
import {
  AgentEvent,
  AgentType,
  SessionFlags,
  SessionState,
  SessionView,
  sessionKey
} from '../shared/events'
import { EVENT_RING_BUFFER_SIZE } from '../shared/constants'

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
  /** 事件环形缓冲（每会话最近 N 条，MVP 存内存不落盘） */
  events: AgentEvent[]
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
        title: deriveTitle(event.sessionId, event.cwd),
        pid: event.payload?.pid,
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

    // 任何新事件都清除 timeout/disconnected 叠加标记（架构文档：恢复即清除）
    if (event.eventType !== 'heartbeat') {
      rec.flags = { timeout: false, disconnected: false }
    }
    rec.lastEventAt = event.timestamp

    // 环形缓冲
    rec.events.push(event)
    if (rec.events.length > EVENT_RING_BUFFER_SIZE) {
      rec.events.splice(0, rec.events.length - EVENT_RING_BUFFER_SIZE)
    }

    // 会话结束后可延迟保留（MVP：session_ended 后仍展示 30s 由上层清理）
    return this.toView(rec)
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
    const views = [...this.sessions.values()].map((r) => this.toView(r))
    const prio = { error: 0, waiting_input: 1, tool_calling: 2, thinking: 3, idle: 4 } as const
    views.sort((a, b) => {
      const pa = prio[a.state] ?? 5
      const pb = prio[b.state] ?? 5
      if (pa !== pb) return pa - pb
      return b.lastEventAt - a.lastEventAt
    })
    return views
  }

  get(key: string): SessionView | undefined {
    const rec = this.sessions.get(key)
    return rec ? this.toView(rec) : undefined
  }

  get size(): number {
    return this.sessions.size
  }

  /** 内部记录 → 渲染视图（不暴露事件缓冲） */
  private toView(rec: SessionRecord): SessionView {
    return {
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
  }
}
