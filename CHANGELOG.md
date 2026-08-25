# Changelog

本文件记录 Pupil 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.3.2] - 2026-08-25

### 修复
- **任务管理器进程名带长描述（用户反馈）**：exe 版本信息 FileDescription 取自 package.json `description`（"Pupil - 开源多 Agent 桌面悬浮球监控工具…"），任务管理器显示一长串；改为 `"description": "Pupil"`，进程列表现在只显示 **Pupil**

## [0.3.1] - 2026-08-25

### 修复
- **CLI 进 PATH 在打包版实际未生效（v0.3.0 回归，冒烟发现）**：原实现把 PowerShell 语句经 spawn 参数拼成 `-Command` 内联，`$p` 等变量在外层传参时被吞导致 PS 解析失败、注册静默失败。改为生成临时 `.ps1` 脚本文件用 `-File` 执行（变量不被外层干扰），并 `spawnSync` 同步等待结果 + 日志留痕。真机回归：CHANGED → 再跑 ALREADY（幂等），`reg query HKCU\Environment` 确认 bin 目录在列
- `ensureCliOnPath` 签名改 async（调用方 `void` 掉即可，行为不变）

## [0.3.0] - 2026-08-25

### 新增
- **独立设置窗口（P1）**：设置从面板内视图升级为独立窗口（380×520，屏幕居中、置顶、不透明保 ClearType）；常驻隐藏复用——关闭仅隐藏，二次打开零创建开销且保留滚动/表单状态；面板「设置」按钮与空态「查看接入指引」均跳转独立窗并让位收起面板
- **CLI 全局可用（P1）**：打包版启动时把 `%LOCALAPPDATA%/Pupil/bin` 幂等注册进用户 PATH——任意终端直接敲 `pupil send ...` 免 cd；实现走 HKCU\Environment 注册表直写 + WM_SETTINGCHANGE 广播（规避 setx 1024 字符截断损坏长 PATH 的风险）
- **事件历史行点击跳转（P2）**：底部「事件历史」页签每行可点击，直接激活对应会话窗口（复用 win32 激活链路），跳转后显示 2s「已跳转」反馈
- **第三方 adapter 动态加载（P2，OPEN-DECISION #6 落地）**：`%APPDATA%/pupil/adapters/*.js` 放 CommonJS 模块（导出 `id`/`create`[/`detect`]，实现 AgentAdapter 接口）即被自动加载，出现在设置面板开关列表；启动加载一次，单文件失败仅告警不影响内置 adapter
- **事件历史持久化（P2）**：环形缓冲投影落盘 `%APPDATA%/pupil/history.json`（原子写 tmp+rename），60s 节流 + 退出前保存；重启后时间线完整恢复。恢复的历史只进时间线不占会话列表，会话收到新事件才重新出现
- `scripts/probe-win32.mjs` 窗口激活诊断探针（v0.2.4 引入，此处归档说明）

### 调研结论
- **Hermes webhook 不替代 sqlite 轮询（OPEN-DECISION #7 关闭）**：本机实测 `hermes webhook` 是"外部事件触发 Agent 执行"的入口（路由 → 渲染 prompt → 可选 LLM 执行），方向与 Pupil 需要的"Agent 内部状态外发"相反，且需启用 gateway webhook 平台——维持 state.db 差分轮询
- **Codex rollout 校准**：本机确认无 `~/.codex/sessions/`（仅桌面版 sqlite），rollout jsonl 解析保持按官方格式实现，待真实 CLI 环境回归

### 变更
- 版本号 0.2.5 → 0.3.0（功能版本：独立设置窗口 + 动态 adapter 两项结构性新增）

## [0.2.5] - 2026-08-24

### 新增
- **提示音音色包（用户反馈"音效能不能做多点、让用户可以选哪种"）**：4 套纯代码合成音色包，各覆盖 5 种事件（完成/等输入/出错/超时/断连），盲听可区分——
  - 清脆铃声（默认）：明亮正弦双音 + 泛音
  - 木质敲击：短促三角波，木鱼质感
  - 8-bit 电子：方波琶音，游戏机风
  - 低音警示：低频慢鸣 / 小二度拍频
  设置面板「通知」区新增下拉选择，切换即自动试听一声；`soundPack` 持久化到 config
- **提示音音量滑块**：设置面板可调 0-100%，拖动即时试听、松手持久化；默认音量峰值系数 0.18 → 0.35（近两倍，用户反馈"声音很小"）
- 音色/音量随每次播放指令实时下发（notifier 读 config），改设置即刻生效无需重启

