# Pupil

> 多 Agent 任务监控悬浮球。AI 编程 Agent 在后台干活时，用余光看一眼就知道：**在跑、在等、出错、完成**——不用再逐个切换终端标签页"狩猎"哪个会话卡住了。

## 特性

- 悬浮球常驻屏幕边缘，按会话显示状态（运行/等待输入/完成/出错/超时）
- 关键事件主动提醒：音效（4 套音色可选）+ 系统通知 + 勿扰模式
- 点击会话直接跳回对应窗口
- 会话列表 + 事件历史时间线，重启不丢
- 开放接入：任何能执行命令或发 HTTP 请求的程序都能上报状态
- 轻量：常驻内存 ~128MB，空闲 CPU ~0.02%

## 下载

从 `release/` 或 GitHub Releases 获取：

- `Pupil-x.x.x-x64.exe` — 安装版（自动注册开机自启与 CLI 命令）
- `Pupil-x.x.x-portable.exe` — 便携版，双击即用

系统要求：Windows 10/11 x64。

## 快速开始

1. 启动后悬浮球出现在屏幕左侧
2. 用 Claude Code / Codex / Hermes 正常干活 → 球自动亮起对应状态
3. 点球打开面板看所有会话；点会话行跳回它的窗口

### 接入其他任意程序

任何工具（自研 Harness、脚本、CI 任务）都可以通过 `pupil` 命令上报状态：

```bash
# 任务开始
pupil send --event turn_started --session my-task-1 --cwd "D:\myproject"
# 出错 / 完成前需要确认
pupil send --event error --session my-task-1
pupil send --event waiting_input --session my-task-1
# 完成
pupil send --event turn_completed --session my-task-1
```

`--cwd` 用于窗口跳转匹配与面板展示名，建议始终携带。安装版会把 `pupil` 命令自动注册进 PATH；便携版可用 `%LOCALAPPDATA%\Pupil\bin\pupil.cmd`。

### 写一个 adapter（零侵入监控）

不想改目标工具的代码？写一个 CommonJS 模块放进 `%APPDATA%/pupil/adapters/`：

```js
// %APPDATA%/pupil/adapters/my-tool.js
module.exports = {
  id: 'my-tool',
  detect: async () => true, // 数据源存在才返回 true
  create: () => ({
    id: 'my-tool',
    agentType: 'custom',
    capabilities: ['lifecycle'],
    async start(emit) {
      // 轮询/读日志，把状态变化归一化为事件上报：
      emit({ source: 'my-tool', agentType: 'custom', sessionId: 'main',
             eventType: 'turn_started', timestamp: Date.now() })
    },
    async stop() {}
  })
}
```

重启 Pupil 即生效，并在设置面板出现启停开关。

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发模式
npm run typecheck  # 类型检查
npm test           # 单元测试（vitest）
npm run build      # 构建产物
npm run dist       # 打包 portable + nsis 安装包
```

技术栈：Electron + React + TypeScript。
架构决策见 [docs/architecture.md](docs/architecture.md)，产品需求见 [docs/PRD.md](docs/PRD.md)，进度与踩坑记录见 [docs/PROGRESS.md](docs/PROGRESS.md)。

## 许可

MIT
