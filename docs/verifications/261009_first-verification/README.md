# MAW 发布核查清单生成任务（2026-10-09）

## 任务

按 `tools/verification-checklist/templates/verification-checklist.html` 模板，生成「v1.8.0-beta.1 → 当前 main」
的人工核查 HTML，按 merge / 原 PR 分组；另核查 issue/PR #185 的后续补充内容。
生成物放本目录，不提交进仓库。

## 范围基线（已确认）

- 上个发布版 tag：`v1.8.0-beta.1`（2026-10-02）
- 当前 HEAD：`9b7e62b8`（main，与 origin/main 同步）
- 28 个变更提交 + 1 个 merge（`e4085f6d`，把 origin/main 的 #181 并入本地 4 提交）

## 目录结构与恢复顺序

1. `data/commits.md` — 全部提交与分组方案（数据已核对完毕）
2. `data/issue185-followup.md` — #185 后续补充的核查结论（已确认：补丁未应用、遗漏未修）
3. `data/baseline.md` — 当前 HEAD 自动化基线（check:editor 已过；git diff --check 仅工作区 AA 文件报冲突）
4. `parts/` — HTML 分段：`00-head.html`（head+css+侧栏）、`01..N-*.html`（各分区）、`99-tail.html`
5. 拼装：按文件名顺序组合 `parts/*.html`。后续模板升级可用
   `python tools/verification-checklist/build.py --refresh docs/verifications/261009_first-verification/maw-verification-v1.8.0b1-to-main.html`，
   保持标题、分区原文与核对项 ID；同步 parts 的头尾后再拼装，避免旧样式覆盖新功能。

## 中断恢复方法

- 每完成一个 part 就落盘；`parts/` 里已有的不用重写。
- 拼装后用浏览器打开，检查：目录生成、勾选持久化（localStorage 按页面标题隔离）、总数计数。
- checkbox id 规则：`p<PR号或组名>-<序号>`，必须全局唯一。

## 约定

- 分区结构：`<details class="section" open>` + summary（标题 + 类型徽标）+ body
  （只读摘要 table + 自述验证 note + 打勾项）。
- 打勾项写「入口 → 操作 → 预期」；间距类验收要求实测数据。
- 本批改了 `web/`，但按现行约定**不重生成 blank-editor.html**，在「后续操作」区写明发布前统一重生成。
- 工作区有一个无关 WIP：`docs/TEST_FEEDBACK_PR180.md` 处于 AA（未合并冲突）状态，
  属另一任务，不动、不提交，仅在清单工作区注记中提示。
