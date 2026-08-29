# Pupil 路线图 v2 —— 详细设计（2026-08-28）

> 状态：**设计定稿，待实现** | 基线：v1.1.2（154→159 测试）
> 定位升级：从"监控工具"到"**有记忆的桌面伙伴**"——它不只是亮灯，它记得你今天干了什么
> 用户决策：~~宠物成长系统~~ 否决（鸡肋）；回顾系统 = 球球日记 × 任务图鉴合体；面板 UI 翻新；闲时杂技

---

## 批次 A（v1.2.0）：任务回顾系统 —— 「今天到底干了什么」

### A.0 用户故事

> 下班前点开面板「回顾」页：球球写的一句今日小结，下面是一排任务卡——每张卡有枚独一无二的
> 徽章、任务标题（我当时让它干嘛来着）、时长、烧了多少 tokens 多少钱、用了哪些工具改了哪些文件。
> 昨天的？点 ‹ 就有。重启电脑？数据还在。

### A.1 数据采集（adapter 层增强，事件契约不变只加可选字段）

**`turn_started.payload.prompt`** —— 本轮用户指令摘要，提取规则按源：

| 数据源 | 提取点 | 规则 |
|---|---|---|
| zcode | rollout 行 `request.messages` 中**最后一条** role=user 的文本 content | content 为 string 直取；block 数组取首个 `type:text` 块 |
| claude-code | jsonl user 行 `message.content` | string 直取；tool_result 行跳过（不是 prompt） |
| hermes | messages 表 user 行 `content` | 同上；首个 user 消息即本轮指令 |
| codex(sqlite) | threads.`first_user_message` | 会话级兜底（无法按轮取），每轮复用 |
| dsh | `projections.values.title` | 已有 title，直接作 prompt |

清洗规则（共用）：取首行 → 去掉 `>` 引用与首尾空白 → 截断 **120 字符**加省略号；空则不附。
隐私红线：**只落摘要不落原文**；`raw` 字段照旧仅在内存事件流，不入 recap 持久化。

**`tool_call_started.payload.files`** —— 尽力而为的文件轨迹：

| 数据源 | 提取点 |
|---|---|
| claude-code | assistant 行 tool_use 块 `input.file_path` / `input.path`（Read/Edit/Write 等） |
| zcode | `response.toolCalls[].input.file_path`（或 `path`） |
| 其他源 | 暂不提取，字段缺省 |

规则：取 basename 展示；单轮去重上限 **12 个**；仅保留路径不含内容。

### A.2 数据模型与持久化

```ts
// src/core/recap.ts（纯逻辑，零 IO，可单测）
interface TaskCard {
  id: string                 // `${agentType}:${sessionId}:${startedAt}`
  agentType: AgentType
  sessionTitle?: string      // 面板已有标题
  cwd?: string
  prompt?: string            // A.1 摘要
  tools: Record<string, number>  // 工具名 → 次数
  files: string[]            // basename 去重
  startedAt: number
  endedAt?: number
  errors: number
  tokensIn: number
  tokensOut: number
  costUsd: number            // hermes 真实值 / 其他按定价折算（与 registry 同口径）
}

interface RecapDay {
  date: string               // 'YYYY-MM-DD'（本地时区）
  cards: TaskCard[]          // 已完结，按 startedAt 升序；上限 500 条（FIFO 截断）
}

interface RecapTotals { tasks: number; errors: number; runMs: number; tokensIn: number; tokensOut: number; costUsd: number }
```

存储：`%APPDATA%/pupil/recap/YYYY-MM-DD.json`，结构 `{ date, cards }`。
- 写入：脏标记 + **3s 防抖** + 原子写（tmp+rename，复用 ConfigStore 模式）
- 保留：**90 天**，启动时清扫更早文件
- 跨天任务：归属**开始日**（卡在旧文件，次日凌晨结算也写回旧文件——按 date 定位）

### A.3 回顾引擎状态机（事件驱动）

```
turn_started  ──► 开新卡（prompt/标题/cwd 快照入卡；同 key 上一张未结卡先强制结卡）
tool_call_*   ──► tools[name]++ ；files 合并（去重≤12）
usage(任意事件)──► tokens/cost 入账（口径与 registry 一致：含缓存读/写拆分）
error         ──► errors++（卡保持开）
turn_completed──► 结卡（endedAt）
session_ended ──► 强制结卡（防幽灵开卡）
registry prune──► 会话被清理时强制结卡并落盘
```

