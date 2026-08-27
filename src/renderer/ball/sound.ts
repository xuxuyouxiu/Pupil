/**
 * 音效 —— Web Audio 合成，多套音色包（用户可选）+ 音量可调
 * 对应 UIUX 文档：五类事件各有可盲听区分的音效
 *
 * 设计：
 *   - 每个音色包 = 5 种事件音的合成配方（纯代码合成，零音频资源）
 *   - 音量：主进程 config 持久化（soundPack/soundVolume），每次播放指令都携带最新值，
 *     球窗无需额外广播通道；设置面板拖滑块/切音色时本地直接试听
 */
let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

export type SoundType = SoundKind
export type { SoundKind } from '../../shared/events'
import type { SoundKind } from '../../shared/events'
export type SoundPackId = 'chime' | 'wood' | 'chip' | 'alarm'

/** 一段包络音的合成参数 */
interface ToneSpec {
  freq: number
  start: number // 相对音效开头的秒
  dur: number
  type?: OscillatorType // 默认 sine
  gain?: number // 包内相对增益 0..1（最终乘全局系数）
}

export interface SoundPack {
  id: SoundPackId
  label: string
  sounds: Record<SoundType, ToneSpec[]>
}

const PACKS: Record<SoundPackId, SoundPack> = {
  /** 清脆铃声（默认）：明亮正弦，金属叮声带泛音 */
  chime: {
    id: 'chime',
    label: '清脆铃声',
    sounds: {
      done: [
        { freq: 880, start: 0, dur: 0.16 },
        { freq: 1318.5, start: 0.12, dur: 0.24 },
        { freq: 1760, start: 0.12, dur: 0.22, gain: 0.5 } // 泛音提亮
      ],
      waiting: [
        { freq: 660, start: 0, dur: 0.09 },
        { freq: 660, start: 0.14, dur: 0.09 }
      ],
      error: [
        { freq: 180, start: 0, dur: 0.3, type: 'square', gain: 0.55 },
        { freq: 92, start: 0.02, dur: 0.3, type: 'square', gain: 0.4 } // 低八度加厚
      ],
      timeout: [
        { freq: 330, start: 0, dur: 0.18, type: 'triangle' },
        { freq: 330, start: 0.26, dur: 0.18, type: 'triangle' }
      ],
      offline: [{ freq: 220, start: 0, dur: 0.22, type: 'triangle' }],
      // 会话结束：下行双音「收工」（与 done 上行琶音方向相反，盲听可区分）
      ended: [
        { freq: 659.26, start: 0, dur: 0.12 },
        { freq: 440, start: 0.14, dur: 0.22, gain: 0.8 }
      ]
    }
  },
  /** 木质敲击：短促三角波，木鱼质感 */
  wood: {
    id: 'wood',
    label: '木质敲击',
    sounds: {
      done: [
        { freq: 523.25, start: 0, dur: 0.07, type: 'triangle' },
        { freq: 659.25, start: 0.08, dur: 0.07, type: 'triangle' },
        { freq: 783.99, start: 0.16, dur: 0.1, type: 'triangle' }
      ],
      waiting: [
        { freq: 440, start: 0, dur: 0.05, type: 'triangle' },
        { freq: 440, start: 0.12, dur: 0.05, type: 'triangle' }
      ],
      error: [
        { freq: 196, start: 0, dur: 0.12, type: 'sawtooth', gain: 0.5 },
        { freq: 185, start: 0.13, dur: 0.14, type: 'sawtooth', gain: 0.5 } // 不谐和双击
      ],
      timeout: [
        { freq: 262, start: 0, dur: 0.1, type: 'triangle' },
        { freq: 247, start: 0.15, dur: 0.1, type: 'triangle' },
        { freq: 233, start: 0.3, dur: 0.12, type: 'triangle' }
      ],
      offline: [{ freq: 165, start: 0, dur: 0.15, type: 'triangle' }],
      // 会话结束：低八度回落，木鱼双敲收工
      ended: [
        { freq: 392, start: 0, dur: 0.06, type: 'triangle' },
        { freq: 261.63, start: 0.1, dur: 0.12, type: 'triangle', gain: 0.8 }
      ]
    }
  },
  /** 8-bit 电子：方波琶音，游戏机风 */
  chip: {
    id: 'chip',
    label: '8-bit 电子',
    sounds: {
      done: [
        { freq: 523, start: 0, dur: 0.09, type: 'square', gain: 0.5 },
        { freq: 659, start: 0.09, dur: 0.09, type: 'square', gain: 0.5 },
        { freq: 784, start: 0.18, dur: 0.09, type: 'square', gain: 0.5 },
        { freq: 1047, start: 0.27, dur: 0.18, type: 'square', gain: 0.5 }
      ],
      waiting: [
        { freq: 988, start: 0, dur: 0.06, type: 'square', gain: 0.5 },
        { freq: 988, start: 0.12, dur: 0.06, type: 'square', gain: 0.5 }
      ],
      error: [
        { freq: 110, start: 0, dur: 0.16, type: 'sawtooth', gain: 0.55 },
        { freq: 98, start: 0.16, dur: 0.22, type: 'sawtooth', gain: 0.55 }
      ],
      timeout: [
        { freq: 392, start: 0, dur: 0.12, type: 'square', gain: 0.45 },
        { freq: 370, start: 0.2, dur: 0.12, type: 'square', gain: 0.45 },
        { freq: 349, start: 0.4, dur: 0.16, type: 'square', gain: 0.45 }
      ],
      offline: [{ freq: 147, start: 0, dur: 0.25, type: 'square', gain: 0.45 }],
      // 会话结束：游戏机「关卡结束」下行琶音
      ended: [
        { freq: 784, start: 0, dur: 0.08, type: 'square', gain: 0.5 },
        { freq: 523, start: 0.1, dur: 0.08, type: 'square', gain: 0.5 },
        { freq: 392, start: 0.2, dur: 0.16, type: 'square', gain: 0.5 }
      ]
    }
  },
  /** 低音警示：低频慢鸣，严肃场景不刺耳 */
  alarm: {
    id: 'alarm',
    label: '低音警示',
    sounds: {
      done: [
        { freq: 587.33, start: 0, dur: 0.28 },
        { freq: 493.88, start: 0.32, dur: 0.38 }
      ],
      waiting: [
        { freq: 622.25, start: 0, dur: 0.11 },
        { freq: 622.25, start: 0.17, dur: 0.11 },
        { freq: 622.25, start: 0.34, dur: 0.11 }
      ],
      error: [
        // 小二度拍频：持续的不安感
        { freq: 138.59, start: 0, dur: 0.35, type: 'sawtooth', gain: 0.5 },
        { freq: 146.83, start: 0.01, dur: 0.35, type: 'sawtooth', gain: 0.45 }
      ],
      timeout: [
        { freq: 207.65, start: 0, dur: 0.22 },
        { freq: 207.65, start: 0.32, dur: 0.22 },
        { freq: 207.65, start: 0.64, dur: 0.3 }
      ],
      offline: [{ freq: 103.83, start: 0, dur: 0.4, type: 'triangle' }],
      // 会话结束：缓落双音，低音收工不刺耳
      ended: [
        { freq: 493.88, start: 0, dur: 0.2, gain: 0.85 },
        { freq: 329.63, start: 0.24, dur: 0.34, gain: 0.85 }
      ]
    }
  }
}

