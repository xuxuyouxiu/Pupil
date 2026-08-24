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

export type SoundType = 'done' | 'waiting' | 'error' | 'timeout' | 'offline'
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
      offline: [{ freq: 220, start: 0, dur: 0.22, type: 'triangle' }]
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
      offline: [{ freq: 165, start: 0, dur: 0.15, type: 'triangle' }]
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
      offline: [{ freq: 147, start: 0, dur: 0.25, type: 'square', gain: 0.45 }]
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
      offline: [{ freq: 103.83, start: 0, dur: 0.4, type: 'triangle' }]
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

/** 播放指定事件音（用当前音色包与音量；面板试听前先 setSoundConfig 即可） */
export function playSound(type: SoundType): void {
  const ac = getCtx()
  if (!ac || currentVolume <= 0) return
  const pack = PACKS[currentPack] ?? PACKS.chime
  for (const spec of pack.sounds[type] ?? []) tone(ac, spec)
}
