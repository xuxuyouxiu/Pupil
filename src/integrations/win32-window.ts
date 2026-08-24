/**
 * Win32 窗口激活集成 —— koffi FFI 直调 user32.dll
 * 架构文档 7.2：定位窗口（PID 优先 -> 标题匹配兜底）-> SetForegroundWindow + Alt 键 workaround
 */
import { SessionView } from '../shared/events'

// koffi 为原生模块，加载失败时降级（不影响应用其他功能）
let koffi: { load: (lib: string) => unknown } | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  koffi = require('koffi')
} catch {
  koffi = null
}

interface Win32Api {
  EnumWindows(cb: (hwnd: number, lParam: number) => boolean, lParam: number): boolean
  GetWindowTextW(hwnd: number, buf: Buffer, maxCount: number): number
  IsWindowVisible(hwnd: number): boolean
  GetWindowThreadProcessId(hwnd: number, pid: number[]): number
  SetForegroundWindow(hwnd: number): boolean
  ShowWindow(hwnd: number, cmd: number): boolean
  keybd_event(vk: number, scan: number, flags: number, extra: number): void
}

const SW_RESTORE = 9
const VK_MENU = 0x12
const KEYEVENTF_KEYUP = 0x0002

/** 加载 user32.dll 符号（koffi 类型尽量宽松，运行时失败一律降级） */
function loadApi(): Win32Api | null {
  if (!koffi) return null
  try {
    const user32 = koffi.load('user32.dll') as {
      func: (name: string, ret: string, args: string[]) => unknown
    }
    return {
      EnumWindows: user32.func('EnumWindows', 'bool', ['callback', 'int32']) as Win32Api['EnumWindows'],
      GetWindowTextW: user32.func('GetWindowTextW', 'int32', ['int32', 'void *', 'int32']) as Win32Api['GetWindowTextW'],
      IsWindowVisible: user32.func('IsWindowVisible', 'bool', ['int32']) as Win32Api['IsWindowVisible'],
      GetWindowThreadProcessId: user32.func('GetWindowThreadProcessId', 'int32', ['int32', 'int32 *']) as Win32Api['GetWindowThreadProcessId'],
      SetForegroundWindow: user32.func('SetForegroundWindow', 'bool', ['int32']) as Win32Api['SetForegroundWindow'],
      ShowWindow: user32.func('ShowWindow', 'bool', ['int32', 'int32']) as Win32Api['ShowWindow'],
      keybd_event: user32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr']) as Win32Api['keybd_event']
    }
  } catch {
    return null
  }
}

const api = loadApi()

/** 按 PID / 标题 / 目录名打分，找到最匹配的顶层可见窗口 */
function findWindow(session: SessionView): number | null {
  if (!api) return null
  let found: number | null = null
  let bestScore = 0

  const key = (session.title ?? session.sessionId).toLowerCase()
  const dir = session.cwd?.split(/[\\/]/).pop()?.toLowerCase() ?? ''

  try {
    api.EnumWindows((hwnd: number) => {
      if (!api!.IsWindowVisible(hwnd)) return true

      let score = 0
      if (session.pid) {
        const pidArr: number[] = [0]
        api!.GetWindowThreadProcessId(hwnd, pidArr)
        if (pidArr[0] === session.pid) score += 10
      }
      const buf = Buffer.alloc(1024)
      const len = api!.GetWindowTextW(hwnd, buf, 512)
      if (len > 0) {
        const title = buf.toString('utf16le', 0, len * 2).toLowerCase()
        if (key && title.includes(key)) score += 5
        if (dir && title.includes(dir)) score += 3
      }
      if (score > bestScore) {
        bestScore = score
        found = hwnd
      }
      return true
    }, 0)
  } catch {
    return null
  }

  return bestScore > 0 ? found : null
}

/**
 * 激活会话对应窗口。
 * 返回 true 表示找到并尝试激活；false 表示未找到（调用方提示"窗口未找到"）。
 */
export async function activateSessionWindow(session: SessionView): Promise<boolean> {
  if (!api) return false
  const hwnd = findWindow(session)
  if (!hwnd) return false
  try {
    api.ShowWindow(hwnd, SW_RESTORE)
    // 前台锁定 workaround：先模拟一次 Alt 键按下再 SetForegroundWindow
    api.keybd_event(VK_MENU, 0, 0, 0)
    api.SetForegroundWindow(hwnd)
    api.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    return true
  } catch {
    return false
  }
}
