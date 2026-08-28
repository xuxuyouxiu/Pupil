/**
 * HTTP 接收端点本体（通道 C / 通道 B 入口）
 * 仅绑定 127.0.0.1；默认端口 17734，占用则向上探测；
 * 实际端口与 token 分别写入 %APPDATA%/pupil/endpoint.json 与 token，供 CLI 发现。
 *
 * POST /ingest/v1/event  (Authorization: Bearer <token>)
 * { agentType, sessionId, cwd?, eventType, payload? }
 * 200 -> { code: 0, data: { accepted: true }, message: "" }
 * 400 参数非法 / 401 token 错误 / 429 超过限速
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { AddressInfo } from 'net'
import { AgentAdapter } from '../types'
import { AgentEvent, AgentEventType, AgentType, sessionKey } from '../../shared/events'
import { HTTP_HOST, HTTP_PORT_DEFAULT } from '../../shared/constants'
import { RateLimiter, TokenManager, dataDir } from './auth'
import { mapClaudeCodeHook, ClaudeCodeHookPayload } from '../claude-code/hook-payload-map'

const VALID_EVENT_TYPES: AgentEventType[] = [
  'session_started',
  'session_ended',
  'turn_started',
  'thinking',
  'tool_call_started',
  'tool_call_finished',
  'turn_completed',
  'waiting_input',
  'error',
  'heartbeat'
]
const VALID_AGENT_TYPES: AgentType[] = ['claude-code', 'codex', 'hermes', 'dsh', 'zcode', 'custom']

interface IngestBody {
  agentType?: unknown
  sessionId?: unknown
  cwd?: unknown
  eventType?: unknown
  payload?: Record<string, unknown>
}

export class HttpIngestAdapter implements AgentAdapter {
  readonly id = 'http-ingest'
  readonly agentType: AgentType = 'custom'
  readonly capabilities = ['lifecycle', 'tool-events'] as const

  private server: http.Server | null = null
  private emit: ((e: AgentEvent) => void) | null = null
  private tokenMgr: TokenManager
  private limiter = new RateLimiter()
  private pruneTimer: NodeJS.Timeout | null = null
  actualPort = 0

  constructor(tokenPath?: string) {
    this.tokenMgr = new TokenManager(tokenPath)
  }

  async start(emit: (e: AgentEvent) => void): Promise<void> {
    this.emit = emit
    await this.listen()
    this.pruneTimer = setInterval(() => this.limiter.prune(), 60_000)
  }

  async stop(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()))
      this.server = null
    }
  }

  private async listen(): Promise<void> {
    let port = HTTP_PORT_DEFAULT
    let server: http.Server | null = null

    for (let attempt = 0; attempt < 20; attempt++) {
      server = http.createServer((req, res) => this.handle(req, res))
      try {
        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject)
          server!.listen(port, HTTP_HOST, () => resolve())
        })
        break
      } catch (err) {
        server = null
        port++ // 占用则向上探测
        if (port - HTTP_PORT_DEFAULT >= 20) {
          throw new Error(`HTTP ingest: no free port near ${HTTP_PORT_DEFAULT}`)
        }
      }
    }

    if (!server) throw new Error('HTTP ingest: failed to bind')
    this.server = server
    this.actualPort = (server.address() as AddressInfo).port
    this.writeEndpointFile()
    console.log(`[http-ingest] listening on http://${HTTP_HOST}:${this.actualPort}`)
  }

  /** 把实际端口写入 endpoint.json 供 pupil send CLI 发现 */
  private writeEndpointFile(): void {
    const file = path.join(dataDir(), 'endpoint.json')
    fs.writeFileSync(file, JSON.stringify({ host: HTTP_HOST, port: this.actualPort }, null, 2))
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 路由：POST /ingest/v1/event（通用通道 C）或 /ingest/claude-code（通道 B hook）
    if (req.method !== 'POST') {
      this.json(res, 404, { code: 404, data: null, message: 'not found' })
      return
    }
    const isHook = req.url === '/ingest/claude-code'
    if (req.url !== '/ingest/v1/event' && !isHook) {
      this.json(res, 404, { code: 404, data: null, message: 'not found' })
      return
    }
    if (!this.tokenMgr.isAuthorizedBearer(req.headers.authorization)) {
      this.json(res, 401, { code: 401, data: null, message: 'unauthorized' })
      return
    }

    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) {
        this.json(res, 400, { code: 400, data: null, message: 'body too large' })
        req.destroy()
      }
    })
    req.on('end', () => {
      let body: unknown
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        this.json(res, 400, { code: 400, data: null, message: 'invalid json' })
        return
      }
      if (isHook) {
        this.processHook(body as ClaudeCodeHookPayload, res)
      } else {
        this.process(body as IngestBody, res)
      }
    })
    req.on('error', () => {
      // 客户端中断/超限 destroy 后 socket 已废；json() 内部有幂等守卫，不会二次响应
      this.json(res, 400, { code: 400, data: null, message: 'bad request' })
    })
  }

  /** 通道 B：Claude Code hook 上报 -> 映射为归一化事件后直接 emit */
  private processHook(payload: ClaudeCodeHookPayload, res: http.ServerResponse): void {
    const events = mapClaudeCodeHook(payload)
    if (events.length === 0) {
      // 未映射（如无等待语义的 Notification）：接受但不产生事件
      this.json(res, 200, { code: 0, data: { accepted: true, events: 0 }, message: '' })
      return
    }
    for (const event of events) {
      // 限速（按会话）
      const key = sessionKey(event.agentType, event.sessionId)
      if (!this.limiter.allow(key)) {
        this.json(res, 429, { code: 429, data: null, message: 'rate limited' })
        return
      }
      this.emit?.(event)
    }
    this.json(res, 200, { code: 0, data: { accepted: true, events: events.length }, message: '' })
  }

  private process(body: IngestBody, res: http.ServerResponse): void {
    // 参数校验（畸形输入不崩溃）
    if (!VALID_AGENT_TYPES.includes(body.agentType as AgentType)) {
      this.json(res, 400, { code: 400, data: null, message: 'invalid agentType' })
      return
    }
    if (typeof body.sessionId !== 'string' || !body.sessionId) {
      this.json(res, 400, { code: 400, data: null, message: 'invalid sessionId' })
      return
    }
    if (!VALID_EVENT_TYPES.includes(body.eventType as AgentEventType)) {
      this.json(res, 400, { code: 400, data: null, message: 'invalid eventType' })
      return
    }
    if (body.cwd !== undefined && typeof body.cwd !== 'string') {
      this.json(res, 400, { code: 400, data: null, message: 'invalid cwd' })
      return
    }

    // 限速（按会话）
    const key = sessionKey(body.agentType as AgentType, body.sessionId)
    if (!this.limiter.allow(key)) {
      this.json(res, 429, { code: 429, data: null, message: 'rate limited' })
      return
    }

    const event: AgentEvent = {
      source: this.id,
      agentType: body.agentType as AgentType,
      sessionId: body.sessionId,
      cwd: body.cwd as string | undefined,
      eventType: body.eventType as AgentEventType,
      timestamp: Date.now(),
      payload: body.payload as AgentEvent['payload']
    }
    this.emit?.(event)
    this.json(res, 200, { code: 0, data: { accepted: true }, message: '' })
  }

  /**
   * 幂等安全写 JSON 响应。此前 error 回调在"已回写过 400 + req.destroy()"的连接上再次
   * writeHead 会同步抛 ERR_HTTP_HEADERS_SENT，把整个主进程带崩——
   * 该守卫覆盖全部路径（重复响应/已销毁/已结束），异常时销毁连接兜底。
   */
  private json(res: http.ServerResponse, status: number, obj: unknown): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return
    try {
      const text = JSON.stringify(obj)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text)
      })
      res.end(text)
    } catch {
      try {
        res.destroy()
      } catch {
        /* 已不可用 */
      }
    }
  }
}
