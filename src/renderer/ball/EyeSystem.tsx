/**
 * EyeSystem —— x.ai GrokBot 风格精灵眼
 * 参数取自 bloub（github.com/jeremy-prt/bloub，MIT）对 x.ai 原版吉祥物的逐帧测量：
 *  - 眼睛 = 白色竖直胶囊，整体倾斜约 26°（`\` 方向），没有瞳孔
 *  - 眼睛长在球面上：看向一侧时远侧眼压缩到 ~0.7×宽（立体感的来源）
 *  - 待机不浮动不张望：生命感 = 目光漂移 + 自然眨眼（单次 ~0.2s）
 *  - 每次形态切换都被一次眨眼掩盖（新状态以闭眼姿态出现再睁开）
 *
 * v0.4.2 状态表情对齐原版状态目录（states.ts 测量值）：
 *  - running → 眼睛隐藏，球体变身三点加载（见 Ball.tsx BounceLoader）
 *  - waiting → wide 惊讶眼（原版 wide：眼高 ×2.1）
 *  - error   → 眼睛隐藏，球体变形成「！」（见 Ball.tsx Exclaim）
 *  - offline → 眼睛隐藏，球缩点弹跳（见 Ball.tsx），仅保留 z
 *
 * v0.5.0 宠物互动表情（mood 覆盖层，优先级高于状态表情）：
 *  - petting → 眯眼享受（原版 egg/hexagon 态眼睛压窄思路的弧线版）+ 脸红 + 头部轻晃
 *  - loved   → 爱心眼♥ + 心心飘出（脸红保留）
 *  - dizzy   → 晕圈眼@_@（被戳烦）+ 发昏摇晃
 *  - done    → 星星眼✦（替换 v0.4.x 的 wink；星光/弹跳仍在 Ball 层）
 * 注视优先级：光标跟随（主进程 GazeTracker 推送）> 状态自带注视；互动 mood 下不跟随。
 */
import { useEffect, useState } from 'react'
import type { DisplayState } from '../../shared/events'

export type EyeMode = DisplayState

/** 互动心情（v0.5.0）：由 Ball 手势仲裁驱动 */
export type PetMood = 'petting' | 'loved' | 'dizzy'

interface EyeSystemProps {
  mode: EyeMode
  mood?: PetMood | null
}

const BALL_C = 28
const EYE_CY = 28
const EYE_GAP = 15.2 // 两眼中心距
const EYE_RX = 5.1 // 胶囊横半径
const EYE_RY = 7.4 // 胶囊纵半径
// v0.5.1：眼睛完全水平（tilt=0）——对齐 bloub 中性态（expressions.ts neutre：eye(EYE_W,EYE_H) 无 tilt）。
// 此前 TILT=-26° 平行斜眼全状态常驻是参考文件「idle 斜 26°」的误读：bloub 源码里斜眼
// 只属于 colere/triste 等情绪表情且镜像对称（[+tilt, -tilt]），静息是纯水平。
// 平行 \ 斜眼视觉上像「一直看左」，用户已确认修复。
const TILT = 0
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

/* ---- v0.5.0 互动表情 ---- */

/** 眯眼享受：^ ^ 弧线（摸头；原版 egg 态「眼变窄」的弧线表达版） */
function SquintEye({ cx }: { cx: number }) {
  return (
    <path
      d={`M ${cx - 5} ${EYE_CY + 1.5} Q ${cx} ${EYE_CY - 3.8} ${cx + 5} ${EYE_CY + 1.5}`}
      fill="none"
      stroke="var(--eye-white)"
      strokeWidth={2.6}
      strokeLinecap="round"
    />
  )
}

/** 白色爱心（爱心眼 / 飘出的心心共用几何，中心在原点，高约 7px） */
export const HEART_PATH = 'M 0 3.2 C -4.4 -0.9 -2.7 -4.8 0 -2.1 C 2.7 -4.8 4.4 -0.9 0 3.2 Z'

function HeartEye({ cx }: { cx: number }) {
  return (
    <path
      d={HEART_PATH}
      transform={`translate(${cx} ${EYE_CY - 0.5})`}
      fill="var(--eye-white)"
    />
  )
}

/** 四角星✦（完成态星星眼；中心在原点，外径 5.4） */
const STAR_PATH = 'M 0 -5.4 L 1.35 -1.35 L 5.4 0 L 1.35 1.35 L 0 5.4 L -1.35 1.35 L -5.4 0 L -1.35 -1.35 Z'

