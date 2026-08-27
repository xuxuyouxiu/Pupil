# Pupil 项目进度记录

> 最后更新：2026-08-27（v0.8.4）
> 本文档记录 Pupil（开源多 Agent 桌面悬浮球监控工具）的开发进度、已完成功能与待办事项，作为团队协作与后续迭代的单一事实来源。设计决策详见 `docs/architecture.md`、需求详见 `docs/PRD.md`、UI 规范详见 `docs/uiux.md`、变更明细见 `CHANGELOG.md`。

---

## 一、项目概述

- **产品名**：Pupil（瞳孔）—— 黑色球体 = 眼睛瞳孔；AI = 学生（pupil）在学习
- **定位**：开源多 Agent 桌面悬浮球监控工具，Windows 优先
- **技术栈**：Electron 33 + React 19 + TypeScript + electron-vite 2.3
- **CLI 命令**：`pupil send`（向悬浮球上报事件）
- **轻量目标**：常驻内存 Private Bytes < 150MB（v0.2.5 实测 128MB 达标），空闲 CPU < 1%（实测 ~0.02%）
- **数据接入三通道**：Hook 主动上报（主）+ 本地 HTTP 接收端点（自研扩展）+ 日志 tail（兜底）

---

## 二、总体进度

| 模块 | 状态 | 说明 |
|------|------|------|
| 应用骨架（Electron + React + TS） | ✅ 完成 | 主进程/渲染层/preload 三层 + 打包管线 |
| 悬浮球（球体 + 精灵眼 + 状态环） | ✅ 完成 | 六态表情 + 动画 + 自定义拖动 |
| 详情面板（会话列表） | ✅ 完成 | 顶栏汇总 + 会话行 + 跳转窗口 |
| 设置面板 | ✅ 完成 | 独立设置窗口（v0.3.0），面板内视图保留兼容 |
| 数据接入层（6 个 adapter） | ✅ 完成 | 通道 A/B/C 全部落地；Codex 补齐 rollout jsonl tail；DSH Web API 轮询（v0.5.3）；第三方动态加载（v0.3.0） |
| 核心逻辑（状态机/推断/通知规则） | ✅ 完成 | 纯函数，无 Electron 依赖；46 个单元测试全绿 |
| 通知系统（音效 + Toast） | ✅ 完成 | Web Audio 合成音效 + 系统通知；4 套音色包 + 音量可调（v0.2.5） |
| 更新检查（GitHub Releases） | ✅ 完成（v0.5.3） | 启动自动检查 + 设置面板手动检查/下载安装包 |
| 窗口激活（跳转会话窗口） | ✅ 完成 | koffi FFI 直调 user32；v0.2.3/24 重写修复回调绑定失效 + 历史行跳转（v0.3.0） |
| 系统托盘 | ✅ 完成 | 菜单 + 勿扰切换 |
| 事件历史页签 | ✅ 完成（v0.2.0） | 跨会话时间线 + 持久化重启不丢 + 行点击跳转（v0.3.0） |
| 开机自启（autoLaunch） | ✅ 完成（v0.2.0） | setLoginItemSettings + 设置开关；dev 只存偏好 |
| 打包（electron-builder） | ✅ 完成（v0.2.0） | NSIS + portable x64 产出验证通过；`npm run dist` |
| CLI 随应用分发 | ✅ 完成 | resources/cli/ + pupil.cmd shim + 用户 PATH 注册修复（v0.3.1） |
| 单元测试 | ✅ 完成（持续补充） | vitest，46 用例：状态机/推断/规则/映射/持久化 |
| git 版本管理 | ✅ 完成（v0.2.0） | 仓库已初始化（main 分支），基线 + 功能提交 |
| 性能指标验证 | ✅ 达标（v0.2.5） | CPU ~0.02% / 内存 PrivateBytes 128MB，口径 <150MB 见性能基线 |
| 内存优化（BrowserView 改造） | ⬜ 挂起评估 | affinity 路线已证伪；指标达标后降级为可选优化 |

---

## 三、已完成功能明细

