# Pupil 架构文档

> 版本：v1.1 | 状态：Phase 1 技术调研与选型结论 | 作者：首席架构师 高见远
> 面向：Windows 优先的开源桌面悬浮球工具，监控各类 AI Agent / Harness 后台任务

---

## 0. 摘要（选型结论先行）

| 决策项 | 结论 | 一句话理由 |
|--------|------|-----------|
| 桌面框架 | **Electron** | 本机无 Rust 编译链导致 Tauri 不可行（硬约束）；pywebview 透明窗口不支持 Windows（官方文档确认）；Electron 是唯一同时满足"工具链就绪 + 悬浮窗全特性 + 生态完整"的方案 |
| 前端 | React 19 + TypeScript + electron-vite | 社区主流，动画/UI 表现力强，AI 辅助生成代码生态最好 |
| SVG 图标库 | **lucide-react（锁定，全项目唯一图标来源）** | MIT 协议、纯 SVG、约 1500 个图标、tree-shaking 友好、风格统一无 emoji 依赖 |
| 数据接入 | 三通道组合：Hook 主动上报（主）+ 本地 HTTP 接收端点（自研扩展）+ 日志 tail（兜底） | 精确性与兼容性兼顾，全部归一化为统一事件模型 |
| 窗口跳转 | Win32 EnumWindows + SetForegroundWindow（koffi FFI 直调 user32.dll） | 灵动岛等实战项目验证过该路径，含 Alt 键模拟 workaround |
| 音效 | 渲染进程 HTML5 Audio + Electron Notification（Windows Toast） | 自定义音效、逐事件区分、静音开关均原生支持 |
| 持久化 | MVP 不引入数据库；配置用 JSON 文件，事件走内存环形缓冲 | 轻量目标优先，避免过度设计 |

核心可行性结论：**用户所需的全部功能（悬浮球、半透明、置顶、拖动、多会话监控、状态展示、音效提醒、系统通知、点击跳转窗口）在 Electron on Windows 上全部可行，无不可行项。** 已识别 2 个已知坑（Win10 透明残影、SetForegroundWindow 前台锁定）均有成熟 workaround。

---

## 1. 硬约束（决策前提，已本机验证）

| 编号 | 约束 | 验证结果 |
|------|------|---------|
| C1 | 开发机无 Rust 编译链（cargo/rustc 不存在，~/.cargo 不存在，~/.rustup 无 toolchain） | 已验证，Tauri 2 编译不可行 |
| C2 | 开发机无 .NET SDK（dotnet 不可用） | 已验证，WPF 排除 |
| C3 | 可用二进制：Node v22.22.2、npm 12.0.2、Python 3.13.14 | 已验证 |
| C4 | 目标平台 Windows 10/11 x64，MVP 不做 macOS/Linux（架构不设障碍） | 用户需求 |
| C5 | 轻量运行：低内存、不影响其他应用 | 用户需求，量化指标见第 9 节 |
| C6 | 开源分发 | 许可证选 MIT，依赖需全部兼容 |

> 注：C1 是可逆约束（用户可安装 Rust 工具链）。但按"开发机工具链可用性作为硬约束纳入决策"的要求，MVP 阶段 Tauri 判定为不可行，迁移路径见 OPEN-DECISIONS #1。

---

## 2. 桌面框架选型对比矩阵（课题 B）

