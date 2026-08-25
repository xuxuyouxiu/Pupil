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

/**
 * 把 CLI bin 目录注册进用户 PATH（P1-4）：任意终端直接敲 `pupil` 免 cd。
 * - 幂等：已在 PATH 中则跳过；失败静默（不影响应用其他功能，设置面板仍显示 shim 路径）
 * - 不用 setx：其 1024 字符截断会损坏长 PATH；直接改 HKCU\\Environment 注册表再广播 WM_SETTINGCHANGE
 */
export function ensureCliOnPath(binDir: string): boolean {
  const { spawn } = require('child_process') as typeof import('child_process')
  try {
    // PowerShell 读当前用户 PATH 原始值判断 + 追加（-NoProfile 防御配置注入）
    const check = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          `$p = (Get-ItemProperty -Path 'HKCU:\\Environment' -Name Path).Path`,
          `if ($p -notlike '*${binDir.replace(/'/g, "''")}*') {`,
          `  $np = if ($p.EndsWith(';')) { $p + '${binDir}' } else { $p + ';' + '${binDir}' }`,
          `  Set-ItemProperty -Path 'HKCU:\\Environment' -Name Path -Value $np`,
          `  Write-Output CHANGED`,
          `} else { Write-Output ALREADY }`
        ].join(' ')
      ],
      { windowsHide: true, timeout: 15_000 }
    )
    let out = ''
    check.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    return new Promise<boolean>((resolve) => {
      check.on('error', () => resolve(false))
      check.on('close', (code) => {
        if (code === 0 && out.includes('CHANGED')) {
          // 广播环境变更，让新开的终端立刻看到（不重启资源管理器）
          const broadcast = spawn(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              [
                'Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition',
                '"[DllImport(\\"user32.dll\\", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);"',
                '$r=[UIntPtr]::Zero',
                '[Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, \'Environment\', 2, 5000, [ref]$r)'
              ].join(' ')
            ],
            { windowsHide: true, timeout: 15_000 }
          )
          broadcast.on('close', () => undefined)
          broadcast.on('error', () => undefined)
          resolve(true)
        }
        resolve(out.includes('ALREADY'))
      })
    }) as unknown as boolean
  } catch {
    return false
  }
}
