# Pupil 项目长期记忆

## 产品定位
- 产品名：Pupil（瞳孔）—— 开源多 Agent 桌面悬浮球监控工具，Windows 优先
- 双关：黑色球体 = 眼睛瞳孔；AI = 学生(pupil)在学习
- CLI 命令：`pupil send`
- 替代工作代号：AgentFloat / AgentPulse

## 关键设计决策
- 悬浮球形态：Grok 式黑色球体 + 两只动画眼睛（精灵人格）
- 外环保留：负责多会话并行展示（分段弧 + 状态色 + 动画）
- 眼睛表达最高优先级状态，自定义 SVG/CSS 实现（不用 Lucide 图标库）
- 六态系统：加载中/运行中/等待输入/完成/错误/超时/断连/空闲，每态有独特眼睛表情
- 技术栈：Electron + React 19 + TypeScript + electron-vite
- 图标库：lucide-react（面板/设置用，球体眼睛不用）
- 数据接入：Hook 主动上报（主）+ HTTP 接收端点（自研扩展）+ 日志 tail（兜底）
- 轻量目标：常驻内存 < 100MB，空闲 CPU < 1%

## Adapter 数据接入层（5 个内置 adapter 已全部实现）
- 通道 C `http-ingest`：127.0.0.1:17734 HTTP 端点 + `pupil send` CLI
- 通道 B `claude-code/hooks-adapter`：PowerShell 转发脚本 + settings.json 幂等安装（备份 .pupil.bak）+ `/ingest/claude-code` 路由
- 通道 A `claude-code/log-adapter`：tail ~/.claude/projects/*.jsonl
- 通道 A `codex/log-adapter`：state_5.sqlite threads 轮询（+ rollout jsonl 预留）
- 通道 A `hermes/sqlite-adapter`：state.db sessions/messages 差分轮询
- SQLite 访问用 koffi FFI 直调系统 winsqlite3.dll（Electron 33 内置 Node 20 无 node:sqlite，零新增依赖）；out 指针需 `_Out_` 限定符 + `[null]` 数组
- ⚠️ 生成的 PowerShell 脚本必须纯 ASCII + 写文件加 UTF-8 BOM，否则 Windows PowerShell 5.1 按 ANSI 误读中文破坏语法

## 本机开发环境运行要点
- 沙箱注入 `ELECTRON_RUN_AS_NODE=1`（检查变量"存在性"而非值）→ 本机跑 dev 必须彻底移除，用 bash 内建 `unset`：`unset ELECTRON_RUN_AS_NODE NODE_OPTIONS && npm run dev`（**勿用 `env -u`**：本沙箱会静默吞掉子进程全部 stdout）
- Chromium 进程沙箱在本环境初始化失败（GPU 进程连环崩溃）→ main 入口已内置 `app.commandLine.appendSwitch('no-sandbox')` + `disableHardwareAcceleration()`
- 新版 Electron（≥33）发行包不再含 resources/electron.asar（JS 编译进二进制），勿以此判断镜像损坏
- TaskStop 杀后台 npm 任务只会杀父进程，electron.exe 会变孤儿残留 → 用 PowerShell `Stop-Process -Name electron` 补刀

## 悬浮球交互（重要教训）
- `-webkit-app-region: drag` 在 Windows 上会吞掉所有鼠标事件 → hover/click/右键/双击全部失效。已改为 IPC 自定义拖动
- drag 最终实现：renderer 用 window 级 pointermove/up/cancel/blur 监听 + 传 screenX/Y 的 delta 给 main（win0+delta setPosition）。**勿用 setPointerCapture + main 侧 getCursorScreenPoint**——透明窗口上 pointerup 会丢失导致 dragState 卡住、球持续跟随鼠标漂移
- 球体可见度分层：空闲/断连 0.55（低调）、活跃态（运行/等待/完成/错误/超时/初始化）0.92、hover 1.0 实心（用 `:where()` 保证 hover 最高优先级）
- 超时状态环是橙色 #db6d28；"两根橙色线"实为超时环在浅色壁纸上半透明显现，非 bug
- 面板"失焦 300ms 关闭"（Raycast 式）；模拟点击测试用 SendInput（mouse_event 不可靠）
