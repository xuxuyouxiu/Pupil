/**
 * Panel —— 详情面板（360px 宽，自悬浮球向右展开）
 * UIUX 文档第 5 节：顶栏汇总 + 会话列表（按优先级排序）+ 底部页签（会话/事件历史）
 */
import { useEffect, useMemo, useState } from 'react'
import { SessionView, toDisplayState, DisplayState, DISPLAY_PRIORITY } from '../../shared/events'
import { useSessions } from '../ball/use-sessions'
import { SessionRow } from './SessionRow'
import { Settings } from './Settings'
import { EventHistory } from './EventHistory'
import { Moon, Settings as SettingsIcon, Radar, History } from '../shared/icons'

type Tab = 'sessions' | 'history'

const STATE_LABEL: Record<DisplayState, string> = {
  initializing: '加载中',
  running: '运行',
  waiting: '待输入',
  done: '完成',
  error: '错误',
  timeout: '超时',
  offline: '断连',
  idle: '空闲'
}

/** mm:ss / h:mm:ss 时长格式化 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '--:--'
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function summarize(views: SessionView[]): { label: string; count: number }[] {
  const counts = new Map<DisplayState, number>()
  for (const v of views) {
    const d = toDisplayState(v)
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  const order: DisplayState[] = ['running', 'waiting', 'done', 'error', 'timeout', 'offline']
  return order
    .filter((d) => (counts.get(d) ?? 0) > 0)
    .map((d) => ({ label: STATE_LABEL[d], count: counts.get(d) ?? 0 }))
}

export function Panel() {
  const sessions = useSessions()
  const [tab, setTab] = useState<Tab>('sessions')
  const [dnd, setDnd] = useState(false)
  /** 面板内嵌设置视图（用户偏好：点设置在悬浮窗内展开，不弹独立窗口） */
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    void window.pupil.getDnd().then(setDnd)
    const off = window.pupil.onDndChanged(setDnd)
    return off
  }, [])


  const summary = useMemo(() => summarize(sessions), [sessions])
  const sorted = useMemo(
    () =>
      [...sessions].sort(
        (a, b) =>
          DISPLAY_PRIORITY[toDisplayState(b)] - DISPLAY_PRIORITY[toDisplayState(a)]
      ),
    [sessions]
  )

  if (showSettings) {
    return <Settings onBack={() => setShowSettings(false)} />
  }

  return (
    <div className="panel">
      {/* 顶栏 */}
      <header className={`panel-top ${dnd ? 'dnd' : ''}`}>
        <div className="summary">
          {summary.length === 0 ? (
            <span className="summary-empty">无活跃会话</span>
          ) : (
            summary.map((s) => (
              <span key={s.label} className="summary-item">
                <i className={`dot dot-${s.label}`} />
                {s.count} {s.label}
              </span>
            ))
          )}
        </div>
        <div className="top-actions">
          <button
            className={`icon-btn ${dnd ? 'active' : ''}`}
            aria-label="切换勿扰模式"
            onClick={() => void window.pupil.toggleDnd().then(setDnd)}
          >
            <Moon size={16} />
          </button>
          <button
            className="icon-btn"
            aria-label="设置"
            onClick={() => setShowSettings(true)}
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>

      {/* 会话列表 / 事件历史 */}
      <div className="panel-body">
        {tab === 'history' ? (
          <EventHistory />
        ) : sorted.length === 0 ? (
          <div className="empty-state">
            <Radar size={32} strokeWidth={1.5} />
            <p className="empty-title">未检测到运行中的 Agent 会话</p>
            <p className="empty-sub">支持监控 Claude Code、Codex、Hermes 等工具的后台会话</p>
            <button className="empty-cta" onClick={() => void window.pupil.openSettingsWindow()}>
              查看接入指引
            </button>
          </div>
        ) : (
          <ul className="session-list">
            {sorted.map((view) => (
              <SessionRow key={view.key} view={view} />
            ))}
          </ul>
        )}
      </div>

      {/* 底部页签 */}
      <footer className="panel-tabs">
        <button
          className={`tab ${tab === 'sessions' ? 'active' : ''}`}
          onClick={() => setTab('sessions')}
        >
          会话
        </button>
        <button
          className={`tab ${tab === 'history' ? 'active' : ''}`}
          onClick={() => setTab('history')}
        >
          <History size={13} />
          事件历史
        </button>
      </footer>
    </div>
  )
}
