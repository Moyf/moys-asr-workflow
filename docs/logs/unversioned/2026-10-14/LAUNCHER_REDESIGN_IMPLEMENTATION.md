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
| 2 | 导航与页面骨架（左侧导航；工具箱、设置从抽屉/弹窗迁为页面；帮助菜单；窄窗口仅图标） | 已修复 | 已提交 `7cb3a76d`；验证见下方「阶段 2」 |
| 3 | 转写页状态驱动、自动后处理列表与配置抽屉、AI 工具拆分、「可用于自动后处理」开关 | 已修复 | 实现与定向回归完成；状态插画暂用统一占位，待维护者实机验收 |
| 4 | 批量页、工程页、最近工程（含「用作工具箱输入」） | 已修复 | 独立页面、本机历史与关于页完成；真实桌面服务切换待人工验收 |

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
| 顺手精简冗余文案 | 仅说明 | 本轮已精简主按钮、AI 设置入口、追加要求、翻译回填及对比页提示，中英同步；没有将全仓文案精简扩大为本次任务 |

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

## 接续实施（2026-10-15，基线 `7cb3a76d`）

只读核对时工作区干净。已核对方案、入库 v4 原型、原型 JS/CSS、参考截图和阶段 2 源码；本地工作副本的 JS/CSS 与入库副本一致。最终品牌色以方案为准，不复制原型旧值。沿用原生 JS、现有元素 id 和后端协议，保留所有工具字段。配置抽屉移动同一份真实表单，不克隆重复 id。

| 当前工作项 | 状态 | 证据 / 边界 |
| --- | --- | --- |
| 自动后处理列表、共享配置抽屉、工具箱二级导航与 AI 工具拆分 | 已修复 | 新增独立 UI 模块，真实面板 reparent；新版专项与导航回归通过 |
| 转写状态、识别设置摘要与结果卡 | 已修复 | 实际路径、可用统计与真实耗时；不虚构费用或百分比；更换媒体清除旧结果 |
| 独立批量页与队列徽标 | 已修复 | 多文件拖入切换批量；保留执行/取消协议；批量工程产出记录到本机历史并通过编辑器桥打开 |
| 工程页、最近工程、关于与支持 | 已修复 | 路径/时间存入用户数据目录，最多 30 条；后端存在性检查，关闭记录时仍可手动重新定位 |
| 明暗 / 窄窗口截图、间距实测与人工核查页 | 已修复 | 截图与测量见 `.artifacts/launcher-phase3/`；核查页 `verification.html`，人工状态尚未确认 |
| 全量 Python 与真实桌面 / 云端链路 | 阻塞 | 全量套件超时，尚未归因；实机与云端未执行，下一步由人工核查 / CI 分层验证 |

### 接续检查点 1

- 新增 `launcher-postprocess-ui.js`：纵向工具导航、独立 AI 工具入口、常用步骤偏好、共享真实面板的配置抽屉，含 Esc / 遮罩关闭与焦点约束。沿用 `postprocessOperation` 协议，隐藏旧任务下拉；翻译参数与自动计划同步。
- 浏览器初步冒烟通过（`.artifacts/checks/20261015T065852Z-03b306ca`、`20261015T070441Z-78deea37`）：抽屉改值后回到工具箱仍保留，页面无重复 id、无 JS 异常。仅覆盖替换步骤，不代表整阶段通过。
- 第一轮契约回归：Python 325 项中 4 条旧结构断言失败，Node 28 项中 2 条测试桩缺少新增 UI 依赖。正在迁移到新契约；尚未宣布通过。
- 继续接线 `launcher-workflow-ui.js`（状态、摘要、真实结果、共享操作栏、独立批量页）、`launcher-projects-ui.js` 与 `maw/launcher_recent.py`（本机最多 30 条路径/时间、存在性检查、关闭/清除/移除/重新定位）。这些代码尚待完整验证。

### 接续检查点 2：实现与定向验证完成

基线仍为 `7cb3a76d`，全部是未提交工作区改动；未生成 `blank-editor.html`，未创建 commit / tag / PR，未 push。第一检查点描述的是当时状态，以下为后续实际结果。

