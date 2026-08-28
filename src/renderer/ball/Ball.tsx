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

/**
 * v1.0.2→v1.0.4 思考动画：按 grok-icon-study 原版 paintOrbit 公式逐项移植
 * （fx.js paintOrbit + geometry-raw Re=114.2705，等比缩放到我们的球 r21）：
 *   轨道半径 52K、球基准 12K、纵向压缩 0.42、相位速度 0.0017 rad/ms（≈3.695s/圈）
 *   深度 dn = 0.5+0.5·max(cos,0)，透明度 = clamp((cos+0.4)/0.6, .18, 1)
 *   入场混合 ze：Rc=easeOutCubic、半径过冲 y1e=easeOutBack
 * 五球在黑球内部环绕（原版即如此），rAF 逐帧 setAttribute 与原引擎同方式。
 */
const GEO_K = 21 / 114.2705

function ThinkingOrbit() {
  const gRef = useRef<SVGGElement | null>(null)

  useEffect(() => {
    const g = gRef.current
    if (!g) return
    const balls = Array.from(g.querySelectorAll<SVGCircleElement>('.orb-ball'))
    const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
    const t0 = performance.now()
    let raf = 0
    const frame = (t: number): void => {
      const ze = clamp01((t - t0) / 450)
      const mt = 1 - Math.pow(1 - ze, 3) // Rc：入场 easeOutCubic
      const A = 52 * GEO_K * (1 + 2.70158 * Math.pow(ze - 1, 3) + 1.70158 * Math.pow(ze - 1, 2)) // y1e 过冲
      const phase = t * 0.0017
      balls.forEach((c, i) => {
        const En = phase + (i * Math.PI * 2) / 5
        const Zt = Math.cos(En)
        const dn = 0.5 + 0.5 * clamp01(Zt)
        c.setAttribute('cx', (28 + A * Math.sin(En)).toFixed(1))
        c.setAttribute('cy', (28 - A * 0.42 * Math.cos(En)).toFixed(1))
        c.setAttribute('r', Math.max(12 * GEO_K * dn * mt, 0.3).toFixed(2))
        c.setAttribute('opacity', (clamp01((Zt + 0.4) / 0.6) * mt).toFixed(3))
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <g className="think-orbit" ref={gRef} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <circle key={i} className="orb-ball" cx={28} cy={28} r={0} fill="var(--eye-white)" />
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


export function Ball() {
  const sessions = useSessions()
  const display = useMemo(() => aggregateState(sessions), [sessions])
  /** v0.10.0 活跃会话数：≥2 时球左上角叠数字徽标（勿扰月牙在右上角，避让） */
  const activeCount = useMemo(
    () => sessions.filter((s) => toDisplayState(s) !== 'idle').length,
    [sessions]
  )
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
    const off = window.pupil.onSoundPlay(({ type, pack, volume, custom }) => {
      if (pack !== undefined || volume !== undefined) {
        setSoundConfig(pack ?? 'chime', volume ?? 0.8)
      }
      playSound(type as never, custom)
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
            stroke="rgba(255,255,255,0.22)"
            strokeWidth={1.2}
            className={`${
              mood === 'dizzy'
                ? 'ball-dizzy-shake'
                : display === 'done'
                  ? 'ball-bounce'
                  : display === 'error'
                    ? 'ball-morph-hide'
                    : display === 'offline'
                      ? 'ball-offline-dim'
                      : display === 'idle'
                        ? 'ball-breathe'
                        : ''
            }${pokePulse > 0 && mood !== 'dizzy' ? ' ball-poke' : ''}`}
          />
          {/* v0.4.5 变形/加载层（画在球体之后 = 黑球底板之上） */}
          {display === 'running' && <ThinkingOrbit />}
          {display === 'error' && <Exclaim />}
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
          {/* v1.0.4 状态色环（notifying 风格）：聚合状态非 idle 时球外圈着色脉冲，
              颜色随聚合状态变化——取代托盘状态色（托盘通常隐藏看不到） */}
          {display !== 'idle' && (
            <circle className="state-ring" cx={28} cy={28} r={24.5} stroke={`var(--state-${display})`} />
          )}
          {/* v0.10.0 多会话徽标：左上角数字（活跃会话 ≥2 时显示），颜色随聚合状态 */}
          {activeCount >= 2 && (
            <g className="session-badge">
              <circle
                cx={9.5}
                cy={10}
                r={7}
                fill={`var(--state-${display})`}
                stroke="var(--orb-body)"
                strokeWidth={1.2}
              />
              <text
                x={9.5}
                y={13}
                textAnchor="middle"
                fontSize={8.5}
                fontWeight={700}
                fill="#ffffff"
              >
                {activeCount > 9 ? '9+' : activeCount}
              </text>
            </g>
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
