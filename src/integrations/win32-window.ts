/**
 * Win32 窗口激活集成 —— koffi FFI 直调 user32.dll
 * 架构文档 7.2：定位窗口（PID 优先 -> 标题匹配兜底）-> SetForegroundWindow + Alt 键 workaround
 *
 * ⚠️ koffi 2.x 回调绑定（本机实测踩坑）：
 *   - 参数表里裸写 'callback' 类型名会绑定失败（Unknown or invalid type name），
 *     且失败被 try/catch 吞掉 => api 恒为 null => 永远提示"窗口未找到"
 *   - 正确做法：koffi.proto 声明原型，符号参数表引用 '<原型名> *'，
 *     回调用 koffi.register(jsFn, koffi.pointer(proto)) 创建，用完 koffi.unregister
 */
import { AgentType, SessionView } from '../shared/events'

// koffi 为原生模块，加载失败时降级（不影响应用其他功能）
let koffi: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  koffi = require('koffi')
} catch {
  koffi = null
}

interface Win32Api {
  EnumWindows(cb: unknown, lParam: number): boolean
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
let EW_PROTO: unknown = null
function loadApi(): Win32Api | null {
  if (!koffi) return null
  try {
    const user32 = koffi.load('user32.dll')
    // 回调原型：全局注册一次；符号参数表按 '<名> *' 引用指针形式
    EW_PROTO = koffi.proto('PupilEnumWindowsProc', 'bool', ['uintptr', 'intptr'])
    return {
      EnumWindows: user32.func('EnumWindows', 'bool', ['PupilEnumWindowsProc *', 'intptr']),
      GetWindowTextW: user32.func('GetWindowTextW', 'int32', ['uintptr', 'void *', 'int32']),
      IsWindowVisible: user32.func('IsWindowVisible', 'bool', ['uintptr']),
      // 出参必须显式 koffi.out，否则传入数组不会被回写、pid 恒为 0（实测踩坑）
      GetWindowThreadProcessId: user32.func('GetWindowThreadProcessId', 'int32', ['uintptr', koffi.out('int32 *')]),
      SetForegroundWindow: user32.func('SetForegroundWindow', 'bool', ['uintptr']),
      ShowWindow: user32.func('ShowWindow', 'bool', ['uintptr', 'int32']),
      keybd_event: user32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr'])
    }
  } catch (err) {
    console.error('[win32-window] user32 bind failed:', err)
    return null
  }
}

const api = loadApi()

/**
 * 模块级常驻回调：EnumWindows 是同步调用，进入前换上当前处理器即可。
 * 回调只创建一次（koffi 文档要求回调实例保持引用防 GC），不逐次注册/注销。
 */
let enumHandler: ((hwnd: number) => void) | null = null
let registeredCb: unknown = null
if (api && EW_PROTO) {
  try {
    registeredCb = koffi.register((hwnd: number) => {
      try {
        enumHandler?.(Number(hwnd))
      } catch {
        /* 单窗口处理失败继续枚举 */
      }
      return true
    }, koffi.pointer(EW_PROTO))
  } catch (err) {
    console.error('[win32-window] callback register failed:', err)
    registeredCb = null
  }
}

/** agent 类型 -> 宿主应用窗口标题关键词（轮询型会话无 pid、会话 ID 不在窗口标题里时的兜底） */
const AGENT_WINDOW_HINTS: Partial<Record<AgentType, string[]>> = {
  // Hermes 桌面版是单实例应用，主窗口标题即 "Hermes"，跳到它就是正确行为
  hermes: ['hermes'],
  codex: ['codex'],
  'claude-code': ['claude'],
  dsh: ['dsh'],
  zcode: ['zcode'],
  gemini: ['gemini'],
  opencode: ['opencode'],
  workbuddy: ['workbuddy', 'doubao']
}

/** 本进程窗口（Pupil 球窗/面板窗）绝不作为跳转目标 */
function isOwnWindow(hwnd: number): boolean {
  if (!api) return false
  const pidArr: number[] = [0]
  api.GetWindowThreadProcessId(hwnd, pidArr)
  return pidArr[0] === process.pid
}

/** 按 PID / 标题 / 目录名打分，找到最匹配的顶层可见窗口 */
function findWindow(session: SessionView): number | null {
  if (!api || !registeredCb) return null

  let found: number | null = null
  let bestScore = 0

  const key = (session.title ?? session.sessionId).toLowerCase()
  const dir = session.cwd?.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  // 宿主应用名兜底：仅当会话自身标识（ID/标题）匹配不到时才启用，且分数最低
  const hints = AGENT_WINDOW_HINTS[session.agentType] ?? []

  enumHandler = (hwnd: number) => {
    if (!api!.IsWindowVisible(hwnd)) return
    // 排除自己：会话目录名（如 "pupil"）可能撞上自家窗口标题（"Pupil Ball"）
    if (isOwnWindow(hwnd)) return

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
      if (hints.some((h) => title.includes(h))) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      found = hwnd
    }
  }

  try {
    api.EnumWindows(registeredCb, 0)
  } catch (err) {
    console.error('[win32-window] EnumWindows failed:', err)
  } finally {
    enumHandler = null
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