/** 设置面板下拉用 */
export function listSoundPacks(): { id: SoundPackId; label: string }[] {
  return Object.values(PACKS).map((p) => ({ id: p.id, label: p.label }))
}

/** 当前生效配置（模块级状态；由主进程下发的最新值驱动） */
let currentPack: SoundPackId = 'chime'
let currentVolume = 0.8 // 0..1，全局音量

export function setSoundConfig(pack: string, volume: number): void {
  if (pack in PACKS) currentPack = pack as SoundPackId
  if (Number.isFinite(volume)) currentVolume = Math.min(1, Math.max(0, volume))
}

/** 默认峰值系数：0.35（旧版 0.18 的近两倍，用户反馈声音太小） */
const PEAK = 0.35

function tone(ac: AudioContext, spec: ToneSpec): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = spec.type ?? 'sine'
  osc.frequency.value = spec.freq
  const peak = PEAK * currentVolume * (spec.gain ?? 1)
  if (peak <= 0) return
  g.gain.setValueAtTime(0, ac.currentTime + spec.start)
  g.gain.linearRampToValueAtTime(peak, ac.currentTime + spec.start + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + spec.start + spec.dur)
  osc.connect(g)
  g.connect(ac.destination)
  osc.start(ac.currentTime + spec.start)
  osc.stop(ac.currentTime + spec.start + spec.dur + 0.05)
}

/** 自定义音频（用户设置的 mp3/wav 等）播放句柄，避免叠音 */
let customAudio: HTMLAudioElement | null = null

/** 按扩展名猜 MIME（Blob 播放用；未知默认 mp3） */
function audioMime(name?: string): string {
  const ext = (name ?? '').split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'wav': return 'audio/wav'
    case 'flac': return 'audio/flac'
    case 'ogg': return 'audio/ogg'
    case 'm4a': case 'aac': return 'audio/mp4'
    case 'wma': return 'audio/x-ms-wma'
    case 'mp3': default: return 'audio/mpeg'
  }
}

