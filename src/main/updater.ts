/**
 * Updater —— GitHub Releases 更新检查/下载（无 electron-updater 依赖）
 *
 * 检查：GET github.com/<owner>/<repo>/releases/latest（公开仓库无需认证）
 * 下载：v0.6.2 起 —— 实测带宽选源 + 多线程分块并行 + 低速看门狗：
 *   1. 对每个候选源（直连 + 镜像）发一个 512KB 的 Range 探测请求，量出真实吞吐
 *      （此前按 HEAD 延迟选源，延迟低 ≠ 速度快），同时探测出该源是否支持 Range；
 *   2. 最快且支持 Range 的源用 6 个连接并行下载不同字节区间，直写文件对应偏移；
 *   3. 不支持 Range 的源回退单流下载；单流带看门狗——平均速度低于阈值即换源，
 *      替代旧的"60 秒硬超时整段重来"（白白丢掉已下的进度）。
 * 安装：sha256 与 GitHub release digest 比对通过后标记退出静默安装（NSIS /S）。
 * 说明：NSIS 安装版优先，portable 兜底；开发模式（非打包）不做网络检查。
 *
 * v0.7.1 网络栈更换：全部请求改走 Electron net.fetch（Chromium 网络栈）——
 * Node 全局 fetch 不认系统代理/PAC（用户挂 Clash 等代理时更新必失败，直连 GitHub 不通），
 * net.fetch 与系统代理行为一致，代理开启即自动生效；app 未就绪时兜底回退 Node fetch。
 */
import { app, Notification, net, shell } from 'electron'
import { createReadStream, promises as fsp, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { UpdateCheckResult } from '../shared/ipc-channels'
import {
  cdnAssetUrl,
  downloadMirrors,
  GitHubRelease,
  isNewerVersion,
  parseGitHubRelease,
  splitRanges
} from './update-core'

/** 统一网络入口：走 Chromium 栈（系统代理/PAC 生效）；app 未 ready 时回退 Node fetch */
function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (app.isReady()) return net.fetch(url, init)
  return fetch(url, init)
}

const OWNER = 'xuxuyouxiu'
const REPO = 'Pupil'
const RELEASE_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const CHECK_TIMEOUT_MS = 10_000
/** 单个下载源（直连/镜像）的尝试超时上限；远端完全无响应的兜底 */
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 120_000
/** 并行探测下载源是否可达的时间窗口 */
const PROBE_TIMEOUT_MS = 6_000
/** 实测带宽探测的字节数 */
const RANGE_PROBE_BYTES = 512 * 1024
/** 并行下载连接数 */
const PARALLEL_CHUNKS = 6
/** 每个分块连接的绝对超时兜底 */
const PER_CHUNK_TIMEOUT_MS = 180_000
/** 看门狗：单流模式平均速度低于该值视为该源太慢，换下一个源 */
const MIN_AVG_SPEED_BPS = 48 * 1024
/** 看门狗生效前给 TCP 慢启动的宽限时间 */
const SPEED_WATCHDOG_GRACE_MS = 15_000

