# Launcher 与 Editor 布局反馈记录

本文记录本次 Launcher / Editor 布局反馈的处理范围、验证结果与未验证边界。

## 处理清单

| 编号 | 范围 | 反馈摘要 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | Launcher | “生成字幕和工程”底部操作区脱离滚动范围，滚动条不在其右侧留下空隙 | 修改 | 已修复 |
| 2 | Launcher | “文稿文件”拖入文件时显示与其他拖放区域一致的反馈样式 | 修改 | 已修复 |
| 3 | Editor | 每个区域右上角的设置齿轮常驻显示，左侧内容在窄宽度下可收缩 | 修改 | 已修复 |
| 4 | Editor / cue block | cue block 跨行时，上一行末端去掉右侧圆角、下一行起端去掉左侧圆角，形成连续外观 | 修改 | 已修复 |
| 5 | Launcher / Editor | 文稿预览及其他滚动区域的滚动条统一为右侧的细样式 | 修改 | 已修复 |
| 6 | Editor / 字幕列表 | 宽度不足时隐藏“显示 150 / 150”数量计数，为工具栏其他控件让出空间 | 修改 | 已修复 |
| 7 | Editor / 全局设置 | 拆分与合并设置中收窄合并输入框，独立显示字幕语言类型，并将拆分标点改为按钮浮窗配置 | 修改 | 已修复 |
| 8 | E2E 测试环境 | Python 子进程不应默认使用缺少项目依赖的系统解释器 | 修改 | 已修复 |
| 9 | Editor / 全局设置 | 将合并字符与拆分标点改为同一行的两个配置按钮，并补充字幕语言类型说明 | 修改 | 已修复 |
| 10 | Editor / 字幕列表 | 批量操作与仅看超长按钮宽度不足时保持单行，文本显示省略号 | 修改 | 已修复 |

## 基线事实

- Launcher 采用 `.shell` flex 上下分区：`.shell-scroll` 是唯一的上方滚动容器，`.actions` 是下方实际占高的 flex 子项；上方只保留 20px 底部留白，不再用固定栏高度人为扩展滚动范围。
- `launcher.js` 已为 `postprocessScriptPath` 绑定文件拖放状态，现有 CSS 的 `.drag-over` 选择器漏掉该输入框。
- Editor 的四个分区均已有设置齿轮；工具栏通用直接子项规则已改为允许左侧内容收缩，并保留齿轮的固定宽度。
- E2E 的浏览器测试由 Node / Playwright（npm）启动，但 Python-backed server 和 `edit.py` 由 `tests/e2e/helpers.mjs` 负责；项目的 `pyproject.toml` / `uv.lock` 已将 `reapeaks` 作为锁定依赖。

## 阶段结果

- 反馈 1：在 `web/launcher/index.html` 增加 `.shell-scroll`，`web/launcher/launcher.css` 将页面滚动锁定到该容器；`.actions` 改为下方 `flex: 0 0 auto` 子项，去除 140 / 190px 人工预留并保留 20px 上方底部留白。浏览器断言确认两者是上下相邻分区，页面本身不可滚动。
- 反馈 2：`web/launcher/launcher.css` 将 `#postprocessScriptPath` 纳入既有 `.drag-over` 规则；浏览器实际派发文件拖入事件后高亮断言通过。
- 反馈 3：`web/editor.css` 覆盖媒体、当前字幕、波形、字幕列表四个工具栏，左侧直接子项可收缩，齿轮 `flex-shrink: 0`；620 / 480 / 360 宽度浏览器断言通过。
- 反馈 4：`web/waveform.js` 改为对所有非 basic 的时间多行 row 应用 `continues-from-previous-row` / `continues-to-next-row`；普通时间多行和“多重字幕”双轨的主、副字幕块都走同一套波形区判断。`web/waveform.css` 清除相接侧上下圆角，真实编辑器回归确认两段的对应 computed radius 为 `0px`，双轨专项回归也确认主轨和副轨均生效。
- 反馈 5：`web/launcher/launcher.css` / `web/launcher/launcher.js` 覆盖文稿预览、批量详情、模型列表、日志、工具箱结果 / 输出等滚动区域；`web/editor.css` 同步覆盖编辑器列表、波形、设置面板、导入文稿预览等区域，统一为 `thin` 与 6px，并让滚动条闪现绑定覆盖 Launcher 内部区域。浏览器断言通过。
- 反馈 6：在字幕列表工具栏的数量计数增加 `.cue-list-count` 标记，`cue-list` 容器宽度不足时隐藏该计数，保留字幕标题、搜索框和设置齿轮。
- 反馈 7：`web/editor-template.html` 将字幕语言提示独立为「字幕语言类型」分组，使用 `editor-settings-item` 样式并显示 `当前为「单词型」（适用于英文、俄文等）` / `当前为「字符型」（适用于中文、日文等）` 说明，置于合并插入设置上方；合并插入文本框收窄为 100px 目标宽度并允许更窄容器继续收缩；拆分标点改为「配置拆分标点」按钮，沿用原有控件与持久化逻辑，在固定定位浮窗中配置，并支持点击外部或 Esc 关闭。
- 反馈 8：`tests/e2e/helpers.mjs` 默认使用 `uv run --frozen python` 启动 `edit.py`、`server-editor` 和 `server-align`，不再把系统解释器与仓库 `.venv` 的 `site-packages` 混用；`MAW_E2E_PYTHON` 仅作为显式解释器覆盖，并保留清晰的 `uv sync` 提示。
- 反馈 9：全局设置中新增字幕语言类型 hint；「配置合并字符」与「配置拆分标点」并排显示，合并字符输入项移入独立浮窗，两个浮窗均支持定位、点击外部关闭和 Esc 关闭。
- 反馈 10：`web/editor.css` 为批量操作下拉按钮及「仅看超长」按钮增加可收缩的最小宽度、单行和省略号规则；新增布局回归覆盖 180px 窄工具栏，确认两个按钮不换行且保持可见。

