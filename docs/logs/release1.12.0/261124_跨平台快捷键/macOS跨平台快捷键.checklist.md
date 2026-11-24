---
task: mac-shortcut-gaps
date: 2026-11-24
status: pending
---

# macOS 跨平台快捷键核对 · 2026-11-24

> 范围：口播对照工具 Cmd+点击跳转卡片修复、编辑器与对照工具的 Alt→Option 提示适配、Alt+拖动创建空隙回归用例。基线 1.12.0（分支 Moyf/fix-mac-shortcut-gaps）。自动化验证全绿（node 441、python 3510、e2e 12/12，含双向红绿证据）；macOS 实测基于本机 Chromium+WebKit，Windows 侧由 CI 矩阵覆盖。

## 实现 / 审查结论
<!-- id: implementation -->
<!-- badge: fixed 只读 -->

- 对照工具 take 块的「Ctrl+单击跳到下方卡片」原先只判断 ctrlKey，macOS 上 Cmd+点击无效；已改为 ctrlKey 或 metaKey。
- 「Mac 不支持 Alt+拖动创建空隙」前提经代码链路与双引擎实测证伪：手势只读 event.altKey，无平台分支；本批未改手势代码，只补 e2e 回归。
- Alt→Option 文案复用既有 Cmd 标签机制（altKeyLabel / data-alt-key / ALT_KEY_LABEL），Windows/Linux 零变化；i18n 词典补 Option 条目，中英往返不漏字。
- 独立审查无 blocker/major；3 个 minor 中容差已修复，Alt 标签遗留覆盖点（模板 title/aria、英文词典旧条目）与文档注记缺口已知并披露于 PR 边界段。详见同目录 REVIEW_FINDINGS.md。

## 自动化验证结果
<!-- id: automated -->
<!-- badge: fixed 只读 -->

- `node scripts/build-editor.mjs --write` + `pnpm run check:editor`：bundle 新鲜。
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_waveform_js.mjs`：441 pass / 0 fail。
- `pnpm run typecheck`：通过。
- `uv run --no-sync python scripts/run_tests.py`：3510 tests OK（skipped=26，合并 origin/main 后的全量）。
- Playwright（macOS chromium）：gap-range-drag 2/2、server-align 6/6、onboarding 4/4。
- 双向验证：移除 Alt 分支 → gap 用例红；还原 ctrlKey-only → Cmd 用例红；均还原复绿。
- `git diff --check`、`scripts/check_personal_paths.py --diff-ref origin/main`：通过。

## 人工核验：macOS（在 Mac 上操作）
<!-- id: manual-macos -->
<!-- badge: todo 待核查 -->

- [ ] **Option+拖动创建静音空隙**
  （操作）编辑器打开任一工程 → 波形空白处按住 Option+左键横向拖出一段 → 松开。
  （预期）出现橙色斜纹空隙块，提示「已人工移除所选范围」；Cmd+Z 可撤销。
  <!-- id: mac-01 -->
- [ ] **帮助面板显示 Option 而非 Alt**
  （操作）帮助面板 → 「空隙操作」页签。
  （预期）快捷键显示为「Option+点击」「Option+左键拖动」「Option+中键拖动」；切到英文界面后显示 Option+left-drag，切回中文不漏英文或异常。
  <!-- id: mac-02 -->
- [ ] **静音空隙面板与右键菜单提示**
  （操作）静音空隙工具窗有扫描结果时看底部摘要行；字幕列表任一条右键看菜单提示。
  （预期）摘要含「Option+点击切换，空白处 Option+左键拖动增加」；菜单「禁用此条」提示列显示 Option+点击。
  <!-- id: mac-03 -->
- [ ] **对照工具 Cmd+点击跳转卡片**
  （操作）Launcher 打开文稿匹配对照 → 底部时间线按住 Cmd+单击任一候选块。
  （预期）页面滚动到下方对应卡片并短暂高亮（jump-target），候选采用状态不变；帮助行文案显示 Ctrl/Cmd+单击。
  <!-- id: mac-04 -->

## 人工核验：Windows（确认零回归）
<!-- id: manual-windows -->
<!-- badge: todo 待核查 -->

- [ ] **Windows 上 Alt 提示与手势不变**
  （操作）编辑器帮助面板「空隙操作」+ 波形空白处 Alt+左键拖动。
  （预期）帮助仍显示「Alt+点击 / Alt+左键拖动」（不出现 Option 字样）；拖动照常创建空隙。
  <!-- id: win-01 -->
- [ ] **对照工具 Ctrl+点击跳转不变**
  （操作）对照工具底部时间线 Ctrl+单击候选块。
  （预期）仍跳转并高亮下方卡片，采用状态不变。
  <!-- id: win-02 -->

## 后续步骤
<!-- id: next -->
<!-- badge: todo 待跟进 -->

- PR 审阅合并后，把本清单勾选结果回写源文件并更新 status。
- 遗留披露项（模板 title/aria 的 Alt 字面量、英文词典旧条目、MULTI_SUBTITLE 文档注记）留待后续小批量统一处理。
