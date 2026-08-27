---
name: pupil-commit-flow
description: Pupil 项目任务完成后的提交流程——用户会在任务做完后追问"提交流程做了吗"，加载本技能按版本号+bump+验证+git commit 提交
---

# Pupil 提交流程

触发场景：完成 Pupil（G:\Pupil）的任何代码/文档改动后，进入收尾阶段；或用户直接问"提交流程做了吗 / 提交了吗"。

## 完整流程

1. **确认工作树**：`cd /g/Pupil && git status --short`。注意用户可能已在外部工具提交过部分改动，先看 status 再决定 commit 范围。
2. **版本号 bump**（新功能/修复发版）：
   - `package.json` 的 `"version"` 升到下一版本（如 0.5.2 → 0.5.3）。
   - `CHANGELOG.md` 顶部新建/改写 `## [X.Y.Z] - YYYY-MM-DD` 版本段（不要留 `[Unreleased]`）。
   - 顺手更新 `docs/PROGRESS.md` 的"最后更新：YYYY-MM-DD（vX.Y.Z）"与适配器数量/表格。
3. **验证**（按改动面，不默认全跑）：
   ```bash
   cd /g/Pupil
   npm test
   npm run typecheck
   npm run build
   ```
4. **提交**：
   ```bash
   cd /g/Pupil
   git add -A
   git commit -m "feat(vX.Y.Z): 一句话描述"
   ```
   提交信息沿用仓库现有风格：`feat(vX.Y.Z): …` / `fix(vX.Y.Z): …` / `chore(vX.Y.Z): …`。
5. **推送**：先 `git remote -v`。当前 Pupil 仓库没有 remote，只做本地 commit，**不要臆造 push**；未来配置了 remote 且用户要求发布时再 push + 打 tag。

## 关键机制与坑

- **版本号与 CHANGELOG 必须同 commit 落地**：历史提交（如 2eaa516 feat(v0.5.2)）都是 package.json + CHANGELOG + docs 同一提交，单独改代码不留版本会被用户认为"没走完流程"。
- **commit 前确认无临时/探针文件**：本会话常在 G:\deepseek-harness 下写 .tmp-*.mts 探针，跑完要删；`git add -A` 前看一遍 status。
- **无 remote 不要 push**：用户环境常见"提交了但没推送"卡在流程后半段，交付时明确说清已提交、未推送。
- **先查 git status 再接手**：用户可能在外部工具改过代码（如 PodMuse、Pupil），不要直接 `git add -A` 覆盖未完成的工作。

## Verification

- `git status --short` 干净。
- `git log --oneline -3` 能看到本次 feat/fix commit。
- npm test / typecheck / build 全部成功（Pupil 当前 93 个测试）。
