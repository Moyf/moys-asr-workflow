# 文稿对齐 FFmpeg 与设置入口反馈

基线：`main / 69bc534a`；相关修复已在本地提交，未推送。范围为 Windows FFmpeg 误选、对齐模型设置与文稿字幕入口，不改动开发启动脚本。

## 反馈处理

| 条目 | 状态 | 决定与结果 |
| --- | --- | --- |
| 1. 文稿对齐报 WinError 193 | 已修复 | worker 在 `maw/` 目录运行，Windows 的 PATHEXT 包含 `.PY` 时，`shutil.which("ffmpeg")` 会误选同目录的 `ffmpeg.py`。Windows 改为明确查找 `ffmpeg.exe` / `ffprobe.exe`，其他平台保持原名查找。模块不重命名。 |
| 2. Align 缺少设置入口 | 已修复 | 对齐模型说明下新增「管理对齐模型」，打开 AI 模型设置并选中工具箱当前模型；管理和下载不再依赖识别方式是否为本地模型。保留当前识别方式。 |
| 3. 清单全绿仍提示修复 | 仅说明 | 原截图运行时已安装版本 6、要求版本 7，因此 9/9 依赖条目存在仍不能代表运行时版本合格。本次未调整清单诊断展示。 |
| 4. 文稿对齐移到媒体工具 | 已修复 | 媒体工具提供「文稿匹配」，放在烧录字幕前、口播对齐前；字幕处理原「文稿匹配」更名为「文稿修正」，仅保留已有字幕的时间码生成，并在文稿修正顶部增加跨页指引。两个入口独立保留模型选择，新入口使用共享媒体输入和独立文稿参数。 |
| 5. 文稿修正与口播对齐是否重复 | 仅说明 | 文稿修正校正已有字幕；媒体工具的文稿匹配用于与准确文稿基本一致的录音；口播对齐处理重录和重复并支持人工选 take。本次不合并处理算法。 |
| 6. 工具箱名称与顺序 | 已修复 | 字幕处理排序为 AI 处理、OCR 去重、固定替换、文稿修正、生成时间码；媒体工具排序为文稿匹配、烧录字幕、口播对齐、提取音频、生成波形。 |

涉及源码：`maw/ffmpeg.py`、Launcher HTML / CSS、`launcher-local-models.js`、`launcher-notify-backend.js` 与中英文文案；回归覆盖在 `test_ffmpeg.py`、`test_gui_web.py`、`launcher-interactions.spec.mjs`。CHANGELOG 已补充整体行为。

## 验证证据

- Python：项目现有虚拟环境执行 `scripts/run_tests.py tests.test_ffmpeg tests.test_script_timestamp_alignment`，另加 GUI FFmpeg 路径的两个定向用例，共 36 项通过。外层使用 `scripts/run_check.py --timeout 90`；结果为 `.artifacts/checks/20261020T041257Z-405a3e3e/result.json`。
- 复现样例：从 worker 相同的 `maw/` 工作目录，用仓库 `examples/八百标兵绕口令` 的媒体与文稿调用 `check_script_alignment`，自动解析到 `ffmpeg.exe`，预处理通过：音轨 0、5725 ms、12 行文稿、1 个块。结果为 `.artifacts/checks/20261020T040953Z-d32db1e8/result.json`。没有写入样例目录。
- Launcher：`node scripts/build-launcher.mjs --write`、`--check` 与脚本语法检查通过。浏览器验证设置跳转、当前模型保留、中英文文案及云端识别下的模拟下载交互；截图已自查，上方间距实测 10 px、换行间距 8 px。结果为 `.artifacts/checks/20261020T041540Z-7100ebe2/result.json`。
- 源码契约：`scripts/run_tests.py tests.test_gui_web.GuiWebBridgeTests.test_launcher_toolbox_uses_primary_tabs_for_postprocessing_and_utilities tests.test_gui_web.LauncherAssetContractTests` 共 61 项通过，结果为 `.artifacts/checks/20261020T041632Z-cae8f695/result.json`。个人路径、LF 换行与 `git diff --check` 通过。
- 环境限制：最初系统 Python 3.14 跑扩展测试缺少 `send2trash`，随后改用项目已有虚拟环境通过。Chromium 首次被沙箱阻止启动，获准启动后通过；未安装或同步依赖。

## 未验证边界

真实样例仅验证 FFmpeg 音频预处理，未运行真实神经网络模型推理；模型下载使用浏览器 mock API。完整 Launcher 的真实模型输出仍需维护者重启后核验，见同目录清单。未验证打包产物或 CI，未生成便携 HTML。

## 入口移动时的追加验证（命名与排序调整前）

- 媒体入口移动后、名称与排序调整前的 Launcher 源码契约 62 项通过，替代更早移动前的 61 项；包含媒体工具入口、独立工具输入与现有口播对齐契约。结果：`.artifacts/checks/20261020T044353Z-ef1e4321/result.json`。
- 同一版本的浏览器定向 7 项通过：已有时间码设置保留、文稿生成字幕无源工程请求、检查与失效、双语指引、对齐模型设置、五列导航与键盘顺序、结果归属。结果：`.artifacts/checks/20261020T044318Z-9815729a/result.json`。其中运行模型和下载均使用 mock；截图已自查，指引与下一行的间距实测 12 px。
- 运行方式为 `scripts/run_check.py --timeout 150 -- node node_modules/@playwright/test/cli.js test tests/e2e/script-timestamp-alignment.spec.mjs tests/e2e/launcher-interactions.spec.mjs --project=chromium --workers=1 -g 'standalone script tool|script mode sends|input check needs|script controls have|script matching guidance|Utilities use a horizontal tab strip|alignment model shortcut'`；Python 契约使用同一外层运行器执行 `scripts/run_tests.py` 中上述两个 GUI 用例和 `LauncherAssetContractTests`。
- Launcher 已重建，脚本语法与 bundle 新鲜度检查通过；HTML/CSS 和用户指南已同步。前一轮 Python 契约的工具列表断言仍对应旧入口，已更新并在当前 62 项中通过。

架构分工补充到 `docs/user/ALIGNMENT_FEATURES.md`：文稿修正校正已有字幕，媒体工具的文稿匹配为准确文稿定位基本一致的录音，口播对齐审查重录候选。后续可用「口播选段 / 重录审查」进一步区分名称；本次保留既有口播入口和处理算法，不将不同输入假设合并到一个隐式模式。

## 名称与顺序调整

「字幕处理」标签顺序调整为 AI 处理 → OCR 去重 → 固定替换 → 文稿修正 → 生成时间码；「媒体工具」顺序调整为文稿匹配 → 烧录字幕 → 口播对齐 → 提取音频 → 生成波形。文稿修正顶部的跳转指引同步使用「媒体工具 / 文稿匹配」。

- Launcher bundle 重建、`--check` 新鲜度与脚本语法检查通过；源码静态顺序与中文标签契约通过，结果：`.artifacts/checks/20261020T050008Z-b889a164/result.json`。
- 浏览器定向 7 项本次重跑未能启动：Chromium `spawn EPERM`，结果：`.artifacts/checks/20261020T045830Z-8ad99a77/result.json`。这不是页面断言失败；上节的 7 项通过发生在本次名称与顺序改动之前。
- Python GUI 源码契约本次未运行：项目虚拟环境被沙箱拒绝启动（`uv trampoline` 权限错误）；系统 Python 3.14 缺少 `send2trash`，结果：`.artifacts/checks/20261020T045811Z-6607a835/result.json` 与 `.artifacts/checks/20261020T050008Z-d0790505/result.json`。
