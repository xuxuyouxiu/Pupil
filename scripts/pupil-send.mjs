#!/usr/bin/env node
/**
 * pupil send —— 通道 C 发送 CLI（零依赖，Node 18+ 自带 fetch，可被任意 shell 调用）
 *
 * 用法示例：
 *   node scripts/pupil-send.mjs --event turn_started --session test-1 --cwd "D:/work/project"
 *   node scripts/pupil-send.mjs --event tool_call_started --session test-1 --tool-name deploy --pid 12345
 *   node scripts/pupil-send.mjs --event error --session test-1 --error "exit code 1"
 *   node scripts/pupil-send.mjs --event turn_completed --session test-1
 *
 * 自动从 %APPDATA%/pupil/endpoint.json 发现端口、token 做鉴权。
 */
import fs from 'node:fs'
import path from 'node:path'

const VALID_EVENTS = new Set([
  'session_started', 'session_ended', 'turn_started', 'thinking',
  'tool_call_started', 'tool_call_finished', 'turn_completed',
  'waiting_input', 'error', 'heartbeat'
])

function die(msg) {
  console.error(`pupil-send: ${msg}`)
  process.exit(1)
}

function dataDir() {
  const base = process.env.APPDATA || path.join(process.env.HOME || '.', '.config')
  return path.join(base, 'pupil')
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i++
    } else {
      args[key] = true
    }
  }
  return args
}

async function main() {
  const a = parseArgs(process.argv.slice(2))

  if (a.help || a.h) {
    console.log('pupil send --event <type> --session <id> [--agent-type custom] [--cwd <path>] [--tool-name <name>] [--pid <n>] [--error <msg>]')
    return
  }

  const eventType = a.event
  if (!eventType) die('missing --event')
  if (!VALID_EVENTS.has(eventType)) die(`invalid --event: ${eventType}`)
  const sessionId = a.session || a['session-id']
  if (!sessionId) die('missing --session')

  const dir = dataDir()
  const endpointFile = path.join(dir, 'endpoint.json')
  const tokenFile = path.join(dir, 'token')
  if (!fs.existsSync(endpointFile) || !fs.existsSync(tokenFile)) {
    die('Pupil 未运行或未初始化（找不到 endpoint.json / token）。请先启动 Pupil。')
  }

  const endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'))
  const token = fs.readFileSync(tokenFile, 'utf8').trim()

  const payload = {}
  if (a['tool-name']) payload.toolName = a['tool-name']
  if (a.pid) payload.pid = Number(a.pid)
  if (a.error) payload.errorMessage = a.error

  const body = {
    agentType: a['agent-type'] || 'custom',
    sessionId,
    eventType,
    payload
  }
  if (a.cwd) body.cwd = a.cwd

  const res = await fetch(`http://${endpoint.host}:${endpoint.port}/ingest/v1/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) die(`HTTP ${res.status}: ${text}`)
  console.log(`sent ${eventType} -> ${sessionId} (${endpoint.host}:${endpoint.port})`)
}

main().catch((err) => die(err.message))
