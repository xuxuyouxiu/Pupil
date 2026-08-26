/**
 * EyeSystem —— x.ai GrokBot 风格精灵眼
 * 参数取自 bloub（github.com/jeremy-prt/bloub，MIT）对 x.ai 原版吉祥物的逐帧测量：
 *  - 眼睛 = 白色竖直胶囊，整体倾斜约 26°（`\` 方向），没有瞳孔
 *  - 眼睛长在球面上：看向一侧时远侧眼压缩到 ~0.7×宽（立体感的来源）
 *  - 待机不浮动不张望：生命感 = 目光漂移 + 自然眨眼（单次 ~0.2s）
 *  - 每次形态切换都被一次眨眼掩盖（新状态以闭眼姿态出现再睁开）
 * 注视优先级：光标跟随（主进程 GazeTracker 推送）> 状态自带注视。
 */
import { useEffect, useState } from 'react'
import type { DisplayState } from '../../shared/events'

export type EyeMode = DisplayState

interface EyeSystemProps {
  mode: EyeMode
}

const BALL_C = 28
const EYE_CY = 28
const EYE_GAP = 15.2 // 两眼中心距
const EYE_RX = 5.1 // 胶囊横半径
const EYE_RY = 7.4 // 胶囊纵半径
const TILT = -26 // `\` 方向倾斜（SVG 正角为顺时针，负号得到左上-右下）
/** 注视单位向量 → 像素换算 */
const OX_MAX = 2.8
const OY_MAX = 2.0
/** 远侧眼宽度压缩比（球面深度，bloub 实测 0.69，取整视觉近似） */
const DEPTH = 0.72

/** 状态自带的注视方向；allowPointer = 是否允许被全局光标接管 */
function stateGaze(mode: EyeMode): { gx: number; gy: number; allowPointer: boolean } {
  switch (mode) {
    case 'running':
      return { gx: 0, gy: -0.16, allowPointer: true } // 思考时也留意主人在哪
    case 'waiting':
      return { gx: 0, gy: -0.44, allowPointer: true } // 抬头望向主人（催促输入）
    case 'idle':
      return { gx: 0, gy: -0.1, allowPointer: true } // 待机也要「活着」
    case 'done':
      return { gx: 0, gy: -0.3, allowPointer: false } // 开心眯眼微仰
    default:
      return { gx: 0, gy: 0, allowPointer: false }
  }
}

/** x.ai 风格胶囊眼。depth=远侧压缩；s=整体缩放（waiting 睁大） */
function BotEye({ cx, depth = 1, s = 1 }: { cx: number; depth?: number; s?: number }) {
  const rx = EYE_RX * depth * s
  const ry = EYE_RY * s
  return (
    <g transform={`rotate(${TILT} ${cx} ${EYE_CY})`}>
      {/* 几何属性走 CSS 过渡：注视移动时眼睛宽度平滑变化 */}
      <rect
        className="bot-eye"
        x={cx - rx}
        y={EYE_CY - ry}
        width={rx * 2}
        height={ry * 2}
        rx={rx}
        fill="var(--eye-white)"
      />
    </g>
  )
}

/** 开心眯眼 ^ ^ */
function HappyEye({ cx }: { cx: number }) {
  return (
    <path
      d={`M ${cx - 5} ${EYE_CY + 1.5} Q ${cx} ${EYE_CY - 3.5} ${cx + 5} ${EYE_CY + 1.5}`}
      fill="none"
      stroke="var(--eye-white)"
      strokeWidth={2.4}
      strokeLinecap="round"
    />
  )
}

/** 闭合线眼（offline 睡觉） */
function ClosedEye({ cx, smile = false }: { cx: number; smile?: boolean }) {
  if (smile) {
    return (
      <path
        d={`M ${cx - 5.5} ${EYE_CY + 1} Q ${cx} ${EYE_CY - 4} ${cx + 5.5} ${EYE_CY + 1}`}
        fill="none"
        stroke="var(--eye-white)"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    )
  }
  return (
    <path
      d={`M ${cx - 5} ${EYE_CY} Q ${cx} ${EYE_CY + 2} ${cx + 5} ${EYE_CY}`}
      fill="none"
      stroke="var(--eye-white)"
      strokeWidth={2.4}
      strokeLinecap="round"
    />
  )
}

/** 半开眼（timeout 不耐烦斜视） */
function HalfOpenEye({ cx, gaze = 0 }: { cx: number; gaze?: number }) {
  return (
    <g>
      <ellipse cx={cx} cy={EYE_CY + 2} rx={6.2} ry={4.4} fill="var(--eye-white)" />
      <circle cx={cx + gaze} cy={EYE_CY + 3} r={2.6} fill="var(--orb-body)" />
      <path
        d={`M ${cx - 6.4} ${EYE_CY - 1} L ${cx + 6.4} ${EYE_CY - 1}`}
        stroke="var(--eye-white)"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </g>
  )
}

