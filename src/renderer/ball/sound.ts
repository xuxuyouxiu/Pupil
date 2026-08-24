/**
 * 音效 —— Web Audio 合成（MVP 无音频资源文件，事件音效全部合成；后续可换自定义文件）
 * 对应 UIUX 文档：四类事件各有可盲听区分的音效
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

/** 播放一段包络音 */
function tone(
  ac: AudioContext,
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType = 'sine',
  gain = 0.18
): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.value = freq
  // 包络：快起快落，避免爆音
  g.gain.setValueAtTime(0, ac.currentTime + start)
  g.gain.linearRampToValueAtTime(gain, ac.currentTime + start + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur)
  osc.connect(g)
  g.connect(ac.destination)
  osc.start(ac.currentTime + start)
  osc.stop(ac.currentTime + start + dur + 0.05)
}

export type SoundType = 'done' | 'waiting' | 'error' | 'timeout' | 'offline'

/** 播放指定类型音效（按事件盲听可区分） */
export function playSound(type: SoundType): void {
  const ac = getCtx()
  if (!ac) return

  switch (type) {
    case 'done': // 明亮双音"叮-叮"（高→更高）
      tone(ac, 880, 0, 0.14)
      tone(ac, 1318, 0.12, 0.2)
      break
    case 'waiting': // 双短提示（重复同音，催促感）
      tone(ac, 660, 0, 0.09)
      tone(ac, 660, 0.14, 0.09)
      break
    case 'error': // 低沉蜂鸣（方波）
      tone(ac, 180, 0, 0.28, 'square', 0.12)
      break
    case 'timeout': // 低沉双音（慢）
      tone(ac, 330, 0, 0.18, 'triangle')
      tone(ac, 330, 0.26, 0.18, 'triangle')
      break
    case 'offline': // 单声低音
      tone(ac, 220, 0, 0.2, 'triangle', 0.12)
      break
  }
}
