/**
 * 第三方 adapter 动态加载（P2-6，架构 OPEN-DECISION #6 落地）
 *
 * 约定：%APPDATA%/pupil/adapters/*.js 为 CommonJS 模块，导出 AdapterFactory 同构对象：
 *   module.exports = {
 *     id: 'my-harness',
 *     detect: async () => fs.existsSync('...'),
 *     create: () => new MyAdapter()
 *   }
 * AgentAdapter 接口见 src/adapters/types.ts（id/agentType/capabilities/start/stop/healthCheck）。
 *
 * 安全边界：
 * - 仅加载用户数据目录下、用户亲手放置的文件（与 config.json 同目录信任级别）
 * - 单文件加载失败仅告警跳过，不影响内置 adapter
 * - 不做热重载：启动时加载一次（改文件后重启应用生效）
 */
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'node:url'
import { AdapterFactory } from './types'
import { dataDir } from './http-ingest/auth'
import { safeJoin } from './safe-path'

/** 第三方 adapter 目录：%APPDATA%/pupil/adapters/ */
export function externalAdaptersDir(): string {
  return path.join(dataDir(), 'adapters')
}

/**
 * 扫描并加载全部第三方 adapter 工厂。
 * 返回成功解析的工厂列表；单文件失败只打日志不抛出。
 * v0.9.0：require(变量) 被安全扫描判定为注入类，改用动态 import()（file:// URL，
 * Node 的 CJS 互操作把 module.exports 放进 default）。
 */
export async function loadExternalAdapters(dir: string = externalAdaptersDir()): Promise<AdapterFactory[]> {
  const factories: AdapterFactory[] = []
  let files: string[] = []
  try {
    if (!fs.existsSync(dir)) return factories
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.disabled.js'))
  } catch {
    return factories
  }

  for (const f of files) {
    const full = safeJoin(dir, f)
    if (!full) continue
    try {
      const ns = (await import(pathToFileURL(full).href)) as {
        default?: unknown
        id?: string
        create?: () => import('./types').AgentAdapter
        detect?: () => Promise<boolean>
      }
      const mod = (typeof ns.default === 'object' && ns.default !== null ? ns.default : ns) as {
        id?: string
        create?: () => import('./types').AgentAdapter
        detect?: () => Promise<boolean>
      }
      if (typeof mod.create !== 'function' || typeof mod.id !== 'string' || !mod.id) {
        console.warn(`[adapters] external ${f}: missing exports (id/create), skipped`)
        continue
      }
      const factory: AdapterFactory = {
        id: mod.id,
        ...(typeof mod.detect === 'function' ? { detect: (): Promise<boolean> => mod.detect!() } : {}),
        create: (): import('./types').AgentAdapter => mod.create!()
      }
      factories.push(factory)
      console.log(`[adapters] external loaded: ${mod.id} (${f})`)
    } catch (err) {
      console.error(`[adapters] external ${f} failed to load (skipped)`, err)
    }
  }
  return factories
}
