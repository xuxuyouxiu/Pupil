/** 跨层复用的格式化工具 */

/** 下载速度展示：字节/秒 -> "1.2 MB/s" / "356 KB/s" / ""（未知或无效） */
export function formatSpeed(bps: number | undefined): string {
  if (!Number.isFinite(bps as number) || (bps as number) <= 0) return ''
  const b = bps as number
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(b / 1024))} KB/s`
}

/**
 * v1.2.0 回顾系统：用户指令摘要清洗。
 * 首行 → 去引用行（> 开头）与首尾空白 → 截 120 字符加省略号；空内容返回 undefined。
 */
export function sanitizePrompt(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const firstLine = raw.split('\n').find((l) => l.trim().length > 0)
  if (!firstLine) return undefined
  const cleaned = firstLine.replace(/^>\s?/, '').trim()
  if (!cleaned) return undefined
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned
}

/** v1.2.0 回顾系统：路径 -> 文件名（跨平台分隔符）；非法输入返回 undefined */
export function basenameOf(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p) return undefined
  const seg = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return seg && seg.length > 0 ? seg : undefined
}