| 维度 | Electron（选定） | Tauri 2.x | pywebview | PySide6 | WPF |
|------|------------------|-----------|-----------|---------|-----|
| 本机工具链可用性 | Node 22 + npm 就绪 | **无 Rust 编译链，阻断** | Python 3.13 就绪 | Python 3.13 就绪 | **无 .NET SDK，阻断** |
| 透明窗口（Windows） | 支持（transparent: true + frame: false；Win10 有残影坑，有 workaround） | 支持 | **官方明确不支持 Windows**（文档原话 "Not supported on Windows"，issue #1611 确认） | 支持（WA_TranslucentBackground） | 支持 |
| 置顶 / 跳过任务栏 | alwaysOnTop + skipTaskbar 原生支持 | alwaysOnTop + skipTaskbar 支持 | on_top 支持（仅 Windows） | WindowStaysOnTopHint 支持 | Topmost 支持 |
| 无边框 + 拖动 | frame: false + CSS -webkit-app-region: drag | decorations: false + data-tauri-drag-region | frameless + easy_drag | FramelessWindowHint + 手写拖动 | WindowStyle.None + 手写拖动 |
| 包体积 | 约 80-150 MB | 约 3-10 MB | 约 30-60 MB | 约 40-80 MB | 约 10-30 MB |
| 空闲内存 | 约 100-200 MB（多进程） | 约 30-80 MB | 约 60-100 MB | 约 60-120 MB | 约 30-80 MB |
| Windows Toast 通知 | Notification API 原生（Windows Toast） | 插件 tauri-plugin-notification | 无内建，需 win10toast 等 | 无原生，需 win32 API 封装 | 原生 |
| 全局快捷键 | globalShortcut 内建 | 插件支持 | 无 | 需 Qxt/第三方 | RegisterHotKey |
| 系统托盘 | Tray 内建 | 内建 | 无 | QSystemTrayIcon | HardcodedTray |
| 窗口枚举/激活生态 | node-window-manager、win-control、koffi（实战验证） | 需写 Rust | pywin32 | pywin32/ctypes | 原生 |
| 音效播放 | HTML5 Audio（零额外依赖） | 前端 Audio 同样可用 | 前端 Audio | QSoundEffect | System.Media |
| 自动更新 | electron-updater 成熟 | tauri-plugin-updater | 需自建 | 需自建 | Squirrel 等 |
| 开发效率（Node/Python/Rust 团队） | 高（纯 TS） | 中（需 Rust） | 中高（Python） | 中（Qt 学习成本） | 中（C#/XAML） |
| 开源社区生态 | 最成熟 | 快速增长 | 一般 | 成熟 | 一般 |

**决策：Electron。**

理由：
1. Tauri 被 C1 硬约束阻断；pywebview 被 Windows 透明不支持一票否决；WPF 被 C2 阻断；PySide6 可行但 UI 动画（球体脉冲、展开过渡）开发效率显著低于 Web 前端，且团队技能面偏 Node/Python。
2. 需求中的全部 OS 集成点（通知、快捷键、托盘、窗口激活、自启动）Electron 均有内建或成熟库覆盖，无一项需要自研 native 模块。
3. 内存劣势（对比 Tauri 约 +80 MB）通过第 9 节缓解措施控制；对一个开发机工具而言可接受。

已知坑（写入规格作为硬约束）：
- Win10 上 transparent 窗口可能出现蓝/黑色矩形残影（硬件加速与 DWM 合成冲突）：规避方案为 backgroundColor 设 '#00000000' + hasShadow: false + 必要时 app.disableHardwareAcceleration()，需在目标机实测。
- Electron 透明窗口的透明区域无法点击穿透（issue #1335）：悬浮球本身需要交互，不受影响；详情面板外围如需穿透，用 setIgnoreMouseEvents(true, { forward: true }) 配合 mouseenter/mouseleave 切换。

---

## 3. 监控数据接入层设计（课题 A）

### 3.1 数据源调研结论（均经联网查证或本机验证）

**Claude Code（本机已验证）**
- 会话日志：`C:\Users\<user>\.claude\projects\<转义后的cwd>\<session-uuid>.jsonl`，append-only。行结构含 type（user/assistant/queue-operation 等）、timestamp、sessionId、cwd、version、message.content、toolUseResult。本机实测存在且可读。
- Hooks 机制：`~/.claude/settings.json` 的 hooks 字段，31 个事件（SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、Notification、Stop、StopFailure、TaskCreated、TaskCompleted、SubagentStart/Stop、SessionEnd 等）。Hook 进程通过 stdin 收到 JSON：session_id、transcript_path、cwd、hook_event_name、tool_name、tool_input、tool_use_id、permission_mode。Windows 用 powershell.exe -NoProfile -ExecutionPolicy Bypass -File 调用（官方文档确认）。这是**最精确的接入通道**。
- Statusline 机制：settings.json 的 statusLine 字段，事件驱动 + refreshInterval 定时，stdin 收 session_id/model/workspace/context_window/cost/transcript_path。可作补充数据源（上下文用量、成本），MVP 不依赖。