- **阶段 3**：新增 `launcher-postprocess-ui.js`、`launcher-workflow-ui.js`；工具导航按三组纵排，AI 工具独立入口、独立提示词和供应商记忆，结果/流式输出按具体 AI 操作归属。识别设置可展开完整表单；统一插画占位覆盖等待/运行/成功/失败。配置抽屉是同一 DOM 表单，含启用同步、步骤导航、Esc / 遮罩 / 完成关闭、焦点约束及返回工具箱。隐藏步骤同步停用，升级时保留旧计划已启用步骤可见。
- **阶段 4**：批量页独立展示队列和共用摘要，底栏/日志沿用同一控件；真实后端一次拖入多个媒体以成组事件传到前端。工程页有服务状态条、可搜索历史、打开文件夹、用作工具箱输入、丢失文件重新定位/移除、关闭/清空记录及关于页。最近记录由 `maw/launcher_recent.py` 原子写入用户数据目录，只保存路径/时间；浏览器 mock 使用隔离的本机演示存储。
- **修正的真实边界**：设置页保存 AI 供应商时，当前 AI 工具的选择不会被切换任务时的旧值覆盖；非当前工具的设置编辑不改写其他任务选择。已有工程的「生成时间码」把同一输入控件移进面板，脚本模式保留自己的输入。异步默认输出、音轨与本地模型状态变化会刷新开始按钮状态。关闭历史记录不影响手动重新定位。
- **设计与资料**：以入库 v4 原型为参考、最终确认色值为准；主按钮 42px、常规控件 36px、卡片内边距 18px、卡片间距 14px。补齐线性 SVG 工具图标，简化常用按钮与 AI 说明，中英文同步。指南与官网只同步本任务三篇正文，保留其他既有文档漂移；CHANGELOG 汇总为一个工作流改版条目。

| 验证层 | 命令（统一经 `scripts/run_check.py`） | 实际结果 / 证据 |
| --- | --- | --- |
| Python 定向 | `python scripts/run_tests.py tests/test_gui_web.py tests/test_launcher_contract.py tests/test_launcher_recent.py` | 335 项，1 跳过，其余通过；`20261015T115944Z-f78e00cb` |
| Node + 预设浏览器 | `node --test tests/test_launcher_script_syntax.mjs tests/test_launcher_feedback_ui.mjs tests/test_launcher_bundle.mjs tests/test_asr_presets_browser.mjs` | 29 通过；`20261015T115719Z-0c13a5c4` |
| 构建新鲜度 | `pnpm run check:launcher` | fresh；`20261015T115724Z-6d1d22f5`；后续 mock 变更已重新构建 |
| 类型 | `pnpm run typecheck` | 通过；`20261015T115727Z-03c1ba0d` |
| 原有受影响 e2e | api-errors / error-context / file-errors / keycaps / provider-memory / resegment / zoom + 当时的 redesign 共 8 个 spec | 34 通过；`20261015T114838Z-4ea31a65`；不是全量 e2e |
| 新版专项 | `launcher-redesign.spec.mjs` | 新增批量产出记录与队列底栏计数断言后 10 通过；最终复测 `20261015T120551Z-e267fa37` |
| 导航交互 | `launcher-interactions.spec.mjs --grep "vertical grouped\|left navigation switches"` | 2 通过；`20261015T115750Z-a38d021a`；没有声称整份旧 interactions 通过 |
| 视觉与间距 | `.artifacts/launcher-phase3/visual.mjs`，截图在同目录 `shots/` | 明暗 × 1000/700/414/375/320px 共 50 个页面组合无溢出；工程卡片相邻距离均 14px；最终复测 `20261015T120622Z-791dda15` |
| 安全 / diff | `python scripts/check_personal_paths.py --diff-ref HEAD`；`git diff --check` | 通过；路径扫描 `20261015T114730Z-f6b0efb5` |
| Python 全量 | `python scripts/run_tests.py`（外层 240 秒） | 超时；输出已有失败标记但未形成最终失败报告，未归因、不计通过；`20261015T072140Z-cad0fd88` |

上表 run-id 均对应 `.artifacts/checks/<run-id>/result.json`。源码变化后已复测对应层，未把阶段 1/2 的证据冒充本轮通过。

核查页已由 `tools/verification-checklist/build.py --data .artifacts/launcher-phase3/verification.json --output .artifacts/launcher-phase3/verification.html` 生成并在默认浏览器打开；所有人工项保持未确认。最终截图复核后，为单文件 / 批量保留各自底栏状态，避免单文件「已完成」误显示为批量结果；队列计数变化也会刷新底栏。收尾 `git diff --check` 与源码 LF 检查通过，没有本工作树遗留的测试 Python / serve.py 进程。

