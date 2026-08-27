/**
 * Updater —— GitHub Releases 更新检查/下载（无 electron-updater 依赖）
 *
 * 检查：GET github.com/<owner>/<repo>/releases/latest（公开仓库无需认证）
 * 下载：用户点击后把安装包拉到系统临时目录，再用 shell 打开让用户完成安装
 * 说明：NSIS 安装版优先，portable 兜底；开发模式（非打包）不做网络检查。
 */
import { app, Notification, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { UpdateCheckResult } from '../shared/ipc-channels'
import { GitHubRelease, isNewerVersion, parseGitHubRelease } from './update-core'

const OWNER = 'xuxuyouxiu'
const REPO = 'Pupil'
const RELEASE_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const CHECK_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

export class Updater {
  private result: UpdateCheckResult
  private checking = false

  constructor() {
    this.result = { status: 'disabled', currentVersion: app.getVersion() }
  }

  get current(): UpdateCheckResult {
    return this.result
  }

  /** 检查更新。manual=true 是用户手动点击（不弹系统通知）。 */
  async check(manual = false): Promise<UpdateCheckResult> {
    if (!app.isPackaged) {
      this.result = { status: 'dev', currentVersion: app.getVersion() }
      return this.result
    }
    if (this.checking) return this.result
    this.checking = true
    this.result = { status: 'checking', currentVersion: app.getVersion() }
    try {
      const res = await fetch(RELEASE_API, {
        headers: {
          'user-agent': 'pupil-updater',
          accept: 'application/vnd.github+json'
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
      const release = (await res.json()) as GitHubRelease
      const parsed = parseGitHubRelease(release)
      const current = app.getVersion()

      if (!parsed.latestVersion || !isNewerVersion(parsed.latestVersion, current)) {
        this.result = {
          status: 'not-available',
          currentVersion: current,
          latestVersion: parsed.latestVersion || undefined,
          releaseUrl: parsed.htmlUrl
        }
        return this.result
      }

      this.result = {
        status: 'available',
        currentVersion: current,
        latestVersion: parsed.latestVersion,
        message: parsed.message,
        releaseUrl: parsed.htmlUrl,
        assetUrl: parsed.asset?.browser_download_url,
        assetName: parsed.asset?.name
      }
      if (!manual) this.notifyAvailable()
      return this.result
    } catch (error) {
      this.result = {
        status: 'error',
        currentVersion: app.getVersion(),
        error: error instanceof Error ? error.message : String(error)
      }
      return this.result
    } finally {
      this.checking = false
    }
  }

  /** 打开发布页（浏览器） */
  openReleasePage(): void {
    if (this.result.releaseUrl) void shell.openExternal(this.result.releaseUrl)
  }

  /** 下载最新安装包并打开（用户手动触发） */
  async downloadAndOpen(): Promise<UpdateCheckResult> {
    if (this.result.status !== 'available' || !this.result.assetUrl) return this.result
    const assetUrl = this.result.assetUrl
    const assetName = this.result.assetName ?? `Pupil-${this.result.latestVersion}.exe`
    const dest = join(app.getPath('temp'), assetName)
    this.result = { ...this.result, status: 'downloading' }
    try {
      const res = await fetch(assetUrl, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`download HTTP ${res.status}`)
      const data = Buffer.from(await res.arrayBuffer())
      await fsp.writeFile(dest, data)
      this.result = { ...this.result, status: 'downloaded', assetUrl: undefined }
      // 打开安装器，用户按向导完成升级；安装后即可体验新版本
      await shell.openPath(dest)
      return this.result
    } catch (error) {
      this.result = {
        ...this.result,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      }
      return this.result
    }
  }

  private notifyAvailable(): void {
    try {
      new Notification({
        title: 'Pupil 有新版本',
        body: `发现 v${this.result.latestVersion}，打开设置即可下载更新`
      }).show()
    } catch {
      /* 通知失败不阻断 */
    }
  }
}
