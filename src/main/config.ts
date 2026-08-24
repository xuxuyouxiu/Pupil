/**
 * 简单 JSON 配置存储（%APPDATA%/pupil/config.json）
 * MVP 不引入数据库（架构文档决策），JSON 文件足够。
 */
import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from '../adapters/http-ingest/auth'

export interface AppConfig {
  /** 悬浮球窗口位置（屏幕坐标） */
  ballPosition?: { x: number; y: number }
  /** 勿扰模式 */
  dnd?: boolean
  /** 总静音 */
  muted?: boolean
  /** 开机自启（默认关闭） */
  autoLaunch?: boolean
  /** 时间推断参数（毫秒） */
  timeoutThresholdMs?: number
  disconnectThresholdMs?: number
  /** 用户禁用的 adapter id 列表 */
  disabledAdapters?: string[]
}

const DEFAULTS: AppConfig = {
  dnd: false,
  muted: false,
  autoLaunch: false
}

export class ConfigStore {
  private file: string
  private data: AppConfig

  constructor(file?: string) {
    this.file = file ?? path.join(dataDir(), 'config.json')
    this.data = this.load()
  }

  private load(): AppConfig {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      return { ...DEFAULTS, ...JSON.parse(raw) }
    } catch {
      return { ...DEFAULTS }
    }
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.data[key]
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.data[key] = value
    this.save()
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}
