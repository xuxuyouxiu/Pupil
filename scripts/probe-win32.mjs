/**
 * 诊断探针：复刻 src/integrations/win32-window.ts 的 FFI 链路（koffi 回调正确绑定）
 * 用法：node scripts/probe-win32.mjs
 * 预期：user32 symbols bound OK + EnumWindows 枚举出可见窗口 + 模拟 hermes 会话命中 "Hermes" 窗口
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const koffi = require('koffi')
console.log('[probe] koffi version:', require('koffi/package.json').version)

const user32 = koffi.load('user32.dll')
const EW_PROTO = koffi.proto('PupilEnumWindowsProc', 'bool', ['uintptr', 'intptr'])
const EnumWindows = user32.func('EnumWindows', 'bool', ['PupilEnumWindowsProc *', 'intptr'])
const GetWindowTextW = user32.func('GetWindowTextW', 'int32', ['uintptr', 'void *', 'int32'])
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['uintptr'])
// 出参必须 koffi.out（与应用实现一致），否则 pid 恒为 0
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'int32', ['uintptr', koffi.out('int32 *')])
console.log('[probe] user32 symbols bound OK')

let handler = null
const cb = koffi.register((hwnd) => {
  try {
    handler?.(Number(hwnd))
  } catch {
    /* 继续 */
  }
  return true
}, koffi.pointer(EW_PROTO))

const wins = []
handler = (hwnd) => {
  if (!IsWindowVisible(hwnd)) return
  const buf = Buffer.alloc(1024)
  const len = GetWindowTextW(hwnd, buf, 512)
  if (len > 0) {
    const pidArr = [0]
    GetWindowThreadProcessId(hwnd, pidArr)
    wins.push({ hwnd, pid: pidArr[0], title: buf.toString('utf16le', 0, len * 2) })
  }
}
const ok = EnumWindows(cb, 0)
console.log(`[probe] EnumWindows OK=${ok}, visible titled windows: ${wins.length}`)
for (const w of wins.slice(0, 12)) console.log(`  hwnd=${w.hwnd} pid=${w.pid} title="${w.title}"`)

// 模拟一条 hermes 会话的匹配打分（与 win32-window.ts 一致）
// 探针本身不是 Pupil 进程，用 PUPIL_PROBE_OWN_PID 指定"视为自己"的 pid（即 Pupil 主进程 pid）
const OWN_PID = Number(process.env.PUPIL_PROBE_OWN_PID || process.pid)
const session = {
  title: '20260824_190',
  sessionId: '20260824_190617_77ba8c',
  cwd: 'G:\\Pupil',
  agentType: 'hermes',
  pid: undefined
}
const key = (session.title ?? session.sessionId).toLowerCase()
const dir = session.cwd.split(/[\\/]/).pop().toLowerCase()
const hints = ['hermes']
let best = 0
let found = null
for (const w of wins) {
  if (w.pid === OWN_PID) continue // 排除自己（与应用一致）
  const t = w.title.toLowerCase()
  let score = 0
  if (session.pid && w.pid === session.pid) score += 10
  if (key && t.includes(key)) score += 5
  if (dir && t.includes(dir)) score += 3
  if (hints.some((h) => t.includes(h))) score += 1
  if (score > best) {
    best = score
    found = w
  }
}
console.log('[probe] match result:', found ? JSON.stringify(found) : 'NONE', '| bestScore=', best)

koffi.unregister(cb)
