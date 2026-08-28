# Pupil 适配器 SDK 指南（v1.0.0）

> 给想接入 Pupil 的自研 Harness / 脚本作者。三条通道按侵入度从低到高排列，
> 任选其一即可让悬浮球亮起来。

---

## 0. 事件模型（三条通道共用的契约）

```ts
interface AgentEvent {
  source: string            // adapter id（内置通道固定，自研可自定义）
  agentType: AgentType      // 'claude-code' | 'codex' | 'hermes' | 'dsh' | 'zcode' | 'custom'
  sessionId: string         // 会话唯一标识（同 agentType 内稳定即可）
  cwd?: string              // 工作目录（窗口跳转匹配 + 面板展示名），强烈建议携带
  eventType: AgentEventType
  timestamp: number         // 毫秒 epoch
  payload?: {
    toolName?: string       // tool_call_*
    errorMessage?: string   // error
    title?: string          // 真实会话标题（面板展示 + 窗口匹配）
    pid?: number            // 宿主进程号（精准窗口跳转）
    usage?: { inputTokens; outputTokens; cacheReadTokens?; cacheCreationTokens? }
  }
}

type AgentEventType =
  | 'session_started' | 'session_ended'
  | 'turn_started' | 'turn_completed'
  | 'thinking' | 'tool_call_started' | 'tool_call_finished'
  | 'waiting_input' | 'error' | 'heartbeat'
```

状态机要点：`turn_started` 开启一轮（重置本轮 token 计数）；`turn_completed` /
`session_ended` 收敛为完成/空闲；`error` 是吸收态，收到正向事件自动恢复。

---

## 通道 A：HTTP 接收端点（推荐，零侵入）

Pupil 启动即监听 `127.0.0.1:17734`（占用自动上探），token 与端口写在：
- `%APPDATA%/pupil/endpoint.json` — `{ host, port }`
- `%APPDATA%/pupil/token` — Bearer 令牌（权限 0600）

安装版自带 CLI（已注册 PATH）：

```bash
pupil send --event turn_started --session my-task --cwd "D:\myproject"
pupil send --event tool_call_started --session my-task --toolName Bash
pupil send --event turn_completed --session my-task
pupil send --event error --session my-task --message "boom"
pupil send --event waiting_input --session my-task
```

裸 HTTP 等价形式：

```bash
curl -X POST "http://127.0.0.1:17734/ingest/v1/event" \
  -H "Authorization: Bearer $(cat %APPDATA%/pupil/token)" \
  -H "Content-Type: application/json" \
  -d '{"agentType":"custom","sessionId":"my-task","cwd":"D:/myproject",
       "eventType":"turn_started","payload":{"title":"我的任务"}}'
```

约束：body ≤ 64KB；每会话限速 100 事件/秒；`eventType` 必须在枚举内。

## 通道 B：Claude Code Hooks（Claude 专属主通道）

设置面板一键安装/卸载（写 `~/.claude/settings.json`），无需手写。

## 通道 C：external adapter（第三方 JS 文件）

`%APPDATA%/pupil/adapters/*.js`（CommonJS，`.disabled.js` 结尾可停用）：

```js
module.exports = {
  id: 'my-tool',
  detect: async () => true,          // 数据源存在才返回 true
  create: () => ({
    id: 'my-tool',
    agentType: 'custom',
    capabilities: ['lifecycle', 'tool-events', 'tokens'],
    async start(emit) {
      // 轮询/读日志/tail 文件，把状态变化归一化后上报
      emit({ source: 'my-tool', agentType: 'custom', sessionId: 'main',
             eventType: 'turn_started', timestamp: Date.now(),
             payload: { usage: { inputTokens: 1200, outputTokens: 300 } } })
    },
    async stop() {}
  })
}
```

注意：文件以主进程权限执行，只放置自己写的或信任来源的脚本；改动后重启 Pupil 生效。

## 工具函数（内置适配器同款，可直接借鉴实现）

- `src/adapters/incremental.ts` — `readUtf8Incremental`：UTF-8 安全的文件增量 tail
- `src/adapters/safe-path.ts` — `safeJoin`：目录约束的路径拼接
- `src/core/digest.ts` / `src/core/notify-rules.ts` — 纯逻辑范例（注入时钟/可单测）

## 发版检查单（给内置 adapter 的贡献者）

1. 映射函数保持纯函数并导出（`map*Line / diff*Session`），配 `tests/*-map.test.ts`
2. 新增 `AgentType` 需同步：`shared/events.ts`、`http-ingest` 白名单、
   `SessionRow/EventHistory` 标签、`win32-window` 跳转关键词、`monitoring-core` 注册
3. 轮询型源：接入 `disconnectThresholdMsByAgent` 放宽误报；无权威完成信号时用
   静默启发式（参考 codex 3 分钟）
4. 更新 `ADAPTER_LABELS` 与设置面板文案
