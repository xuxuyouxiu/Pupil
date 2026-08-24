# Changelog

本文件记录 Pupil 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
