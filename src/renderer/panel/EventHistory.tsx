/**
 * EventHistory —— 事件历史时间线（底部页签）
 * 数据：主进程 SessionRegistry 环形缓冲投影（每会话最近 1000 条，跨会话合并倒序）
 */
import { Fragment, useCallback, useEffect, useState } from 'react'
import { SessionHistoryItem, AgentEventType } from '../../shared/events'
import { t, I18nKey } from '../../shared/i18n'
import { AlertTriangle, WifiOff, Zap } from '../shared/icons'

/** 事件类型 -> 展示动词（与状态色一致） */
const EVENT_VERB_KEY: Record<AgentEventType, I18nKey> = {
  session_started: 'evSessionStarted',
  session_ended: 'evSessionEnded',
  turn_started: 'evTurnStarted',
  thinking: 'evThinking',
  tool_call_started: 'evToolCall',
  tool_call_finished: 'evToolCallDone',
  turn_completed: 'evTurnCompleted',
  waiting_input: 'evWaiting',
  error: 'evErrorVerb',
  heartbeat: 'evHeartbeat'
}

const EVENT_CLASS: Record<AgentEventType, string> = {
  session_started: 'ev-idle',
  session_ended: 'ev-offline',
  turn_started: 'ev-running',
  thinking: 'ev-running',
  tool_call_started: 'ev-tool',
  tool_call_finished: 'ev-done',
  turn_completed: 'ev-done',
  waiting_input: 'ev-waiting',
  error: 'ev-error',
  heartbeat: 'ev-muted'
}

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
  dsh: 'DSH',
  zcode: 'ZCode',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  custom: 'Harness'
}

/** HH:mm:ss 时间戳 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 日期分组标签（v0.8.0 → v1.0.0 i18n）：今天 / 昨天 / M月D日（跨年带年份） */
function dayLabel(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '?'
  const now = new Date()
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return t('today')
  if (diffDays === 1) return t('yesterday')
  const base = `${d.getMonth() + 1}/${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? base : `${d.getFullYear()}/${base}`
}

function EventIcon({ type }: { type: AgentEventType }) {
  if (type === 'error') return <AlertTriangle size={12} className="ev-icon ev-icon-error" />
  if (type === 'waiting_input') return <Zap size={12} className="ev-icon ev-icon-waiting" />
  if (type === 'session_ended') return <WifiOff size={12} className="ev-icon ev-icon-offline" />
  return <i className={`dot ${EVENT_CLASS[type]}`} />
}

export function EventHistory() {
  const [items, setItems] = useState<SessionHistoryItem[] | null>(null)
  /** 点击行后 2s 内显示「已跳转」反馈 */
  const [jumped, setJumped] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setItems(await window.pupil.getHistory())
    } catch {
      setItems([])
    }
  }, [])

  useEffect(() => {
    void load()
    // 轻量轮询：历史页签打开期间每 3s 刷新（数据在主进程内存中，开销可忽略）
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [load])

  /** P2-5：点击历史行 -> 跳转对应会话窗口（复用窗口激活链路） */
  const jumpToSession = async (key: string): Promise<void> => {
    try {
      await window.pupil.activateWindow(key)
      setJumped(key)
      setTimeout(() => setJumped(null), 2000)
    } catch {
      /* 激活失败静默：会话可能已被清理 */
    }
  }

  if (items === null) {
    return <div className="history-empty">{t('historyLoading')}</div>
  }
  if (items.length === 0) {
    return (
      <div className="history-empty">
        {t('historyEmpty')}
        <span className="history-empty-sub">{t('historyEmptySub')}</span>
      </div>
    )
  }

  return (
    <ul className="history-list">
      {items.map((it, i) => {
        const label = dayLabel(it.timestamp)
        const showDay = i === 0 || dayLabel(items[i - 1].timestamp) !== label
        return (
          <Fragment key={`${it.key}-${it.timestamp}-${i}`}>
            {showDay && <li className="history-day">{label}</li>}
            <li
              className="history-row history-row-clickable"
              title={`${t('jumpTooltip')}: ${it.title ?? it.sessionId.slice(0, 12)}`}
              onClick={() => void jumpToSession(it.key)}
            >
              <span className="history-time">{formatTime(it.timestamp)}</span>
              <EventIcon type={it.eventType} />
              <div className="history-main">
                <div className="history-title">
                  <span className="history-name">{it.title ?? it.sessionId.slice(0, 12)}</span>
                  <span className="agent-tag">{AGENT_LABEL[it.agentType] ?? it.agentType}</span>
                  {jumped === it.key && <span className="history-jumped">{t('historyJumped')}</span>}
                </div>
                <div className={`history-desc ${EVENT_CLASS[it.eventType]}`}>
                  {t(EVENT_VERB_KEY[it.eventType])}
                  {it.toolName ? ` ${it.toolName}` : ''}
                  {it.errorMessage ? ` · ${it.errorMessage}` : ''}
                </div>
              </div>
            </li>
          </Fragment>
        )
      })}
    </ul>
  )
}
