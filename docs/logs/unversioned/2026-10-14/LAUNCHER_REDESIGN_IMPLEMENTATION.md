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
| 2 | 导航与页面骨架（左侧导航；工具箱、设置从抽屉/弹窗迁为页面；帮助菜单；窄窗口仅图标） | 已修复 | 待维护者确认与提交；验证见下方「阶段 2」 |
| 3 | 转写页状态驱动、自动后处理列表与配置抽屉、AI 工具拆分、「可用于自动后处理」开关 | 待处理 | 状态插画见下方「状态插画素材」 |
| 4 | 批量页、工程页、最近工程（含「用作工具箱输入」） | 待处理 | |

## 状态插画素材（2026-10-15 维护者约定）

维护者将提供 4 张**同尺寸**图片，分别对应转写页的四个状态：等待媒体（转写前）、转写中、转写成功、转写失败。素材到位前先用占位符（统一尺寸的占位框 + 注释标明替换位置），实现时四个状态共用同一个图片槽位，按状态切换 `src`，避免布局跳动。

## 阶段 2 摸底（2026-10-15）

- 现结构：`web/launcher/index.html` 中 `main.shell > .shell-scroll` 顺序排列 hero、5 张卡片（`mediaCard` / `recognitionCard` / `autoPostprocessCard` / 日志 / `serverCard`）、`errorNotice`、`status`，底部 `footer.actions`；工具箱是 `main` 外的 `#toolboxFab` + `aside#toolboxDrawer`（含 `toolboxResizeX/Y` 拖拽把手）；设置是 `#settingsModal`（`settingsTabList` 四个 tab）。
- 相关 JS：工具箱开合 `postprocess.js` 的 `setOpen()`（约 840 行）、尺寸持久化 `bindToolboxResize` / `restoreToolboxSize`、`openToolboxAiProcessing`（约 3043 行）；设置开合 `boot/launcher-settings-startup.js` 的 `openSettings(sectionId, focusId)` / `closeSettings()`，多处跨模块调用（notify-backend、local-models、media-form、presets）；单文件/批量切换在 `batch.js` 的 `setMode`；hero 链接在 `launcher-notify-backend.js` 约 302 行。
- 迁移思路：保留 `openSettings` / `setOpen` 的函数签名，内部改为切换页面，调用方不用改；`toolboxFab`、`settingsModal` 等 id 在测试中有断言，需同步改为新契约。

### 阶段 2 范围决定（2026-10-15 维护者确认）

1. 自动后处理「配置」按钮：阶段 2 暂时跳到工具箱页面（保留仅配置模式），页面上提供「返回转写」链接；右侧配置抽屉留到阶段 3。
2. 导航「批量」：阶段 2 复用现有 `setMode("batch")`，在转写页内显示批量界面，同时高亮导航项；独立批量页留到阶段 4。
3. 导航「工程」：阶段 2 把现有编辑器卡片（`serverCard`）移到工程页；日志卡片留在转写页。最近工程留到阶段 4。
4. 设置「关于与支持」分区：阶段 2 只放空占位。
5. 提交：维护者确认后再提交，和阶段 1 一样。

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

### 阶段 2：导航与页面骨架（HEAD `541ef0ef` + 工作区改动）