异常路径：重启时若当日文件存在"无 endedAt 的卡"（上次没结），启动即强制结卡补 endedAt=启动时刻。

### A.4 IPC 契约

```
recapGet: 'pupil:recap:get'      // renderer → main：date?: string('YYYY-MM-DD'，缺省今天)
                                  // 返回 { date, cards, totals }（date 为实际返回日，便于越界钳制）
```
preload：`getRecap(date?: string): Promise<RecapDayView>`。
日期越界：早于最早保留日返回该日空卡；未来日期一律钳制为今天。

### A.5 DNA 徽章（shared/dna.ts 纯函数 + panel 薄组件）

确定性参数（同输入必同图，可单测）：

| 视觉要素 | 数据映射 | 范围 |
|---|---|---|
| 外环分段数 | 本任务轮内工具调用总次数 | clamp 3..12 段 |
| 环色相 | agentType 映射（claude=橙、codex=青、hermes=紫、zcode=蓝、dsh=绿、custom=灰） | 固定表 |
| 内芯多边形边数 | agentType（claude 5 / codex 6 / hermes 7 / zcode 4 / dsh 8 / custom 3） | 3..8 |
| 内芯散点密度 | errors（0 错=0 点，最多 8 点） | 0..8 |
| 整体旋转角 | hash(id) % 360 | 0..359 |
| 环宽/辉光 | tokens 对数分档（<10k/100k/1M 三档） | 3 档 |

SVG 40×40 viewBox，参数函数 `buildGlyphParams(card): GlyphParams` 纯导出供测试；组件仅渲染。

### A.6 回顾页 UI（面板第三页签「回顾 / Recap」）

```
┌──────────────────────────────────────┐
│ ‹  今天  ›                    共 5 任务│
├──────────────────────────────────────┤
│ ╭──────────────────────────────────╮ │
│ │ 🖤 "今天陪主人打了 5 仗，全胜！     │ │  ← 今日小结卡（球球口吻）
│ │     烧了 1.2M tok · $3.42"        │ │
│ ╰──────────────────────────────────╯ │
│ ╭──╮ 修复面板 UI 黑球看不见的问题      │ │  ← 任务卡：徽章 + prompt 标题
│ │DNA│ hermes · 12:30 · 42m           │ │     元行：agent · 开始时间 · 时长
│ ╰──╯ Read×12 Edit×6 Bash×8 · 892k · $2.10 │  工具Top3 · tokens · $
│        Ball.tsx  theme.css  Panel.tsx    │  文件轨迹（≤6 显示，更多 +N）
│ ╭──╮ ...                              │ │
├──────────────────────────────────────┤
│ 合计  5 任务 · 2h 14m · 1.2M tok · $3.42│  ← 底部合计条
└──────────────────────────────────────┘
```

- 日期导航 ‹ ›：步进一天，未来禁用；标题显示 今天/昨天/M月D日
- 空态：雷达图标 +「这一天没有任务记录」
- 语气分支（今日小结，zh/en 各配）：
  1. 全绿（0 错）：「打了几仗全胜」得意语气
  2. 有错（≥1）：「有几个家伙搞砸了，但我盯着呢」担忧+可靠
  3. 深夜（卡片时间 ≥1 点仍有活动）：「又陪主人熬夜了」困倦
  4. 氪金（日耗 ≥$5）：「今天有点烧钱」心疼
  优先级：深夜 > 氪金 > 有错 > 全绿（一句话最多叠一个前缀短语）

### A.7 每日简报升级

DailyDigest 通知正文从"内存计数"改为读回顾引擎当日 totals（持久化后重启不丢、口径统一）；
触发时刻/勿扰静默行为不变；正文保持符号化（✓ ✗ ⏱ Σ $）语言无关。

### A.8 i18n 新增键（zh/en 同步）

`tabRecap` 回顾/Recap · `recapEmpty` 这一天没有任务记录 · `recapTotal` 合计 ·
`recapTasks` 任务 · 语气模板 ×4 组（含参数占位）· `recapToday` 今天 · `recapYesterday` 昨天 ·
文件轨迹"等 N 个文件"等。

### A.9 测试计划（tests/recap.test.ts + dna.test.ts）

1. 开卡→工具→usage→结卡：全字段正确
2. error 计数不阻断结卡；session_ended 强制结卡
3. 跨天：23:59 开卡 00:01 结卡 → 归属开始日
4. 重启恢复：未结卡补 endedAt
5. 500 条 FIFO 截断；totals 求和正确
6. buildGlyphParams：同输入两次调用输出全等；各映射档位边界
7. prompt 清洗：多行取首行/120 截断/引用行剔除/空安全