**Codex（本机已安装并验证）**
- 经典 CLI：`~/.codex/sessions/YYYY/MM/DD/rollout-{ISO时间戳}-{uuid}.jsonl`，事件流格式：session_meta（id/cwd/cli_version）、event_msg（user_message/agent_message/task_started/task_complete/token_count）、response_item（message/function_call/function_call_output）、turn_context。
- 本机安装的是 OpenAI Codex 桌面版：状态存于 `~/.codex/state_5.sqlite`（threads、agent_jobs、agent_job_items 等表，本机实测可并发读取）。
- Adapter 策略：优先探测 rollout jsonl 目录；桌面版则轮询 sqlite（只读连接）。两路径同一 adapter 内做能力探测。

**Hermes Agent（Nous Research，已查证）**
- Windows 数据目录 `%LOCALAPPDATA%\hermes`，会话存于 SQLite（state.db，sessions/messages 表，WAL 模式支持并发只读）。另有 `hermes webhook` 子命令支持事件订阅（细节未完全查证，MVP 先用 sqlite 轮询）。

**dsh（DeepSeek Harness）及自研 Harness**
- 无公开的本地状态暴露规范，归类为"通用自研 harness 接入"，走通道 C（HTTP 接收端点 + 发送 CLI）。

### 3.2 三通道评估与推荐组合

| 通道 | 机制 | 优点 | 缺点 | 定位 |
|------|------|------|------|------|
| A. 日志/文件 tail | fs.watch + 增量读取 jsonl / 轮询 sqlite | 零配置零侵入，兼容一切有日志的 agent | 被动、有延迟、需推断状态、依赖日志格式稳定性（上游升级可能破坏） | 兜底 + 会话发现 |
| B. 原生 hook 主动上报 | Claude Code hooks 调 PowerShell 脚本 POST 到本地端点 | 精确、低延迟、语义明确（事件名即状态）、官方机制 | 仅 Claude Code（Codex 无 hooks）；需安装器写入 settings.json | 主通道（Claude Code） |
| C. 本地 HTTP 接收端点 | 常驻 127.0.0.1 HTTP server + 配套发送 CLI | 任何进程都能推事件（自研 harness、dsh、CI 脚本）；协议自控 | 需要对方主动集成 | 自研/通用扩展主通道 |

**推荐组合：B（Claude Code）+ C（自研 harness/dsh/任意工具）+ A（Codex/Hermes 及无 hook 场景兜底）。** 三通道产出统一归一化为同一事件模型（3.4），对上层完全透明。

### 3.3 Adapter 插件化架构

原则：**新增一个 Agent 类型 = 新增一个 adapter 目录文件 + 在 registry 注册一行，不改动任何上层代码。**

```typescript
// src/adapters/types.ts —— 所有 adapter 实现此接口
export interface AgentAdapter {
  readonly id: string;                 // 如 'claude-code-hooks'
  readonly agentType: AgentType;       // 'claude-code' | 'codex' | 'hermes' | 'custom'
  readonly capabilities: Capability[]; // ['lifecycle','tool-events','tokens','cost'] 子集
  start(emit: (e: AgentEvent) => void): Promise<void>;
  stop(): Promise<void>;
  /** 可选：报告健康状况，供 disconnected 推断 */
  healthCheck?(): Promise<AdapterHealth>;
}
```

MVP 内置 5 个 adapter：
1. `claude-code/hooks-adapter`：通道 B。接收 hook 上报（经通道 C 的 HTTP server 路由 `/ingest/claude-code`），含 hooks 自动安装器（写入/合并 settings.json，幂等，可卸载还原）。
2. `claude-code/log-adapter`：通道 A。tail projects 目录发现会话、恢复历史状态、为无 hook 场景兜底。
3. `codex/log-adapter`：通道 A。rollout jsonl 探测 + 桌面版 sqlite 只读轮询。
4. `hermes/sqlite-adapter`：通道 A。state.db 只读轮询。
5. `http-ingest`：通道 C 本体。通用端点 `/ingest/v1/event`，配套发送 CLI（`pupil send`，Node 脚本，零依赖可被任意 shell 调用）。

第三方扩展路径（MVP 后）：约定目录 `%APPDATA%/pupil/adapters/*.js` 动态加载——登记为 OPEN-DECISION #6，不进 MVP。

### 3.4 统一事件模型

