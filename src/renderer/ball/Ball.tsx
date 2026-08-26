/**
 * Ball —— 悬浮球主体
 * v0.4.3：外圈状态环整体移除——状态全部由球体本身表达（GrokBot 原版做法）：
 * 眼睛表情/三点加载/感叹号/睡眠点。
 *
 * v0.5.0 宠物互动：
 *  - 窗口向上扩 BUBBLE_BAND 20px 作「状态播报气泡」带，球体 SVG 绝对定位在下 56px
 *    （透明窗口透明像素本就不接收点击，气泡带无需鼠标穿透逻辑）
 *  - 手势仲裁（petting.ts）：单击面板 / 双击跳转 / 三连点戳晕 / 长按摸头
 *  - 完成态星星眼（EyeSystem）；摸头呼噜音、戳痒音（sound.ts 本地直触）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DISPLAY_PRIORITY, DisplayState, SessionView, toDisplayState } from '../../shared/events'
import { EyeSystem, PetMood } from './EyeSystem'
import { useSessions } from './use-sessions'
import { playSound, setSoundConfig, playPoke, startPurr, stopPurr } from './sound'
import { PettingArbiter } from './petting'
import { BALL_SIZE, BUBBLE_BAND, BALL_WINDOW_INSET_X } from '../../shared/constants'

/** 窗口总高：气泡带 + 球 */
const WIN_H = BALL_SIZE + BUBBLE_BAND

/** 摸头升级爱心眼的时长（与 PRD 一致） */
const PET_LOVE_MS = 2500
/** 戳晕持续时长 */
const DIZZY_MS = 1400
/** 气泡展示时长（悬停可暂停） */
const BUBBLE_SHOW_MS = 2650
/** 气泡淡出动画时长 */
const BUBBLE_OUT_MS = 180

/** 聚合最高优先级展示态 */
function aggregateState(views: SessionView[]): DisplayState {
  if (views.length === 0) return 'idle'
  return views
    .map(toDisplayState)
    .sort((a, b) => DISPLAY_PRIORITY[b] - DISPLAY_PRIORITY[a])[0]
}

/** bloub 三点横向几何（球半径单位 × 21px）——弹跳球沿用同一横向节奏 */
const DOT_X = [-11.7, -0.3, 11.2]
/** 点半径（bloub 0.165 × 21px ≈ 3.5） */
const DOT_R = 3.5

/**
 * 三点波浪加载（v0.5.2 换回官方：用户反馈「加载图标是网上找的，换官方的看看」）。
 * 对照 bloub dotPulse 测量：三白点横向 -0.557/-0.013/+0.532（×21px），r=0.165×21≈3.5，
 * 1.5s 一轮、相位差 0.5s、峰值 ×1.25 + opacity 0.55→1（半余弦「跳一下歇一下」），
 * 波从左到右扫过。黑色球体留在原地当底板（v0.4.5），白点任何壁纸都有对比度。
 */
function ThinkingDots() {
  return (
    <g>
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          className={`tdot tdot-${i}`}
          cx={28 + DOT_X[i]}
          cy={28}
          r={i === 1 ? DOT_R * 1.06 : DOT_R}
          fill="var(--eye-white)"
        />
      ))}
    </g>
  )
}

