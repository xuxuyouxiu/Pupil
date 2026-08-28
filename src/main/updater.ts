/**
 * Updater —— v1.0.0：electron-updater 差量更新 + 双 provider 回退 + 全套韧性设施
 *
 * 结构（继承自 0.6.x~0.8.x 的全部教训）：
 * - 检查/下载改用 electron-updater：利用 blockmap 差量（88MB 新版只下变化块，通常几 MB）
 * - 双 provider：阿里云 CDN 固定目录（dl.xuxuya66.top/download/pupil，国内全速）
 *   优先，失败切 GitHub provider 兜底；两轮之外再叠「系统代理 → 直连」模式重试
 * - 代理预检快速失败（v0.8.4）；update-check.log 全程取证（v0.8.3）
 * - 安装走自研批处理（等 1s → taskkill 残留 → /S 静默 → 显式自启，v0.9.0），
 *   关闭 autoInstallOnAppQuit 避免双安装
 * - 完整性由 electron-updater 内建 sha512 校验（latest.yml），通道切换不降级
 */
import { app, Notification, shell } from 'electron'
import { writeFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import * as nodeNet from 'node:net'
import { autoUpdater, UpdateCheckResult as EuCheckResult } from 'electron-updater'
import { UpdateCheckResult } from '../shared/ipc-channels'
import { dataDir } from '../adapters/http-ingest/auth'
import { t } from '../shared/i18n'

const OWNER = 'xuxuyouxiu'
const REPO = 'Pupil'
const CHECK_TIMEOUT_MS = 10_000
/** CDN 固定目录：sync-release-oss.py 每次发版把 latest.yml/exe/blockmap 同步到这里 */
const CDN_FEED_URL = 'https://dl.xuxuya66.top/download/pupil'

/** 统一网络模式切换（跟随系统代理 / 强制直连） */
async function setNetworkMode(mode: 'system' | 'direct'): Promise<void> {
  try {
    const { session } = await import('electron')
    await session.defaultSession.setProxy(mode === 'direct' ? { mode: 'direct' } : { mode: 'system' })
  } catch {
    /* setProxy 失败不阻断 */
  }
}

/**
 * 代理预检：问 Chromium「本次会走哪个系统代理」，对端口做真实 TCP 连接测试。
 * 代理软件退出/重启中而系统开关残留时，直接切直连，省掉注定失败的轮次。
 */
async function proxyPreflight(log: string[]): Promise<'system' | 'direct'> {
  try {
    const { session } = await import('electron')
    const info = await Promise.race([
      session.defaultSession.resolveProxy('https://api.github.com/'),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('resolveProxy timeout')), 2000))
    ])
    const m = info.match(/(?:PROXY|HTTPS|SOCKS5?)\s+([^;\s]+)/i)
    if (!m) return 'system'
    const hostPort = m[1]
    const idx = hostPort.lastIndexOf(':')
    if (idx <= 0) return 'system'
    const host = hostPort.slice(0, idx)
    const port = Number(hostPort.slice(idx + 1))
    if (!Number.isFinite(port)) return 'system'

    const alive = await new Promise<boolean>((resolve) => {
      const s = nodeNet.createConnection({ host, port })
      s.setTimeout(1500, () => {
        s.destroy()
        resolve(false)
      })
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.once('error', () => resolve(false))
    })
    if (!alive) {
      log.push(`preflight: system proxy ${hostPort} unreachable -> force direct`)
      await setNetworkMode('direct')
      return 'direct'
    }
    log.push(`preflight: system proxy ${hostPort} alive`)
    return 'system'
  } catch {
    return 'system'
  }
}