## [0.2.4] - 2026-08-24

### 修复
- **宿主窗口明明开着仍提示"窗口未找到"（用户反馈）**：koffi 2.x 的 `EnumWindows` 回调参数声明为裸 `'callback'` 类型名，绑定直接抛 `Unknown or invalid type name 'callback'` 且被 try/catch 静默吞掉 → FFI API 恒为 null → **所有会话永远提示窗口未找到**（与宿主是否运行无关）。重写绑定链路：
  1. 回调用 `koffi.proto` 声明原型，符号参数表按 `'<原型名> *'` 引用；JS 回调用 `koffi.register(fn, koffi.pointer(proto))` 创建模块级常驻实例（防 GC），枚举时换 handler
  2. hwnd 全链改 `uintptr`（64 位进程句柄截断隐患）
  3. `GetWindowThreadProcessId` 出参数组补 `koffi.out` —— 此前不回写、pid 恒为 0，pid 匹配加分形同虚设
  4. 新增本进程窗口排除：会话目录名可能撞上自家窗口标题（如 cwd=Pupil 命中 "Pupil Ball"，实测得分反超真目标），跳转永不落到自己身上

### 新增
- `scripts/probe-win32.mjs`：win32 激活链路诊断探针（枚举窗口 + 复现匹配打分），`PUPIL_PROBE_OWN_PID=<pid>` 可指定视为自身的 pid

## [0.2.3] - 2026-08-24

### 修复
- **点击会话提示"窗口未找到"（用户反馈）**：窗口匹配靠 pid 优先 + 会话 ID/目录名标题包含兜底，但 Hermes/Codex 是 sqlite 轮询型源——天生无 pid、会话 ID 前缀（如 `20260824_190`）从不出现在窗口标题里，得分恒为 0。三层修复：
  1. 匹配兜底加「宿主应用名」最低分档：Hermes 桌面版单实例、主窗口标题即 "Hermes"，按 agent 类型给关键词（`win32-window.ts` 新增 `AGENT_WINDOW_HINTS`）
  2. 轮询型 adapter 把库里的**真实会话标题**随事件上报（`AgentEventPayload` 新增 `title` 字段；hermes 维护 sessionId→title 映射并在摘要标题生成后重发 session_started 刷新面板；codex threads 同理）——标题同时用于面板展示与窗口匹配，真实标题含项目名时可直接命中终端窗口标题
  3. `SessionRegistry` 首见与后续事件均接受 `payload.title` 覆盖 ID 前缀兜底名

### 测试
- 新增 `tests/session-registry.test.ts`：payload.title 首见采用 / 缺省回退 / 后续更新三用例（44 个全绿）

## [0.2.2] - 2026-08-24

### 修复
- **面板底部大片空白（用户反馈"下面有那么大一片空白"）**：面板窗口改不透明后 `.panel` 卡片仍是随内容收缩的高度，内容不足时窗口下半截露出原生底色死区；现在 `html/body/#root` 全高 + `.panel` 撑满整个窗口，列表区 `flex:1` 自动吸收剩余高度，设置视图同样受益（`src/renderer/panel/panel.css`）
- **"Hermes 链接中断"误报 + "发消息后才显示运行"**：推断引擎把任意状态静默 >30s 一律判为断连，但 idle（等用户下一句）与 waiting_input（等用户确认）的静默是正常等待；改为仅运行中（thinking/tool_calling）静默才判断连，且 hermes/codex 这类 sqlite 轮询源的运行中静默多半是长回复生成中，按 agent 放宽断连阈值到与 timeout 一致（`src/core/inference.ts` 新增 `disconnectThresholdMsByAgent`、`src/main/monitoring-core.ts` 注入）
- **夜间（勿扰）模式没有可见效果（用户反馈）**：勿扰此前只抑制音效/通知，球面毫无变化；悬浮球新增右上角月牙角标（呼吸动画）+ 勿扰时球体压暗（`Ball.tsx`、`ball.css`）；补上缺失的 `useState` import（上一轮遗留 typecheck 错误）

### 测试
- 断连推断语义变更同步用例：idle/waiting_input 静默不打标记、运行中超阈值才打 disconnected（41 个用例全绿）

## [0.2.1] - 2026-08-24

