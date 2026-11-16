# 波形显示设置反馈

基线：`fix/弹窗编辑改进`，HEAD `a1ea0ce2`；工作区存在先前任务及并行改动，须保留。
状态取值：待处理、进行中、已修复、仅说明、阻塞。

| # | 问题 | 状态 | 核实结论/方案 |
| --- | --- | --- | --- |
| 1 | 「实时生成补间」像「频谱颜色」一样显示在列表右边、同一行；选择「隐藏画面带」时不显示。两个 checkbox 与左侧多留一些空间。 | 已修复 | 位于视频缩略图选择旁；隐藏模式隐藏该项，关键帧模式保留但禁用。中英文浏览器实测左右间距均 20px。 |
| 2 | 波形区设置的「显示」下新增「字幕块悬浮时显示完整文本」开关，默认开启，可关闭 hover tooltip。 | 已修复 | 主轨、副轨、叠加轨共用开关；旧偏好缺字段时默认开启，使用本机波形偏好保存。 |
| 3 | 开关改名为「悬浮时显示完整文本」，同时控制字词块的悬浮提示。 | 已修复 | 保留现有偏好字段；字词块原有提示含全文和时间，关闭时隐藏该提示，字词边界操作说明保留。 |

## 阶段汇总

- 已核对现有未提交改动；保留先前字词双击修复及并行工作。涉及模板、波形设置与渲染、翻译、样式、用户指南、更新日志及针对性浏览器测试。
- 构建：`node scripts/build-editor.mjs --write`、`node scripts/build-editor.mjs --check` 均通过；类型检查 `node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json` 通过。分别经 `scripts/run_check.py` 执行，记录见 `.artifacts/checks/20261109T082242Z-20cde846/result.json`、`.artifacts/checks/20261109T082341Z-54fe7109/result.json`、`.artifacts/checks/20261109T082339Z-338f8eb1/result.json`。
- 单元：`node --test tests/test_waveform_display_presets.mjs` 15 项通过，记录 `.artifacts/checks/20261109T082242Z-c6c8c5bd/result.json`。
- 浏览器：`node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium tests/e2e/waveform-display-settings.spec.mjs` 通过；覆盖旧设置默认值、三轨、实际悬浮、关闭后刷新恢复、下拉模式切换和中英文间距以及 360px 窄窗口内同一行横向滚动。记录 `.artifacts/checks/20261109T083015Z-6099ce79/result.json`。既有 `filmstrip.spec.mjs -g 'filmstrip preserves the waveform region'` 通过，记录 `.artifacts/checks/20261109T082741Z-0522f9c5/result.json`。
- 间距：中英文中两个复选框与左侧控件间均 20px，补间与选择框中心线相差 0px；新开关与上下控件间分别 25px、16.5px。已检查截图 `.artifacts/waveform-display-settings/waveform-settings-zh.png` 和 `waveform-settings-en.png`。
- 测试过程：沙箱内 Python trampoline 返回权限拒绝，获得执行权限后通过。悬浮测试曾两次失败：一次指针实际落在副字幕，另一次缩略图模式切换后异步重建目标；分别调整断言对象和测试时机，最终通过。
- 待人工验收：在真实视频工程中切换三种缩略图模式，并悬浮主、副及叠加字幕块确认体验；自动化使用合成媒体与模拟画面带。未生成 `blank-editor.html`，未提交。
- 追加字词范围：重建编辑器 bundle（`.artifacts/checks/20261109T083302Z-64e578ab/result.json`），新鲜度检查通过（`.artifacts/checks/20261109T083345Z-27262339/result.json`）；波形设置 Playwright 两项通过（`.artifacts/checks/20261109T083319Z-13f5aceb/result.json`），覆盖默认开启、真实悬浮、单行及多行关闭、刷新持久化、重开及中英文文案。检查中英文截图并重新实测上下间距分别 25px、16.5px；仍待真实工程人工验收。
