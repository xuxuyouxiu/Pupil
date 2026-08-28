/**
 * readUtf8Incremental 单元测试 —— 覆盖 UTF-8 多字节字符跨读取边界场景
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readUtf8Incremental } from '../src/adapters/incremental'

let tmpDir: string | null = null

function tmpFile(name: string): string {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pupil-incr-'))
  return path.join(tmpDir, name)
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

describe('readUtf8Incremental', () => {
  it('两段式写入中文行：第一段不会产出 U+FFFD，第二段拼出完整行', async () => {
    const p = tmpFile('a.jsonl')
    const full = Buffer.from('{"prompt":"你好世界"}\n', 'utf8')
    const haoStart = full.indexOf('好', 'utf8')

    // 第一段写到"好"字 3 字节的中间（已含前 2 字节）
    fs.writeFileSync(p, full.subarray(0, haoStart + 2))
    const r1 = readUtf8Incremental(p, 0)
    // 截断的"好"整字被回退，只保留到完整字符为止
    expect(r1.nextOffset).toBe(haoStart)
    expect(r1.text).toBe('{"prompt":"你')
    expect(r1.text).not.toContain('\uFFFD')

    // 写入剩余字节后，两段拼接还原完整行、无替换符
    fs.appendFileSync(p, full.subarray(haoStart + 2))
    const r2 = readUtf8Incremental(p, r1.nextOffset)
    expect(r1.text + r2.text).toBe(full.toString('utf8'))
    expect(r1.text + r2.text).not.toContain('\uFFFD')
  })

  it('纯 ASCII 输入不受影响，一次读完', () => {
    const p = tmpFile('b.jsonl')
    const content = '{"n":1}\n{"n":2}\n'
    fs.writeFileSync(p, content, 'ascii')
    const r = readUtf8Incremental(p, 0)
    expect(r.text).toBe(content)
    expect(r.nextOffset).toBe(Buffer.byteLength(content))
  })

  it('无新数据时返回空文本且 offset 不变', () => {
    const p = tmpFile('c.jsonl')
    fs.writeFileSync(p, 'hello\n')
    const size = fs.statSync(p).size
    const r = readUtf8Incremental(p, size)
    expect(r.text).toBe('')
    expect(r.nextOffset).toBe(size)
  })

  it('emoji（4 字节序列）跨边界同样安全', () => {
    const p = tmpFile('d.jsonl')
    const buf = Buffer.from('{"x":"任务完成🎉"}\n', 'utf8')
    const emojiStart = buf.indexOf('🎉', 'utf8')

    // 截在 4 字节 emoji 的第 2 个字节（此时引号和大括号还没写入）
    fs.writeFileSync(p, buf.subarray(0, emojiStart + 2))
    const r1 = readUtf8Incremental(p, 0)
    expect(r1.nextOffset).toBe(emojiStart)
    expect(r1.text).toBe('{"x":"任务完成')
    expect(r1.text).not.toContain('\uFFFD')

    fs.appendFileSync(p, buf.subarray(emojiStart + 2))
    const r2 = readUtf8Incremental(p, r1.nextOffset)
    expect(r1.text + r2.text).toBe(buf.toString('utf8'))
  })
})