**未验证 / 后续**：真实 pywebview 中的系统文件选择和多文件拖放、原生通知、编辑器服务切换 / 重启及外部服务占用、真实云端与本地模型任务、打包产物和完整 e2e。四张状态插画由维护者提供后再替换统一占位；其余未验证项按人工核查页验收。全量 Python 超时与已有失败应另按测试文件拆分定位，不循环重跑。本任务未改工程 schema、编辑器业务或接口监听范围。

## 视觉返工：仅「选择媒体」卡片

维护者指出实现与原型存在明显差异。上节「实现完成」只描述功能接线与定向测试，不能视为设计完整复刻；视觉验收尚未完成。本轮仅处理维护者裁图中的媒体空态，不修改识别设置、其他页面或底栏。

| 项目 | 状态 | 范围 / 依据 |
| --- | --- | --- |
| 媒体空态按原型还原 | 已修复 | 圆形浅色编号、右上批量入口、横向拖放区、88px 图标卡、原有三行文案；同宽组件几何与原型相同，定向验证见下 |
| 其他区域的视觉还原 | 待处理 | 按维护者要求暂停，不在本轮扩大范围 |

### 视觉返工第二轮：识别摘要胶囊 + 自动后处理卡片 + 抽屉动效 + 焦点 bug（2026-10-16）

维护者追加三项要求：识别摘要胶囊只显示主名（模型 / 供应商的「（备注）」拆开）、「自动后处理」卡片按原型复刻、抽屉出现带动效；并修复「点翻译开关焦点闪到追加要求」的 bug。全部完成：

- **摘要胶囊拆分**：`chipEntry` 用正则拆「主名（备注）」，胶囊只显示主名，备注转存 title（共享 tooltip 自动转为 `data-title` 悬浮气泡）；中英半/全角括号都处理。选择 diarize 模型时胶囊只显示 `gpt-4o-transcribe-diarize`，「（说话人分离）」在悬浮提示。
- **自动后处理卡片复刻**：头部合并为「标题 + 按顺序执行 · 已启用 N 项 + 总开关」；步骤行改为「圆形编号 | 名称 + LLM/慎用徽章 + 摘要 | 配置/去配置 | 开关」，未启用行文字转次要色、编号灰底；底部「另有 N 个步骤未显示（在工具箱中开启）+ 选择显示的步骤」；「保留中间文件」改为标题 + 说明 + 开关的独立行。批量文稿提示 `batchManuscriptNotice` 移到批量页共用设置卡。
- **「其他」组**：按截图改为 2×2 网格（说话人配色 / 频谱 / 调试 + 右下占位格），三项统一开关样式；频谱说明精简为「默认只生成波形；频谱会增加耗时和文件体积」，调试模式新增说明「保留原始响应内容，方便排查问题」，中英同步。
- **抽屉动效**：`postprocessSheet` / `postprocessScrim` 改为 `hidden → open` class 切换，右侧 640px 抽屉 `transform translateX(105%) ↔ 0` 加 0.22s 缓动，遮罩淡入淡出；关闭动画期间焦点约束由 `currentStep` 守卫。
- **焦点 bug 根因与修复**：此前给 `openAutoStep` 加的 `invalidField ∈ {llmApiKey,llmBaseUrl,llmModel}` 白名单导致「无配置 + 无 invalidField」走抽屉分支，焦点落到 `postprocessPrompt`。恢复无条件走设置页分支（focusId 计算不变），并新增回归用例断言打开的是设置页且焦点在 `#llmApiKey`、开关不保持勾选。
- **顺带修复**：AI 设置保存/测试成功后立即记忆当前工具的供应商（原实现只记任务组，覆盖旧值）；初始化阶段不再触发 `save_postprocess_plan`（此前每次启动都会多一次保存调用）；`open_editor` 按维护者确认去掉 🎬 emoji（保留 SVG 图标），同步 Node 断言与 e2e。
- **旧用例迁移**：`mediaPath/batchMode/utilitiesPrimaryTab/postprocessOperation/AI cleanup 旧元素` 等改为新契约；`batch failure/start delegates` 与 AI cleanup 系列、`launcher-script-match-cancel` 2 条仍为账本记录的**基线已知失败**（干净 HEAD 同样失败），本轮排除后统计。
- 本地模型「检查中/部分安装」不再禁用开始按钮：交给 `validateLocal` 给精确原因并定位设置项；媒体/输出/密钥缺失仍禁用并在底栏说明。

