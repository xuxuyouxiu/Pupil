/** 跨层复用的格式化工具 */

/** 下载速度展示：字节/秒 -> "1.2 MB/s" / "356 KB/s" / ""（未知或无效） */
export function formatSpeed(bps: number | undefined): string {
  if (!Number.isFinite(bps as number) || (bps as number) <= 0) return ''
  const b = bps as number
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(b / 1024))} KB/s`
}
