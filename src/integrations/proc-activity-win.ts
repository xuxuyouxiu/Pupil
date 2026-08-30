/**
 * 进程 CPU 采样探针（Windows）—— v1.7.0 进程活性信号的采样端
 * 用 kernel32!GetProcessTimes 读每进程累计 CPU 时间（user+kernel，100ns 单位）。
 * koffi 类型宽松声明 + 运行时失败一律降级（与 win32-window 同款防呆模式）。
 */
let koffi: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  koffi = require('koffi')
} catch {
  koffi = null
}

let readFn: ((pid: number) => number | null) | null = null

function load(): ((pid: number) => number | null) | null {
  if (readFn) return readFn
  if (!koffi) return null
  try {
    const lib = koffi.load('kernel32.dll')
    const openProc = lib.func('__stdcall', 'OpenProcess', 'void*', 'uint32', 'uint32')
    const getTimes = lib.func('__stdcall', 'GetProcessTimes', 'int8', 'void*', 'int64', 'int64', 'int64', 'int64')
    const closeH = lib.func('__stdcall', 'CloseHandle', 'void*', 'void*')
    const QUERY_LIMITED = 0x1000
    readFn = (pid: number): number | null => {
      let h: unknown = null
      try {
        h = openProc(QUERY_LIMITED, pid)
        if (!h || h === 0) return null
        const created = [BigInt(0)]
        const exited = [BigInt(0)]
        const kernel = [BigInt(0)]
        const user = [BigInt(0)]
        if (!getTimes(h, created, exited, kernel, user)) return null
        // FILETIME（100ns）→ ms
        return (Number(kernel[0]) + Number(user[0])) / 10_000
      } catch {
        return null
      } finally {
        try {
          if (h) closeH(h, h)
        } catch {
          /* ignore */
        }
      }
    }
    return readFn
  } catch {
    readFn = null
    return null
  }
}

export interface CpuSample {
  pid: number
  cpuMs: number
}

/** 批量采样目标进程的累计 CPU 毫秒；读不到的进程不出现在结果中 */
export function sampleCpu(pids: number[]): CpuSample[] {
  const fn = load()
  if (!fn) return []
  const out: CpuSample[] = []
  for (const pid of pids) {
    const ms = fn(pid)
    if (ms !== null) out.push({ pid, cpuMs: ms })
  }
  return out
}
