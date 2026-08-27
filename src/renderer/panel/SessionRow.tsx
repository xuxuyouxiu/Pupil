/**
 * SessionRow —— 单会话行（状态点 + 身份 + 当前活动 + 时长 + 悬停跳转）
 * 点击整行 -> 激活对应窗口
 */
import { useEffect, useState } from 'react'
import { SessionView, toDisplayState, DisplayState } from '../../shared/events'
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
  custom: '自研 Harness'
}

/** 当前活动描述 */
function activity(view: SessionView): string {
  switch (toDisplayState(view)) {
    case 'running':
      return view.currentTool ? `调用 ${view.currentTool}` : '思考中…'
    case 'waiting':
      return '等待确认'
    case 'done':
      return '已完成 · 点击查看结果'
    case 'error':
      return view.state === 'error' ? '任务失败' : '错误'
    case 'timeout':
      return '运行超时'
    case 'offline':
      return '连接中断'
    default:
      return '空闲'
  }
}

export function SessionRow({ view }: { view: SessionView }) {
  const [hover, setHover] = useState(false)
  const [notFound, setNotFound] = useState(false)
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
      title={view.cwd ?? view.key}
    >
      <i className={`dot ${DOT_CLASS[state]}`} />
      <div className="row-main">
        <div className="row-title">
          <span className="session-name">{view.title ?? view.sessionId}</span>
          <span className="agent-tag">{AGENT_LABEL[view.agentType] ?? view.agentType}</span>
        </div>
        <div className="row-sub">
          {notFound ? (
            <span className="row-sub-warn">窗口未找到</span>
          ) : (
            <span>{activity(view)}</span>
          )}
        </div>
      </div>
      <span className="duration">{formatDuration(runningMs)}</span>
      <button
        className={`jump-btn ${hover ? 'visible' : ''}`}
        aria-label="跳转会话窗口"
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