## 验证记录

- `uv run python edit.py --blank`：通过，已同步 `blank-editor.html`。
- `node --check web/launcher/launcher.js`、`node --check web/waveform.js`、`node --check web/editor.js`：通过。
- `node --test tests/test_waveform_js.mjs`：45/45 通过。
- `node --test tests/test_editor_utils.mjs tests/test_waveform_js.mjs`：245/245 通过。
- `uv run python -m unittest tests.test_gui_web.LauncherAssetContractTests`：42/42 通过。
- `npx playwright test tests/e2e/layout-feedback.spec.mjs --reporter=line`：2/2 通过（提升权限运行，普通沙箱启动 Chromium 会返回 `spawn EPERM`）。
- `npx playwright test tests/e2e/waveform-history.spec.mjs --project=chromium --grep "removes adjacent corner radii" --reporter=line`：1/1 通过（真实普通多行波形跨 5 秒边界；`edit.py` 与 `server-editor` 均由 helper 默认的 `uv run --frozen python` 启动）。
- `npx playwright test tests/e2e/multi-subtitle.spec.mjs --project=chromium --grep "keeps adjacent corners square" --reporter=line`：1/1 通过（不设置覆盖变量，helper 默认使用 `uv run --frozen python`，真实多重字幕双轨主、副字幕同时跨 5 秒边界）。
- `$env:MAW_E2E_PYTHON = (Resolve-Path .venv\Scripts\python.exe).Path; npx playwright test tests/e2e/multi-subtitle.spec.mjs --project=chromium --grep "keeps adjacent corners square" --reporter=line`：1/1 通过（显式解释器覆盖仍可用）。
- `node --check tests/e2e/helpers.mjs`：通过。
- `npx playwright test tests/e2e/cue-list-count-layout.spec.mjs --project=chromium --reporter=line`：1/1 通过（620 / 480 / 360 宽度）。
- `npx playwright test tests/e2e/cue-list-action-buttons-layout.spec.mjs --project=chromium --reporter=line`：1/1 通过（180px 窄工具栏中的两个操作按钮；提升权限运行）。
- `npx playwright test tests/e2e/cue-color-filter.spec.mjs --project=chromium --grep "split trim|merge join" --reporter=line`：2/2 通过（两个配置按钮同行、两个浮窗、语言分组与原有设置持久化）。
- `npx playwright test tests/e2e/cue-color-filter.spec.mjs --project=chromium --grep "merge join" --reporter=line`：1/1 通过（`editor-settings-item` 样式与两种语言适用范围文案）。
- `git diff --check`：通过。

## 未验证边界

- 未执行全量 Playwright 套件；本次只覆盖新增的 Launcher 和 Editor 窄宽度回归。

## 增量记录：字幕列表异常滚动（2026-08-28）

| 编号 | 范围 | 反馈摘要 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 11 | Editor / 字幕列表 | 分配字幕颜色后列表发生异常滚动，并排查同类列表重绘与过滤路径 | 修改 | 已修复 |

### 根因与处理

