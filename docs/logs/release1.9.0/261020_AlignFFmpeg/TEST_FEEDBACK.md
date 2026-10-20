# 文稿对齐 FFmpeg 与设置入口反馈

基线：本地 `origin/main / 0b61b87c`；分支包含 `69bc534a` 的 Launcher 开发启动改进、`54d10fc7` 的文稿对齐和工具箱入口，以及本次运行状态提示优化。任务账本同时记录 Windows FFmpeg 误选、模型管理和文稿工具入口反馈。

## 反馈处理

| 条目 | 状态 | 决定与结果 |
| --- | --- | --- |
| 1. 文稿对齐报 WinError 193 | 已修复 | worker 在 `maw/` 目录运行，Windows 的 PATHEXT 包含 `.PY` 时，`shutil.which("ffmpeg")` 会误选同目录的 `ffmpeg.py`。Windows 改为明确查找 `ffmpeg.exe` / `ffprobe.exe`，其他平台保持原名查找。模块不重命名。 |
| 2. Align 缺少设置入口 | 已修复 | 对齐模型说明下新增「管理对齐模型」，打开 AI 模型设置并选中工具箱当前模型；管理和下载不再依赖识别方式是否为本地模型。保留当前识别方式。 |
| 3. 清单全绿仍提示修复 | 已修复 | 运行时卡片现在显示旧版与要求版本（如 6 → 7）、已检测依赖数和新版验证状态，操作按钮改为「升级并验证运行环境」；清单状态也显示具体升级版本。对齐模型单独呈现「已下载／未下载」，并仅在其运行依赖确实缺失时补充「缺少依赖」，不再用通用修复状态掩盖原因。 |
| 4. 文稿对齐移到媒体工具 | 已修复 | 媒体工具提供「文稿匹配」，放在烧录字幕前、口播对齐前；字幕处理原「文稿匹配」更名为「文稿修正」，仅保留已有字幕的时间码生成，并在文稿修正顶部增加跨页指引。两个入口独立保留模型选择，新入口使用共享媒体输入和独立文稿参数。 |
| 5. 文稿修正与口播对齐是否重复 | 仅说明 | 文稿修正校正已有字幕；媒体工具的文稿匹配用于与准确文稿基本一致的录音；口播对齐处理重录和重复并支持人工选 take。本次不合并处理算法。 |
| 6. 工具箱名称与顺序 | 已修复 | 字幕处理排序为 AI 处理、OCR 去重、固定替换、文稿修正、生成时间码；媒体工具排序为文稿匹配、烧录字幕、口播对齐、提取音频、生成波形。 |
| 7. PR 281：工具箱顺序契约导致 CI 失败 | 已修复 | Python 断言按文稿匹配 → 烧录字幕 → 隐藏 FFconcat → 口播对齐检查；Node 契约定位实际的导航容器。Python 定向 1 项和 Node 27 项通过，结果为 `.artifacts/checks/20261020T070408Z-658dc5e8/result.json`、`.artifacts/checks/20261020T070539Z-6c4269fe/result.json`。 |
| 8. PR 281：选中对齐模型不显示缺失依赖 | 已修复 | 两处状态渲染保留完整状态；管理面板与识别后对齐选择器均显示缺依赖原因和设置链接。浏览器定向通过，结果为 `.artifacts/checks/20261020T070939Z-d139d1b8/result.json`。 |
| 9. PR 281：云端识别模式无法配置本地运行环境 | 已修复 | 面板、刷新、安装与识别方式解耦；云端模式使用共享运行环境 ID，安装并下载对齐模型后保留原识别方式及 ASR 模型。修复模型刷新抢先完成时未刷新升级清单的问题。浏览器相关 5 项通过，结果同条目 8。 |
| 10. 子代理复审：云端模式安装失败后状态滞留 | 已修复 | 成功、取消和错误事件均刷新云端模式的运行环境，避免缓存仍为 installing；新增安装失败及取消错误码的浏览器回归通过，结果为 `.artifacts/checks/20261020T071347Z-7f720d2c/result.json`。 |

涉及源码：`maw/ffmpeg.py`、Launcher HTML / CSS、`launcher-local-models.js`、`launcher-notify-backend.js` 与中英文文案；回归覆盖在 `test_ffmpeg.py`、`test_gui_web.py`、`launcher-interactions.spec.mjs`。CHANGELOG 已补充整体行为。

## 验证证据

- Python：项目现有虚拟环境执行 `scripts/run_tests.py tests.test_ffmpeg tests.test_script_timestamp_alignment`，另加 GUI FFmpeg 路径的两个定向用例，共 36 项通过。外层使用 `scripts/run_check.py --timeout 90`；结果为 `.artifacts/checks/20261020T041257Z-405a3e3e/result.json`。
- 复现样例：从 worker 相同的 `maw/` 工作目录，用仓库 `examples/八百标兵绕口令` 的媒体与文稿调用 `check_script_alignment`，自动解析到 `ffmpeg.exe`，预处理通过：音轨 0、5725 ms、12 行文稿、1 个块。结果为 `.artifacts/checks/20261020T040953Z-d32db1e8/result.json`。没有写入样例目录。
- Launcher：`node scripts/build-launcher.mjs --write`、`--check` 与脚本语法检查通过。浏览器验证设置跳转、当前模型保留、中英文文案及云端识别下的模拟下载交互；截图已自查，上方间距实测 10 px、换行间距 8 px。结果为 `.artifacts/checks/20261020T041540Z-7100ebe2/result.json`。
- 源码契约：`scripts/run_tests.py tests.test_gui_web.GuiWebBridgeTests.test_launcher_toolbox_uses_primary_tabs_for_postprocessing_and_utilities tests.test_gui_web.LauncherAssetContractTests` 共 61 项通过，结果为 `.artifacts/checks/20261020T041632Z-cae8f695/result.json`。个人路径、LF 换行与 `git diff --check` 通过。
- 环境限制：最初系统 Python 3.14 跑扩展测试缺少 `send2trash`，随后改用项目已有虚拟环境通过。Chromium 首次被沙箱阻止启动，获准启动后通过；未安装或同步依赖。