```typescript
// src/shared/events.ts —— main 与 renderer 共享
export type AgentEventType =
  | 'session_started'    // 会话创建/被发现
  | 'session_ended'      // 会话结束
  | 'turn_started'       // 一轮任务开始（用户提交 prompt）
  | 'thinking'           // 模型推理中
  | 'tool_call_started'  // 工具调用开始（含工具名）
  | 'tool_call_finished' // 工具调用结束（含成功/失败）
  | 'turn_completed'     // 一轮回答完成（对话回答完成的关键事件）
  | 'waiting_input'      // 等待用户输入/权限确认
  | 'error'              // 报错（含错误信息）
  | 'heartbeat';         // 数据源心跳（供 timeout/disconnected 推断）

export interface AgentEvent {
  readonly source: string;        // adapter id
  readonly agentType: AgentType;
  readonly sessionId: string;     // 各源会话标识（归一化键：agentType + ':' + sessionId）
  readonly cwd?: string;
  readonly eventType: AgentEventType;
  readonly timestamp: number;     // 毫秒 epoch
  readonly payload?: {
    toolName?: string;            // tool_call_*
    errorMessage?: string;        // error
    modelName?: string;           // thinking
    pid?: number;                 // 上报方附带的进程号（用于窗口跳转）
    raw?: unknown;                // 原始行/事件，调试用
  };
}
```

各源事件映射表（示例，完整映射在 adapter 内实现）：

| 源事件 | 归一化事件 |
|--------|-----------|
| CC hook UserPromptSubmit | turn_started |
| CC hook PreToolUse | tool_call_started |
| CC hook PostToolUse / PostToolUseFailure | tool_call_finished |
| CC hook Notification（含"waiting for input"） | waiting_input |
| CC hook Stop / StopFailure | turn_completed / error |
| CC hook SessionStart / SessionEnd | session_started / session_ended |
| Codex event_msg task_started / task_complete | turn_started / turn_completed |
| Codex response_item function_call | tool_call_started |
| Hermes messages 表角色变化（轮询差分） | 相应事件 |

### 3.5 HTTP 接收端点契约（通道 C，v1）

仅绑定 127.0.0.1，端口默认 17734（占用则向上探测，实际端口写入 `%APPDATA%/pupil/endpoint.json` 供 CLI 发现）。POST JSON：

```
POST /ingest/v1/event
Authorization: Bearer <本地token，安装时生成，存 %APPDATA%/pupil/token>
{
  "agentType": "custom",
  "sessionId": "my-harness-job-42",
  "cwd": "D:/work/project",
  "eventType": "tool_call_started",   // 同 AgentEventType
  "payload": { "toolName": "deploy", "pid": 12345 }
}
响应：{ "code": 0, "data": { "accepted": true }, "message": "" }
错误码：400 参数非法 / 401 token 错误 / 429 超过限速
```

安全约束：仅回环地址、token 校验、事件速率限制（默认 100 事件/秒/会话）。

---

## 4. 会话状态机

每会话（agentType + sessionId）独立维护一个状态机。状态由事件驱动 + 推断器补充：

```
                         ┌────────────────────────────────────┐
                         v                                    │
 session_started ──> idle ──(turn_started)──> thinking ──(tool_call_started)──> tool_calling
                      ^                          │                        │(tool_call_finished)
                      │                          │<───────────────────────┘
                      │(turn_completed/           │
                      │ session_ended)            │(waiting_input 事件)
                      │                          v
                      └──────────────── waiting_input
                                                   │(turn_started)
                                                   └──────> thinking

 任意状态 + error 事件 ──> error（保留前态用于恢复显示）
 任意状态 ── 推断器：N 分钟无事件且非 idle ──> 标记 timeout（不改基础状态，叠加警示）
 任意状态 ── 推断器：数据源 healthCheck 失败 / 日志句柄失效 ──> disconnected
 timeout / disconnected 恢复：收到新事件即清除标记
```

```typescript
export type SessionState = 'idle' | 'thinking' | 'tool_calling' | 'waiting_input' | 'error';
export interface SessionFlags { timeout: boolean; disconnected: boolean }
export interface SessionView {   // 推送给 renderer 的完整视图
  key: string;                   // agentType + ':' + sessionId
  agentType: AgentType;
  sessionId: string;
  state: SessionState;
  flags: SessionFlags;
  cwd?: string;
  currentTool?: string;
  turnStartedAt?: number;        // 已运行时长 = now - turnStartedAt
  lastEventAt: number;
  title?: string;                // 展示名（目录名/任务名）
  pid?: number;
}
```

注意：**timeout 与 disconnected 是监控端推断的叠加标记，不是基础状态**——这是状态机设计的关键决策，避免推断逻辑污染事件驱动的主状态。

