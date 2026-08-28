/**
 * Claude Code hooks 自动安装器（通道 B）
 * 对应架构文档 3.3 第 1 项：幂等写入/合并 ~/.claude/settings.json，可卸载还原。
 *
 * 安装内容：
 *   1. PowerShell 转发脚本 -> %APPDATA%/pupil/hooks/claude-code-hook.ps1
 *      （读 stdin 的 hook JSON，POST 到 http://127.0.0.1:<port>/ingest/claude-code）
 *   2. 在 settings.json 的 hooks 字段里为若干事件注册该命令（不覆盖既有 hooks）
 *   3. 首次安装前备份 settings.json 为 settings.json.pupil.bak，供卸载还原
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { dataDir } from '../http-ingest/auth'

/** 需要 hook 的事件名 -> matcher（工具类事件用 '*' 全匹配，非工具类为 null） */
const HOOK_EVENTS: Record<string, string | null> = {
  SessionStart: null,
  SessionEnd: null,
  UserPromptSubmit: null,
  PreToolUse: '*',
  PostToolUse: '*',
  PostToolUseFailure: '*',
  Notification: null,
  Stop: null,
  SubagentStart: null,
  SubagentStop: null
}

/** 我们脚本的识别标记（用于幂等去重与卸载定位） */
const SCRIPT_MARK = 'claude-code-hook.ps1'

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

function hookScriptPath(): string {
  return path.join(dataDir(), 'hooks', 'claude-code-hook.ps1')
}

/** 生成 settings.json 里使用的 hook 命令（powershell 调用转发脚本） */
export function buildHookCommand(): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${hookScriptPath()}"`
}

/** 生成 PowerShell 转发脚本内容（纯 ASCII，避免 PS 5.1 编码误读） */
function hookScriptContent(): string {
  return `# Claude Code hook -> Pupil forwarder (auto-generated, do not edit)
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }

try {
  $payload = $raw | ConvertFrom-Json
} catch { exit 0 }

# Best-effort: walk up to find the host terminal pid (first non powershell/cmd/conhost ancestor)
try {
  $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
  for ($i = 0; $i -lt 6 -and $cur; $i++) {
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)"
    if (-not $par) { break }
    if ($par.Name -notmatch 'powershell|pwsh|cmd|conhost') {
      $payload | Add-Member -NotePropertyName 'pid' -NotePropertyValue $par.ProcessId -Force
      break
    }
    $cur = $par
  }
} catch { }

$dir = Join-Path $env:APPDATA 'pupil'
try {
  $endpoint = Get-Content (Join-Path $dir 'endpoint.json') -Raw | ConvertFrom-Json
  $token = (Get-Content (Join-Path $dir 'token') -Raw).Trim()
} catch { exit 0 }

$body = $payload | ConvertTo-Json -Depth 8 -Compress
$url = "http://$($endpoint.host):$($endpoint.port)/ingest/claude-code"
try {
  $headers = @{ Authorization = "Bearer $token" }
  Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $headers -Body $body -TimeoutSec 3 | Out-Null
} catch { }
exit 0
`
}

/** 判断某条 hook 命令是否属于我们 */
function isOurs(hook: unknown): boolean {
  const cmd = (hook as { command?: string })?.command ?? ''
  return cmd.includes(SCRIPT_MARK)
}

export class HooksInstaller {
  /** 是否已安装（脚本存在且 settings.json 含我们的 hook） */
  isInstalled(): boolean {
    if (!fs.existsSync(hookScriptPath())) return false
    try {
      const cfg = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as {
        hooks?: Record<string, { hooks?: unknown[] }[]>
      }
      const hooks = cfg.hooks ?? {}
      return Object.values(hooks).some((list) =>
        Array.isArray(list) && list.some((m) => Array.isArray(m.hooks) && m.hooks.some(isOurs))
      )
    } catch {
      return false
    }
  }

  /** 安装：写脚本 + 合并 hooks（幂等） */
  install(command: string): boolean {
    try {
      // 1. 写脚本（UTF-8 BOM，确保 Windows PowerShell 5.1 正确识别编码）
      const scriptPath = hookScriptPath()
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '\ufeff' + hookScriptContent(), 'utf8')

      // 2. 备份原 settings.json（仅首次）
      const sp = settingsPath()
      const bak = sp + '.pupil.bak'
      if (fs.existsSync(sp) && !fs.existsSync(bak)) {
        fs.copyFileSync(sp, bak)
      }

      // 3. 合并 hooks
      let cfg: { hooks?: Record<string, unknown[]> } = {}
      if (fs.existsSync(sp)) {
        try {
          cfg = JSON.parse(fs.readFileSync(sp, 'utf8'))
        } catch {
          cfg = {}
        }
      }
      const hooks: Record<string, unknown[]> = { ...(cfg.hooks ?? {}) }

      for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
        const list = Array.isArray(hooks[event]) ? [...(hooks[event] as { hooks?: unknown[] }[])] : []
        // 移除旧的我们的 matcher-config（幂等）
        const filtered = list.filter((m) => !(Array.isArray(m.hooks) && m.hooks.some(isOurs)))
        const entry: { matcher?: string; hooks: unknown[] } = {
          hooks: [{ type: 'command', command }]
        }
        if (matcher) entry.matcher = matcher
        filtered.push(entry)
        hooks[event] = filtered
      }

      cfg.hooks = hooks
      fs.writeFileSync(sp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
      return true
    } catch (err) {
      console.error('[claude-code-hooks] install failed', err)
      return false
    }
  }

  /** 卸载：移除我们的 hooks + 删除脚本；若还原备份成功则恢复原状 */
  uninstall(): boolean {
    try {
      const sp = settingsPath()
      const bak = sp + '.pupil.bak'
      // 优先还原备份（若存在且未被用户改动）
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, sp)
        fs.rmSync(bak)
      } else if (fs.existsSync(sp)) {
        // 无备份：手动移除我们的 hooks
        const cfg = JSON.parse(fs.readFileSync(sp, 'utf8')) as { hooks?: Record<string, unknown[]> }
        if (cfg.hooks) {
          for (const [event, list] of Object.entries(cfg.hooks)) {
            if (!Array.isArray(list)) continue
            cfg.hooks[event] = list.filter(
              (m) => !(m && Array.isArray((m as { hooks?: unknown[] }).hooks) && (m as { hooks?: unknown[] }).hooks!.some(isOurs))
            )
          }
          fs.writeFileSync(sp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
        }
      }
      // 删除脚本
      if (fs.existsSync(hookScriptPath())) fs.rmSync(hookScriptPath())
      return true
    } catch (err) {
      console.error('[claude-code-hooks] uninstall failed', err)
      return false
    }
  }
}