### 3.1 应用骨架
- Electron 33.4.11 + React 19 + TypeScript + electron-vite 2.3
- 目录分层：`src/main`（主进程）、`src/preload`、`src/renderer`（ball/panel）、`src/core`（纯逻辑）、`src/adapters`（数据接入）、`src/integrations`（Win32 集成）、`src/shared`（三端共享类型/常量）
- 单实例锁、悬浮球/面板双窗口、托盘、配置存储（`%APPDATA%/pupil/config.json`）

### 3.2 悬浮球
- 形态：Grok 式黑色球体 + 两只自定义 SVG/CSS 精灵眼（不用图标库）
- 六态系统：加载中/运行中/等待输入/完成/错误/超时/断连/空闲，每态有独特眼睛表情与动画
- v0.4.2 起对齐 bloub 逐帧测量值：running=三点弹跳加载、error=斜体感叹号、offline=睡眠弹跳点
- v0.5.0 宠物互动：长按摸头（眯眼+脸红+呼噜+爱心眼升级）、三连点戳晕（晕圈眼）、done 星星眼✦；手势仲裁器统一裁决四类左键手势
- v0.5.0 状态播报气泡：完成/等待/出错时球顶冒泡（窗口上扩 20px 气泡带，零新进程）；实测发现气泡顶部超出窗口 9px 文字被裁 → 定位改顶部 y=4px、横向 padding 收窄至 5px，三种文案均完整显示（v0.4.x 无气泡，无回归）
- v0.5.0 回合完成判定修正：按 tool_calls 字段判定（assistant 无工具调用=回合结束，stop/NULL 皆可），替代 finish_reason==='stop'——修复截断回合（迭代上限等）完成事件缺失、球卡思考态的问题；启动恢复逻辑同步（最后消息无工具调用→idle）
- 自定义拖动（IPC + window 级 pointer 监听，替代 `-webkit-app-region: drag`）

### 3.3 详情面板
- 顶栏：状态汇总（各状态计数）+ 勿扰开关 + 设置入口
- 会话列表：按优先级排序、状态点、时长、悬停跳转窗口按钮
- 底部页签：会话 / 事件历史（历史页签为占位）
- 设置视图：通知（勿扰/静音）、adapter 开关、Claude Code Hooks 安装/卸载

### 3.4 数据接入层（6 个 adapter 全部完成）
| adapter | 通道 | 机制 |
|---------|------|------|
| `http-ingest` | C | 127.0.0.1:17734 HTTP 端点 + `pupil send` CLI |
| `claude-code/hooks-adapter` | B | PowerShell 转发脚本 + settings.json 幂等安装 + `/ingest/claude-code` 路由 |
| `claude-code/log-adapter` | A | tail `~/.claude/projects/*.jsonl` 增量读取 |
| `codex/log-adapter` | A | `state_5.sqlite` threads 只读轮询（rollout jsonl 预留） |
| `hermes/sqlite-adapter` | A | `state.db` sessions/messages 差分轮询 |
| `dsh-api` | C | DSH Web API（`127.0.0.1:3080/api/session.list`）轮询，按权威 `running` 状态映射会话活动 |

- Adapter 插件化：实现 `AgentAdapter` 接口 + registry 注册一行，支持运行时启停（设置面板开关）
- SQLite 访问：koffi FFI 直调系统 `winsqlite3.dll`（零新增依赖，Electron 33 内置 Node 20 无 `node:sqlite`）

### 3.5 核心逻辑
- 状态机（`transitionState`）：事件驱动，timeout/disconnected 为推断叠加标记（非基础状态）
- 推断引擎：timeout 默认 10 分钟、disconnected 默认 30 秒，每秒 tick
- 通知规则：事件/状态 → 音效/Toast 策略，running/idle 不打扰

### 3.6 通知与集成
- 音效：renderer Web Audio 合成（done/waiting/error/timeout/offline 各型）
- 系统通知：Electron Notification，silent 避免双重声音
- 窗口激活：koffi FFI 调 user32（EnumWindows + SetForegroundWindow + Alt 键 workaround），PID 优先 + 标题匹配兜底

---

## 变更日志（v0.5.2）

- v0.5.2 思考加载换回官方三点波浪（bloub dotPulse：三白点 1.5s 相位差 0.5s、峰值×1.25、opacity 0.55→1）——替换 v0.4.4 uiverse 弹跳球，黑球底板保留