/**
 * 斜体感叹号（GrokBot 原版 alert 态）：球变成「！」滑入 + 2.5Hz 微震。
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

/** 睡眠弹跳小球（GrokBot 原版 sleep 态） */
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

  // ---- v0.5.0 互动状态 ----
  const [mood, setMood] = useState<PetMood | null>(null)
  /** 戳痒压扁脉冲计数：作为 key 让球体动画每次重放 */
  const [pokePulse, setPokePulse] = useState(0)
  const [bubble, setBubble] = useState<{ text: string; leaving: boolean } | null>(null)

  const loveTimerRef = useRef<number | null>(null)
  const dizzyTimerRef = useRef<number | null>(null)
  const bubbleTimerRef = useRef<number | null>(null)
  const bubbleOutTimerRef = useRef<number | null>(null)
  /** 最新会话快照（双击跳转用，避免仲裁回调闭包过期） */
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  /** 主进程边沿检测推来的状态播报 */
  useEffect(() => window.pupil.onSpeechBubble((text) => showBubble(text)), [])

  const showBubble = useCallback((text: string) => {
    if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current)
    if (bubbleOutTimerRef.current) window.clearTimeout(bubbleOutTimerRef.current)
    setBubble({ text, leaving: false })
    bubbleTimerRef.current = window.setTimeout(() => {
      bubbleTimerRef.current = null
      setBubble((b) => (b ? { ...b, leaving: true } : b))
      bubbleOutTimerRef.current = window.setTimeout(() => {
        bubbleOutTimerRef.current = null
        setBubble(null)
      }, BUBBLE_OUT_MS)
    }, BUBBLE_SHOW_MS)
  }, [])

  /** 悬停气泡：冻结消失计时；移开：立即进入淡出 */
  const onBubbleEnter = useCallback(() => {
    if (bubbleTimerRef.current) {
      window.clearTimeout(bubbleTimerRef.current)
      bubbleTimerRef.current = null
    }
    if (bubbleOutTimerRef.current) {
      window.clearTimeout(bubbleOutTimerRef.current)
      bubbleOutTimerRef.current = null
    }
    setBubble((b) => (b ? { ...b, leaving: false } : b))
  }, [])
  const onBubbleLeave = useCallback(() => {
    setBubble((b) => (b ? { ...b, leaving: true } : b))
    bubbleOutTimerRef.current = window.setTimeout(() => {
      bubbleOutTimerRef.current = null
      setBubble(null)
    }, BUBBLE_OUT_MS)
  }, [])

  // ---- 手势仲裁（petting.ts 纯状态机） ----
  const arbiterRef = useRef<PettingArbiter | null>(null)
  if (arbiterRef.current === null) {
    arbiterRef.current = new PettingArbiter((e) => {
      switch (e.type) {
        case 'petStart':
          startPurr()
          setMood('petting')
          // 爱心眼升级计时（Ball 侧持有，petEnd 统一清理）
          if (loveTimerRef.current) window.clearTimeout(loveTimerRef.current)
          loveTimerRef.current = window.setTimeout(() => setMood('loved'), PET_LOVE_MS)
          break
        case 'petLove':
          setMood('loved') // 仲裁层兜底信号
          break
        case 'petEnd':
          stopPurr()
          if (loveTimerRef.current) {
            window.clearTimeout(loveTimerRef.current)
            loveTimerRef.current = null
          }
          setMood(null)
          break
        case 'poke':
          playPoke()
          setPokePulse((n) => n + 1)
          break
        case 'triple':
          setMood('dizzy')
          if (dizzyTimerRef.current) window.clearTimeout(dizzyTimerRef.current)
          dizzyTimerRef.current = window.setTimeout(() => setMood(null), DIZZY_MS)
          break
        case 'click':
          void window.pupil.togglePanel()
          break
        case 'double': {
          // 双击跳转：取最高优先级会话（原 handleDoubleClick 语义）
          const views = sessionsRef.current
          if (views.length === 0) break
          const active = views.filter((v) => v.state !== 'idle')
          const pool = active.length > 0 ? active : views
          const top = [...pool].sort(
            (a, b) => DISPLAY_PRIORITY[toDisplayState(b)] - DISPLAY_PRIORITY[toDisplayState(a)]
          )[0]
          if (top) void window.pupil.activateWindow(top.key)
          break
        }
      }
    })
  }
  useEffect(() => () => arbiterRef.current?.dispose(), [])

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

  // 自定义拖动：window 级监听 pointermove/up（避免 pointerup 丢失导致球漂移）
  const draggingRef = useRef(false)
  const startRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      // 手势仲裁全程跟踪移动（长按中拖走 → 结束摸头）
      arbiterRef.current?.pointerMove(e.clientX, e.clientY, performance.now())
      if (!draggingRef.current) return
      const dx = e.screenX - startRef.current.x
      const dy = e.screenY - startRef.current.y
      window.pupil.ballDragMove(dx, dy)
    }
    const onUp = (): void => {
      arbiterRef.current?.pointerUp(performance.now())
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
    if (e.button !== 0) return // 仅左键
    draggingRef.current = true
    startRef.current = { x: e.screenX, y: e.screenY }
    window.pupil.ballDragStart()
    arbiterRef.current?.pointerDown(e.clientX, e.clientY, performance.now())
  }, [])

  return (
    <div className="ball-window" style={{ width: 2 * BALL_WINDOW_INSET_X + BALL_SIZE, height: WIN_H }}>
      {/* 状态播报气泡（主进程边沿触发；勿扰时主进程不发） */}
      {bubble && (
        <div
          className={`speech-bubble${bubble.leaving ? ' sb-out' : ''}`}
          onMouseEnter={onBubbleEnter}
          onMouseLeave={onBubbleLeave}
        >
          {bubble.text}
        </div>
      )}
      <div
        className={`ball-shell state-${display} ${dnd ? 'dnd-on' : ''}`}
        onPointerDown={handlePointerDown}
        onContextMenu={(e) => {
          e.preventDefault()
          window.pupil.showBallContext()
        }}
        title={
          sessions.length > 0 ? `Pupil · ${sessions.length} 个会话` : 'Pupil · 等待 Agent 会话接入'
        }
      >
        <svg className="ball" viewBox="0 0 56 56" aria-hidden="true">
          {/* 中层：球体——纯黑正圆。running 时保留当底板（白球在球内弹，浅色壁纸也清晰）；
              error/offline 变形时隐藏。key=pokePulse 让戳痒压扁动画每次重放 */}
          <circle
            key={pokePulse}
            cx={28}
            cy={28}
            r={21}
            fill="var(--orb-body)"
            className={`${
              mood === 'dizzy'
                ? 'ball-dizzy-shake'
                : display === 'done'
                  ? 'ball-bounce'
                  : display === 'error' || display === 'offline'
                    ? 'ball-morph-hide'
                    : display === 'idle'
                      ? 'ball-breathe'
                      : ''
            }${pokePulse > 0 && mood !== 'dizzy' ? ' ball-poke' : ''}`}
          />
          {/* v0.4.5 变形/加载层（画在球体之后 = 黑球底板之上） */}
          {display === 'running' && <ThinkingDots />}
          {display === 'error' && <Exclaim />}
          {display === 'offline' && <SleepDot />}
          {/* 中心：精灵眼（互动 mood 优先；变形态由 EyeSystem 内部返回 null） */}
          <g className="eye-layer">
            <EyeSystem mode={display} mood={mood} />
          </g>
          {/* 完成态：两侧星光弹出（配合星星眼 + 弹跳） */}
          {display === 'done' && (
            <>
              <g className="sparkle">
                <path
                  d="M 8 12 l 1 2.2 2.2 1 -2.2 1 -1 2.2 -1 -2.2 -2.2 -1 2.2 -1 z"
                  fill="var(--state-done)"
                />
              </g>
              <g className="sparkle s2">
                <path
                  d="M 47 15 l 0.9 2 2 0.9 -2 0.9 -0.9 2 -0.9 -2 -2 -0.9 2 -0.9 z"
                  fill="var(--state-done)"
                />
              </g>
            </>
          )}
          {/* 勿扰指示：右上角月牙角标 */}
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
    </div>
  )
}
