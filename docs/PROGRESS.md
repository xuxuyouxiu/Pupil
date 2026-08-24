# Pupil 项目进度记录

> 最后更新：2026-08-24
> 本文档记录 Pupil（开源多 Agent 桌面悬浮球监控工具）的开发进度、已完成功能与待办事项，作为团队协作与后续迭代的单一事实来源。设计决策详见 `docs/architecture.md`、需求详见 `docs/PRD.md`、UI 规范详见 `docs/uiux.md`。

---

## 一、项目概述

- **产品名**：Pupil（瞳孔）—— 黑色球体 = 眼睛瞳孔；AI = 学生（pupil）在学习
- **定位**：开源多 Agent 桌面悬浮球监控工具，Windows 优先
- **技术栈**：Electron 33 + React 19 + TypeScript + electron-vite 2.3
- **CLI 命令**：`pupil send`（向悬浮球上报事件）
- **轻量目标**：常驻内存 < 100MB，空闲 CPU < 1%
- **数据接入三通道**：Hook 主动上报（主）+ 本地 HTTP 接收端点（自研扩展）+ 日志 tail（兜底）

---

## 二、总体进度

| 模块 | 状态 | 说明 |
|------|------|------|
| 应用骨架（Electron + React + TS） | ✅ 完成 | 主进程/渲染层/preload 三层 + 打包管线 |
| 悬浮球（球体 + 精灵眼 + 状态环） | ✅ 完成 | 六态表情 + 动画 + 自定义拖动 |
| 详情面板（会话列表） | ✅ 完成 | 顶栏汇总 + 会话行 + 跳转窗口 |
| 设置面板 | ✅ 完成 | 面板内视图（通知/adapter 开关/hooks 管理） |
| 数据接入层（5 个 adapter） | ✅ 完成 | 通道 A/B/C 全部落地 |
| 核心逻辑（状态机/推断/通知规则） | ✅ 完成 | 纯函数，无 Electron 依赖 |
| 通知系统（音效 + Toast） | ✅ 完成 | Web Audio 合成音效 + 系统通知 |
| 窗口激活（跳转会话窗口） | ✅ 完成 | koffi FFI 直调 user32 |
| 系统托盘 | ✅ 完成 | 菜单 + 勿扰切换 |
| 事件历史页签 | ⬜ 空壳 | 底部页签已就位，内容未实现 |
| 开机自启（autoLaunch） | ⬜ 未实现 | config 有字段，无逻辑 |
| 打包（electron-builder） | ⬜ 未配置 | 依赖已装，缺 build 配置块 |
| 单元测试 | ⬜ 未写 | 状态机等纯函数可测 |
| CLI 全局安装 | ⬜ 未做 | 目前是 `scripts/pupil-send.mjs` |

---

## 三、已完成功能明细

### 3.1 应用骨架
- Electron 33.4.11 + React 19 + TypeScript + electron-vite 2.3
- 目录分层：`src/main`（主进程）、`src/preload`、`src/renderer`（ball/panel）、`src/core`（纯逻辑）、`src/adapters`（数据接入）、`src/integrations`（Win32 集成）、`src/shared`（三端共享类型/常量）
- 单实例锁、悬浮球/面板双窗口、托盘、配置存储（`%APPDATA%/pupil/config.json`）

### 3.2 悬浮球
- 形态：Grok 式黑色球体 + 两只自定义 SVG/CSS 精灵眼（不用图标库）
- 外环：按会话分段的彩色状态弧，>5 会话合并为单色环
- 六态系统：加载中/运行中/等待输入/完成/错误/超时/断连/空闲，每态有独特眼睛表情与动画
- 可见度分层：空闲/断连 0.55（低调）、活跃态 0.92（醒目）、hover 1.0（实心）
- 自定义拖动（IPC + window 级 pointer 监听，替代 `-webkit-app-region: drag`）

### 3.3 详情面板
- 顶栏：状态汇总（各状态计数）+ 勿扰开关 + 设置入口
- 会话列表：按优先级排序、状态点、时长、悬停跳转窗口按钮
- 底部页签：会话 / 事件历史（历史页签为占位）
- 设置视图：通知（勿扰/静音）、adapter 开关、Claude Code Hooks 安装/卸载

