# Launcher 现代化改版实施记录

方案与已确认决策见 [Launcher 现代化改版设计方案](../../../plans/LAUNCHER_REDESIGN.md)。本文是实施账本：每完成一项立即回写状态、涉及文件、验证命令与结果。状态只用：待处理 / 进行中 / 已修复 / 仅说明 / 阻塞。

## 基线

- 分支工作树：`mellow-dragon`，起点 HEAD `fd166d48`。
- 原型：[docs/plans/launcher-redesign/](../../../plans/launcher-redesign/README.md)（已入库作参考；本地工作副本与完整截图仍在 `.artifacts/launcher-redesign/`）。实现时以原型的令牌与组件为准，映射到 `launcher.css` 现有变量名。
- 运行方式：`web/launcher/index.html` 以 file:// 加载；无 pywebview 后端时自动进入 mock（`launcher-mock-api.js`），浏览器直接打开即可预览。
- 构建：`pnpm run build:launcher`，校验 `pnpm run check:launcher`；bundle 与 `.meta.json` 不进 Git。

## 测试约束（摸底结果）

- `tests/test_gui_web.py`：大量 `test_launcher_*` 以子串断言 `index.html` / `launcher.css` / `postprocess.js`，包括 `toolboxFab` / `toolboxDrawer` / `toolboxClose`、`settingsModal` / `settingsButton`、`keycap-1..5`、`.hero-brand` / `.hero-icon`、`.card h2 {...}`、`.toolbox-*` 的整段 CSS 等。结构性改动要同步改这些断言，且改为验证新契约，而不是删掉。
- `tests/test_launcher_feedback_ui.mjs`：正则断言部分 id 与中英文案。
- `tests/test_launcher_contract.py`：mock `get_config` 键集合与真实后端一致；新增配置项（自动后处理可见步骤、最近工程）要两边同步。
- e2e：`tests/e2e/launcher-*.spec.mjs` 共 9 个，加上 `layout-feedback` / `script-timestamp-alignment` / `shared-tooltip`。
- 没有中英 key 对齐的自动检查，新增文案需手动同步 zh / en。

## 阶段与进度

| # | 阶段 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 令牌与基础组件（只换皮：配色、字号、按钮、输入、卡片、开关、去渐变） | 已修复 | 维护者确认，已单独提交 |
| 2 | 导航与页面骨架（左侧导航；工具箱、设置从抽屉/弹窗迁为页面；帮助菜单；窄窗口仅图标） | 待处理 | |
| 3 | 转写页状态驱动、自动后处理列表与配置抽屉、AI 工具拆分、「可用于自动后处理」开关 | 待处理 | |
| 4 | 批量页、工程页、最近工程（含「用作工具箱输入」） | 待处理 | |

## 第三轮原型反馈（2026-10-14）

| 反馈 | 状态 | 处理 |
| --- | --- | --- |
| 「可用于自动后处理」开关不要挤在卡片头 | 已修复（原型） | 移到卡片底部：分隔线 + 小号开关 + 文字；配置抽屉里隐藏。方案 5.2 已更新 |
| 媒体工具缺少共享「媒体文件」输入 | 已修复（原型） | 烧录字幕 / 提取音频 / 生成波形显示「媒体文件 · 跟随转写页」卡片（对应 `toolboxUtilityMediaPath`），面板内重复的媒体字段删除；口播对齐、生成时间码自带输入不显示共享卡；输出模式只在字幕类工具显示。方案第 4 节已更新 |
| 顺手精简冗余文案 | 进行中 | 原型已精简 17 处提示；抽屉内「处理对象…」提示与标题重复，已删除并并入标题。真实界面文案在各阶段改到对应区域时同步精简，原则见方案第 8 节第 5 条 |

原型截图：`.artifacts/launcher-redesign/shots/18-*.png` ~ `22-*.png`。

## 验证记录

### 阶段 1：令牌与基础组件（HEAD `fd166d48` + 工作区改动）

改动：
- `web/launcher/launcher.css`：暗色 `:root` 换成黑橙炭灰令牌、亮色 `[data-theme="light"]` 换成红白令牌；新增 `--accent-text`、`--green`；圆角 6/9/14。去掉页面背景、卡片、拖放高亮、批量行、音轨框、进度条、主按钮共 10 处渐变。主按钮改为实心强调色 + `--accent-text`，不再上浮。分段控件选中态改为白底 + 强调色文字。卡片标题 15px、主文字色。29 处 12px 正文类（标签、提示、状态、说明）提到 13px；等宽日志统一 12px（原 11.5px）；12px 只留给徽标、计数和代码块。keycap 数字跟随 `--accent-text`。拖放区不再铺强调色底。
- `web/launcher/index.html` 首屏防闪烁底色、`maw/gui_web.py` 窗口 `background_color` 同步为 `#1c1c20`。
- 测试：`tests/test_gui_web.py`（卡片标题、首屏底色三处一致）、`tests/e2e/launcher-keycaps.spec.mjs`（品牌色与数字颜色）改为断言新契约。