推断参数（可配置）：timeout 阈值默认 10 分钟；disconnected 判定默认 30 秒无心跳且 healthCheck 失败。

---

## 5. 进程与窗口架构

单 Electron 应用、两个 BrowserWindow、一个 Node 常驻监控内核：

```
┌──────────────────────────── Electron 主进程（Node）────────────────────────────┐
│                                                                                │
│  main/index.ts（仅装配）                                                       │
│   ├─ MonitoringCore                                                            │
│   │    ├─ AdapterRegistry ──> [CC-hooks, CC-log, Codex, Hermes, HTTP-ingest]   │
│   │    ├─ SessionRegistry（状态机实例池）                                       │
│   │    ├─ InferenceEngine（timeout / disconnected 心跳推断）                    │
│   │    └─ NotifyRulesEngine（事件 -> 提醒策略：颜色/音效/Toast/无）              │
│   ├─ HTTPServer（127.0.0.1:17734，通道 B/C 入口）                               │
│   ├─ WindowManager（球窗 + 面板窗生命周期）                                      │
│   ├─ Integrations: win32-window(激活) / sound / notifications / shortcuts      │
│   └─ Tray / auto-launch                                                        │
│                          │ IPC（contextBridge，SessionView 快照 + 事件流）      │
└──────────────────────────┼─────────────────────────────────────────────────────┘
                           v
   ┌─ 球窗口（BrowserWindow）──┐        ┌─ 面板窗口（BrowserWindow）─────────────┐
   │ transparent+frameless     │ 点击/  │ alwaysOnTop+skipTaskbar               │
   │ alwaysOnTop+skipTaskbar   │ 悬停   │ 展示全部会话列表：状态/工具/时长/        │
   │ 左侧默认位置，-webkit-app- │ 展开   │ 错误信息；点击行 -> 主进程激活对应窗口    │
   │ region: drag 拖动，位置持久 │──────> │ 多会话区分（agentType 图标 + 目录名）   │
   └───────────────────────────┘        └────────────────────────────────────────┘

外部事件源（全部汇入 MonitoringCore）：
  Claude Code --(hook 进程 POST 127.0.0.1)--> HTTPServer
  Codex / Hermes --(adapter 轮询/读取)--> AdapterRegistry
  自研 harness / dsh --(pupil send CLI)--> HTTPServer
```

窗口与进程要点：
- **球窗口**：约 56x56 px，transparent、frame: false、alwaysOnTop（'screen-saver' 级）、skipTaskbar、resizable: false。聚合显示：任意会话 thinking/tool_calling 时呼吸动画；timeout/error 时变色。拖动用 CSS drag region，位置写配置文件。
- **面板窗口**：由球窗口触发创建/销毁（或常驻隐藏，MVP 用创建/销毁更省内存），失焦自动隐藏。
- **常驻方式**：系统托盘 + 开机自启动（app.setLoginItemSettings）。关闭面板不退出；托盘菜单退出。
- **渲染节流**：球与面板通过 IPC 接收快照/增量，renderer 内 requestAnimationFrame 动画；后台时 backgroundThrottling 保持 false 仅对球窗开启（保证动画不冻结），面板窗可节流。
- 单实例锁（app.requestSingleInstanceLock），防止多开。

---

## 6. 目录结构规划

遵循代码组织规范：单文件不超过 300 行、入口只装配、按资源分包、纯逻辑与框架解耦（core/ 不依赖 electron，可独立单测）。

