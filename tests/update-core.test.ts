/**
 * 更新核心纯函数单测（版本比较 / 安装包挑选 / Release 解析）
 */
import { describe, it, expect } from 'vitest'
import {
  compareVersions,
  isNewerVersion,
  normalizeVersion,
  parseGitHubRelease,
  pickUpdateAsset
} from '../src/main/update-core'

describe('compareVersions', () => {
  it('常规语义化比较', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
  })

  it('支持 v 前缀与缺省段（0 补齐）', () => {
    expect(normalizeVersion('v0.5.3')).toBe('0.5.3')
    expect(compareVersions('v0.5', '0.5.0')).toBe(0)
    expect(compareVersions('2', '1.9.9')).toBe(1)
  })

  it('忽略 prerelease 后缀', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0)
  })
})

describe('isNewerVersion', () => {
  it('只在最新版本大于当前版本时返回 true', () => {
    expect(isNewerVersion('0.5.3', '0.5.2')).toBe(true)
    expect(isNewerVersion('0.5.2', '0.5.2')).toBe(false)
    expect(isNewerVersion('0.5.1', '0.5.2')).toBe(false)
  })
})

describe('pickUpdateAsset', () => {
  const assets = [
    { name: 'Pupil-0.5.3-portable.exe', browser_download_url: 'https://x/p' },
    { name: 'Pupil-0.5.3-x64.exe', browser_download_url: 'https://x/i' },
    { name: 'latest.yml', browser_download_url: 'https://x/yml' }
  ]

  it('优先 NSIS 安装版，其次 portable', () => {
    expect(pickUpdateAsset(assets)?.name).toBe('Pupil-0.5.3-x64.exe')
    expect(pickUpdateAsset([assets[0]])?.name).toBe('Pupil-0.5.3-portable.exe')
  })

  it('没有 .exe 或空列表时返回 undefined', () => {
    expect(pickUpdateAsset([{ name: 'latest.yml', browser_download_url: 'x' }])).toBeUndefined()
    expect(pickUpdateAsset([])).toBeUndefined()
    expect(pickUpdateAsset(undefined)).toBeUndefined()
  })
})

describe('parseGitHubRelease', () => {
  it('提取 tag/版本/发布页/安装包', () => {
    const parsed = parseGitHubRelease({
      tag_name: 'v0.5.3',
      name: 'Pupil 0.5.3',
      html_url: 'https://github.com/xuxuyouxiu/Pupil/releases/tag/v0.5.3',
      assets: [{ name: 'Pupil-0.5.3-x64.exe', browser_download_url: 'https://x/i' }]
    })
    expect(parsed.latestVersion).toBe('0.5.3')
    expect(parsed.htmlUrl).toContain('v0.5.3')
    expect(parsed.asset?.name).toBe('Pupil-0.5.3-x64.exe')
  })

  it('缺失/空响应不抛错', () => {
    const parsed = parseGitHubRelease(undefined)
    expect(parsed.latestVersion).toBe('')
    expect(parsed.asset).toBeUndefined()
  })
})
