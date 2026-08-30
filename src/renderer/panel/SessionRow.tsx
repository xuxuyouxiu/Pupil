/**
 * SessionRow —— 单会话行（状态点 + 身份 + 当前活动 + 时长 + 悬停跳转）
 * 点击整行 -> 激活对应窗口
 */
import { useEffect, useState } from 'react'
import { SessionView, toDisplayState, DisplayState } from '../../shared/events'
import { t } from '../../shared/i18n'
import { ExternalLink } from '../shared/icons'
import { formatDuration } from './Panel'

const DOT_CLASS: Record<DisplayState, string> = {
  initializing: 'dot-running',
  running: 'dot-running',
  waiting: 'dot-waiting',
  done: 'dot-done',
  error: 'dot-error',
  timeout: 'dot-timeout',
  offline: 'dot-offline',
  idle: 'dot-offline'
}

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
  dsh: 'DSH',
  zcode: 'ZCode',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  custom: '自研 Harness'
}

/** 当前活动描述 */
function activity(view: SessionView): string {
  switch (toDisplayState(view)) {
    case 'running':
      return view.currentTool ? `${t('activityCalling')} ${view.currentTool}` : t('activityThinking')
    case 'waiting':
      return t('activityWaiting')
    case 'done':
      return t('activityDone')
    case 'error':
      return view.state === 'error' ? t('activityFailed') : t('activityError')
    case 'timeout':
      return t('activityTimeout')
    case 'offline':
      return t('activityOffline')
    default:
      return t('activityIdle')
  }
}

/** v0.11.0 token 数格式化：1234 -> 1.2k */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function SessionRow({ view }: { view: SessionView }) {
  const [hover, setHover] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [muted, setMuted] = useState(false)
  /** 本地秒级心跳：主进程只在状态变化时广播，没有它运行中的时长会冻结到下一个事件 */
  const [, tick] = useState(0)
  const state = toDisplayState(view)
  const runningMs =
    view.turnStartedAt !== undefined ? Date.now() - view.turnStartedAt : undefined

  useEffect(() => {
    if (view.turnStartedAt === undefined) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [view.turnStartedAt])

  useEffect(() => {
    void window.pupil.isSessionMuted(view.key).then(setMuted)
  }, [view.key])

  const toggleMute = (): void => {
    void window.pupil.toggleSessionMuted(view.key).then(setMuted)
  }

  const jump = async (): Promise<void> => {
    const res = await window.pupil.activateWindow(view.key)
    setNotFound(!res.ok)
    if (res.ok) setNotFound(false)
    setTimeout(() => setNotFound(false), 2000)
  }

  return (
    <li
      className="session-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => void jump()}
      onContextMenu={(e) => {
        e.preventDefault()
        toggleMute()
      }}
      title={view.cwd ?? view.key}
    >
      <i className={`dot ${DOT_CLASS[state]}`} />
      <div className="row-main">
        <div className="row-title">
          <span className="session-name">{muted ? `🔇 ${view.title ?? view.sessionId}` : view.title ?? view.sessionId}</span>
          <span className="agent-tag">{AGENT_LABEL[view.agentType] ?? view.agentType}</span>
        </div>
        <div className="row-sub">
          {notFound ? (
            <span className="row-sub-warn">{t('windowNotFound')}</span>
          ) : (
            <span>{activity(view)}</span>
          )}
        </div>
      </div>
      <span className="duration">
        {runningMs !== undefined
          ? formatDuration(runningMs)
          : state === 'running'
            ? '--:--'
            : '—'}
        {view.usage && view.usage.totalIn + view.usage.totalOut > 0 && (
          <span className="usage" title={t('rowTitle')}>
            {' · '}
            {fmtTokens(view.usage.totalIn + view.usage.totalOut)}
            {view.usage.costTotal > 0 ? ` · $${view.usage.costTotal.toFixed(2)}` : ''}
          </span>
        )}
      </span>
      <button
        className={`jump-btn ${hover ? 'visible' : ''}`}
        aria-label={t('jumpTooltip')}
        onClick={(e) => {
          e.stopPropagation()
          void jump()
        }}
      >
        <ExternalLink size={15} />
      </button>
    </li>
  )
}
