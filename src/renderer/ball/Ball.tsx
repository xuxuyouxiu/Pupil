/**
 * Ball —— 悬浮球主体
 * v0.4.3：外圈状态环整体移除（用户反馈：环不动不亮没效果）——
 * 状态全部由球体本身表达（GrokBot 原版做法）：眼睛表情/三点加载/感叹号/睡眠点。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DISPLAY_PRIORITY, DisplayState, SessionView, toDisplayState } from '../../shared/events'
import { EyeSystem } from './EyeSystem'
import { useSessions } from './use-sessions'
import { playSound, setSoundConfig } from './sound'

/** 聚合最高优先级展示态 */
function aggregateState(views: SessionView[]): DisplayState {
  if (views.length === 0) return 'idle'
  return views
    .map(toDisplayState)
    .sort((a, b) => DISPLAY_PRIORITY[b] - DISPLAY_PRIORITY[a])[0]
}

/** bloub 三点横向几何（球半径单位 × 21px）——弹跳球沿用同一横向节奏 */
const DOT_X = [-11.7, -0.3, 11.2]
/** 弹跳延迟（uiverse grumpy-turtle-41 原版：0 / +0.2s / +0.3s 交错波） */
const BOUNCE_DELAYS = [0, 0.2, 0.3]

/**
 * 弹跳加载（v0.4.5，用户指定 uiverse mobinkakei/grumpy-turtle-41）：
 * 三个白球交替弹跳——落地压扁(scaleX1.5/scaleY0.35)、起跳拉圆，影子同步缩放；
 * v0.4.5 修复：白球浮在透明窗口上，浅色壁纸直接隐形（用户看到「灰色圆球」就是
 * 白球隐形只剩影子）——黑色球体不再隐藏、留在原地当底板，白球在黑球里弹，
 * 任何壁纸都有对比度；影子改白色柔光（黑底可见）。
 */
function BounceLoader() {
  return (
    <g>
      {/* 地面柔光标记：先画（球下层），随弹跳缩放变淡 */}
      {BOUNCE_DELAYS.map((d, i) => (
        <ellipse
          key={`s${i}`}
          className="bounce-shadow"
          style={{ animationDelay: `${d}s` }}
          cx={28 + DOT_X[i]}
          cy={36.8}
          rx={4.4}
          ry={1.15}
          fill="#ffffff"
        />
      ))}
      {/* 弹跳球：白球，落地压扁起跳变圆 */}
      {BOUNCE_DELAYS.map((d, i) => (
        <circle
          key={i}
          className="bounce-ball"
          style={{ animationDelay: `${d}s` }}
          cx={28 + DOT_X[i]}
          cy={33.5}
          r={3.4}
          fill="var(--eye-white)"
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
        {/* 中层：球体——纯黑正圆。running 时保留当底板（白球在球内弹，浅色壁纸也清晰）；
            error/offline 变形时隐藏 */}
        <circle
          cx={28}
          cy={28}
          r={21}
          fill="var(--orb-body)"
          className={
            display === 'done'
              ? 'ball-bounce'
              : display === 'error' || display === 'offline'
                ? 'ball-morph-hide'
                : display === 'idle'
                  ? 'ball-breathe'
                  : ''
          }
        />
        {/* v0.4.5 变形/加载层（画在球体之后 = 黑球底板之上）：
            running=弹跳加载 error=感叹号 offline=睡眠弹跳点；眼睛态由 EyeSystem 表达 */}
        {display === 'running' && <BounceLoader />}
        {display === 'error' && <Exclaim />}
        {display === 'offline' && <SleepDot />}
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
