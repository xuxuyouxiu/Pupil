/**
 * 日志文件增量读取工具 —— jsonl tail 共用
 * 解决按字节分块 + UTF-8 的经典坑：多字节字符（中文 prompt 高频）恰好横跨两次读取边界时，
 * 直接 toString('utf8') 会把前半截变成 U+FFFD 污染整行，JSON.parse 失败后事件被静默丢弃。
 * 做法：每次只解码"确定完整"的字节段，末尾不完整的字符序列留在文件里等下次读到。
 */
import * as fs from 'fs'

export interface IncrementalRead {
  /** 新增的、保证无截断字符的文本 */
  text: string
  /** 下次读取应从该字节偏移开始（小于等于当前文件大小） */
  nextOffset: number
}

export function readUtf8Incremental(filePath: string, offset: number): IncrementalRead {
  const size = fs.statSync(filePath).size
  if (size <= offset) return { text: '', nextOffset: offset }
  const buf = Buffer.alloc(size - offset)
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.readSync(fd, buf, 0, buf.length, offset)
  } finally {
    fs.closeSync(fd)
  }
  const cut = completeByteLength(buf)
  return { text: buf.toString('utf8', 0, cut), nextOffset: offset + cut }
}

/** 返回 buf 中"确保完整"的前缀字节数：末尾若是被截断的多字节序列起始段则切掉 */
function completeByteLength(buf: Buffer): number {
  const n = buf.length
  const scan = Math.min(4, n)
  let lead = -1
  for (let i = n - 1; i >= n - scan; i--) {
    if ((buf[i] & 0xc0) !== 0x80) {
      lead = i
      break
    }
  }
  if (lead === -1) return n // 连续 4 个续字节属异常编码，交给上层容错
  const b = buf[lead]
  const need = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4
  return n - lead >= need ? n : lead
}
