/**
 * EyeSystem —— 精灵眼动画引擎（自定义 SVG/CSS，六态表情）
 * 对应 UIUX 文档第 4 节：每态 = 眼睛表情 + 动画 三重编码之一
 *
 * 模式：
 *  initializing 瞳孔快速游移（搜寻）
 *  running      瞳孔缓慢游移 + 定期眨眼（专注）
 *  waiting      瞳孔放大居中凝视 + 频繁眨眼（催促）
 *  done         开心眯眼 ^ ^
 *  error        X X 眼
 *  timeout      半开 + 斜视（不耐烦）
 *  offline      闭眼 + z 飘出
 *  idle         闭眼浅睡 + 偶尔开合
 */
import type { DisplayState } from '../../shared/events'

export type EyeMode = DisplayState

interface EyeSystemProps {
  mode: EyeMode
}

const EYE_CX = 20
const EYE_CY = 28
const EYE_GAP = 16

/** 普通睁眼（白 + 瞳孔 + 高光） */
function OpenEye({
  cx,
  pupilR = 3.2,
  gaze = 0,
  cls = ''
}: {
  cx: number
  pupilR?: number
  gaze?: number
  cls?: string
}) {
  return (
    <g className={cls}>
      <ellipse cx={cx} cy={EYE_CY} rx={6.5} ry={8} fill="var(--eye-white)" />
      <g className="pupil">
        <circle cx={cx + gaze} cy={EYE_CY + 1} r={pupilR} fill="var(--eye-pupil)" />
        <circle cx={cx + gaze - 1.1} cy={EYE_CY - 1.4} r={1.1} fill="var(--eye-highlight)" />
      </g>
    </g>
  )
}

/** 闭合线眼 */
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

/** 半开眼（上眼睑遮住上半） */
function HalfOpenEye({ cx, gaze = 0 }: { cx: number; gaze?: number }) {
  return (
    <g>
      <ellipse cx={cx} cy={EYE_CY + 2} rx={6.2} ry={4.4} fill="var(--eye-white)" />
      <circle cx={cx + gaze} cy={EYE_CY + 3} r={2.6} fill="var(--eye-pupil)" />
      <path
        d={`M ${cx - 6.4} ${EYE_CY - 1} L ${cx + 6.4} ${EYE_CY - 1}`}
        stroke="var(--eye-white)"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </g>
  )
}

/** X 眼 */
function XEye({ cx }: { cx: number }) {
  const half = 4.6
  return (
    <g stroke="var(--eye-white)" strokeWidth={2.6} strokeLinecap="round">
      <path d={`M ${cx - half} ${EYE_CY - half} L ${cx + half} ${EYE_CY + half}`} />
      <path d={`M ${cx + half} ${EYE_CY - half} L ${cx - half} ${EYE_CY + half}`} />
    </g>
  )
}

/** 眯眼笑 ^ ^ */
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

function OfflineZ() {
  return (
    <text
      className="z-float"
      x={EYE_CX + EYE_GAP / 2 + 6}
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
  const left = EYE_CX
  const right = EYE_CX + EYE_GAP

  let content: React.ReactNode

  switch (mode) {
    case 'initializing':
      content = (
        <>
          <OpenEye cx={left} cls="eye-dart" />
          <OpenEye cx={right} cls="eye-dart" />
        </>
      )
      break
    case 'running':
      content = (
        <>
          <OpenEye cx={left} gaze={0.6} cls="eye-blink-r" />
          <OpenEye cx={right} gaze={-0.6} cls="eye-blink-r" />
        </>
      )
      break
    case 'waiting':
      content = (
        <>
          <OpenEye cx={left} pupilR={4.2} cls="eye-blink-w" />
          <OpenEye cx={right} pupilR={4.2} cls="eye-blink-w" />
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
          <ClosedEye cx={left} smile />
          <ClosedEye cx={right} smile />
        </>
      )
      break
  }

  return (
    <svg className="eyes" viewBox="0 0 56 56" aria-hidden="true">
      {content}
    </svg>
  )
}
