/**
 * HTTP 接收端点认证与限速（通道 C）
 * - 仅回环地址（由 server 层强制绑定 127.0.0.1）
 * - Bearer token：首次运行生成，存 %APPDATA%/pupil/token
 * - 事件速率限制：默认 100 事件/秒/会话（超出返回 429）
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { DATA_DIR_NAME, EVENT_RATE_LIMIT_PER_SEC } from '../../shared/constants'

/** 读取数据目录（%APPDATA%/pupil），不存在则创建 */
export function dataDir(): string {
  const base = process.env.APPDATA ?? path.join(process.env.HOME ?? '.', '.config')
  const dir = path.join(base, DATA_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export class TokenManager {
  private token: string
  readonly tokenPath: string

  constructor(tokenPath?: string) {
    this.tokenPath = tokenPath ?? path.join(dataDir(), 'token')
    this.token = this.loadOrCreate()
  }

  private loadOrCreate(): string {
    try {
      const existing = fs.readFileSync(this.tokenPath, 'utf8').trim()
      if (existing) return existing
    } catch {
      /* 首次运行，生成新 token */
    }
    const token = randomBytes(24).toString('hex')
    fs.writeFileSync(this.tokenPath, token, { mode: 0o600 })
    return token
  }

  verify(authHeader: string | undefined): boolean {
    if (!authHeader) return false
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
    if (!m) return false
    // 常数时间比较，避免时序侧信道
    const a = Buffer.from(m[1])
    const b = Buffer.from(this.token)
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
  }

  get value(): string {
    return this.token
  }
}

/** 简单令牌桶限速（每会话） */
export class RateLimiter {
  private last = new Map<string, { count: number; resetAt: number }>()

  constructor(private perSec = EVENT_RATE_LIMIT_PER_SEC) {}

  allow(key: string, now = Date.now()): boolean {
    let entry = this.last.get(key)
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 1000 }
      this.last.set(key, entry)
    }
    entry.count++
    return entry.count <= this.perSec
  }

  /** 清理过期条目，防内存膨胀 */
  prune(now = Date.now()): void {
    for (const [k, v] of this.last) {
      if (now >= v.resetAt + 5000) this.last.delete(k)
    }
  }
}