改动：
- `web/launcher/index.html`：hero 换成左侧导航（logo、转写 / 批量 / 工具箱 / 工程，底部帮助、设置）+ 顶栏（标题、版本、支持 MAW、主题切换）。新增线性 SVG sprite（`icon-sprite`）。页面：`pageTranscribe`（原卡片与底栏）、`pageProjects`（`serverCard`，去掉 5 号徽章）、`pageToolbox`（原抽屉内容，`toolboxPanel`；删除 `toolboxFab`、`toolboxClose`、拖拽把手，新增 `toolboxBackToTranscribe`）、`pageSettings`（原弹窗，左侧竖排分区：通用、断句与标点、AI 模型、运行环境，「关于」组下的「关于与支持」空占位）。帮助菜单：新功能、报告问题禁用并标「即将推出」；使用指南（官网文档）、教程视频、GitHub 可点。
- 新增 `web/launcher/boot/launcher-navigation.js`（清单中位于 settings-startup 之前）：`showPage` / `navigateTo`、帮助菜单（方向键、Esc 回焦、点外部关闭）、主题切换按钮、批量模式与导航高亮同步。
- `openSettings(sectionId, focusId)` / `closeSettings()` 签名不变：打开切到设置页，关闭回到打开前的页面。`setOpen()` / `openToolboxAiProcessing()` 签名不变：打开切到工具箱页；「仅配置」模式显示「返回转写」，离开工具箱页即恢复普通模式。`expandServer()` 会切到工程页。删除工具箱尺寸持久化（`maw.launcher.toolbox.size`）与滚轮拦截。
- `batch.js` 通过 `MAWLauncher.setTranscribeMode / getTranscribeMode / onTranscribeModeChanged` 与导航互通；`postprocess.js` 经 `MAWLauncher.showPage / navigateTo / getActivePage` 访问页面（bundle 外脚本不能直接调用 bundle 内函数）。
- `launcher.css`：新增导航、帮助菜单、顶栏、页面、设置页样式，窄窗口（< 760px）导航 56px 只显示图标（文字保留给读屏）；删除 hero、悬浮按钮、抽屉定位与拖拽把手样式；设置分区卡片样式从 `.modal-card` 迁到 `.settings-page`，卡片间距 14px。
- i18n：新增 `nav_*`、`help_*`、`support_maw`、`theme_toggle`、`page_projects_*`、`toolbox_back_to_transcribe`、`settings_tab_about`、`settings_group_*`、`settings_about_placeholder`，中英同步。
- 文档：CHANGELOG【🔄 变更】新增「Launcher 改用左侧导航」；`LAUNCHER_GUIDE.md` 批量入口、`OCR_SUBTITLE_DEDUP.md` 工具箱入口改为左侧导航，同步官网两篇副本（`sync:docs` 顺带刷新的其他 10 篇是 HEAD 就存在的漂移，已还原，不在本任务范围）。
- 测试改为断言新契约：`test_gui_web.py`（工具箱页、设置页、导航、帮助菜单、品牌图标、keycap 1–4 + 工程页编辑器卡片；新增 `test_launcher_left_nav_switches_pages`、`test_launcher_help_menu_and_topbar_links`）；e2e 选择器 `toolboxFab → navToolbox`、`settingsClose → navTranscribe`、`settingsModal → pageSettings`；「toolbox resize」用例随抽屉删除，换成「左侧导航切换页面」交互用例（批量同步、设置返回、仅配置模式返回）。

| 层 | 命令 | 结果 |
| --- | --- | --- |
| bundle 新鲜度 | `node scripts/build-launcher.mjs --check` | fresh |
| Python 契约 | `run_tests.py tests/test_gui_web.py tests/test_launcher_contract.py` | 325 通过，1 跳过（`.artifacts/checks/20261015T055953Z-c64fec81`） |
| Python 全量 | `run_tests.py` | 2183 项，1 失败：`test_hub_download` 读取本机 `%LOCALAPPDATA%\MAW\model-cache` 真实缓存，stash 掉本次改动后同样失败，与本任务无关（`.artifacts/checks/20261015T061703Z-f4e73ca9`） |
| Node 单测 | `node --test test_launcher_script_syntax / feedback_ui / bundle`；`test_asr_presets_browser.mjs` | 28 通过；1 通过 |
| e2e | `launcher-interactions` 受影响 10 条（含新增导航用例）；keycaps、layout-feedback、api-errors、file-errors、error-context、provider-memory、resegment、zoom、script-timestamp-alignment、shared-tooltip | 全部通过 |
| 布局实测 | `.artifacts/launcher-phase2/measure.mjs` | 转写卡片间距 12px、设置分区 14px、工程页标题到卡片 14px、导航项 4px；各页无横向溢出；工具箱底栏贴齐视口底；帮助菜单在视口内，Esc 回焦到「帮助」；700px 宽导航 56px、文字隐藏 |
| 截图 | `.artifacts/launcher-phase2/shots/`（明暗 × 转写 / 批量 / 工具箱 / 工程 / 设置 / 关于 / 帮助 / 窄窗口） | 已自查 |

已有失败（与本改动无关）：
- `launcher-interactions` 两条 batch 用例与 4 条 AI cleanup 用例、`launcher-script-match-cancel` 2 条：与阶段 1 记录相同（`#postprocessAiCleanup` 不存在、batch 用例在干净 HEAD 同样失败）。
- 偶发 `browserType.launch: Timeout 180000ms`（两个 worker 同时启动浏览器）。

未验证：真实 pywebview 窗口（只在浏览器 mock 模式下验证）；全量 e2e 未跑。

留给后续阶段：自动后处理「配置」仍跳工具箱页（阶段 3 改右侧配置抽屉）；批量独立页、最近工程（阶段 4）；「关于与支持」内容；导航批量徽标。