```
pupil/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── resources/
│   └── sounds/                      # 默认音效（wav，按事件命名）
│       ├── turn-completed.wav
│       ├── error.wav
│       ├── timeout.wav
│       └── waiting-input.wav
├── scripts/
│   └── pupil-send.mjs          # 通道 C 发送 CLI（零依赖，可被任意 shell 调用）
└── src/
    ├── main/                        # Electron 主进程（薄装配层）
    │   ├── index.ts                 # 仅装配，禁止业务逻辑
    │   ├── window-manager.ts        # 球窗/面板窗生命周期
    │   ├── tray.ts
    │   ├── shortcuts.ts             # globalShortcut 注册
    │   └── auto-launch.ts
    ├── core/                        # 纯逻辑，零 electron 依赖（可单测）
    │   ├── state-machine.ts         # 第 4 节状态机
    │   ├── session-registry.ts
    │   ├── events.ts                # 统一事件模型
    │   ├── inference.ts             # timeout/disconnected 推断
    │   └── notify-rules.ts          # 事件->提醒策略引擎
    ├── adapters/                    # 数据接入层（第 3 节）
    │   ├── types.ts                 # AgentAdapter 接口
    │   ├── registry.ts
    │   ├── claude-code/
    │   │   ├── hooks-adapter.ts
    │   │   ├── hook-payload-map.ts  # 源事件->归一化事件映射
    │   │   ├── log-adapter.ts
    │   │   └── hooks-installer.ts   # settings.json 幂等安装/卸载
    │   ├── codex/
    │   │   └── log-adapter.ts       # rollout jsonl + sqlite 双探测
    │   ├── hermes/
    │   │   └── sqlite-adapter.ts
    │   └── http-ingest/
    │       ├── server.ts            # 127.0.0.1 HTTP 端点
    │       └── auth.ts              # token 校验与限速
    ├── integrations/                # Windows 集成（主进程侧）
    │   ├── win32-window.ts          # EnumWindows/SetForegroundWindow（koffi）
    │   ├── sound.ts                 # 指挥 renderer 播放音效
    │   └── notifications.ts         # Electron Notification 封装
    ├── shared/                      # main 与 renderer 共享类型与常量
    │   ├── events.ts                # AgentEvent/SessionView（single source of truth）
    │   └── ipc-channels.ts
    └── renderer/
        ├── ball/                    # 悬浮球窗口入口
        │   ├── index.html
    │   ├── Ball.tsx             # 球体视觉（黑色球体 + 眼睛动画系统/外环状态色）
    │   ├── EyeSystem.tsx        # 精灵眼动画引擎（六态表情 + 瞳孔游移 + 眨眼循环）
    │   └── use-sessions.ts      # IPC 订阅 hook
        ├── panel/                   # 详情面板窗口入口
        │   ├── index.html
        │   ├── Panel.tsx            # 会话列表
        │   ├── SessionRow.tsx       # 单会话行（跳转按钮）
        │   └── Settings.tsx         # 音效/通知/adapter 开关
        └── shared/
            ├── icons.ts             # lucide-react 统一导出（唯一图标来源）
            └── ipc.ts               # preload 暴露的 API 封装
```

新增一个 Agent 接入的操作路径（验收标准）：复制任一 adapter 目录为实现模板，实现 AgentAdapter 接口，在 registry.ts 注册——其余代码零改动。

---

## 7. 关键实现方案（课题 C）

### 7.1 音效播放与通知

- 音效：renderer 中 new Audio(本地资源 URL) 播放。设置项：总开关（静音）、逐事件音效选择（自定义文件路径，支持 wav/mp3/ogg）、音量。不同事件绑定不同音效由 notify-rules 引擎驱动。
- 系统通知：Electron Notification（Windows 上为系统 Toast，跨应用可见）。Notification 构造传 silent: true（关闭系统提示音，避免与自定义音效叠加）。点击通知的 defaultAction 触发窗口跳转（同 7.2）。
- 音效文件在主进程校验存在性与大小（上限 2MB），路径由用户在设置面板选择。

### 7.2 点击跳转回对应工具窗口

Win32 路径（koffi FFI 调 user32.dll，均在主进程）：

1. **定位窗口**：优先按 PID（事件 payload.pid，由 hook 上报方附带）；无 PID 时按窗口标题匹配（EnumWindows + GetWindowText，匹配 cwd 的目录名或会话标题——Windows Terminal 标签标题通常含运行目录/命令名）。
2. **激活**：SetForegroundWindow(hwnd)。Windows 有前台锁定限制（进程非前台时调用可能只闪任务栏），标准 workaround：先 keybd_event 模拟一次 Alt 键按下再调用（灵动岛等多个项目实战验证）。
3. 若目标窗口最小化：先 ShowWindow(SW_RESTORE) 再激活。
4. 找不到窗口时的降级：Toast 提示"未找到会话对应窗口"。

SessionView.pid 的获取路径：Claude Code hook 的 PowerShell 脚本可用 Get-Process 或 $PID 链条获取宿主终端进程；通道 C 由发送方自带 payload.pid；通道 A（日志）无 PID，依赖标题匹配——此不确定性登记 OPEN-DECISION #2。

### 7.3 轻量化措施（针对约束 C5）

