# ASS 逐字换色底框：提交前自审

- 比较基线：`main`（`e7889e2f`）。
- 负对照：仅添加回归测试、不改导出实现时，双事件结构与逐字换色像素用例均失败，已有说话人底框用例通过。
- 正对照：修复后，`node --test tests/test_ass_speaker_box.mjs tests/test_ass_karaoke.mjs` 通过；libass 实测截图对应的七字句无深色接缝，换色时刻保持不变，自动换行时底框与文字对齐。
- Chromium：首次实际帧提示在请求挂起时可见，字号 16 px、行高 24 px，与底部按钮区的垂直距离不少于 8 px，渲染完成后隐藏；同轮普通 ASS 和说话人 ASS 浏览器下载验证通过。早先因服务启动时下载依赖超时未执行到下载步骤，依赖就绪后复验通过。

## 独立审查结论

- 无 blocker / major。独立审查复跑 `tests/test_ass_speaker_box.mjs`，Windows 上 9 项通过；内存替换回基线导出器后，新增双事件测试按预期失败。
- **Minor，接受**：此前关闭自动渲染时，首次打开不会主动请求实际帧（`web/editor/styles/editor-wiring-ass-frame.js` 的打开窗口回调）。审查者用现有 fixture 探针确认打开后请求数为 0，点击可见的「渲染当前帧」后为 1。按维护者指定保留提示原文；手动按钮及其行为不变。
- **额外检查失败**：独立审查运行 `tests/test_ass_frame_font_wait.mjs` 时，11 项因 fixture 缺少 `global.addEventListener` 失败；该 fixture 和触发调用不在本 PR 改动范围内。

## 验证边界

- 内联字号或字体切换、自定义变换无法安全合并时保留既有输出，不将这些语句宣称为已消除底框重叠。
- 本地实测为 Windows；未运行 macOS / Linux 的完整矩阵。