### A.10 验收清单

- [ ] 跑一轮真实任务，回顾页出现卡片（prompt 摘要 + 工具统计 + 文件轨迹 + tokens/$）
- [ ] 重启 Pupil，当日回顾仍在；跨天任务归属正确
- [ ] 简报通知数字与回顾合计一致
- [ ] 中英双语完整；159+ 测试全绿；本地 build 通过

---

## 批次 B（v1.3.0）：面板 UI 翻新（只动皮肤不动逻辑）

### B.1 设计原则

对齐 docs/uiux.md 的 Linear/Geist 基准：**卡片化、辉光点缀、8px 节奏、去硬边框**。
全部改动收敛在 panel.css + 少量 className（Panel/SessionRow/EventHistory/Settings 零逻辑变更）。

### B.2 令牌与区域改造明细

| 区域 | 现状 | 目标 |
|---|---|---|
| 会话行 | 1px 底边框扁平行 | 独立卡片：bg `--surface`、radius 10、左 3px 状态色条、hover 上浮 1px + 边框亮化 + 状态点 6px 辉光（box-shadow 0 0 6px 状态色） |
| 顶栏汇总 | 纯文字+点 | chips 胶囊（dot+辉光+计数），底色 surface |
| 底部页签 | 通栏文字+下划线 | **胶囊分段控件**（三段：会话/历史/回顾），选中实底 accent 10% |
| 事件历史 | 同扁平行 | 行距收紧、时间戳 muted、分组头吸顶保留 |
| 设置页 | 行+分隔线 | 分组卡片区化（section 包卡片容器）、行 hover 柔化 |
| 空状态 | 图标+文字 | 图标装 64px 圆形 surface 底 + 描边，文案层级拉开 |
| 滚动条 | 6px 方块 | 4px 圆角 + hover 加深 |
| 动效 | — | 卡片入场 stagger 淡入（≤120ms，遵守全局克制约束） |

### B.3 验收

- [ ] 三页签 + 设置页换肤完成；不新增任何逻辑分支
- [ ] hover/focus-visible 键盘可达性保留；暗色对比度 ≥ 现状（WCAG AA 目标）
- [ ] 全量测试与 build 通过

---

## 批次 C（v1.4.0）：闲时杂技

### C.1 触发状态机

```
条件：display === 'idle'（无任何活跃会话）且 !dnd
计时：连续 idle ≥ 90s 后进入「可杂耍」态
调度：可杂耍态下每 120~300s（随机）触发一次；单次 7s
打断：任何 display 变化 / 勿扰开启 / 用户交互（pointerdown）→ 立即收球（120ms 淡出）
冷却：被打断后重新计 90s
```

### C.2 动画规格（rAF 驱动，复用 ThinkingOrbit 的 setAttribute 模式）

- 三颗小球（r=3.2K，K 同环绕动画）在球顶上方抛物线级联：相位差 1/3 周期
- 每球轨迹：`x = cx + sin(t)·14K`，`y = cy - 18K - |sin(t·2)|·10K`（双抛物线弧感）
- 周期 1.4s/圈；进行中球体本体轻微左右摇（±2°，1.4s 正弦）
- 眼神：EyeSystem 已有 gaze 通道，杂技期间目标点固定为球顶上方（实现为临时 override）
- 音效：无（安静是性格）；如全局 soundPack 试听模式开启也不打扰

### C.3 验收

- [ ] 全空闲 90s+ 后能在 2~5 分钟内观察到一次杂耍；任意事件立即收球
- [ ] 勿扰期间绝不触发；CPU 占用无可感知变化（rAF 仅动画期活跃）
- [ ] 测试：触发状态机纯逻辑单测（idle 计时/打断/冷却）

---

## 版本计划与风险

| 批次 | 版本 | 依赖 | 风险与回滚 |
|---|---|---|---|
| A | v1.2.0 | 无新依赖 | recap 文件损坏 → 启动按天丢弃重建（单日损失可接受）；回滚=隐藏页签 |
| B | v1.3.0 | 无 | 纯 CSS，回滚=还原 css |
| C | v1.4.0 | B 的动效基元 | 打断路径遗漏 → 强制 7s 上限自愈 |

每批独立发版（push 标签自动流水线），批内按 A.1→A.10 / B / C 顺序逐项完成并勾选。