## 未验证边界

真实样例仅验证 FFmpeg 音频预处理，未运行真实神经网络模型推理；模型下载使用浏览器 mock API。完整 Launcher 的真实模型输出仍需维护者重启后核验，见同目录清单。未验证打包产物或 CI，未生成 `blank-editor.html` 内联副本。

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

## 运行环境与对齐模型状态提示

- Launcher bundle 重建与 `--check` 通过；`test_launcher_script_syntax.mjs`、`test_launcher_bundle.mjs` 3 项通过，覆盖 classic 脚本语法与 bundle 装配。结果：`.artifacts/checks/20261020T063444Z-79a25e5b/result.json`。
- 新增浏览器用例覆盖旧运行时 6 → 7、依赖文件 9/9、缺少单项依赖以及对齐模型的分项状态。该用例未能启动 Chromium（`spawn EPERM`），浏览器断言、实际截图与布局实测未完成。结果：`.artifacts/checks/20261020T063526Z-afe4973d/result.json`。
- Python `LauncherAssetContractTests` 未能启动：`uv` 拒绝访问解释器；直接调用项目虚拟环境也被 uv trampoline 权限错误阻止。源码级 Python 契约结果未验证。结果：`.artifacts/checks/20261020T063454Z-f7150ade/result.json`、`.artifacts/checks/20261020T063526Z-de6a0d15/result.json` 与 `.artifacts/checks/20261020T063636Z-40782d37/result.json`。
- 后端对齐模型状态单测 5 项通过，新增用例确认模型已下载但运行依赖缺失时仍报告 `installed=true`，结果：`.artifacts/checks/20261020T064250Z-ba8364ee/result.json`。
- 当前提交前复核（HEAD `54d10fc7`，状态提示改动尚未提交）：Launcher `--check` 通过；Node 脚本语法与 bundle 契约 3 项通过，结果：`.artifacts/checks/20261020T064404Z-a4cc3bb5/result.json`。最终核验清单检查与 HTML 生成通过，结果分别为 `.artifacts/checks/20261020T064440Z-cb177880/result.json`、`.artifacts/checks/20261020T064440Z-2cdd3d84/result.json`；个人路径扫描与 `git diff --check` 通过。待提交范围为 CHANGELOG、Launcher 状态提示及 mock、对齐模型状态判定和测试、反馈账本与核验清单。
- 核验清单 Markdown 检查通过，并生成 `.artifacts/align-ffmpeg-settings/verification.html`；浏览器未能打开该本地页面，故不以生成结果冒充人工检查。
- 本次没有生成 `blank-editor.html` 内联副本，也未运行真实模型推理或打包检查。

## PR 281 审查修复与最终本地验证

修复基线为 `f5cba025`。PR 原有三条审查反馈均成立；另从两组失败 CI 中确认旧导航容器断言，独立子代理复审补充云端安装失败后的状态刷新。条目 7–10 已处理，没有待处理或阻塞的代码反馈。

- Python：`scripts/run_tests.py tests.test_gui_web.LauncherAssetContractTests tests.test_gui_web.GuiWebBridgeTests.test_launcher_toolbox_uses_primary_tabs_for_postprocessing_and_utilities tests.test_alignment_models tests.test_ffmpeg tests.test_script_timestamp_alignment` 共 100 项通过；结果为 `.artifacts/checks/20261020T071250Z-30456e5d/result.json`。删除旧提示后发现的旧契约已改为验证运行环境常驻可用。
- Node：`node --test tests/test_dev_session.mjs tests/test_web_build_artifact.mjs tests/test_launcher_script_syntax.mjs tests/test_launcher_bundle.mjs tests/test_launcher_feedback_ui.mjs` 共 77 项通过；结果为 `.artifacts/checks/20261020T071000Z-ef8c5650/result.json`。最终事件分支修复后，语法和 bundle 契约 3 项再次通过，结果为 `.artifacts/checks/20261020T071436Z-663ef46b/result.json`；两套 bundle 新鲜度检查通过。
- 浏览器：外层 `scripts/run_check.py --timeout 180` 执行 `node node_modules/@playwright/test/cli.js test tests/e2e/script-timestamp-alignment.spec.mjs tests/e2e/launcher-interactions.spec.mjs --project=chromium --workers=1`，按文稿工具、模型入口和运行环境用例名称定向过滤，12 项通过；结果为 `.artifacts/checks/20261020T071433Z-ccb2bfd0/result.json`。覆盖云端模式安装后下载对齐模型、失败和取消后退出 installing、两个选中模型状态区、版本升级、标签键盘导航以及文稿输入失效和结果归属。
- 截图已自查云端模式运行环境、版本升级清单、对齐模型缺依赖状态；间距实测：模型入口上方 10 px、换行 8 px，升级提示行 gap 为 10 px，文稿指引下方 12 px。截图保留在本地 `.artifacts/pr281/final-browser/`，不入库。
- 独立子代理最终复审通过，未发现其他合并阻塞项。较早的浏览器权限阻塞由本节当前源码验证替代；初次升级状态测试暴露库存刷新竞态并已修复，后续测试夹具的模型前提与 Proxy thenable 问题也已纠正。

本地自动化使用模型下载 mock 与注入后端，不代表真实模型下载、推理或打包验收；这些人工项仍保留在核验清单中。远端 CI 与合并结果以 PR 当前状态为准，内联副本待发布前统一重生成。
