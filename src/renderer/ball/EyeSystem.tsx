/**
 * EyeSystem —— x.ai GrokBot 风格精灵眼
 * 参数取自 bloub（github.com/jeremy-prt/bloub，MIT）对 x.ai 原版吉祥物的逐帧测量：
 *  - 眼睛 = 白色竖直胶囊，整体倾斜约 26°（`\` 方向），没有瞳孔
 *  - 眼睛长在球面上：看向一侧时远侧眼压缩到 ~0.7×宽（立体感的来源）
 *  - 待机不浮动不张望：生命感 = 目光漂移 + 自然眨眼（单次 ~0.2s）
 *  - 每次形态切换都被一次眨眼掩盖（新状态以闭眼姿态出现再睁开）
 *
 * v0.4.2 状态表情对齐原版状态目录（states.ts 测量值）：
 *  - running → 眼睛隐藏，球体变身三点加载（见 Ball.tsx ThinkingDots）
 *  - waiting → wide 惊讶眼（原版 wide：眼高 ×2.1）
 *  - done    → wink 眨单眼（原版测量：闭眼是比睁眼更宽的横杠 0.447 vs 0.236）
 *  - error   → 眼睛隐藏，球体变形成「！」（见 Ball.tsx Exclaim）
 *  - offline → 眼睛隐藏，球缩点弹跳（见 Ball.tsx），仅保留 z
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
    case 'waiting':
      return { gx: 0, gy: -0.44, allowPointer: true } // 抬头望向主人（催促输入）
    case 'idle':
      return { gx: 0, gy: -0.1, allowPointer: true } // 待机也要「活着」
    case 'done':
      return { gx: 0, gy: -0.3, allowPointer: false } // 眨单眼微仰
    default:
      return { gx: 0, gy: 0, allowPointer: false }
  }
}

/** x.ai 风格胶囊眼。depth=远侧压缩；sw/sh=宽/高缩放（waiting 惊讶眼） */
function BotEye({
  cx,
  depth = 1,
  sw = 1,
  sh = 1
}: {
  cx: number
  depth?: number
  sw?: number
  sh?: number
}) {
  const rx = EYE_RX * depth * sw
  const ry = EYE_RY * sh
  return (
    <g transform={`rotate(${TILT} ${cx} ${EYE_CY})`}>
      {/* 几何属性走 CSS 过渡：注视移动/惊讶放大时平滑变化 */}
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

/** wink 闭合眼：横杠（原版测量：比睁眼更宽 0.447 vs 0.236，且是独立形状不是压扁） */
function WinkDash({ cx }: { cx: number }) {
  const w = 4.7 // 0.447/0.236 × EYE_RX ≈ 9.6 直径 → 半宽 4.8，取 4.7 视觉近似
  const h = 1.0
  return <rect x={cx - w} y={EYE_CY - h} width={w * 2} height={h * 2} rx={h} fill="var(--eye-white)" />
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

  // 球体本身成为动画的状态（running 三点加载 / error 感叹号 / offline 睡眠点）不画脸
  if (mode === 'running' || mode === 'error') return null

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
    case 'waiting':
      // wide 惊讶眼（原版测量 0.356/0.875 ≈ 睁眼 ×1.9/×2.1；按本球眼距收敛到 ×1.4/×1.75 防重叠）
      content = (
        <>
          <BotEye cx={left} depth={depthL} sw={1.4} sh={1.75} />
          <BotEye cx={right} depth={depthR} sw={1.4} sh={1.75} />
        </>
      )
      break
    case 'done':
      // wink：左眼保持胶囊，右眼变横杠（原版测量：横杠比睁眼宽）
      content = (
        <>
          <BotEye cx={left} depth={depthL} />
          <WinkDash cx={right} />
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
      // 球缩点弹跳（Ball.tsx），这里只留 z
      content = <OfflineZ />
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

  // 无光标时的自动生命感：待机张望+歪头疑惑 / 初始化急切游移（running 已改三点加载）
  let wander = ''
  let tilt = ''
  if (!ptrActive) {
    if (mode === 'idle') {
      wander = 'gaze-wander'
      tilt = 'gaze-tilt' // 歪头：缓慢左右倾头（疑惑/好奇感），与漂移同周期
    } else if (mode === 'initializing') wander = 'gaze-dart'
  }
  // 循环眨眼节奏：waiting 频繁(催促)、idle 伪随机(7.3s 两次不均匀落点)
  let blinkLoop = ''
  if (mode === 'waiting') blinkLoop = 'blink-wait'
  else if (mode === 'idle') blinkLoop = 'blink-idle'

  return (
    <svg className="eyes" viewBox="0 0 56 56" aria-hidden="true">
      {/* 四层嵌套各持一种变换源：注视平移(过渡) > 切换睁眼(一次性) > 循环眨眼 > 漂移(动画) */}
      <g className="eye-gaze" style={{ transform: `translate(${ox}px, ${oy}px)` }}>
        <g className={tilt}>
          <g key={mode} className="eye-swap">
            <g className={blinkLoop}>
              <g className={wander}>{content}</g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  )
}