export class Updater {
  private result: UpdateCheckResult
  private checking = false
  private downloading = false
  /** 待静默安装的安装包路径（will-quit 批处理拉起，见 consumePendingInstaller） */
  private pendingInstaller: string | null = null
  /** check 阶段记录的完整性基准（latest.yml sha512，下载失败时辅助取证） */
  private assetSha512: string | undefined
  private lastGhError = ''
  private lastCdnError = ''
  /** 已监听进度/下载事件（electron-updater 的 listener 只挂一次） */
  private wired = false
  /** downloadUpdate() 的 Promise（doDownloadAndOpen 等它拿安装包路径） */
  private downloadPromise: Promise<string[]> | null = null

  constructor() {
    this.result = { status: 'disabled', currentVersion: app.getVersion() }
  }

  get current(): UpdateCheckResult {
    return this.result
  }

  /** electron-updater 全局设置 + 事件接线（只做一次） */
  private wire(): void {
    if (this.wired) return
    this.wired = true
    autoUpdater.autoDownload = false // 下载由用户点击触发
    autoUpdater.autoInstallOnAppQuit = false // 安装由自研批处理接管（强杀+自启）
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = null
    autoUpdater.on('download-progress', (p) => {
      if (!this.downloading) return
      this.result = {
        ...this.result,
        status: 'downloading',
        progress: Math.min(99, Math.round(p.percent)),
        speedBps: p.bytesPerSecond > 0 ? p.bytesPerSecond : undefined
      }
    })
    autoUpdater.on('error', (e) => {
      console.warn('[updater] error event:', e?.message)
    })
  }

