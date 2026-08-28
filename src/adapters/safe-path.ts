/**
 * 目录内安全拼接（v0.9.0 安全加固）：路径相关静态扫描的规范解法。
 * base 目录 + 任意段拼接后，解析结果必须仍位于 base 内；
 * 段中含 `..`、绝对路径或盘符时返回 null，由调用方跳过。
 */
import * as path from 'path'

export function safeJoin(base: string, ...segs: string[]): string | null {
  const normBase = path.resolve(base)
  const resolved = path.resolve(normBase, ...segs)
  if (resolved !== normBase && !resolved.startsWith(normBase + path.sep)) return null
  return resolved
}