| 层 | 命令 | 结果 |
| --- | --- | --- |
| bundle 新鲜度 | `node scripts/build-launcher.mjs --check` | 通过（本阶段只改 CSS / HTML，bundle 未变） |
| Python 契约 | `run_tests.py tests/test_gui_web.py tests/test_launcher_contract.py` | 324 通过，1 跳过（`.artifacts/checks/20261014T113931Z-bc9a92b6`） |
| Node 单测 | `node --test test_launcher_script_syntax / feedback_ui / bundle` | 28 通过 |
| e2e | keycaps、layout-feedback、api-errors、file-errors、provider-memory、resegment、error-context、shared-tooltip、launcher-interactions（大部分） | 通过 |
| 截图 | Edge headless 明暗两套，`.artifacts/launcher-redesign/impl-shots/phase1-*.png` | 已自查：无渐变、品牌色正确、对比度正常 |

已有失败（与本改动无关，均已在干净 HEAD 复现或确认）：
- `launcher-interactions` 两条 batch 用例（`batch start delegates…`、`batchDone fails rows…`）：在另一干净 HEAD 工作树同样失败。
- `launcher-interactions` 4 条 AI cleanup 用例与 `launcher-script-match-cancel` 2 条：等待 `#postprocessAiCleanup`，该元素在 HEAD 的 `index.html` 中不存在（`git grep` 为 0），属测试与页面漂移。
- 偶发 `browserType.launch: Timeout 180000ms`：两个 worker 同时启动浏览器的环境问题，单独重跑通过。
- `launcher-script-match-cancel` 首次失败于 `No module named 'requests'`：需设置 `MAW_E2E_PYTHON` 指向 `.venv\Scripts\python.exe`。

未验证：真实 pywebview 窗口（只在浏览器 mock 模式下验证）。

第四轮调整（维护者确认阶段 1 后）：亮色主色改为 `#c84545`（与编辑器红一致，`--red` 同步）；暗色主色改为 `#f09a50`（介于 `#ff8f3f` 与 `#e0a05a`，偏亮）。重跑 `test_gui_web.py`（323 通过）与 `launcher-keycaps` e2e（通过），截图已更新。维护者确认测试中的既有失败不在本任务范围内。

### 编辑器配色对齐（维护者要求，2026-10-14）

改动：
- `web/editor.css`：暗色 `:root` 换成炭灰中性底（`#1c1c20` / `#26262b` …），去掉原蓝调石墨；亮色换成中性白灰。文字、边框、按钮、滚动条、工具栏背板、空状态与 dock 底色同步。波形区保留独立底色，但从深蓝调改为比页面略深的炭灰（`--bg-wave #18181c`、`--wave-row-bg #212126`）；活动字幕块混色改为跟随 `--accent`。
- 强调色：新增 `brand` 预设并设为默认（暗色 `#f09a50`、亮色 `#c84545`，与 Launcher 一致）；原默认蓝色改为显式 `data-accent="blue"` 预设；暗色橙色预设改为 `#f09a50`（亮色橙 `#d9834a` 不变）。各预设显式设置 `--accent-active-fg`，深色强调底配深色字、红/蓝底配白字。
- 强调色选项：品牌色作为首项只显示圆点（名称放在 `title` / `aria-label`：「品牌色（默认）」 / 「Brand (default)」）；选中项的圆点加前景色描边环，不再与同色底融成一片。
- 设置：`web/shared/utils/settings.js`、`web/editor/state/editor-settings.js`、模板首帧脚本的默认值与合法值同步加入 `brand`；无效或缺省值回退 `brand`，已保存的 blue/red/orange/custom 不受影响。
- 测试：`test_editor_utils.mjs`（默认值与回退）、`test_waveform.py`（品牌色选项）、`editor-i18n-save.spec.mjs`（默认品牌色、选中圆点描边环、各预设选中底色）改为断言新契约。

| 层 | 命令 | 结果 |
| --- | --- | --- |
| bundle | `node scripts/build-editor.mjs --check` | fresh |
| Node 单测 | `node --test tests/test_editor_utils.mjs`（及 syntax / order / waveform_js） | 331 / 395 通过 |
| Python | `run_tests.py tests/test_waveform.py tests/test_editor_assets.py tests/test_editor_palette.py`（及 test_cli、test_web_build） | 通过 |
| e2e | `editor-i18n-save.spec.mjs`：主题切换、强调色 | 通过 |
| 截图 | 临时 Playwright 脚本（已删除），`.artifacts/launcher-redesign/editor-shots/` | 明暗两套自查：无蓝调残留，波形仍有独立底色 |

已有失败（干净 HEAD 同样失败，未处理）：`editor-i18n-save` 的 `English waveform and sticker names…`（表情包 img 未加载）与 `English locale covers the editor shell…`（「重组后音频」「打开全局设置的播放预览页」未翻译）。

未处理：`editor.css` 仍有约 375 处硬编码颜色（例如说话人颜色、语义色、个别组件），本轮只替换令牌层。见方案「后续：颜色令牌统一」。