## 变更日志（v0.5.1）

- v0.5.1 眼睛斜视修复：TILT -26°→0°（bloub 源码反证中性态纯水平，斜眼仅情绪表情且镜像）——修复「一直看左」的斜视感

## 待办事项

### P1（核心体验完善）
1. ~~性能指标验证（打包版）~~ → ✅ 实测达标（见性能基线）
2. ~~独立设置窗口~~ → ✅ v0.3.0：380×520 居中窗口，常驻隐藏复用，面板设置按钮/空态 CTA 均跳转独立窗
3. ~~Codex rollout 实测校准~~ → ✅ v0.3.0：本机确认无 `~/.codex/sessions`（仅桌面版 sqlite），rollout 路径保持"按官方格式实现"，待有 CLI 环境回归
4. ~~CLI shim 加入 PATH~~ → ✅ v0.3.0：打包启动幂等注册 `%LOCALAPPDATA%/Pupil/bin` 进用户 PATH（注册表直写 + WM_SETTINGCHANGE 广播，规避 setx 截断）
5. **内存优化**：affinity 路线已证伪；BrowserView 结构改造挂后续评估

### P2（打磨 / 增强）
6. ~~通知跳转精化~~ → ✅ v0.3.0：事件历史行点击跳转对应会话窗口（带「已跳转」反馈）；pid 链路改进维持 OPEN-DECISION #2
7. ~~第三方 adapter 动态加载~~ → ✅ v0.3.0：`%APPDATA%/pupil/adapters/*.js` CommonJS 约定（id/create[/detect]），启动加载一次、单文件失败跳过，自动出现在设置开关列表
8. ~~Hermes webhook 调研~~ → ✅ v0.3.0 结论：方向相反（外部触发 Agent 执行 vs 内部状态外发）且需启用 gateway 平台，不替代 sqlite 轮询（见踩坑表）
9. ~~事件历史持久化~~ → ✅ v0.3.0：`%APPDATA%/pupil/history.json` 原子写（tmp+rename），60s 节流 + 退出落盘，重启恢复时间线；恢复项不占会话列表

---

## 五、关键技术决策与踩坑记录

