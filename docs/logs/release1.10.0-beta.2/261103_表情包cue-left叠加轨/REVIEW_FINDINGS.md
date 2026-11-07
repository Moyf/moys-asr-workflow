# 表情包 cue-left 叠加字幕轨修复 — 提交前自审

日期：2026-11-03　分支：`investigate/sticker-cue-left-overlay-track`（基于 main `f3f45273`）
审查方式：未参与实现的后台 subagent 通读全部 diff，实现者只回答提问。

## 调查结论

- **不生效**：cue-left 贴放候选集只收排版计划 `role === 'main'`（主轨）条目；叠加字幕轨条目 role 为 `'overlay'`（`web/shared/utils/ass-export.js:409` 进入同一份计划并烧录进 ASS），被排除在候选集外。表情包窗口收集本就覆盖双轨（`web/editor/media/editor-sticker-overlay.js:82-83`），窗口与叠加轨字幕重叠而主轨空窗的时段被判为句间空隙段，回退固定位置。
- **根因层**：placement 计算（`web/shared/utils/sticker-placement.js`）没读叠加轨 cue。编辑器 payload（`buildBurnVideoSubtitles` 传入的 plan 与窗口）与烧录服务端（`server-editor/serve.py` 只做校验 + contain 适配，不计算 cue 位置）均无需改动。

## 修复摘要

`sticker-placement.js`：cue 收集加入 `role === 'overlay'`（role 随 cue 传递）；段匹配改 `covering('main') || covering('overlay')`（主轨优先、叠加轨兜底）；`cueLeftBox` 按 `cue.role` 匹配承载条目。回退规则（legacy / 移动段 / 越界）不变。同屏多张仍按窗口时间先后「先到先得」占用。附 hint/i18n/注释/CHANGELOG 同步与 4 个新单测。

## Findings 处置

| # | 级别 | 内容 | 处置 |
| --- | --- | --- | --- |
| 1 | minor | `occupied` 整窗占用粒度：部分贴上字幕的窗口把整窗记入占用，重叠的第二张图即使非同屏时段也整窗回退固定位置（如 A[0,1000] 贴上后 B[500,1500] 的 [1000,1500] 段落固定框）。既有行为，本次修复让第一窗更容易贴上、更常触发；与 hint「同屏多张时固定位置居中叠放」的文档化规则一致。 | 接受为既有设计；如需细化改为记录子区间，另行任务。 |
| 2 | nit | 新增 legacy 回退用例在旧代码上也通过：守的是「叠加轨句 legacy 排版回退固定位置」的用户可见契约，而非「legacy slice 不收集 cue」机制。 | 保留（契约守护有效）；机制侧已有 `item.legacy` 拒绝兜底。 |
| 3 | nit | 「主轨不可贴（manual/legacy）+ 叠加轨可贴」同屏组合无用例：按段匹配短路整段回退固定位置，符合文档语义（仅主轨空窗才用叠加轨），但无测试锁定。 | 接受；行为由 `covering('main') \|\| covering('overlay')` 语义保证，如后续调整优先级规则再补用例。 |

无 blocker / major，放行提交。

## 验证与双向回归

- `node --test tests/*.mjs` 全量 1002 pass / 0 fail（TMPDIR 指向 `.artifacts/tmp`）。
- `node --test tests/test_sticker_placement.mjs` 21/21（新增 4 用例）；临时还原 `sticker-placement.js` 至 HEAD 重跑：2 个新用例真实失败（叠加轨不生效行为复现），守护用例（主轨优先 / legacy 回退）修复前后均过；已恢复原状并重建 bundle。
- 全量 Python `scripts/run_tests.py` 2803 OK（skipped 19 为既有环境性跳过）；`pnpm run check:editor` bundle 新鲜；`git diff --check` 干净、全 LF。
- 未重生成 `blank-editor.html`（按现行约定，发布前统一重生成）；e2e 未跑（改动为纯 placement 计算，单测已覆盖，浏览器实机确认点见报告）。
