/**
 * 闲时杂技状态机（v1.4.0）—— 纯逻辑，注入时钟可单测
 * 规格见 docs/ROADMAP-v2.md 批次 C：
 *   全空闲 ≥90s 进入可杂耍态；此后每 120~300s（随机）触发一次，单次 7s；
 *   任何非 idle 状态/勿扰/用户交互立即打断并重新计 90s 冷却。
 */
export interface JuggleConfig {
  idleThresholdMs: number // 进入可杂耍态的连续空闲时长（默认 90s）
  minIntervalMs: number // 两次触发的最小间隔（默认 120s）
  maxIntervalMs: number // 最大间隔（默认 300s）
  durationMs: number // 单次杂耍时长（默认 7000）
}

export const DEFAULT_JUGGLE_CONFIG: JuggleConfig = {
  idleThresholdMs: 90_000,
  minIntervalMs: 120_000,
  maxIntervalMs: 300_000,
  durationMs: 7_000
}

export type JugglePhase = 'idle' | 'armed' | 'performing'

export class JuggleScheduler {
  private phase: JugglePhase = 'idle'
  private idleSince = 0
  private nextAt = 0
  private performUntil = 0
  private rand: () => number

  constructor(
    private config: JuggleConfig = DEFAULT_JUGGLE_CONFIG,
    rand: () => number = Math.random
  ) {
    this.rand = rand
  }

  get currentPhase(): JugglePhase {
    return this.phase
  }

  /**
   * 每帧/每秒 tick。displayIdle = 聚合展示态为 idle；disturbed = 用户交互/勿扰等打断信号。
   * 返回当前是否应该播放杂耍动画（performing 且未超时）。
   */
  tick(displayIdle: boolean, now: number, disturbed = false): boolean {
    if (disturbed || !displayIdle) {
      // 任何打断/退出空闲：回到 idle 相位重新计 90s
      this.phase = 'idle'
      this.idleSince = displayIdle ? now : 0 // displayIdle 时保留计时（勿扰不算严格打断）
      if (!displayIdle) this.idleSince = 0
      return false
    }

    // 空闲中
    if (this.idleSince === 0) this.idleSince = now
    const idleMs = now - this.idleSince

    switch (this.phase) {
      case 'idle':
        if (idleMs >= this.config.idleThresholdMs) {
          this.phase = 'armed'
          this.nextAt = now + this.randomInterval()
        }
        return false
      case 'armed':
        if (now >= this.nextAt) {
          this.phase = 'performing'
          this.performUntil = now + this.config.durationMs
          return true
        }
        return false
      case 'performing':
        if (now >= this.performUntil) {
          this.phase = 'armed'
          this.nextAt = now + this.randomInterval()
          return false
        }
        return true
      default:
        return false
    }
  }

  /** 用户交互（pointerdown 等）：无条件重新冷却 */
  poke(now: number): void {
    this.phase = 'idle'
    this.idleSince = now
  }

  private randomInterval(): number {
    const { minIntervalMs, maxIntervalMs } = this.config
    return minIntervalMs + this.rand() * (maxIntervalMs - minIntervalMs)
  }
}
