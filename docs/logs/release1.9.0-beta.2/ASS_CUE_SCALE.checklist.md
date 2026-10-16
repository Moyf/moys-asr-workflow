---
task: ass-cue-scale
pr: 248
date: 2026-10-16
updated: 2026-10-16
status: partial
---

# 主字幕单句缩放核对

> 基线 `2cc67041`；PR #248 已打开。自动化与本机合成工程交互已通过；此清单保留给维护者复核四角手势、真实工程及 PR 反馈。

## 实现 / 审查结论
<!-- id: implementation-review -->

单句倍率保存在 `assOverride.scale`，与 `pos` 分开；仅缩放时继续沿用全局 anchor 和自动排布。ASS 导出偏移只应用组适配倍率一次，文字效果和震动幅度应用组适配倍率与单句倍率的乘积。滚轮要求当前选中主字幕可见；滚轮事务在其它命令快照开始前提交。X/Y 为整数，倍率显示两位小数。功能尚未发布，因此没有旧工程迁移步骤。

## 自动化验证结果
<!-- id: automated-verification -->

- [x] **编辑器 bundle**：重建后运行 `node scripts/build-editor.mjs --check`；预期：显示 `Editor bundle is fresh` <!-- id: bundle-freshness -->
- [x] **类型检查**：运行 `node node_modules/typescript/bin/tsc --project tsconfig.typecheck.json`；预期：以退出码 0 完成 <!-- id: typecheck -->
- [x] **Node 契约测试**：用 `scripts/run_check.py --timeout 180` 运行编辑器脚本顺序、缩放定位、Canvas 排布、命令隔离与震动测试；预期：57 项通过 <!-- id: node-tests -->
- [x] **Python 契约测试**：用 `scripts/run_check.py --timeout 180` 运行 `scripts/run_tests.py tests/test_ass_cue_position.py`；预期：4 项通过 <!-- id: python-tests -->
- [ ] **浏览器 e2e**：运行 `tests/e2e/ass-cue-position.spec.mjs --project=chromium`；预期：16 项通过，涵盖九锚点、横竖屏、震动、libass / ASS 帧、滚轮可见性、命令事务与缩放堆叠；CI 已修复 FFmpeg 缺失，但 6 个像素对照失败于默认 venv 缺少 Pillow；Pillow 已加入 dev 组，待新 CI 验证 <!-- id: e2e -->
- [x] **差异空白检查**：运行 `git diff --check`；预期：无空白错误 <!-- id: diff-check -->

## 人工核验
<!-- id: manual-acceptance -->

- [ ] **单击与拖动**：选中 ASS 主字幕后先原地点选定位框，再拖动字幕；预期：原地点选不写位置也不新增撤销，实际拖动后才显示整数 X/Y 且一次撤销恢复 <!-- id: select-and-drag -->
- [ ] **四角缩放**：依次从四个角拖动 handle；预期：字幕整体等比缩放，锚点保持全局样式设置，缩放本身不创建逐句位置 <!-- id: four-corners -->
- [ ] **滚轮区域**：鼠标放在实际视频画面内滚动，再移到黑边和视频外滚动；预期：仅视频画面内调整选中主字幕倍率，快捷键与黑边不触发缩放 <!-- id: wheel-region -->
- [ ] **两种重置**：同时设置倍率与位置后分别点「重置大小」和「重置定位」；预期：每次只清理对应字段，另一个字段保持；归零后两组控件隐藏 <!-- id: independent-resets -->
- [ ] **取消手势**：拖动 handle 时按 Esc，再拖动时切换窗口焦点；预期：两次操作都恢复手势开始状态，不留下缩放或撤销记录 <!-- id: cancel-gestures -->
- [ ] **真实工程与播放器**：打开维护者常用工程检查动画、句内字号、描边和目标播放器；预期：预览与 ASS 输出可接受且不把震动瞬时偏移写回位置 <!-- id: real-project-player -->

## 修复与提交记录
<!-- id: fixes-and-pr -->

- [x] **提交与 PR**：查看本分支提交和 PR 文件列表；预期：只包含本功能源码、测试、文档和本清单，没有 bundle、便携页、媒体或个人路径 <!-- id: review-pr-scope -->
- [ ] **PR CI 与反馈**：查看安装 FFmpeg、Pillow 后的新 CI 与三条 Greptile inline thread；预期：确认新增 e2e 与缩放后自动堆叠帧对照通过，记录实际结果，再回复或解决已验证的线程 <!-- id: review-feedback -->

## 后续操作
<!-- id: follow-up -->

- 查看 PR 描述中的验证与未验证边界；`blank-editor.html` 留待发布前统一重生成。
- 完成真实工程与播放器验收后，将对应项目勾选并把 front-matter `status` 更新为 `partial` 或 `passed`。