### 修复
- **状态环圆心错位（用户反馈"头上两条线"的真正根因）**：`RingSegments` 三处 `<circle>` 漏写 `cx/cy`，SVG 默认圆心落在 viewBox 左上角 (0,0)，状态环没有环绕球体、只露出两段悬空弧线；补上 `cx=28 cy=28` 与球体同心，并全库排查确认 EyeSystem 等其余 21 个圆均无同类问题（`src/renderer/ball/Ball.tsx`）
- **面板文字发虚（用户反馈"里面的文字看不清"）**：面板窗口 `transparent: true` 在 Windows 上会禁用 ClearType 亚像素渲染，文字发灰模糊；面板已定实色底，改为不透明窗口 + `backgroundColor: #0d1117`，文字恢复清晰渲染（`src/main/window-manager.ts`、`panel.css` 实色兜底 + `--panel-alpha: 1`）

## [0.2.0] - 2026-08-24

### 新增
- **打包分发（P0）**：`package.json` 补齐 electron-builder `build` 配置块（appId、NSIS + portable 双目标 x64、图标、extraResources），`npm run dist` 一键出安装包；产出 `release/Pupil-0.2.0-x64.exe`（NSIS 安装版）与 `Pupil-0.2.0-portable.exe`
- **CLI 随应用分发（P1）**：`pupil send` 打包进 `resources/cli/`，打包版启动时在 `%LOCALAPPDATA%/Pupil/bin` 写 `pupil.cmd` shim（用 Pupil 自身 exe 以 `ELECTRON_RUN_AS_NODE=1` 跑，无需系统 Node）
- **事件历史页签（P1）**：底部「事件历史」页签落地——跨会话合并时间线（倒序），显示时间/会话/工具/错误摘要；数据来自 SessionRegistry 环形缓冲投影（每会话最近 1000 条），3s 轻量轮询
- **开机自启（P1）**：`app.setLoginItemSettings` 封装（`src/main/auto-launch.ts`），设置面板新增开关并持久化到 config；dev 模式只存偏好不注册登录项
- **单元测试（P1）**：接入 vitest，39 个用例覆盖状态机全转移矩阵、推断引擎（超时/断连/恢复清除）、通知规则、hook-payload-map、Claude Code mapLine、Codex rollout 映射；`npm test`
- **Toast 精准跳转（P2）**：点击系统通知直接激活对应会话窗口（复用 win32 激活链路），找不到窗口时回退聚焦悬浮球

### 修复
- **完成提醒被吞（测试发现的真 bug）**：`resolveStrategy` 此前按"事件应用后"的会话视图算展示态，`turn_completed` 应用后状态已是 idle，导致任务完成的音效+系统通知从未触发；改为以事件语义推导展示态（`src/core/notify-rules.ts`）
- **error 吸收态卡死**：出错后同一会话重启（`session_started`）仍停留在错误态；现在 session_started 总是重置状态机
- **设置视图失焦误关（P0）**：面板失焦 300ms 自动收起会打断设置操作；新增 `panel:mode` IPC，renderer 在进入/退出设置视图时同步主进程，设置模式下不再自动收起
- **Panel hooks 规则违规**：`useMemo` 写在条件 return 之后（React Hooks 顺序隐患），已把全部 hooks 提前
- **托盘图标打包后丢失**：改用 `resourcePath()` 解析（dev=项目 resources/，打包=`process.resourcesPath/`）

### 变更
- 版本号 0.1.0 → 0.2.0；`.gitignore` 增加 `release/`
- Codex adapter 补全经典 CLI rollout jsonl tail（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）：session_meta/response_item/event_msg 三类行映射 + 增量 tail + 断点续读；桌面版 sqlite 路径保持不变

### 性能基线（dev 模式实测，打包版预计更低）
- 内存：4 进程合计 ~296MB（含 vite dev server 与未压缩产物）
- CPU：主渲染进程空闲增量 ~1.7%/20s（球体动画常驻）

## [0.1.0] - 2026-08-24

### 首个可用版本
- Electron 33 + React 19 + TS + electron-vite 三层骨架；单实例锁；托盘
- 悬浮球：Grok 式黑球 + 双精灵眼六态表情系统、分段状态外环、可见度分层、自定义拖动
- 详情面板：顶栏状态汇总、会话列表（优先级排序）、勿扰开关、面板内设置视图
- 数据接入 5 adapter 全通：HTTP ingest(127.0.0.1:17734, Bearer token, 限速)、Claude Code hooks（PowerShell 转发 + settings.json 幂等安装）、Claude Code jsonl tail、Codex sqlite、Hermes state.db 轮询（koffi FFI 直调 winsqlite3.dll）
- 核心逻辑纯函数化：状态机、timeout/disconnected 推断引擎、通知规则
- 通知：Web Audio 合成音效 + Windows Toast；koffi 直调 user32 实现会话窗口跳转