| 验证 | 结果 | run-id（`.artifacts/checks/`） |
| --- | --- | --- |
| `launcher-redesign.spec.mjs`（含胶囊拆分、卡片布局、动效、焦点 bug 4 条新用例） | 13 通过 | `20261015T160112Z-8a029127`（末次） |
| interactions + media-card + keycaps + api-errors（排除基线已知失败） | 67 通过 | `20261015T155532Z-735db947` |
| provider-memory / resegment / zoom / file-errors / error-context | 29 通过 | `20261015T155914Z-14c425dc` |
| Python 契约 + 最近工程存储 | 335 项，1 跳过，其余通过 | `20261015T155914Z-7bc014ff` |
| Node 语法 / feedback / bundle / 预设浏览器 | 29 通过 | `20261015T155914Z-4958f0fd` |
| check:launcher / typecheck / 视觉 50 组合无溢出 / git diff --check / 个人路径 | 全部通过 | `20261015T155922Z-4034993f` 等 |

截图：`.artifacts/launcher-phase3/shots/auto-card-light.png`（本轮自动后处理卡片）及既有明暗/窄窗全套。未验证边界不变：真实 pywebview、云端/本地识别、打包与全量 e2e 未执行；基线已知失败保持记录，未在本轮范围内修复。

### 本轮处理与证据

- 仅改变媒体卡片的 HTML / 局部 CSS、i18n 及其必需接线。未选文件时隐藏旧竖排插画与路径 / 输出表单，改为原型横向拖放卡片；选中后仍显示原路径、音轨与输出设置。错误需要定位字段时会展开原字段，不让隐藏状态妨碍修复。
- 整个拖放区可点击和键盘操作；「多个文件？用 批量」连接已有批量导航，多文件拖入逻辑保留。修正旧 `batch.js` 对 `dropZone.textContent` 的覆盖，避免切换模式或语言后把原型结构抹掉。
- 上传 SVG 使用原型的同一路径；只把第一步徽章改为浅底圆形，不改其他编号、识别区、底栏或其他页面布局。颜色沿用最终确认的品牌令牌。
- `.artifacts/launcher-media-card/actual-light.png` / `prototype-light.png` 为同宽 640px 的真实实现 / 原型截图，已逐张自查；对应 `measurements.json`：两者高度都是 `214.46875px`，上内边距 `18px`、横内边距 `20px`、标题到拖放区 `14px`、图标卡 `88×88px`、图文间距 `22px`。暗色与窄窗口截图同目录保存。没有通过修改其他页面列宽来伪造组件一致。

| 验证 | 结果 | `.artifacts/checks/` 下的 run-id |
| --- | --- | --- |
| `launcher-media-card.spec.mjs`：同宽原型几何对照、点击 / Enter 选文件、替换 / 音轨 / 输出、批量 / 多文件拖入、英文结构保持、明暗与 1000/884/700/414/375/320px 布局 | 4 通过；同宽几何差值 ≤ 1px（本次实际相同），无溢出 | `20261015T123656Z-148407a4` |
| `launcher-api-errors.spec.mjs`、`launcher-keycaps.spec.mjs`、`launcher-redesign.spec.mjs` | 19 通过 | `20261015T123432Z-67daa85f` |
| `run_tests.py tests/test_gui_web.py tests/test_launcher_contract.py` | 325 项，1 跳过，其余通过 | `20261015T123432Z-c0ac84a8` |
| Node syntax / feedback_ui / bundle | 28 通过 | `20261015T123442Z-589125dc` |
| `pnpm run check:launcher`、`pnpm run typecheck` | fresh / 通过 | `20261015T123710Z-a693339d`、`20261015T123712Z-c080f386` |

未验证边界：仍未冒充真实 pywebview 的系统文件选择 / 原生拖放验证；本轮只在浏览器 mock 中验证操作接线。其他视觉差异按维护者要求留待后续指定，不标记整页已还原。未生成便携 HTML，未提交或推送。
