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

/** 按会话绘制分段弧；>5 会话时合并为单色环。
 *  v0.4.0：running/initializing 不再是静态弧——改为「彗星轨道」：
 *  一个亮点拖着渐隐尾巴绕球转（参考 bloub 对 x.ai comet 态的测量：点不动、尾绕行） */
function RingSegments({ views }: { views: SessionView[] }) {
  // 注意：所有环都必须显式指定 cx/cy=28（SVG 默认圆心是 (0,0)/viewBox 左上角，
  // 漏写会导致弧线画到窗口角落——曾因此出现"球顶两段悬空弧线"）
  const CX = 28
  const CY = 28
  if (views.length === 0) {
    return (
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--state-offline)" strokeWidth={1.4} opacity={0.5} />
    )
  }
  if (views.length > MAX_SEGMENTS) {
    const agg = aggregateState(views)
    if (agg === 'running') return null // 三点加载就是加载器，不再叠加环
    if (agg === 'initializing') return <Comet delay={0} />
    return (
      <circle
        cx={CX}
        cy={CY}
        r={R}
        fill="none"
        stroke={STATE_COLOR[agg]}
        strokeWidth={1.8}
        className={ringAnimClass(agg)}
      />
    )
  }
  const len = (CIRC - SEG_GAP * views.length) / views.length
  return (
    <>
      {views.map((view, i) => {
        const state = toDisplayState(view)
        if (state === 'running') {
          // running 由三点加载表达（GrokBot 原版：球即加载器），不画环段
          return null
        }
        if (state === 'initializing') {
          return <Comet key={view.key} delay={-i * 0.55} />
        }
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
            strokeWidth={1.8}
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

/** 彗星轨道：头部亮点 + 双层渐隐尾，绕球心旋转（delay 秒相位差，负值即错开） */
function Comet({ delay }: { delay: number }) {
  return (
    <g className="comet-orbit" style={{ animationDelay: `${delay}s` }}>
      {/* 尾巴外层：长而淡 */}
      <path
        d="M 27.9 1.2 A 26.8 26.8 0 0 1 48.9 10.6"
        fill="none"
        stroke="var(--state-running)"
        strokeWidth={1.1}
        strokeLinecap="round"
        opacity={0.28}
      />
      {/* 尾巴内层：短而亮（靠近头部更实） */}
      <path
        d="M 27.95 1.7 A 26.3 26.3 0 0 1 41.2 7.3"
        fill="none"
        stroke="var(--state-running)"
        strokeWidth={1.6}
        strokeLinecap="round"
        opacity={0.6}
      />
      {/* 头部亮点 + 微光晕 */}
      <circle cx={28} cy={3.5} r={2.3} fill="var(--state-running)" />
      <circle cx={28} cy={3.5} r={4} fill="var(--state-running)" opacity={0.22} />
    </g>
  )
}

/** bloub 实测三点加载几何（球半径单位 × 21px）：x = -0.557/-0.013/+0.532，r = 0.165（峰值 ×1.25 走 CSS 动画） */
const DOT_X = [-11.7, -0.3, 11.2]
const DOT_R = 3.5

/** 三点波浪脉动（GrokBot 原版 thinking 态：球缩成中间点，两侧点从球身冒出，波从左到右） */
function ThinkingDots() {
  return (
    <g className="tdots-layer">
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          className={`tdot tdot-${i}`}
          cx={28 + DOT_X[i]}
          cy={28}
          r={i === 1 ? DOT_R * 1.06 : DOT_R} // 中间点略大（原版是球缩成的）
          fill="var(--state-running)"
        />
      ))}
    </g>
  )
}

/**
 * 斜体感叹号（GrokBot 原版 alert 态）：球变成「！」滑入 + 2.5Hz 微震。
 * bloub 测量：胶囊杆（宽 0.269、长 0.776）+ 水滴点，倾斜 17.7°，
 * 轨迹 -0.087 → +0.732（球半径单位）1.5s ease-in-out，1.6s 处 0.4s 弹回。
 */
function Exclaim() {
  return (
    <g className="exclaim-anim">
      <g transform={`rotate(17.7 28 28)`}>
        {/* 杆：胶囊，中心 (28, 28-0.325×21) */}
        <rect x={28 - 2.85} y={28 - 13.4} width={5.7} height={16.3} rx={2.85} fill="var(--state-error)" />
        {/* 点：水滴（圆端朝杆，尖朝外）——用圆近似，视觉差异在 56px 下可忽略 */}
        <circle cx={28 - Math.sin(0.309) * 12.2} cy={28 + Math.cos(0.309) * 12.2} r={2.5} fill="var(--state-error)" />
      </g>
    </g>
  )
}

/** 睡眠弹跳小球（GrokBot 原版 sleep 态：r=0.1585，y = 0.11 ± 0.19，周期 0.6s） */
function SleepDot() {
  return <circle className="sleep-dot" cx={28} cy={28} r={3.3} fill="var(--state-offline)" />
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
        {/* v0.4.2 球体变形态：球本身成为动画（GrokBot 原版做法）——
            running=三点加载 error=感叹号 offline=睡眠弹跳点，此时隐藏球体与眼睛 */}
        {display === 'running' && <ThinkingDots />}
        {display === 'error' && <Exclaim />}
        {display === 'offline' && <SleepDot />}
        {/* 中层：球体——纯黑正圆（x.ai 实测 #0a0a0c），变形态隐藏；出错抖动/空闲微呼吸保留 */}
        <circle
          cx={28}
          cy={28}
          r={21}
          fill="var(--orb-body)"
          className={
            display === 'done'
              ? 'ball-bounce'
              : display === 'error' || display === 'running' || display === 'offline'
                ? 'ball-morph-hide'
                : display === 'idle'
                  ? 'ball-breathe'
                  : ''
          }
        />
        {/* 中心：精灵眼（变形态由 EyeSystem 内部返回 null） */}
        <g className="eye-layer">
          <EyeSystem mode={display} />
        </g>
        {/* 完成态：两侧星光弹出（配合眯眼笑 + 绿环 + 弹跳） */}
        {display === 'done' && (
          <>
            <g className="sparkle">
              <path d="M 8 12 l 1 2.2 2.2 1 -2.2 1 -1 2.2 -1 -2.2 -2.2 -1 2.2 -1 z" fill="var(--state-done)" />
            </g>
            <g className="sparkle s2">
              <path d="M 47 15 l 0.9 2 2 0.9 -2 0.9 -0.9 2 -0.9 -2 -2 -0.9 2 -0.9 z" fill="var(--state-done)" />
            </g>
          </>
        )}
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