function StarEye({ cx }: { cx: number }) {
  return (
    <g transform={`translate(${cx} ${EYE_CY})`}>
      <path className="star-eye" d={STAR_PATH} fill="var(--eye-white)" />
    </g>
  )
}

/** 晕圈眼@_@：白圈 + 小圆点（左右反向慢转，发昏感） */
function DizzyEye({ cx, reverse = false }: { cx: number; reverse?: boolean }) {
  return (
    <g transform={`translate(${cx} ${EYE_CY})`}>
      <g className={reverse ? 'dizzy-spin-r' : 'dizzy-spin'}>
        <circle r={5} fill="none" stroke="var(--eye-white)" strokeWidth={2} />
        <circle cx={3.2} r={1.9} fill="var(--eye-white)" />
      </g>
    </g>
  )
}

/** 脸红：黑球上两枚低饱和粉椭圆（唯一新增颜色元素，不破坏轮廓） */
function Blush() {
  return (
    <g className="blush-in">
      <ellipse cx={BALL_C - 11} cy={EYE_CY + 8.5} rx={3.7} ry={2} fill="#e8a0a8" opacity={0.55} />
      <ellipse cx={BALL_C + 11} cy={EYE_CY + 8.5} rx={3.7} ry={2} fill="#e8a0a8" opacity={0.55} />
    </g>
  )
}

/** 爱心眼配套：心心从球顶飘出消散 */
function FloatingHearts() {
  return (
    <g>
      <path className="float-heart fh-l" d={HEART_PATH} transform="translate(17 16)" fill="#f2b8be" />
      <path className="float-heart fh-r" d={HEART_PATH} transform="translate(39 14)" fill="#f2b8be" />
    </g>
  )
}

/** 闭眼睡眠：白色横线（离线态，z 由 OfflineZ 提供；保留黑球可见性） */
function ClosedEye({ cx }: { cx: number }) {
  return (
    <path
      d={`M ${cx - 5.3} ${EYE_CY} Q ${cx} ${EYE_CY + 1.8} ${cx + 5.3} ${EYE_CY}`}
      fill="none"
      stroke="var(--eye-white)"
      strokeWidth={2.4}
      strokeLinecap="round"
    />
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

export function EyeSystem({ mode, mood = null }: EyeSystemProps) {
  // 全局光标注视方向（GazeTracker 推送；死区内为 0,0 = 回中）
  const [ptr, setPtr] = useState({ gx: 0, gy: 0 })
  useEffect(() => window.pupil.onGaze(setPtr), [])

  const left = BALL_C - EYE_GAP / 2
  const right = BALL_C + EYE_GAP / 2

  // ---- v0.5.0 互动 mood 覆盖层：优先于一切状态表情；眼神不跟随、无循环眨眼 ----
  if (mood === 'petting' || mood === 'loved' || mood === 'dizzy') {
    let face: React.ReactNode
    let wrapAnim = ''
    if (mood === 'petting') {
      face = (
        <>
          <SquintEye cx={left} />
          <SquintEye cx={right} />
        </>
      )
      wrapAnim = 'pet-sway'
    } else if (mood === 'loved') {
      face = (
        <>
          <HeartEye cx={left} />
          <HeartEye cx={right} />
        </>
      )
      wrapAnim = 'pet-sway'
    } else {
      face = (
        <>
          <DizzyEye cx={left} />
          <DizzyEye cx={right} reverse />
        </>
      )
      wrapAnim = 'dizzy-sway'
    }
    return (
      <svg className="eyes" viewBox="0 0 56 56" aria-hidden="true">
        <g className={wrapAnim}>
          <g key={`mood-${mood}`} className="eye-swap">
            {(mood === 'petting' || mood === 'loved') && <Blush />}
            {face}
            {mood === 'loved' && <FloatingHearts />}
          </g>
        </g>
      </svg>
    )
  }

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
      // v0.5.0 星星眼✦（庆祝感；弹跳与两侧星光仍在 Ball 层）
      content = (
        <>
          <StarEye cx={left} />
          <StarEye cx={right} />
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
      // 黑球保留（Ball.tsx 加 ball-offline-dim 弱化），闭眼 + z 表达睡眠
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
