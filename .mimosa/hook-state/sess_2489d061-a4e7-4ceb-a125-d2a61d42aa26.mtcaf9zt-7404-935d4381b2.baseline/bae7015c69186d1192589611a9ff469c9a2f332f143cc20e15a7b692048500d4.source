/**
 * HistoryStore 文件实现（P2-8 事件历史持久化）
 * - 存 %APPDATA%/pupil/history.json：跨会话合并时间线条目（SessionHistoryItem[]）
 * - 上限 EVENT_RING_BUFFER_SIZE * 4 条（与内存投影一致），超出裁最旧
 * - 原子写：临时文件 + rename，防写入中途崩溃损坏
 */
import * as fs from 'fs'
import * as path from 'path'
import { SessionHistoryItem } from '../shared/events'
import { EVENT_RING_BUFFER_SIZE } from '../shared/constants'
import { dataDir } from '../adapters/http-ingest/auth'
import { HistoryStore } from '../core/session-registry'

const MAX_ITEMS = EVENT_RING_BUFFER_SIZE * 4

export class FileHistoryStore implements HistoryStore {
  private readonly file: string

  constructor(file?: string) {
    this.file = file ?? path.join(dataDir(), 'history.json')
  }

  load(): SessionHistoryItem[] | null {
    try {
      if (!fs.existsSync(this.file)) return null
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as SessionHistoryItem[]
      if (!Array.isArray(raw)) return null
      return raw.slice(-MAX_ITEMS)
    } catch {
      return null
    }
  }

  save(items: SessionHistoryItem[]): void {
    const trimmed = items.slice(-MAX_ITEMS)
    const tmp = this.file + '.tmp'
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(trimmed), 'utf8')
    fs.renameSync(tmp, this.file)
  }
}
