/**
 * 更新检查核心（纯函数，零 Electron 依赖，可单测）
 * —— GitHub Releases 最新版解析 / 版本比较 / 安装包挑选
 */
import { UpdateCheckResult, UpdateStatus } from '../shared/ipc-channels'

/** GitHub API assets 形状（只声明用到的字段） */
export interface UpdateAsset {
  name: string
  browser_download_url: string
}

/** GitHub Release 响应（只声明用到的字段） */
export interface GitHubRelease {
  tag_name?: string
  name?: string
  html_url?: string
  body?: string
  assets?: UpdateAsset[]
}

/** 去掉前置 v/V 的规范化版本号 */
export function normalizeVersion(version: string): string {
  return String(version ?? '').replace(/^[vV]/, '').trim()
}

/** 把版本号拆成可比较数字数组（忽略 prerelease 后缀） */
export function parseVersion(version: string): number[] {
  const normalized = normalizeVersion(version)
  const match = normalized.match(/^\d+(?:\.\d+)*/)
  if (!match) return []
  return match[0].split('.').map((part) => Number(part))
}

/** 语义化比较（忽略 prerelease）：a > b 返回 1，相等 0，a < b 返回 -1 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

/** 是否比当前版本更新 */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}

/**
 * 挑选安装包：
 * 1. 优先 NSIS 安装版（Pupil-x.y.z-x64.exe，排除 portable）
 * 2. 其次 portable 版（Pupil-x.y.z-portable.exe）
 * 3. 最后任意 .exe
 */
export function pickUpdateAsset(assets: UpdateAsset[] | undefined): UpdateAsset | undefined {
  if (!Array.isArray(assets) || assets.length === 0) return undefined
  const exes = assets.filter((a) => /^Pupil-.*\.exe$/i.test(a.name ?? '') || a.name?.toLowerCase().endsWith('.exe'))
  const installer = exes.find((a) => /-x64\.exe$/i.test(a.name) && !/-portable/i.test(a.name))
  if (installer) return installer
  const portable = exes.find((a) => /-portable\.exe$/i.test(a.name))
  if (portable) return portable
  return exes[0]
}

/** 解析 GitHub Release API 响应为可用摘要 */
export function parseGitHubRelease(release: GitHubRelease | null | undefined): {
  tagName: string
  latestVersion: string
  message: string
  htmlUrl?: string
  asset?: UpdateAsset
} {
  const tagName = release?.tag_name ?? ''
  const latestVersion = normalizeVersion(tagName)
  const message = release?.name || release?.body || ''
  return {
    tagName,
    latestVersion,
    message: message.slice(0, 200),
    htmlUrl: release?.html_url,
    asset: pickUpdateAsset(release?.assets)
  }
}

/**
 * GitHub 下载镜像回退链（国内直连 github.com 常慢/不通）：
 * 直连 -> ghfast.top -> gh-proxy.com -> mirror.ghproxy.com
 */
export function downloadMirrors(url: string): string[] {
  return [
    url,
    `https://ghfast.top/${url}`,
    `https://gh-proxy.com/${url}`,
    `https://mirror.ghproxy.com/${url}`
  ]
}

/** 组合成一个 UpdateCheckResult（不包含网络请求的副作用） */
export function buildUpdateResult(
  partial: Pick<UpdateCheckResult, 'currentVersion'> & Partial<UpdateCheckResult>
): UpdateCheckResult {
  const status: UpdateStatus = partial.status ?? 'disabled'
  return { status, currentVersion: partial.currentVersion } as UpdateCheckResult
}