  /** 配置 provider 并检查；返回 electron-updater 的 UpdateInfo 结果或抛错 */
  private async checkWithProvider(
    provider: 'cdn' | 'github'
  ): Promise<{ version: string; sha512?: string; assetName?: string }> {
    if (provider === 'cdn') {
      autoUpdater.setFeedURL({ provider: 'generic', url: CDN_FEED_URL })
    } else {
      autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO })
    }
    const r = (await withTimeout(
      autoUpdater.checkForUpdates(),
      CHECK_TIMEOUT_MS,
      `${provider} check`
    )) as EuCheckResult | null
    const info = r?.updateInfo
    if (!info?.version) throw new Error('empty update info')
    const files = (info.files ?? []) as Array<{ url?: string }>
    const assetName = files.find((f) => f.url?.endsWith('.exe'))?.url
    return { version: info.version, sha512: (info as { sha512?: string }).sha512, assetName }
  }

  /** 检查更新。两轮模式：跟随系统代理（CDN→GitHub）全失败后切直连再来一轮；
   *  全过程写入 update-check.log 取证。 */
  async check(manual = false): Promise<UpdateCheckResult> {
    if (!app.isPackaged) {
      this.result = { status: 'dev', currentVersion: app.getVersion() }
      return this.result
    }
    if (this.checking) return this.result
    this.checking = true
    this.wire()
    const current = app.getVersion()
    const log: string[] = [`check v${current} manual=${manual}`]
    try {
      this.result = { status: 'checking', currentVersion: current }

      // ---- 代理预检：系统代理端口死了就直接走直连，不浪费轮次 ----
      const route = await proxyPreflight(log)
      let attempt = await this.runCheckChannels(current, manual, log)
      if (attempt) {
        log.push(`outcome=${attempt.status}${route === 'direct' ? ' (direct)' : ''}`)
        this.writeCheckLog(log)
        return attempt
      }

      // ---- 直连兜底：仅当第一轮确实走过系统代理时才值得重试 ----
      if (route === 'system') {
        log.push('pass2=direct-fallback')
        await setNetworkMode('direct')
        attempt = await this.runCheckChannels(current, manual, log)
        if (attempt) {
          log.push('outcome=' + attempt.status + ' (via direct)')
          this.writeCheckLog(log)
          return attempt
        }
      }

      const reason = this.lastChannelErrors()
      this.result = {
        status: 'error',
        currentVersion: current,
        error:
          route === 'direct'
            ? '检测到你的系统代理指向的端口没有响应，已自动改用直连但仍然失败——请检查本机网络连通性，或在代理软件中关闭 TUN/虚拟网卡模式后重试。详情见 %APPDATA%\\pupil\\update-check.log'
            : `系统代理与直连两轮尝试均失败（${reason}）。日志：%APPDATA%\\pupil\\update-check.log`
      }
      log.push(`outcome=error ${reason}`)
      this.writeCheckLog(log)
      return this.result
    } catch (error) {
      this.result = {
        status: 'error',
        currentVersion: app.getVersion(),
        error: error instanceof Error ? error.message : String(error)
      }
      log.push(`outcome=crash ${this.result.error}`)
      this.writeCheckLog(log)
      return this.result
    } finally {
      this.checking = false
    }
  }

  /** 两条 provider 通道（CDN → GitHub）。双双失败返回 null 并记录原因 */
  private async runCheckChannels(
    current: string,
    manual: boolean,
    log: string[]
  ): Promise<UpdateCheckResult | null> {
    let cdnError = ''
    try {
      const info = await this.checkWithProvider('cdn')
      log.push(`cdn-version=${info.version}`)
      if (!isNewer(info.version, current)) {
        return { status: 'not-available', currentVersion: current, latestVersion: info.version }
      }
      const assetName = info.assetName ?? `Pupil-${info.version}-x64.exe`
      this.result = {
        status: 'available',
        currentVersion: current,
        latestVersion: info.version,
        message: 'CDN 镜像通道',
        releaseUrl: `https://github.com/${OWNER}/${REPO}/releases/tag/v${info.version}`,
        assetUrl: `${CDN_FEED_URL}/${assetName}`,
        assetName
      }
      this.assetSha512 = info.sha512
      if (!manual) this.notifyAvailable()
      return this.result
    } catch (e) {
      cdnError = e instanceof Error ? e.message : String(e)
      log.push(`cdn-error=${cdnError.slice(0, 200)}`)
      console.warn('[updater] CDN channel failed:', cdnError)
    }

    try {
      const info = await this.checkWithProvider('github')
      log.push(`gh-version=${info.version}`)
      if (!isNewer(info.version, current)) {
        return { status: 'not-available', currentVersion: current, latestVersion: info.version }
      }
      const assetName = info.assetName ?? `Pupil-${info.version}-x64.exe`
      this.result = {
        status: 'available',
        currentVersion: current,
        latestVersion: info.version,
        releaseUrl: `https://github.com/${OWNER}/${REPO}/releases/tag/v${info.version}`,
        assetUrl: `https://github.com/${OWNER}/${REPO}/releases/download/v${info.version}/${assetName}`,
        assetName
      }
      this.assetSha512 = info.sha512
      if (!manual) this.notifyAvailable()
      return this.result
    } catch (e) {
      const ghError = e instanceof Error ? e.message : String(e)
      log.push(`gh-error=${ghError.slice(0, 200)}`)
      this.lastCdnError = cdnError
      this.lastGhError = ghError
      return null
    }
  }

  private lastChannelErrors(): string {
    return `CDN: ${this.lastCdnError || '未知'}; GitHub: ${this.lastGhError || '未知'}`
  }

  /** 追加一行检查日志到 %APPDATA%/pupil/update-check.log（超 128KB 直接重开），失败静默 */
  private writeCheckLog(lines: string[]): void {
    try {
      const file = join(dataDir(), 'update-check.log')
      let prev = ''
      try {
        if (statSync(file).size <= 128 * 1024) prev = readFileSync(file, 'utf8')
      } catch {
        /* 首次无文件 */
      }
      const sep = prev && !prev.endsWith('\n') ? '\n' : ''
      writeFileSync(
        file,
        `${prev}${sep}[${new Date().toISOString()}] ${lines.join(' | ')}\n`,
        'utf8'
      )
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 打开发布页（浏览器） */
  openReleasePage(): void {
    if (this.result.releaseUrl) void shell.openExternal(this.result.releaseUrl)
  }

  /** 用户点击「下载更新」：立即返回当前快照并后台开跑（渲染端轮询拿进度） */
  startDownload(): UpdateCheckResult {
    if (this.downloading) return this.result
    if (this.result.status !== 'available' || !this.result.assetUrl) return this.result
    void this.downloadAndOpen().catch((e) => console.warn('[updater] download crashed:', e))
    return this.result
  }

  /** 后台执行完整下载；electron-updater 内建 sha512 + blockmap 差量 */
  async downloadAndOpen(): Promise<UpdateCheckResult> {
    if (this.downloading) return this.result
    if (this.result.status !== 'available' || !this.result.assetUrl) return this.result
    this.downloading = true
    try {
      this.setResult({ ...this.result, status: 'downloading', progress: 0 })
      this.downloadPromise = autoUpdater.downloadUpdate()
      const paths = await this.downloadPromise
      const installerPath = paths?.[0]
      if (!installerPath) throw new Error('installer path missing after download')
      this.setResult({ ...this.result, status: 'downloaded', progress: 100, assetUrl: undefined })
      // 自研批处理安装（强杀残留 + 静默 + 显式自启）
      this.pendingInstaller = installerPath
      try {
        new Notification({
          title: 'Pupil 更新',
          body: `v${this.result.latestVersion} · ${t('notifVerified')}`
        }).show()
      } catch {
        /* 通知失败不阻断 */
      }
      setTimeout(() => app.quit(), 1200)
      return this.result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn('[updater] download failed:', msg)
      this.setResult({
        ...this.result,
        status: 'error',
        progress: undefined,
        error: `下载失败（${msg}）。完整性基准 ${this.assetSha512 ? 'sha512@latest.yml' : 'provider 内建'}。更新器已跟随系统代理；也可点下方按钮手动下载`
      })
      return this.result
    } finally {
      this.downloading = false
    }
  }

  /**
   * 主进程 will-quit 时调用：取走待静默安装的包路径并拉起安装。
   * 批处理时序（等 1s → taskkill 残留 → /S 静默 → 显式自启）由系统调度接管，
   * 不依赖本进程退出进度。spawn 失败回退打开向导。
   */
  consumePendingInstaller(): string | null {
    const installerPath = this.pendingInstaller
    this.pendingInstaller = null
    if (!installerPath) return null
    try {
      const bat = join(app.getPath('temp'), 'pupil-silent-install.cmd')
      // 1s 等本进程完全退出 → 强杀残留 → 静默安装 → 等 2s → 显式拉起新版。
      // 最后一行必须显式 start：NSIS /S 会跳过完成页，runAfterFinish 在静默模式下不生效
      writeFileSync(
        bat,
        [
          '@echo off',
          'timeout /t 1 /nobreak >nul',
          'taskkill /F /IM Pupil.exe >nul 2>&1',
          `start "" /wait "${installerPath}" /S`,
          'timeout /t 2 /nobreak >nul',
          `start "" "${join(process.env.LOCALAPPDATA ?? '', 'Programs', 'pupil', 'Pupil.exe')}"`
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
        title: `Pupil · ${t('foundNewVersion')}`,
        body: `v${this.result.latestVersion} · ${t('silentInstallHint')}`
      }).show()
    } catch {
      /* 通知失败不阻断 */
    }
  }
}

/** 硬超时 race：promise 挂死也能跳过（不取消底层，仅放弃等待） */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
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

/** 版本比较（语义化，忽略 prerelease 后缀；latest > current 才为 true） */
function isNewer(latest: string, current: string): boolean {
  const pa = String(latest ?? '')
    .replace(/^[vV]/, '')
    .trim()
    .match(/^\d+(?:\.\d+)*/)
  const pb = String(current ?? '')
    .replace(/^[vV]/, '')
    .trim()
    .match(/^\d+(?:\.\d+)*/)
  if (!pa || !pb) return false
  const a = pa[0].split('.').map(Number)
  const b = pb[0].split('.').map(Number)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0
    const vb = b[i] ?? 0
    if (va > vb) return true
    if (va < vb) return false
  }
  return false
}