| 主题 | 结论 |
|------|------|
| 悬浮球拖动 | 勿用 `-webkit-app-region: drag`（吞鼠标事件）与 `setPointerCapture` + `getCursorScreenPoint`（透明窗口 pointerup 丢失→球漂移）；最终用 window 级 pointer 监听 + renderer 传 screenX/Y delta |
| SQLite 访问 | Electron 33 内置 Node 20 无 `node:sqlite`，用 koffi FFI 直调系统 `winsqlite3.dll`；out 指针需 `_Out_` 限定符 + `[null]` 数组 |
| PowerShell hook 脚本 | 必须纯 ASCII + 写文件加 UTF-8 BOM，否则 Windows PowerShell 5.1 按 ANSI 误读中文破坏语法 |
| 透明/不透明窗口与渲染 | Win10 上 `transparent: true` 禁用 ClearType（文字发虚）→ 面板改不透明；但不透明窗口内容不满高时下半截露出原生底色死区（"下面一大片空白"）→ 根节点必须撑满整个窗口 |
| 断连推断语义 | "静默 >30s = 断连"只对运行中状态成立：idle/waiting_input 的静默是正常等待用户；sqlite 轮询源（hermes/codex）运行中静默多半是长回复生成中，需按 agent 放宽阈值 |
| 窗口跳转匹配 | pid 只有 hook 型源有；轮询型源（hermes/codex）会话 ID 前缀从不出现在窗口标题里，必然"窗口未找到"→ 按 agent 给宿主应用名关键词兜底（hermes 桌面版单实例），并让 adapter 上报库里真实会话标题用于匹配与展示 |
| koffi 回调绑定 | 2.x 里 `user32.func(..., ['callback', ...])` 直接绑定失败且被吞 → API 恒 null、功能整体静默失效；正确写法：`koffi.proto` 声明 + 参数表 `'名 *'` + `koffi.register(fn, koffi.pointer(proto))`；出参数组必须 `koffi.out` 否则不回写（pid 恒 0）；匹配必须排除本进程窗口（目录名撞自家标题） |
| Electron 33 affinity 已失效 | `webPreferences.affinity` 在 Electron 33 实测不再生效（同组窗口仍各起 renderer，进程 4→6），d.ts 已无此键——老文档示例不可信，共享渲染进程只能靠 BrowserView/WebContentsView 结构改造 |
| Hermes webhook 不适合替代 sqlite 轮询 | 本机实测（v0.2.x）：`hermes webhook` 是"外部事件触发 Agent 执行"的入口（subscribe 路由 → 渲染 prompt → 可选 LLM），方向与 Pupil 需要的"Agent 内部状态外发"相反；且需启用 gateway webhook 平台。轮询 state.db 的差分方案保持不变 |
| 本机沙箱跑 Electron | 注入 `ELECTRON_RUN_AS_NODE=1`（检查存在性），需 `unset` 彻底移除（`env -u` 会吞 stdout）；需 `no-sandbox` + 关硬件加速 |
| 孤儿进程 | TaskStop 杀 npm 父进程会留 electron.exe 孤儿，需 `Stop-Process -Name electron` 补刀 |
| Claude Code jsonl 格式 | 顶层 type 只有 user/assistant/queue-operation 等；tool_use/tool_result/thinking 是 `message.content` 内嵌块，非顶层行；`stop_reason` 在 `message.stop_reason` 不在顶层 |
| Hermes/Codex 时间戳 | Hermes 用 Unix 秒（REAL）；Codex 桌面版 sqlite 用毫秒（INTEGER），rollout jsonl 用 ISO 字符串，注意换算 |
| 通知策略与视图状态 | 展示态必须按"事件语义"算而非"事件应用后"的会话状态——turn_completed 应用后视图已 idle，按视图算完成提醒会被吞（v0.2.0 修复的典型坑） |
| electron-builder 资源路径 | 打包后 `__dirname` 相对路径失效；统一走 `resourcePath()`（dev=项目 resources/，打包=`process.resourcesPath/`） |
| SVG 圆心必须显式写 | `<circle>` 漏写 `cx/cy` 时默认 (0,0)=viewBox 左上角，环/圆会画到角落（v0.2.1 状态环错位根因）；代码评审时把"圆无 cx"列为检查项 |
| 透明窗口与文字渲染 | Windows 上 `transparent: true` 窗口禁用 ClearType，文字发虚；需要清晰文字的窗口（面板/设置）用不透明窗口 + 实色底，只有悬浮球本体保留透明 |

---

## 五·五、性能基线（v0.2.5 打包版实测，2026-08-24）

> 测法：`win-unpacked\Pupil.exe` 启动后空闲 8s，PowerShell 取 4 进程 WorkingSet/PrivateBytes；CPU 用 20s 窗口 TotalProcessorTime 差分 ÷ 核数。

| 指标 | 承诺 | 实测 | 判定 |
|------|------|------|------|
| 空闲 CPU（全进程合计） | < 1% | **~0.02%**（20s 增量 0.03s / 8 核） | ✅ 大幅达标 |
| 内存 WorkingSet（4 进程合计） | — | 285 MB（含跨进程共享页重复计入） | 口径参考 |
| 内存 Private Bytes（真实占用） | < 150MB（口径修订，原 <100MB） | **128 MB** | ✅ 达标 |

- 进程构成：主进程 ~81MB WS / 球窗渲染 ~107MB WS / GPU + utility 各 ~50MB WS
- 结论：CPU 达标；内存按修订后口径（Private Bytes <150MB）达标。原 100MB 承诺基于单进程假设，Electron 双窗口架构下不现实；affinity 共享渲染路线已证伪（见踩坑表），BrowserView 结构改造挂后续评估

---

## 六、本机验证过的数据源（供回归参考）

- **Claude Code**：`~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl`，本机存在且可读
- **Codex**：桌面版 `~/.codex/state_5.sqlite`（threads/agent_jobs 表，本机暂无线程数据）
- **Hermes**：`%LOCALAPPDATA%/hermes/state.db`（46 会话，sessions/messages 表，本机有活跃会话）
