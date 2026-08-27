/**
 * Updater —— GitHub Releases 更新检查/下载（无 electron-updater 依赖）
 *
 * 检查：GET github.com/<owner>/<repo>/releases/latest（公开仓库无需认证）
 * 下载：用户点击后把安装包拉到系统临时目录，再用 shell 打开让用户完成安装
 * 说明：NSIS 安装版优先，portable 兜底；开发模式（非打包）不做网络检查。
 */
import { app, Notification, shell } from 'electron'
import { createWriteStream, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { UpdateCheckResult } from '../shared/ipc-channels'
import { downloadMirrors, GitHubRelease, isNewerVersion, parseGitHubRelease } from './update-core'

const OWNER = 'xuxuyouxiu'
const REPO = 'Pupil'
const RELEASE_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const CHECK_TIMEOUT_MS = 10_000
/** 单个下载源（直连/镜像）的尝试超时；超时自动切下一个镜像 */
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 60_000
/** 并行探测下载源是否可达的时间窗口 */
const PROBE_TIMEOUT_MS = 5_000

/** HEAD 探测候选源可用性并测速；失败/超时返回 null */
async function probeSource(url: string): Promise<{ url: string; ms: number } | null> {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (!res.ok) return null
    return { url, ms: Date.now() - started }
  } catch {
    return null
  }
}

/**
 * 流式写入 + 背压（磁盘慢时暂停读网络），避免 88MB 全堆内存；失败清理 .downloading。
 * 返回所写字节的 sha256（hex）——供安装前与 GitHub 官方 digest 比对。
 */
async function downloadBinaryWithProgress(
  url: string,
  savePath: string,
  timeoutMs: number,
  onProgress: (pct: number) => void
): Promise<string> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const tmp = `${savePath}.downloading`
  const writer = createWriteStream(tmp)
  const hasher = createHash('sha256')
  const reader = res.body.getReader()
  let downloaded = 0
  let writerError: Error | null = null
  writer.on('error', (e: Error) => {
    writerError = e
  })

  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    hasher.update(chunk)
    if (writer.write(chunk)) return
    await new Promise<void>((resolve, reject) => {
      writer.once('drain', resolve)
      writer.once('error', reject)
    })
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await writeChunk(value)
      downloaded += value.length
      if (total > 0) onProgress(Math.min(99, Math.round((downloaded / total) * 100)))
    }
    await new Promise<void>((resolve, reject) => {
      if (writerError) {
        reject(writerError)
        return
      }
      writer.once('error', reject)
      writer.once('finish', resolve)
      writer.end()
    })
  } catch (e) {
    writer.destroy()
    await fsp.unlink(tmp).catch(() => undefined)
    throw e
  }
  await fsp.rm(savePath, { force: true }).catch(() => undefined)
  await fsp.rename(tmp, savePath)
  return hasher.digest('hex')
}

export class Updater {
  private result: UpdateCheckResult
  private checking = false
  private downloading = false
  /** check() 时记录的官方 sha256（"sha256:<hex>"），安装前校验用 */
  private assetDigest: string | undefined

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
      this.assetDigest = parsed.asset?.digest
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

  /** 下载最新安装包并打开（用户手动触发）；先并行探测最快源，再流式下到文件，校验通过才执行 */
  async downloadAndOpen(): Promise<UpdateCheckResult> {
    if (this.downloading) return this.result // 防连点重入：两条流写同一临时文件会互相覆盖
    if (this.result.status !== 'available' || !this.result.assetUrl) return this.result
    this.downloading = true
    try {
      return await this.doDownloadAndOpen()
    } finally {
      this.downloading = false
    }
  }

  private async doDownloadAndOpen(): Promise<UpdateCheckResult> {
    const assetUrl = this.result.assetUrl!
    const assetName = this.result.assetName ?? `Pupil-${this.result.latestVersion}.exe`
    const expectedSha256 = this.assetDigest?.replace(/^sha256:/i, '').toLowerCase()
    const dest = join(app.getPath('temp'), assetName)
    this.setResult({ ...this.result, status: 'downloading', progress: 0 })

    // 并行 HEAD 测速所有候选源，选最快可达的（避免直连卡 60s 才切镜像）
    const candidates = downloadMirrors(assetUrl)
    const probes = await Promise.all(candidates.map((url) => probeSource(url)))
    const reachable = probes
      .filter((p): p is { url: string; ms: number } => p !== null)
      .sort((a, b) => a.ms - b.ms)
    const ordered = [
      ...reachable.map((p) => p.url),
      ...candidates.filter((url) => !reachable.some((p) => p.url === url))
    ]

    for (const url of ordered) {
      try {
        const actualSha256 = await downloadBinaryWithProgress(
          url,
          dest,
          DOWNLOAD_ATTEMPT_TIMEOUT_MS,
          (pct) => this.setResult({ ...this.result, status: 'downloading', progress: pct })
        )
        // 官方 digest 校验：镜像链路可能被篡改/损坏，直接执行安装包等于任意代码执行。
        // 无 digest（旧 API 响应）时跳过校验但保留告警。
        if (expectedSha256 && actualSha256.toLowerCase() !== expectedSha256) {
          await fsp.rm(dest, { force: true }).catch(() => undefined)
          throw new Error(`sha256 mismatch: got ${actualSha256.slice(0, 16)}…`)
        }
        if (!expectedSha256) {
          console.warn('[updater] release has no digest field — skipped integrity verification')
        }
        this.setResult({ ...this.result, status: 'downloaded', progress: 100, assetUrl: undefined })
        // 打开安装器，用户按向导完成升级；安装后即可体验新版本
        await shell.openPath(dest)
        return this.result
      } catch (error) {
        console.warn('[updater] download failed, trying next:', url, error instanceof Error ? error.message : error)
      }
    }

    this.setResult({
      ...this.result,
      status: 'error',
      progress: undefined,
      error: '所有下载源均失败或校验不通过（可能是网络/代理问题），请手动打开发布页下载'
    })
    return this.result
  }

  private setResult(next: UpdateCheckResult): void {
    this.result = next
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
