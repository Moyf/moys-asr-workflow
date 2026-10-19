---
task: ass-cue-scale
pr: 248
date: 2026-10-16
updated: 2026-10-17
status: pending
---

# 主字幕单句缩放核对

> 已组合 main 24c6b202；本轮 56 项浏览器、67 项 Python 和 34 项 Node 验证通过，三条 Greptile 反馈已逐条复核。人工体验仍待确认，最终 CI 与合并状态见 PR 评论。

## 实现 / 审查结论
<!-- id: implementation-review -->

单句倍率保存在 `assOverride.scale`，与 `pos` 分开；仅缩放时继续沿用全局 anchor 和自动排布。ASS 导出偏移只应用组适配倍率一次，文字效果和震动幅度应用组适配倍率与单句倍率的乘积。滚轮要求当前选中主字幕可见；滚轮事务在其它命令快照开始前提交。X/Y 为整数，倍率显示两位小数。功能尚未发布，因此没有旧工程迁移步骤。

2026-10-17 复审已核对三条 Greptile 原意见、对应修复和线程状态。原有自动化记录改为只读说明，六项人工勾选及稳定 ID 保留，pending 仅代表人工验收未完成。新增检查覆盖 Python 与 JavaScript 在精确小数边界的倍率规范化一致性；额外震动手势疑点未复现，不作为已确认缺陷。

## 自动化验证结果
<!-- id: automated-verification -->

编辑器 bundle：重建后运行 `node scripts/build-editor.mjs --check`；预期：显示 `Editor bundle is fresh`
类型检查：运行 `node node_modules/typescript/bin/tsc --project tsconfig.typecheck.json`；预期：以退出码 0 完成
Node 契约测试：用 `scripts/run_check.py --timeout 180` 运行编辑器脚本顺序、缩放定位、Canvas 排布、命令隔离与震动测试；预期：57 项通过
Python 契约测试：用 `scripts/run_check.py --timeout 180` 运行 `scripts/run_tests.py tests/test_ass_cue_position.py`；预期：4 项通过
浏览器 e2e：提交 `c03bf021` 的 Editor workflow run `38875181279` 运行 `tests/e2e/ass-cue-position.spec.mjs --project=chromium`；预期：29 项通过，涵盖九锚点、横竖屏、震动、libass / ASS 帧、滚轮可见性、命令事务与缩放堆叠；实际：29/29 通过。10 行夹具在字号 90 下未触发自动适配，最终设为字号 150 后通过
差异空白检查：运行 `git diff --check`；预期：无空白错误

2026-10-17 当前组合验证：67 项 Python、34 项 Node 通过；单独 18 项 ASS Chromium 与组合后的四个 spec 共 56 项 Chromium 测试通过，包含九锚点、横竖屏、Canvas／Server libass／导出实际帧、滚轮可见性及事务隔离。Pillow 按本 PR 锁文件版本放在临时依赖目录；FFmpeg 使用本机已有的 libass 构建，未修改共享虚拟环境。倍率 1.125 的跨语言舍入不一致已复现并统一；震动起终点及不同移动事件次数的探针通过，不将疑点记为缺陷。

## 人工核验
<!-- id: manual-acceptance -->

- [ ] **点选不写位置，拖动才形成一次撤销**
  （操作）单击与拖动：选中 ASS 主字幕后先原地点选定位框，再拖动字幕
  （预期）原地点选不写位置也不新增撤销，实际拖动后才显示整数 X/Y 且一次撤销恢复
  <!-- id: select-and-drag -->
- [ ] **四角整体缩放且不创建单句位置**
  （操作）四角缩放：依次从四个角拖动 handle
  （预期）字幕整体等比缩放，锚点保持全局样式设置，缩放本身不创建逐句位置
  <!-- id: four-corners -->
- [ ] **滚轮仅在实际视频画面内缩放**
  （操作）滚轮区域：鼠标放在实际视频画面内滚动，再移到黑边和视频外滚动
  （预期）仅视频画面内调整选中主字幕倍率，快捷键与黑边不触发缩放
  <!-- id: wheel-region -->
- [ ] **大小与位置可独立重置**
  （操作）两种重置：同时设置倍率与位置后分别点「重置大小」和「重置定位」
  （预期）每次只清理对应字段，另一个字段保持；归零后两组控件隐藏
  <!-- id: independent-resets -->
- [ ] **取消手势恢复开始状态**
  （操作）取消手势：拖动 handle 时按 Esc，再拖动时切换窗口焦点
  （预期）两次操作都恢复手势开始状态，不留下缩放或撤销记录
  <!-- id: cancel-gestures -->
- [ ] **真实工程的动画与播放器表现一致**
  （操作）真实工程与播放器：打开维护者常用工程检查动画、句内字号、描边和目标播放器
  （预期）预览与 ASS 输出可接受且不把震动瞬时偏移写回位置
  <!-- id: real-project-player -->

## 修复与提交记录
<!-- id: fixes-and-pr -->

提交与 PR：查看本分支提交和 PR 文件列表；预期：只包含本功能源码、测试、文档和本清单，没有 bundle、便携页、媒体或个人路径
PR CI 与反馈：检查 Editor run `38875181279`、Python lint run `38875181328`、Windows 预览包 run `38875181281` 与三条 Greptile inline thread；预期：记录实际验证并处理反馈；实际：三个 workflow 均通过，三条线程已回复并解决

## 后续操作
<!-- id: follow-up -->

- 查看 PR 描述中的验证与未验证边界；`blank-editor.html` 留待发布前统一重生成。
- 完成真实工程与播放器验收后，将对应项目勾选并把 front-matter `status` 更新为 `partial` 或 `passed`。