/** 探测单个源：Range 小段真实下载测吞吐；失败返回 null */
async function scoreSource(url: string): Promise<{ url: string; bps: number; supportsRange: boolean } | null> {
  const started = Date.now()
  try {
    const res = await httpFetch(url, {
      method: 'GET',
      headers: { Range: `bytes=0-${RANGE_PROBE_BYTES - 1}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (!res.ok || !res.body) return null
    const supportsRange = res.status === 206
    const reader = res.body.getReader()
    let bytes = 0
    while (bytes < RANGE_PROBE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
    }
    // 已达探测字节数就掐断流：源可能忽略 Range 返回整包
    void reader.cancel().catch(() => undefined)
    const ms = Date.now() - started
    if (bytes === 0) return null
    return { url, bps: (bytes / Math.max(1, ms)) * 1000, supportsRange }
  } catch {
    return null
  }
}

/** HEAD 取安装包总大小；拿不到返回 0 */
async function headContentLength(url: string): Promise<number> {
  try {
    const res = await httpFetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    return Number(res.headers.get('content-length')) || 0
  } catch {
    return 0
  }
}

/**
 * 把 [start,end] 区间的响应体写到文件句柄指定偏移。
 * end=-1 表示不分块的完整流（不带 Range 头）；块模式下写完必须精确到位否则抛错。
 * v0.8.1 防挂死双保险：不依赖 net.fetch 对 AbortSignal 的支持程度——
 *   1) 整体硬超时 race（fetch 挂死也能跳到下一个源）；
 *   2) 读循环内 30s 无新数据判定卡死，主动 abort 并抛错换源。
 */
const STALL_TIMEOUT_MS = 30_000

function withHardTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

async function streamRangeIntoFile(
  url: string,
  fh: fsp.FileHandle,
  start: number,
  end: number,
  timeoutMs: number,
  onBytes: (n: number) => void
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let stallTimer: NodeJS.Timeout | undefined
  try {
    const headers: Record<string, string> = {}
    if (end >= 0) headers.Range = `bytes=${start}-${end}`
    const res = await withHardTimeout(
      httpFetch(url, { headers, redirect: 'follow', signal: controller.signal }),
      timeoutMs,
      'request'
    )
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    let pos = start
    const reader = res.body.getReader()
    while (true) {
      // 单次 read 超过 STALL_TIMEOUT_MS 无返回 => 判定卡死，掐断换源
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => {
          stallTimer = setTimeout(
            () => rej(new Error(`stalled: no data for ${STALL_TIMEOUT_MS / 1000}s`)),
            STALL_TIMEOUT_MS
          )
        })
      ]).finally(() => clearTimeout(stallTimer))
      if (done) break
      await fh.write(Buffer.from(value), 0, value.length, pos)
      pos += value.length
      onBytes(value.length)
    }
    if (end >= 0 && pos !== end + 1) {
      throw new Error(`chunk incomplete: wrote up to ${pos}, expected ${end + 1}`)
    }
  } finally {
    clearTimeout(timer)
    controller.abort() // 正常结束时为无害 no-op；挂死时确保底层连接被掐断
  }
}

/**
 * 单流 + 看门狗：平均速度低于阈值时抛错换源（宽限期后开始计时），
 * 比旧版"60 秒硬超时从零重下"更聪明——慢源不再浪费已下载的部分判断权。
 */
async function streamSingleWithWatchdog(
  url: string,
  fh: fsp.FileHandle,
  timeoutMs: number,
  onBytes: (n: number) => void
): Promise<void> {
  const started = Date.now()
  let received = 0
  const wrappedTick = (n: number): void => {
    received += n
    const elapsed = Date.now() - started
    if (
      elapsed > SPEED_WATCHDOG_GRACE_MS &&
      elapsed < timeoutMs &&
      received / elapsed < MIN_AVG_SPEED_BPS
    ) {
      throw new Error(`source too slow (${Math.round(received / elapsed / 1024)} KB/s avg)`)
    }
    onBytes(n)
  }
  await streamRangeIntoFile(url, fh, 0, -1, timeoutMs, wrappedTick)
}

/** 流式读取已落盘文件的 sha256 */
function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hasher = createHash('sha256')
    const rs = createReadStream(path)
    rs.on('data', (c) => hasher.update(c))
    rs.on('error', reject)
    rs.on('end', () => resolve(hasher.digest('hex')))
  })
}

/**
 * 分块并行下载到临时文件并返回 sha256（hex）：
 * 支持 Range 的源开 PARALLEL_CHUNKS 个连接各取一段、直写偏移；
 * 不支持或 HEAD 拿不到总大小时退回单流看门狗。任一块失败即整体失败换源。
 * 只写 tmpPath 不做落位——原子改名由调用方完成。
 */
async function downloadTo(
  url: string,
  tmpPath: string,
  opts: { supportsRange: boolean; total: number },
  onProgress: (received: number, elapsedMs: number) => void
): Promise<string> {
  const fh = await fsp.open(tmpPath, 'w')
  try {
    let received = 0
    const started = Date.now()
    const tick = (n: number): void => {
      received += n
      onProgress(received, Date.now() - started)
    }

    if (opts.supportsRange && opts.total > 0) {
      const ranges = splitRanges(opts.total, PARALLEL_CHUNKS)
      await Promise.all(
        ranges.map(([start, end]) =>
          streamRangeIntoFile(url, fh, start, end, PER_CHUNK_TIMEOUT_MS, tick)
        )
      )
    } else {
      await streamSingleWithWatchdog(url, fh, DOWNLOAD_ATTEMPT_TIMEOUT_MS, tick)
    }
  } finally {
    await fh.close().catch(() => undefined)
  }

  return sha256File(tmpPath)
}

export class Updater {
  private result: UpdateCheckResult
  private checking = false
  private downloading = false
  /** check() 时记录的官方 sha256（"sha256:<hex>"），安装前校验用 */
  private assetDigest: string | undefined
  /**
   * 待静默安装的安装包路径：下载校验完成后置位，由主进程 will-quit 拉起
   * NSIS /S 静默安装（electron-builder assisted 安装器支持，runAfterFinish 默认装完自启）。
   * 先退出再安装的原因：旧进程存活时静默安装会命中"关闭程序"确认，/S 下无法点击导致失败。
   */
  private pendingInstaller: string | null = null

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
      const res = await httpFetch(RELEASE_API, {
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

  /**
   * 用户点击「下载更新」：立即返回当前快照并后台开跑。
   * 此前 IPC 直接 await 整个下载流程（数分钟），渲染端拿到的 status 始终停留在
   * available，500ms 轮询永不启动——进度条自 v0.5.5 起从未真正显示过。
   * 现改为调用即返回 downloading 快照，渲染端靠既有轮询循环持续取进度；
   * 同步段（守卫 + setResult(downloading)）在返回前已执行完，无竞态。
   */
  startDownload(): UpdateCheckResult {
    if (this.downloading) return this.result
    if (this.result.status !== 'available' || !this.result.assetUrl) return this.result
    void this.downloadAndOpen().catch((e) => console.warn('[updater] download crashed:', e))
    return this.result
  }

  /** 后台执行完整下载；用户手动触发 */
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

    // 候选源：阿里云 CDN（PodMuse 同 bucket，国内全速）置顶 + 直连 + 三个镜像。
    // CDN 文件由发布流水线自动同步；尚未同步时探测 404 自然淘汰，不影响排序逻辑
    const mirrors = [
      cdnAssetUrl(this.result.latestVersion ?? '', assetName),
      ...downloadMirrors(assetUrl)
    ]
    const scores = await Promise.all(mirrors.map((u) => scoreSource(u)))
    const live = scores.filter((s): s is NonNullable<typeof s> => s !== null)
    const ranked = [...live].sort((a, b) => b.bps - a.bps)
    // 排序规则：支持 Range 的实测最快优先，其次不支持 Range 的（单流看门狗），探测全挂的按原始顺序垫底
    type ScoredSource = { url: string; bps: number; supportsRange: boolean }
    const ordered: ScoredSource[] = [
      ...ranked.filter((s) => s.supportsRange),
      ...ranked.filter((s) => !s.supportsRange),
      ...mirrors
        .filter((u) => !live.some((s) => s.url === u))
        .map((url) => ({ url, bps: 0, supportsRange: false }))
    ]
    console.log(
      '[updater] source ranking:',
      ranked.map((s) => `${new URL(s.url).host} ${(s.bps / 1024 / 1024).toFixed(2)} MB/s${s.supportsRange ? '' : ' (no-range)'}`).join(' | ')
    )

    this.setResult({ ...this.result, status: 'downloading', progress: 0 })

    let lastError = ''
    for (const cand of ordered) {
      try {
        const total = cand.supportsRange ? await headContentLength(cand.url) : 0
        const tmpPath = `${dest}.downloading`
        const sha = await downloadTo(cand.url, tmpPath, { supportsRange: cand.supportsRange, total }, (recv, elapsed) => {
          const pct = total > 0 ? Math.min(99, Math.round((recv / total) * 100)) : undefined
          this.setResult({
            ...this.result,
            status: 'downloading',
            ...(pct !== undefined ? { progress: pct } : {}),
            speedBps: elapsed > 500 ? recv / (elapsed / 1000) : undefined
          })
        })
        // 官方 digest 校验：镜像链路可能被篡改/损坏，直接执行安装包等于任意代码执行。
        // 无 digest（旧 API 响应）时跳过校验但保留告警。
        if (expectedSha256 && sha.toLowerCase() !== expectedSha256) {
          throw new Error(`sha256 mismatch: got ${sha.slice(0, 16)}…`)
        }
        if (!expectedSha256) {
          console.warn('[updater] release has no digest field — skipped integrity verification')
        }
        // 原子落位：tmp -> dest（校验通过后才替换旧文件）
        await fsp.rename(tmpPath, dest).catch(async () => {
          // Windows 上 dest 若被占用会 EPERM：删掉重试一次
          await fsp.rm(dest, { force: true })
          await fsp.rename(tmpPath, dest)
        })
        this.setResult({ ...this.result, status: 'downloaded', progress: 100, assetUrl: undefined })
        // 一键热更：不再打开安装向导，标记退出后自动静默安装并重启
        this.pendingInstaller = dest
        try {
          new Notification({
            title: 'Pupil 更新',
            body: `v${this.result.latestVersion} 校验通过，正在退出并自动安装，稍候自动重启…`
          }).show()
        } catch {
          /* 通知失败不阻断 */
        }
        setTimeout(() => app.quit(), 1200)
        return this.result
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        console.warn('[updater] download failed, trying next:', new URL(cand.url).host, lastError)
        await fsp.rm(`${dest}.downloading`, { force: true }).catch(() => undefined)
      }
    }

    this.setResult({
      ...this.result,
      status: 'error',
      progress: undefined,
      error: `全部 ${ordered.length} 个下载源均失败（末次原因：${lastError || '未知'}）。更新器已跟随系统代理——若你开了代理软件，请确认已开启「系统代理」模式后重试；或点下方按钮手动下载`
    })
    return this.result
  }

  /**
   * 主进程 will-quit 时调用：取走待静默安装的包路径并拉起安装。
   * v0.8.1 改为批处理时序（等 1s → taskkill 强杀残留 Pupil.exe → 静默安装 /S）：
   * 之前直接 spawn 安装器，旧进程尚未完全退出时 NSIS 静默模式会卡在"关闭程序"确认上
   * 无人点击 => 永远挂住（用户表现「后台没退软件更新就卡住」）。
   * 批处理由系统调度接管时序，不依赖本进程的退出进度。spawn 失败回退打开向导。
   */
  consumePendingInstaller(): string | null {
    const installerPath = this.pendingInstaller
    this.pendingInstaller = null
    if (!installerPath) return null
    try {
      const bat = join(app.getPath('temp'), 'pupil-silent-install.cmd')
      writeFileSync(
        bat,
        [
          '@echo off',
          'timeout /t 1 /nobreak >nul',
          'taskkill /F /IM Pupil.exe >nul 2>&1',
          `start "" "${installerPath}" /S`
        ].join('\r\n'),
        'utf8'
      )
      const child = spawn('cmd.exe', ['/d', '/c', bat], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()
    } catch {
      void shell.openPath(installerPath)
    }
    return installerPath
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