/** X 眼（error） */
function XEye({ cx }: { cx: number }) {
  const half = 4.6
  return (
    <g stroke="var(--eye-white)" strokeWidth={2.6} strokeLinecap="round">
      <path d={`M ${cx - half} ${EYE_CY - half} L ${cx + half} ${EYE_CY + half}`} />
      <path d={`M ${cx + half} ${EYE_CY - half} L ${cx - half} ${EYE_CY + half}`} />
    </g>
  )
}

function OfflineZ() {
  return (
    <text
      className="z-float"
      x={BALL_C + EYE_GAP / 2 + 6}
      y={EYE_CY - 10}
      fill="var(--muted)"
      fontSize={9}
      fontFamily="var(--font-mono)"
    >
      z
    </text>
  )
}

export function EyeSystem({ mode }: EyeSystemProps) {
  // 全局光标注视方向（GazeTracker 推送；死区内为 0,0 = 回中）
  const [ptr, setPtr] = useState({ gx: 0, gy: 0 })
  useEffect(() => window.pupil.onGaze(setPtr), [])

  const base = stateGaze(mode)
  const ptrActive = base.allowPointer && Math.hypot(ptr.gx, ptr.gy) > 0.001
  const g = ptrActive ? ptr : base

  const ox = g.gx * OX_MAX
  const oy = g.gy * OY_MAX
  // 球面深度：往右看 → 左眼变远侧眼（压缩）；反之亦然
  const depthL = ox >= 0 ? DEPTH : 1
  const depthR = ox <= 0 ? DEPTH : 1

  const left = BALL_C - EYE_GAP / 2
  const right = BALL_C + EYE_GAP / 2

  // 表情内容
  let content: React.ReactNode
  switch (mode) {
    case 'initializing':
      content = (
        <>
          <BotEye cx={left} />
          <BotEye cx={right} />
        </>
      )
      break
    case 'running':
      content = (
        <>
          <BotEye cx={left} depth={depthL} />
          <BotEye cx={right} depth={depthR} />
        </>
      )
      break
    case 'waiting':
      content = (
        <>
          <BotEye cx={left} depth={depthL} s={1.12} />
          <BotEye cx={right} depth={depthR} s={1.12} />
        </>
      )
      break
    case 'done':
      content = (
        <>
          <HappyEye cx={left} />
          <HappyEye cx={right} />
        </>
      )
      break
    case 'error':
      content = (
        <>
          <XEye cx={left} />
          <XEye cx={right} />
        </>
      )
      break
    case 'timeout':
      content = (
        <>
          <HalfOpenEye cx={left} gaze={1.6} />
          <HalfOpenEye cx={right} gaze={1.6} />
        </>
      )
      break
    case 'offline':
      content = (
        <>
          <ClosedEye cx={left} />
          <ClosedEye cx={right} />
          <OfflineZ />
        </>
      )
      break
    case 'idle':
    default:
      content = (
        <>
          <BotEye cx={left} depth={depthL} />
          <BotEye cx={right} depth={depthR} />
        </>
      )
      break
  }

  // 无光标时的自动生命感：待机漂移 / 思考扫视 / 初始化急切游移
  let wander = ''
  if (!ptrActive) {
    if (mode === 'idle') wander = 'gaze-wander'
    else if (mode === 'running') wander = 'gaze-scan'
    else if (mode === 'initializing') wander = 'gaze-dart'
  }
  // 循环眨眼节奏：running 从容(~5s)、waiting 频繁(催促)、idle 伪随机(7.3s 两次不均匀落点)
  let blinkLoop = ''
  if (mode === 'running') blinkLoop = 'blink-run'
  else if (mode === 'waiting') blinkLoop = 'blink-wait'
  else if (mode === 'idle') blinkLoop = 'blink-idle'

  return (
    <svg className="eyes" viewBox="0 0 56 56" aria-hidden="true">
      {/* 四层嵌套各持一种变换源：注视平移(过渡) > 切换睁眼(一次性) > 循环眨眼 > 漂移(动画) */}
      <g className="eye-gaze" style={{ transform: `translate(${ox}px, ${oy}px)` }}>
        <g key={mode} className="eye-swap">
          <g className={blinkLoop}>
            <g className={wander}>{content}</g>
          </g>
        </g>
      </g>
    </svg>
  )
}
