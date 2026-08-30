/**
 * 进程活性探测（v1.7.0）—— 「日志滞后型」数据源的统一忙/闲信号
 *
 * 背景（用户报告的两类误报，经审计为 zcode/gemini/codex/opencode 四源共有）：
 *   1. 用户刚发消息、模型首响应未落地 → 日志无新行 → 球仍显示上一轮「完成」
 *   2. 会话内跑后台命令（如 git push）→ 不产生 LLM 请求 → 日志停更 → 误判收敛/悬空
 *
 * 原理：harness 进程在"忙"（等模型/执行工具/跑命令）时 CPU 有持续活动；
 * 彻底空闲时趋近 0。以滑动窗口平均 CPU > 阈值 判定 Busy，作为日志信号之上
 * 的状态修正层：
 *   - 日志说完成 + 进程 Busy → 维持 running（覆盖症状 2 的"悬空"）
 *   - 日志静默 + 进程 Busy  → 维持/进入 running（覆盖症状 1 的"提前完成"）
 */

export interface ProcessActivitySample {
  pid: number
  /** 内核+用户 CPU 时间合计（毫秒），单调递增 */
  cpuMs: number
}

export interface TrackedProcess {
  pid: number
  lastCpuMs: number
  lastAt: number
  /** 滑动窗口内的活跃率 0..1 */
  activity: number
}

const BUSY_CPU_RATIO = 0.05 // 采样间隔内 CPU 时间占比 >5% 视为活跃
const WINDOW_MS = 10_000 // 活跃率统计窗口

export class ProcessActivityTracker {
  private procs = new Map<number, TrackedProcess>()

  /** 采样一批进程（cpuMs 由平台探针提供；缺失/退出的进程自动清理） */
  sample(samples: ProcessActivitySample[], now: number): void {
    const seen = new Set<number>()
    for (const s of samples) {
      seen.add(s.pid)
      const prev = this.procs.get(s.pid)
      if (!prev || s.cpuMs < prev.lastCpuMs) {
        // 新进程或计数器重置
        this.procs.set(s.pid, { pid: s.pid, lastCpuMs: s.cpuMs, lastAt: now, activity: 0 })
        continue
      }
      const dtMs = now - prev.lastAt
      if (dtMs <= 0) continue
      const used = s.cpuMs - prev.lastCpuMs
      // 多核归一：used/dt 可能 >1（多线程），clamp 到 1
      const ratio = Math.min(1, used / dtMs)
      const prev2 = this.procs.get(s.pid)!
      // 指数滑动平均（半衰期 ≈ 窗口一半）
      const alpha = Math.min(1, dtMs / WINDOW_MS)
      prev2.activity = prev2.activity * (1 - alpha) + ratio * alpha
      prev2.lastCpuMs = s.cpuMs
      prev2.lastAt = now
    }
    for (const pid of [...this.procs.keys()]) {
      if (!seen.has(pid)) this.procs.delete(pid)
    }
  }

  /** 任一被跟踪进程是否处于忙态 */
  anyBusy(): boolean {
    for (const p of this.procs.values()) {
      if (p.activity > BUSY_CPU_RATIO) return true
    }
    return false
  }

  tracked(): number[] {
    return [...this.procs.keys()]
  }
}
