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
