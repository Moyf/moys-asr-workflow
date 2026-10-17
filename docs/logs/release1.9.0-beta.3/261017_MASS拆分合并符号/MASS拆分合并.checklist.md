---
task: mass-split-merge-symbols
date: 2026-10-17
status: pending
---

# MASS 拆分/合并符号修复核对

> 范围：单词型合并折叠句级/行内符号对、渐进拆分左半句补全、整句壳与行内标记区分。基线 `feat/ass-style-line-spacing` / `af141848`。自动化：单测 34 项、Node 全量 814 项（1 项既有失败与本任务无关）、e2e 9 项通过；以下为浏览器实操项。

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
- Node 全量：814 通过 / 1 失败 / 1 跳过；失败为 ASS 导出字节哈希，回退本任务文件后依旧失败，属同工作树 `ass-style.js` 在途改动，非本任务引入。
- e2e：`editor-text-tools.spec.mjs` progressive/duplicate 9 项通过。
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
  （操作）选中 `!!重新开始!!` 字幕，光标放在「重」之后按 Shift+B 渐进拆分；再用星号强调对包裹的同句重复一次。
  （预期）左半句为 `!!重!!`（或星号对完整包裹的「重」），右半句保持整句原文；字词时间码不丢。
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
3. `96685652` 改动 `ass-style.js` 后 `tests/test_ass_cue_position.mjs` 的导出字节 golden 哈希未同步（与本任务无关的既有红灯），请该工作收口时更新。
