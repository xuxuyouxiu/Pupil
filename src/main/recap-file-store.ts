/**
 * 回顾数据文件存储（v1.2.0）—— RecapStore 的文件实现
 * 目录：%APPDATA%/pupil/recap/YYYY-MM-DD.json（原子写；90 天保留由引擎 prune 驱动）
 */
import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from '../adapters/http-ingest/auth'
import { RecapDay, RecapStore } from '../core/recap'

const dir = (): string => path.join(dataDir(), 'recap')

const validDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d)

export class FileRecapStore implements RecapStore {
  load(date: string): RecapDay | null {
    if (!validDate(date)) return null
    try {
      const raw = fs.readFileSync(this.file(date), 'utf8')
      const day = JSON.parse(raw) as RecapDay
      if (day?.date !== date || !Array.isArray(day.cards)) return null
      return day
    } catch {
      return null
    }
  }

  save(day: RecapDay): void {
    if (!validDate(day.date)) return
    fs.mkdirSync(dir(), { recursive: true })
    const file = this.file(day.date)
    const tmp = `${file}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(day, null, 2))
      fs.renameSync(tmp, file)
    } catch {
      fs.writeFileSync(file, JSON.stringify(day, null, 2))
      fs.rmSync(tmp, { force: true })
    }
  }

  listDates(): string[] {
    try {
      return fs
        .readdirSync(dir())
        .filter((f) => f.endsWith('.json') && validDate(f.slice(0, -5)))
        .map((f) => f.slice(0, -5))
        .sort()
    } catch {
      return []
    }
  }

  drop(date: string): void {
    if (!validDate(date)) return
    try {
      fs.rmSync(this.file(date), { force: true })
    } catch {
      /* 忽略 */
    }
  }

  private file(date: string): string {
    return path.join(dir(), `${date}.json`)
  }
}