/** 播放用户自定义音频文件（主进程把 file:// URL 经 IPC 下发；无自定义则用内置合成） */
export function playSound(
  type: SoundType,
  custom?: { name?: string; url?: string; data?: Uint8Array | ArrayBuffer }
): void {
  if (custom && (custom.url || custom.data)) {
    // 先停掉上一个自定义音，防止连续完成事件叠音
    if (customAudio) {
      try {
        customAudio.pause()
        customAudio.currentTime = 0
      } catch {
        /* 已销毁的 Audio：忽略 */
      }
      customAudio = null
    }
    // 优先 file:// 直载（已验证安全可播放）；data 字节仅作兜底（临时 Blob）
    let url = custom.url ?? ''
    let revoke = false
    if (!url && custom.data) {
      const bytes = custom.data instanceof ArrayBuffer ? new Uint8Array(custom.data) : custom.data
      const buffer = new Uint8Array(bytes).buffer as ArrayBuffer
      const blob = new Blob([buffer], { type: audioMime(custom.name) })
      url = URL.createObjectURL(blob)
      revoke = true
    }
    if (!url) return
    const audio = new Audio(url)
    audio.volume = currentVolume
    const cleanup = (): void => {
      if (revoke) URL.revokeObjectURL(url)
    }
    audio.onended = cleanup
    audio.onerror = cleanup
    customAudio = audio
    void audio.play().catch((e) => {
      console.warn('[sound] custom audio play failed:', e)
      cleanup()
    })
    return
  }

  const ac = getCtx()
  if (!ac || currentVolume <= 0) return
  const pack = PACKS[currentPack] ?? PACKS.chime
  for (const spec of pack.sounds[type] ?? []) tone(ac, spec)
}

/* ---- v0.5.0 宠物互动音效（不走通知策略，球窗本地直触） ---- */

/**
 * 戳一下「啵」：880→1200Hz 快速上滑正弦，60ms（指数滑音听感 Q 弹）。
 */
export function playPoke(): void {
  const ac = getCtx()
  if (!ac || currentVolume <= 0) return
  const osc = ac.createOscillator()
  const g = ac.createGain()
  const t0 = ac.currentTime
  osc.type = 'sine'
  try {
    osc.frequency.setValueAtTime(880, t0)
    osc.frequency.exponentialRampToValueAtTime(1200, t0 + 0.06)
  } catch {
    osc.frequency.value = 1000 // 极端参数下兜底为定频
  }
  const peak = PEAK * currentVolume * 0.7
  g.gain.setValueAtTime(peak, t0)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06)
  osc.connect(g)
  g.connect(ac.destination)
  osc.start(t0)
  osc.stop(t0 + 0.09)
}

/**
 * 呼噜循环：55Hz 正弦 × 22Hz 幅度颤音，持续到 stopPurr()。
 * 结构：osc(55Hz) → tremGain(LFO 调制增益) → master → destination。
 * 返回停止句柄；重复调用先停旧的（摸头重入安全）。
 */
let purrNodes: { osc: OscillatorNode; lfo: OscillatorNode; master: GainNode } | null = null

export function startPurr(): void {
  const ac = getCtx()
  if (!ac || currentVolume <= 0) return
  stopPurr()

  const osc = ac.createOscillator()
  const lfo = ac.createOscillator()
  const trem = ac.createGain()
  const master = ac.createGain()
  const t0 = ac.currentTime

  osc.type = 'sine'
  osc.frequency.value = 55
  // 颤音：22Hz LFO 控制增益在 0.25~1 间摆动（呼噜的滚动质感）
  lfo.type = 'sine'
  lfo.frequency.value = 22
  const base = PEAK * currentVolume * 0.5
  trem.gain.value = base * 0.375 // 摆幅 ±37.5%（LFO 输出 ±1 × 此值）
  lfo.connect(trem.gain)

  master.gain.setValueAtTime(0, t0)
  master.gain.linearRampToValueAtTime(base, t0 + 0.18) // 180ms 淡入不突兀

  osc.connect(trem)
  trem.connect(master)
  master.connect(ac.destination)
  osc.start(t0)
  lfo.start(t0)
  purrNodes = { osc, lfo, master }
}

export function stopPurr(): void {
  if (!purrNodes) return
  const { osc, lfo, master } = purrNodes
  purrNodes = null
  try {
    const t0 = osc.context.currentTime
    master.gain.cancelScheduledValues(t0)
    master.gain.setValueAtTime(master.gain.value, t0)
    master.gain.linearRampToValueAtTime(0, t0 + 0.15) // 150ms 淡出
    osc.stop(t0 + 0.2)
    lfo.stop(t0 + 0.2)
  } catch {
    /* 已停止的节点：忽略 */
  }
}
