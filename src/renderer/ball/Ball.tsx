/**
 * Ball —— 悬浮球主体
 * 三层结构（UIUX 文档方案 A）：
 *   外层：按会话分段的状态环（每段弧 = 一个会话）
 *   中层：黑色球体 + 微弱高光
 *   中心：EyeSystem 精灵眼（最高优先级状态的表情）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DISPLAY_PRIORITY,
  DisplayState,
  SessionView,
  toDisplayState
} from '../../shared/events'
import { EyeSystem } from './EyeSystem'
import { useSessions } from './use-sessions'
import { playSound, setSoundConfig } from './sound'

const R = 24.5
const CIRC = 2 * Math.PI * R
const SEG_GAP = 3.2
const MAX_SEGMENTS = 5

const STATE_COLOR: Record<DisplayState, string> = {
  initializing: 'var(--state-running)',
  running: 'var(--state-running)',
  waiting: 'var(--state-waiting)',
  done: 'var(--state-done)',
  error: 'var(--state-error)',
  timeout: 'var(--state-timeout)',
  offline: 'var(--state-offline)',
  idle: 'var(--state-offline)'
}

/** 聚合最高优先级展示态 */
function aggregateState(views: SessionView[]): DisplayState {
  if (views.length === 0) return 'idle'
  return views
    .map(toDisplayState)
    .sort((a, b) => DISPLAY_PRIORITY[b] - DISPLAY_PRIORITY[a])[0]
}

/** 环动画类名（聚合态 -> 环动画） */
function ringAnimClass(state: DisplayState): string {
  switch (state) {
    case 'running':
      return 'ring-rotate'
    case 'waiting':
      return 'ring-breathe'
    case 'error':
      return 'ring-flash'
    case 'timeout':
      return 'ring-slow-flash'
    default:
      return ''
  }
}

/** 按会话绘制分段弧；>5 会话时合并为单色环 */
function RingSegments({ views }: { views: SessionView[] }) {
  // 注意：所有环都必须显式指定 cx/cy=28（SVG 默认圆心是 (0,0)/viewBox 左上角，
  // 漏写会导致弧线画到窗口角落——曾因此出现"球顶两段悬空弧线"）
  const CX = 28
  const CY = 28
  if (views.length === 0) {
    return (
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--state-offline)" strokeWidth={1.6} opacity={0.5} />
    )
  }
  if (views.length > MAX_SEGMENTS) {
    const agg = aggregateState(views)
    return (
      <circle
        cx={CX}
        cy={CY}
        r={R}
        fill="none"
        stroke={STATE_COLOR[agg]}
        strokeWidth={3}
        className={ringAnimClass(agg)}
      />
    )
  }
  const len = (CIRC - SEG_GAP * views.length) / views.length
  return (
    <>
      {views.map((view, i) => {
        const state = toDisplayState(view)
        const color = STATE_COLOR[state]
        const offset = CIRC / 4 - i * (len + SEG_GAP)
        return (
          <circle
            key={view.key}
            cx={CX}
            cy={CY}
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={`${len} ${CIRC - len}`}
            strokeDashoffset={offset}
            className={ringAnimClass(state)}
          />
        )
      })}
    </>
  )
}

export function Ball() {
  const sessions = useSessions()
  const display = useMemo(() => aggregateState(sessions), [sessions])
  const [dnd, setDnd] = useState(false)

  useEffect(() => {
    void window.pupil.getDnd().then(setDnd)
    const off = window.pupil.onDndChanged(setDnd)
    return off
  }, [])

  // 自定义拖动：window 级监听 pointermove/up（避免 pointerup 丢失导致球漂移）
  const draggingRef = useRef(false)
  const movedRef = useRef(false)
  const startRef = useRef({ x: 0, y: 0 })

  // 主进程通知策略驱动的音效播放（指令携带最新音色包/音量，球窗无需额外广播通道）
  useEffect(() => {
    const off = window.pupil.onSoundPlay(({ type, pack, volume }) => {
      if (pack !== undefined || volume !== undefined) {
        setSoundConfig(pack ?? 'chime', volume ?? 0.8)
      }
      playSound(type as never)
    })
    return off
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (!draggingRef.current) return
      const dx = e.screenX - startRef.current.x
      const dy = e.screenY - startRef.current.y
      if (dx * dx + dy * dy > 16) movedRef.current = true // 超过 4px 视为拖动
      window.pupil.ballDragMove(dx, dy)
    }
    const onUp = (): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      window.pupil.ballDragEnd()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
    }
  }, [])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return // 仅左键拖动
    draggingRef.current = true
    movedRef.current = false
    startRef.current = { x: e.screenX, y: e.screenY }
    window.pupil.ballDragStart()
  }, [])

  const handleClick = useCallback(() => {
    if (movedRef.current) return // 拖动结束后不触发面板
    void window.pupil.togglePanel()
  }, [])

  const handleDoubleClick = useCallback(() => {
    if (sessions.length === 0) return
    const top = aggregateTop(sessions)
    if (top) void window.pupil.activateWindow(top.key)
  }, [sessions])

  return (
    <div
      className={`ball-shell state-${display} ${dnd ? 'dnd-on' : ''}`}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onContextMenu={(e) => {
        e.preventDefault()
        window.pupil.showBallContext()
      }}
      onDoubleClick={handleDoubleClick}
      title={sessions.length > 0 ? `Pupil · ${sessions.length} 个会话` : 'Pupil · 等待 Agent 会话接入'}
    >
      <svg className="ball" viewBox="0 0 56 56" aria-hidden="true">
        <RingSegments views={sessions} />
        {/* 中层：球体 */}
        <circle cx={28} cy={28} r={21} fill="var(--orb-body)" className={display === 'done' ? 'ball-bounce' : ''} />
        {/* 球面高光（低透明度椭圆，非渐变） */}
        <ellipse cx={24.5} cy={21} rx={10.5} ry={6.5} fill="var(--orb-highlight)" opacity={0.35} />
        {/* 中心：精灵眼 */}
        <g className="eye-layer">
          <EyeSystem mode={display} />
        </g>
        {/* 勿扰指示：右上角月牙角标（可见反馈，勿扰时球体同步变暗） */}
        {dnd && (
          <g className="dnd-badge">
            <path
              d="M 44.6 8.2 A 5.4 5.4 0 1 1 38.2 1.9 A 4.3 4.3 0 0 0 44.6 8.2 Z"
              fill="var(--state-waiting)"
              stroke="var(--orb-body)"
              strokeWidth={1.2}
            />
          </g>
        )}
      </svg>
    </div>
  )
}

/** 双击跳转：取最高优先级会话（不包含 idle） */
function aggregateTop(views: SessionView[]): SessionView | undefined {
  const active = views.filter((v) => v.state !== 'idle')
  const pool = active.length > 0 ? active : views
  return [...pool].sort(
    (a, b) => DISPLAY_PRIORITY[toDisplayState(b)] - DISPLAY_PRIORITY[toDisplayState(a)]
  )[0]
}
