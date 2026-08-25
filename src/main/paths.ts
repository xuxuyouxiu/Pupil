/**
 * 资源路径解析 —— dev 与打包版统一
 * - dev：项目根下 resources/
 * - 打包：安装目录 resources/（electron-builder extraResources 产物）
 * - CLI（pupil send）：打包后随 resources/cli/ 分发，并在 %LOCALAPPDATA%/Pupil/bin 写 cmd shim
 */
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/** 应用内静态资源（图标等）的绝对路径 */
export function resourcePath(...rel: string[]): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...rel)
  }
  return path.join(app.getAppPath(), 'resources', ...rel)
}

/** 随应用分发的 CLI 脚本路径 */
export function cliScriptPath(): string {
  return resourcePath('cli', 'pupil-send.mjs')
}

/**
 * 确保 pupil.cmd shim 存在（打包版）：
 * 用 ELECTRON_RUN_AS_NODE=1 让 Pupil.exe 以 Node 模式执行 CLI 脚本，
 * 不要求系统装有 Node。返回 shim 所在目录（供设置面板展示）；dev 返回 null。
 */
export function ensureCliShim(): string | null {
  if (!app.isPackaged) return null
  const binDir = path.join(app.getPath('home'), '..', 'LocalAppData', 'Pupil', 'bin')
  // home 上级拼 LocalAppData 在极少数漫游配置下不可靠，优先用显式环境变量
  const dir = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Pupil', 'bin')
    : binDir
  try {
    fs.mkdirSync(dir, { recursive: true })
    const exe = process.execPath
    const script = cliScriptPath()
    const shim = [
      '@echo off',
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${exe}" "${script}" %*`,
      'endlocal'
    ].join('\r\n')
    fs.writeFileSync(path.join(dir, 'pupil.cmd'), shim, 'utf8')
    return dir
  } catch {
    return null
  }
}

/** PowerShell 单引号字符串转义：内部单引号翻倍（PS 唯一的转义规则） */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * 把 CLI bin 目录注册进用户 PATH（P1-4）：任意终端直接敲 `pupil` 免 cd。
 *
 * v0.3.1 修复：改用「PS 脚本文件」而非 -Command 内联——内联经 spawn 参数拼接时
 * $ 变量会被外层 shell 吞掉导致 PS 解析失败（本机实测复现），脚本文件无此问题。
 *
 * - 幂等：已在 PATH 中则跳过；失败静默（不影响应用其他功能）
 * - 不用 setx：其 1024 字符截断会损坏长 PATH；直接改 HKCU\Environment 再广播 WM_SETTINGCHANGE
 */
export async function ensureCliOnPath(binDir: string): Promise<boolean> {
  const { spawnSync } = require('child_process') as typeof import('child_process')
  try {
    const scriptPath = path.join(app.getPath('temp'), 'pupil-path-register.ps1')
    const script = [
      "$key = Get-ItemProperty -Path 'HKCU:\\Environment' -Name Path",
      '$p = [string]$key.Path',
      `$bin = ${psq(binDir)}`,
      "if ($p -notlike ('*' + $bin + '*')) {",
      "  $np = if ($p.EndsWith(';')) { $p + $bin } else { $p + ';' + $bin }",
      "  Set-ItemProperty -Path 'HKCU:\\Environment' -Name Path -Value $np -Type ExpandString",
      '  Write-Output CHANGED',
      '} else {',
      '  Write-Output ALREADY',
      '}',
      '# 广播环境变更，让新开的终端立刻看到（不重启资源管理器）',
      "Add-Type -Namespace Win32 -Name NM -MemberDefinition '[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'",
      '$r = [UIntPtr]::Zero',
      '[Win32.NM]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r) | Out-Null'
    ].join('\r\n')
    fs.writeFileSync(scriptPath, script, 'utf8')

    // 同步等待结果：主进程启动路径里调用方需要确定性行为（15s 上限，失败静默）
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      timeout: 15_000,
      encoding: 'utf8'
    })
    const out = (res.stdout ?? '') as string
    if (res.status === 0 && out.includes('CHANGED')) {
      console.log(`[cli] ${binDir} registered into user PATH`)
      try {
        fs.rmSync(scriptPath, { force: true })
      } catch {
        /* 清理失败无所谓 */
      }
      return true
    }
    if (res.status === 0 && out.includes('ALREADY')) return true
    console.warn(`[cli] PATH registration skipped/failed: status=${res.status} out=${out.trim()}`)
    return false
  } catch (err) {
    console.warn('[cli] PATH registration error', err)
    return false
  }
}