- 面板窗口按需创建、失焦销毁；常驻仅球窗 + 主进程。
- 日志 adapter 用 fs.watch + 增量读取（从上次 offset 续读），不做全文件轮询重读；大 jsonl 只解析新增行。
- sqlite adapter 只读连接 + 5 秒间隔轮询（仅活跃会话，空闲会话降频至 60 秒）。
- 事件日志内存环形缓冲（最近 1000 条/会话），不落盘。
- 验收指标：应用空闲（无活跃会话）时常驻内存（Private Bytes 口径，全进程合计）不超过 150 MB；活跃监控 5 会话时 CPU 平均占用不超过 2%。（v0.2.5 实测：Private Bytes 128 MB、空闲 CPU ~0.02%，均达标。注：原 WorkingSet 口径在 Electron 多进程下含跨进程共享页重复计入，不可比；合并渲染进程的 affinity 路线已在 Electron 33 证伪，见 PROGRESS 踩坑记录。）

---

## 8. 技术栈与版本锚定

| 依赖 | 版本锚定 | 用途 | 许可证 |
|------|---------|------|--------|
| Electron | 当前 stable 主线（43.x，以安装时 latest 为准，package-lock 锁死） | 桌面框架 | MIT |
| electron-vite | 4.x | 构建 | MIT |
| React | 19.x | renderer UI | MIT |
| TypeScript | 5.x | 语言 | Apache-2.0 |
| **lucide-react** | latest（锁 lockfile） | **唯一 SVG 图标库，全项目禁用其他图标来源与 emoji** | ISC |
| koffi | 2.x | Win32 FFI（user32.dll 直调） | MIT |
| electron-builder | 26.x | 打包 NSIS 安装器/便携版 | MIT |

显式排除：不引入数据库（SQLite 驱动）、不引入状态管理库（React 内建 + IPC 快照足够）、不引入 UI 组件库（自绘球体与面板，Tailwind 亦不引入，用 CSS Modules 控制体积）。

---

## 9. 风险与未决项登记册（OPEN-DECISIONS）

| # | 事项 | 类型 | 状态 | 说明与责任人建议 |
|---|------|------|------|------------------|
| 1 | Tauri 迁移路径 | 架构预留 | Open | 若未来安装 Rust 工具链且内存指标不达标，renderer（React）代码可整体复用迁移至 Tauri；adapter/core 为纯 TS 亦可复用。触发条件：内存指标（7.3）连续两个版本未达标 |
| 2 | Session 到窗口的映射策略 | 设计未决 | Partial（v0.2.3/v0.2.4） | MVP 实现 PID 优先 + 标题兜底 + 宿主应用名兜底（hermes/codex 单实例应用）；koffi 进程树追踪留待跳转准确率不达标时引入。轮询型源只能定位到宿主应用为已知边界 |
| 3 | Codex 桌面版 sqlite schema 无官方文档 | 数据源风险 | **Mitigated（v0.3.3）** | codex/hermes adapter 已加 schema 守卫：表缺失时优雅降级为不监控并告警一次，不再反复查询报错。上游每次升级后仍需人工回归字段语义 |
| 4 | Win10 透明窗口残影 | 平台已知坑 | Mitigated | 悬浮球保留透明（本机 Win10 实测无残影问题）；面板/设置窗口已改不透明以保 ClearType 文字渲染 |
| 5 | HTTP 端点安全边界 | 安全 | Mitigated（MVP） | 127.0.0.1 + Bearer token + 限速已实装；token 文件权限控制与防误配说明待 README 安全章节补充 |
| 6 | 第三方 adapter 动态加载 | 范围外 | **Resolved（v0.3.0）** | `%APPDATA%/pupil/adapters/*.js` CommonJS 约定落地：导出 id/create[/detect] 即自动加载进设置开关列表 |
| 7 | Hermes webhook 机制 | 数据源调研 | **Resolved（v0.3.0，结论：不采用）** | 本机实测 `hermes webhook` 是"外部事件触发 Agent 执行"入口，方向与 Pupil 需要的"Agent 内部状态外发"相反，且需启用 gateway 平台——维持 state.db 差分轮询 |
| 8 | 多显示器与 DPI 缩放 | 平台风险 | Open | 当前球位置按全局坐标持久化（Electron 自动处理 DPI 虚拟坐标）；拔掉显示器球可能落在屏外——右键托盘「重置悬浮球位置」可作为兜底（待实现） |
| 9 | 端口冲突与多用户场景 | 边界 | Mitigated | 默认端口占用时自动探测递增并写入 endpoint.json；多用户同机（远程桌面多会话）场景 MVP 不支持，README 声明 |
| 10 | 产品命名与品牌 | 范围外 | **Resolved** | 用户确认产品名为 **Pupil**（瞳孔——黑色球体即眼睛的瞳孔，双关 AI "学生"在学习）。已更新全部文档 |