### 3.4 数据接入层（5 个 adapter 全部完成）
| adapter | 通道 | 机制 |
|---------|------|------|
| `http-ingest` | C | 127.0.0.1:17734 HTTP 端点 + `pupil send` CLI |
| `claude-code/hooks-adapter` | B | PowerShell 转发脚本 + settings.json 幂等安装 + `/ingest/claude-code` 路由 |
| `claude-code/log-adapter` | A | tail `~/.claude/projects/*.jsonl` 增量读取 |
| `codex/log-adapter` | A | `state_5.sqlite` threads 只读轮询（rollout jsonl 预留） |
| `hermes/sqlite-adapter` | A | `state.db` sessions/messages 差分轮询 |

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

## 四、待办事项

### P0（下一步优先）
1. **打包配置**：补 `package.json` 的 `build` 配置块（appId、win nsis/portable 目标、图标、图标资源），产出可分发安装包
2. **设置视图失焦优化**：面板目前「失焦 300ms 关闭」，设置视图中途失焦会被关，需对设置态做例外（不自动关或延长）

### P1（核心体验完善）
3. **事件历史页签**：实现会话事件时间线展示（环形缓冲最近 1000 条/会话，架构文档 3.6 节）
4. **开机自启**：实现 `autoLaunch`（`app.setLoginItemSettings`），并接入设置面板
5. **CLI 全局安装**：把 `pupil send` 打包成可执行命令（npm bin / 独立 exe），随应用分发
6. **单元测试**：状态机、推断引擎、事件映射（`hook-payload-map`、各 adapter 的 `mapLine`）等纯函数
7. **Codex rollout jsonl 路径**：补全经典 CLI 的 jsonl tail（当前只实现桌面版 sqlite）

### P2（打磨 / 增强）
8. **独立设置窗口**：从面板内视图升级为独立窗口（架构 P1）
9. **通知跳转精化**：Toast 点击精准跳转到对应会话窗口（当前仅聚焦球/面板）
10. **窗口跳转 pid 匹配**：改进 hook/日志侧宿主终端 pid 的获取链路（架构 OPEN-DECISION #2）
11. **性能指标验证**：实测内存/CPU，确认达标（<100MB / <1%）
12. **第三方 adapter 动态加载**：`%APPDATA%/pupil/adapters/*.js` 约定（架构 OPEN-DECISION #6，deferred）
13. **Hermes webhook**：调研 `hermes webhook` 是否可替代 sqlite 轮询（架构 OPEN-DECISION #7）

---

## 五、关键技术决策与踩坑记录

| 主题 | 结论 |
|------|------|
| 悬浮球拖动 | 勿用 `-webkit-app-region: drag`（吞鼠标事件）与 `setPointerCapture` + `getCursorScreenPoint`（透明窗口 pointerup 丢失→球漂移）；最终用 window 级 pointer 监听 + renderer 传 screenX/Y delta |
| SQLite 访问 | Electron 33 内置 Node 20 无 `node:sqlite`，用 koffi FFI 直调系统 `winsqlite3.dll`；out 指针需 `_Out_` 限定符 + `[null]` 数组 |
| PowerShell hook 脚本 | 必须纯 ASCII + 写文件加 UTF-8 BOM，否则 Windows PowerShell 5.1 按 ANSI 误读中文破坏语法 |
| 本机沙箱跑 Electron | 注入 `ELECTRON_RUN_AS_NODE=1`（检查存在性），需 `unset` 彻底移除（`env -u` 会吞 stdout）；需 `no-sandbox` + 关硬件加速 |
| 孤儿进程 | TaskStop 杀 npm 父进程会留 electron.exe 孤儿，需 `Stop-Process -Name electron` 补刀 |
| Claude Code jsonl 格式 | 顶层 type 只有 user/assistant/queue-operation 等；tool_use/tool_result/thinking 是 `message.content` 内嵌块，非顶层行 |
| Hermes/Codex 时间戳 | Hermes 用 Unix 秒（REAL）；Codex 用毫秒（INTEGER），注意换算 |

---

## 六、本机验证过的数据源（供回归参考）

- **Claude Code**：`~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl`，本机存在且可读
- **Codex**：桌面版 `~/.codex/state_5.sqlite`（threads/agent_jobs 表，本机暂无线程数据）
- **Hermes**：`%LOCALAPPDATA%/hermes/state.db`（46 会话，sessions/messages 表，本机有活跃会话）
