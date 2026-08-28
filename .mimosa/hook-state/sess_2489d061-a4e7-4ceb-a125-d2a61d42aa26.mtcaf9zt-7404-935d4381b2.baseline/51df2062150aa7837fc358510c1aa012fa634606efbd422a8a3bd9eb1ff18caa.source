/**
 * Claude Code hooks adapter —— 通道 B（主通道，最精确、低延迟）
 * 对应架构文档 3.3 第 1 项。
 *
 * 职责：启动时幂等安装 hooks（写入 PowerShell 转发脚本 + 合并 settings.json）。
 * 事件本身经 HTTP server 的 /ingest/claude-code 路由流入（见 http-ingest/server.ts），
 * 故本 adapter 不直接 emit；它负责"安装 + 健康检查"。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentAdapter, AdapterFactory, AdapterHealth } from '../types'
import { AgentType } from '../../shared/events'
import { HooksInstaller, buildHookCommand } from './hooks-installer'

const ID = 'claude-code-hooks'

function claudeSettingsDir(): string {
  return path.join(os.homedir(), '.claude')
}

export class ClaudeCodeHooksAdapter implements AgentAdapter {
  readonly id = ID
  readonly agentType: AgentType = 'claude-code'
  readonly capabilities = ['lifecycle', 'tool-events'] as const

  private installer = new HooksInstaller()

  async start(_emit: (e: import('../../shared/events').AgentEvent) => void): Promise<void> {
    // 幂等安装；事件经 HTTP 路由流入，不在此 emit
    const ok = this.installer.install(buildHookCommand())
    if (ok) {
      console.log('[claude-code-hooks] hooks installed (idempotent)')
    }
  }

  async stop(): Promise<void> {
    // 保留 hooks（卸载是用户显式动作，不随停止触发）
  }

  async healthCheck(): Promise<AdapterHealth> {
    return this.installer.isInstalled()
      ? { ok: true }
      : { ok: false, detail: 'hooks not installed' }
  }
}

export const claudeCodeHooksAdapterFactory: AdapterFactory = {
  id: ID,
  detect: async () => fs.existsSync(claudeSettingsDir()),
  create: () => new ClaudeCodeHooksAdapter()
}