- 颜色分配与清除路径在 `renderAll()` 后调用 `update()`；`updateActiveCue()` 会把当前活动字幕自动滚入视口，因而覆盖用户当前位置。相关结构重绘后的刷新统一改为不触发字幕列表自动跟随的路径。
- `renderAll()` 会替换字幕行，`content-visibility: auto` 在随后的几帧内回填真实行高；仅保存数值 `scrollTop` 仍可能因累计行高误差产生位移。现统一保存可见字幕行的屏幕位置，重绘后按视觉锚点补偿，并使用稳定字幕 ID 重新定位。
- 颜色和表情包分配/清除属于属性更新，现在只原地刷新已有字幕行、预览和相关菜单，不调用 `renderAll()`，因此不会触发列表滚动。搜索过滤、颜色过滤、显示设置和隐藏禁用项等确实会改变行显隐或布局的路径仍使用视觉锚点保护；如果锚点行被过滤或隐藏，则回退到原 `scrollTop`，补偿检测到用户滚轮、指针、键盘或调用方主动设置滚动位置后立即让出控制权。
- 拆分、合并、新建字幕和列表点击等本来就有明确导航意图的路径保留显式居中或原位逻辑，不由通用补偿覆盖。

### 增量验证

- `node --check web/editor.js`、`node --check tests/e2e/cue-color-filter.spec.mjs`、`git diff --check`：通过。
- `node --test tests/test_editor_utils.mjs tests/test_waveform_js.mjs`（隔离项目内 uv 缓存并允许 Python 子进程）：245/245 通过。
- `npx playwright test tests/e2e/cue-color-filter.spec.mjs --grep "assigning a color|assigning and clearing a sticker|search filtering" --repeat-each=2 --reporter=line`：8/8 通过，覆盖颜色/表情包原地更新、搜索后锚点仍可见和锚点被过滤三种情况。
- 既有表情包列表布局与导出回归：2/2 通过；按 `B` 拆分的关键滚动/选中回归：4/4 通过。
- 既有列表点击、拆分、波形导航、Home/End 和多字幕位置回归：14/14 通过。

### 早期阶段未验证边界

- 在早期布局反馈阶段尚未执行全量 Playwright 套件；当时仅覆盖颜色/过滤场景及受影响的既有滚动回归。全量结果见文末“最终验证”。

## 增量记录：本地 ASR 时间码回退（2026-09-05）

- FunASR 的混合时间戳只保留句级精度，并使用仍有效的时间戳首尾范围；Qwen Forced Aligner 的局部坏词码同样回退到有效词范围，不再静默扩大到整段媒体。
- 删除云端 Fun-ASR 解析中未使用的中间变量，并为上述两种回退路径补充回归测试。
- 当前阶段验证：`tests.test_local_asr` 53/53、`tests.test_qwen` 9/9、受影响文件 Ruff 检查通过、`git diff --check` 通过。
- 全量 Python / Node 测试、Launcher 回归及最终完整 diff 复查在收尾阶段统一执行。

## 增量记录：云端时间码防御与粗粒度边界（2026-09-05）

- 修复 Soniox 时间码结果分支中的语法错误；非字典 token 与无效时间码统一降级为可用时间范围内的句级字幕，不再宣称完整词级精度。
- Tencent 的非字典 `Words` 项现在会触发该句回退；Tencent、必剪、Soniox 按实际语言/文本推导 `char` / `word` 粒度；OpenAI、必剪、Tencent 的句段范围会扩展到完整包住所挂接的有效 item。
- 本地 ASR 粗粒度项的总时长小于字符数时保留原句级 item，避免整数毫秒插值制造倒挂时间码。
- 增量验证：`python -m py_compile ...` 通过；`python -m unittest tests.test_tencent tests.test_bcut tests.test_openai_asr tests.test_soniox tests.test_local_asr` 186/186 通过；`git diff --check` 通过。
- 全量 Python / Node 测试、完整 Playwright、Launcher 异步竞态回归及最终完整 diff 复查在收尾阶段统一执行。

## 最终验证（2026-09-05）

- 本轮新增 Launcher 异步初始化与本地模型状态回归、云端/本地 ASR 时间码回退回归均通过；定向回归累计 76 项通过。
- 全量 Chromium Playwright 已执行 295 项，282 项通过、13 项失败；失败集中在主线已有的帧字段兼容、gap 元数据/间隔语义、英文合并空格，以及一个旧工程加载竞态断言，未涉及本轮 Launcher 异步初始化或 ASR provider 时间码防御改动。
- 最终验证：`.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"` 通过（1133 项，跳过 6 项）；`MAW_TEST_PYTHON=.venv\Scripts\python.exe node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs` 通过（269/269）；`.venv\Scripts\ruff.exe check .`、3 个前端入口语法检查和 `git diff --check` 均通过。
