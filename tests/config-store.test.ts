/**
 * ConfigStore 单元测试 —— v0.9.0 原子写
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ConfigStore } from '../src/main/config'

let tmpDir: string | null = null
let file: string

function makeStore(): ConfigStore {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pupil-cfg-'))
  file = path.join(tmpDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  return new ConfigStore(file)
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

describe('ConfigStore 原子写', () => {
  it('set 后文件为合法 JSON 且不残留 .tmp', () => {
    const store = makeStore()
    store.set('dnd', true)
    const raw = fs.readFileSync(file, 'utf8')
    expect(JSON.parse(raw).dnd).toBe(true)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('多次 set 覆盖旧值（rename over existing 正常）', () => {
    const store = makeStore()
    store.set('soundVolume', 0.5)
    store.set('soundVolume', 0.9)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).soundVolume).toBe(0.9)
  })

  it('已有损坏文件时 load 回退默认值且可继续写入', () => {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pupil-cfg-'))
    file = path.join(tmpDir, 'broken.json')
    fs.writeFileSync(file, '{"dnd":tru') // 半截 JSON（模拟断电）
    const store = new ConfigStore(file)
    expect(store.get('dnd')).toBe(false)
    store.set('muted', true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).muted).toBe(true)
  })
})