---

## 10. 成本估算（供 PM 参考）

依据开发成本参考模型（桌面工具类 4-6 周 / 2-3 人月，AI 辅助整体提速 2-3 倍）：

| 模块 | 相对工作量 | 说明 |
|------|-----------|------|
| 脚手架 + 球窗口 + 拖动/置顶 | 小 | Electron 成熟路径 |
| 通道 B：hooks 上报 + 安装器 | 中 | 含 Windows PowerShell 脚本与幂等安装 |
| 通道 C：HTTP 端点 + CLI | 小 | |
| 通道 A：CC jsonl + Codex + Hermes 三个 adapter | 中大 | 日志解析与状态推断是主要工作量 |
| 状态机 + 推断 + 通知规则引擎 | 中 | 纯逻辑，可测性好 |
| 面板 UI + 设置 | 中 | |
| 窗口跳转集成 | 小 | koffi 路径已验证 |
| 打包分发 + 自启动 + 开机体验 | 小 | |

预计 MVP 总周期 3-5 周（单人 + AI 辅助），核心风险在通道 A 的三个日志 adapter（上游格式变更风险，见 OPEN-DECISIONS #3）。

---

## 11. 端到端验证步骤（本架构的验收闭环）

1. `npm run dev` 启动应用：球出现在屏幕左侧，半透明、置顶、可拖动，重启后位置保持。
2. 运行安装器接入 Claude Code hooks 后，启动一个 Claude Code 会话提交任务：球进入 thinking 动画；Claude 调用工具时球切 tool_calling 且面板显示工具名与运行时长。
3. Claude 完成回答：播放 turn-completed 音效 + 弹出系统 Toast；点击 Toast 或面板行，对应的终端窗口被带到前台。
4. 打开第二个 Claude Code 会话（不同目录）：面板出现两行会话且可区分；各自事件互不串扰。
5. 人为制造错误（断网触发 API 报错）：球变错误色 + error 音效。
6. 让任务静置超过 timeout 阈值：球标记 timeout 警示色并提示音。
7. `node scripts/pupil-send.mjs --event tool_call_started --session test-1 --pid <某窗口PID>`：面板出现 custom 会话；点击行跳转到该 PID 窗口。
8. 关闭面板与托盘退出：进程全部结束，无残留；任务管理器核对空闲内存（Private Bytes 口径）不超过 150 MB。
9. 卸载 hooks：settings.json 恢复原状（安装器做备份还原），Claude Code 正常运行不受影响。

---

## 附：本调研的证据索引

- 本机验证：`C:\Users\admin\.claude\projects\*\*.jsonl` 结构采样（2026-08-24）；`~/.cargo` 不存在、cargo/rustc/dotnet 不在 PATH；`~/.codex/state_5.sqlite` 可并发读取（threads/agent_jobs 表）。
- Claude Code hooks 官方文档（code.claude.com/docs/en/hooks）：31 个事件、stdin JSON 字段、Windows PowerShell 配置。
- Codex rollout 格式：HF 博客与多篇技术文章交叉验证（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl，session_meta/event_msg/response_item）。
- Hermes Agent：Nous Research 官方文档与社区指南（%LOCALAPPDATA%\hermes、state.db SQLite WAL、webhook 子命令）。
- pywebview 官方 API 文档（transparent "Not supported on Windows"）+ GitHub issue #1611。
- Tauri 2 官方 window API 文档（transparent/alwaysOnTop/skipTaskbar/decorations 均支持 Windows）+ SnapShelf 实战文章（Windows 透明置顶窗口工程坑）。
- Electron 官方文档（自定义窗口样式/BaseWindow：transparent、frame、alwaysOnTop、skipTaskbar、setIgnoreMouseEvents）+ 灵动岛实战（koffi Win32 集成、透明窗口 Win10 残影 workaround）。
- SetForegroundWindow 前台锁定限制与 Alt 键模拟 workaround：Win32 文档与社区实践。
