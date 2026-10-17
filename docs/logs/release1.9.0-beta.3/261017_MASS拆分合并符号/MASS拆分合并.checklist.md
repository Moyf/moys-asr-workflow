---
task: mass-split-merge-symbols
pr: 264
date: 2026-10-17
updated: 2026-10-18
status: pending
---

# MASS 拆分/合并符号修复核对

> 范围：单词型合并折叠句级/行内符号对、渐进拆分左半句补全、整句壳与行内标记区分。PR 基线 `f98311b0`：Linux CI Node 815 项、浏览器选定集 56 项通过；合并前补验见下文，以下勾选项仍为人工实操。

## 实现与审查结论
<!-- id: implementation -->
<!-- badge: fixed 已修复 -->

单词型合并：`joinSegmentTextsMassFold` 去掉 `separator === ''` 门槛，分隔符作为 joiner 参与折叠复验并插回 junction，items 层同步裁符号、归位分隔符。

渐进拆分：`buildSplitPair` / `splitAtCursor` / 联动弹窗预览三处与普通拆分同走刀点吸附 + 补齐，仅采用左段补齐结果，右段保留整句原文。

整句区分：`!!` 走新增 `shakeShellPair` 句级折叠（`parseSentenceShakeMarkers` 复验），移出行内折叠列表；fade 原有句级分支不变。

## 自动化验证结果
<!-- id: automated -->
<!-- badge: pass 通过 -->

- 单元测试：`node --test tests/test_mass_markers.mjs tests/test_split_style_markers.mjs` 34 项通过（含新增维护者场景用例）。
- PR 独立基线：`f98311b0` 的 [Linux CI](https://github.com/Moyf/moys-asr-workflow/actions/runs/39045077748) Node 815 项全部通过、无失败或跳过；选定浏览器集 56 项通过。开发期间混合工作树的 ASS 字节基线失败属于历史记录，不是当前 PR 的失败。
- e2e：`editor-text-tools.spec.mjs` progressive/duplicate 9 项通过。
- 合并前补验：`node --test tests/test_mass_markers.mjs tests/test_split_style_markers.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` 36 项通过；`split-style-markers.spec.mjs` 16 项通过（无跳过或重试），包含主轨和联动的普通/渐进/复制模式，覆盖 `!!` 预览与提交一致。
- 产物：editor bundle 已重建，`pnpm run check:editor` 新鲜；`git diff --check` 干净。

## 人工核验
<!-- id: manual-checks -->
<!-- badge: todo 待核查 -->

- [ ] **单词型合并还原整句壳**
  （操作）打开示例工程（英文、单词型），选中 `!!This is a!!` 与 `!!short test video!!` 两条字幕 → 右键合并。
  （预期）合并为一条 `!!This is a short test video!!`，不再出现 `!!This is a!! !!short test video!!`；字词时间码保留，预览震动效果覆盖整句。
  <!-- id: merge-word-shake -->
- [ ] **单词型合并折叠行内符号对**
  （操作）两条带星号强调对的英文短句（如 This is a 与 short test video 各自被同一对双星号包裹）按单词型合并；再用单星号对重复一次。
  （预期）各自还原成一个完整样式对，不再出现成对重复的符号；字词时间码保留。
  <!-- id: merge-word-inline -->
- [ ] **字符型合并行为不变**
  （操作）中文工程（字符型）合并两条各带星号强调对的字幕，以及不带符号的两条中文合并。
  （预期）前者折叠为一个完整样式对（如 甲乙 共用一对），后者直接拼接为「甲乙」，与升级前一致。
  <!-- id: merge-continuous-regression -->
- [ ] **渐进拆分两侧补全**
  （操作）选中 `!!重新开始!!` 字幕，光标放在「重」之后按 Shift+B 渐进拆分；再用星号强调对包裹的同句重复一次，并在绑定副轨时检查拆分弹窗。
  （预期）左半句为 `!!重!!`（或星号对完整包裹的「重」），右半句保持整句原文；弹窗预览与确认后的文本一致，副轨仍按普通拆分补齐；字词时间码不丢。
  <!-- id: progressive-complete -->
- [ ] **渐进拆分切点贴符号时吸附**
  （操作）光标放在句首符号内部或紧贴符号处做渐进拆分。
  （预期）切点吸附到符号外侧，左半句不产生只有开符号的孤儿字幕；无法形成两侧正文的切点按普通拆分同规则拒绝并提示。
  <!-- id: progressive-snap -->
- [ ] **复制拆分与普通拆分不受影响**
  （操作）对带星号强调对的字幕分别做 Ctrl/Cmd+Shift+B 复制拆分和普通拆分。
  （预期）复制拆分两侧都是整句原文；普通拆分两侧各自补齐，行为与升级前一致。
  <!-- id: duplicate-normal-regression -->

## 后续操作
<!-- id: followup -->
<!-- badge: todo 待办 -->

1. 核验完成后把勾选项改为 `- [x]`，front-matter `status` 更新为 `partial` / `passed`。
2. `blank-editor.html` 按约定发布前统一重生成，本任务不提交。
3. 合入前在更新后的 main 上核对最终 head 的 CI；与其他 PR 组合后的验证另行记录。
