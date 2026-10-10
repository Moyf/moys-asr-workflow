# ASR 识别预设管理：UI 反馈与整理记录

背景：`fix/preset-ui-consolidate-fields` 分支基于 asr-presets 特性（PR #150 审查修复后）。
上一轮「管理预设」UI 工作以未提交状态遗留在
`C:\Users\lei.hu\.codex\worktrees\f103\moys-asr-workflow`（codex/review-pr150-20260924），
本任务已将该未提交 diff 恢复到本分支工作区，并在此基础上完成两轮反馈整理。

## 第一轮用户反馈逐条状态（11 条）

| # | 反馈 | 状态 | 处理结果 |
| --- | --- | --- | --- |
| 1 | 未选择预设时不显示「当前预设：」前缀 | 已修复 | 原型已实现：`renderCurrentAsrPreset()` 在无预设时隐藏前缀，仅显示「当前未选择预设」。 |
| 2 | 「保存预设」「保存资料」区分不清 | 已修复 | 改为「另存为新预设」与「仅保存名称/描述」；第二轮进一步把后者改为失焦自动保存并移除按钮。 |
| 3 | 「刷新」按钮换行 | 已修复 | `#refreshAsrPresets` 增加 `min-width: 72px; white-space: nowrap`。 |
| 4 | 弹窗太大 | 已修复 | `.asr-preset-modal-card` 为 `min(760px, 100vw-48px) × min(600px, 100dvh-48px)`。 |
| 5 | 修改时间下方显示文件路径，点击打开 | 已修复 | 原型已实现；第二轮按新反馈移除了该路径显示。 |
| 6 | 「有效字段」预览，空字段跳过 | 已修复 | `renderPresetOptionsPreview()` 逐行列出非空字段，超长截断。 |
| 7 | 复制预设应先复制再改名 | 已修复 | `copy` 动作生成「×× 副本」并选中，焦点落在名称输入框全选等待改名。 |
| 8 | 表单有变动时在「预设管理」左侧显示「更新预设」 | 已修复 | 快照对比控制 `updateCurrentAsrPreset` 显隐。 |
| 9 | 打开「管理预设」时自动聚焦当前预设 | 已修复 | `openAsrPresetManager()` 对当前预设 `selectAsrPreset(name, { focus: true })`。 |
| 10 | 弹窗滚轮不透传到 Launcher | 已修复 | 弹窗 `wheel` 监听 + `overscroll-behavior: contain`。 |
| 11 | Prompt/Context 合并为一个共享值 | 已修复 | 原型合并了 `openaiPrompt` + `qwenAudioContext` → `promptContext`；本任务补齐 `sonioxContextText`：预设 schema 移除该字段，三个输入框（Qwen 上下文 / OpenAI Prompt / Soniox Text）双向同步，旧预设读取时自动并入共享值（`SHARED_PROMPT_INPUTS`）。 |

## 第二轮用户反馈逐条状态

| # | 反馈 | 状态 | 处理结果 |
| --- | --- | --- | --- |
| 1 | 主表单「更新预设」直接更新，不要二次弹窗 | 已修复 | `updateCurrentAsrPresetFromForm()` 移除 `confirmAction`；弹窗内「更新到预设」覆盖的是列表选中项（可能与当前预设不同），保留二次确认。 |
| 2 | 去掉「另存为新预设…」介绍文字 | 已修复 | 移除 `asr-preset-action-hint` 段落及 `preset_actions_hint` 文案。 |
| 3 | 「仅保存名称/描述」改为失焦自动保存 | 已修复 | 移除按钮；`asrPresetName` / `asrPresetDescription` `blur` 时若有变更即调用 `save_info` 并显示「预设资料已保存」；带 `presetInfoSaving` 防重入；名称留空时还原旧名。 |
| 4 | 去掉「修改时间」下面的 JSON 路径 | 已修复 | 移除 `#asrPresetFilePath` 元素、JS 与 CSS；后端 `open_asr_preset_file`（含路径穿越防护，有测试覆盖）保留。 |
| 5 | 5 个按钮放到弹窗下方，增加 hover 说明 | 已修复 | 操作按钮移入 `.asr-preset-modal-actions`（弹窗底部一行），全部带 `data-i18n-title` 悬停说明（zh/en）。 |
| 6 | 预览加大 | 已修复 | `.asr-preset-preview` 改为 `flex: 1 1 auto; min-height: 150px`，移除 100px 上限（实测约 170px，随弹窗空间伸展）。 |
| 7 | 未选中时【加载预设】显示为【新建预设】 | 已修复 | `updatePresetActionAvailability()` 同步按钮文案与悬停说明；未选中时点击走 `createAsrPresetFromForm()`，选中时恢复「加载预设」。未选中时「更新到预设 / 复制预设 / 删除预设」保持禁用。 |
| 8 | 预览标签「提示词/上下文」→「提示词」、「热词/关键词」→「热词」 | 已修复 | i18n `preset_field_prompt_context` / `preset_field_hotwords_keywords`（zh/en）同步更新。 |
| 9 | 「设备」不显示预览 | 已修复 | 从 `PRESET_PREVIEW_FIELDS` 移除 `localDevice`。 |
| 10 | 增加显示说话人、调试运行 | 已修复 | 两项本就在预览开关列表中；标签改为「显示说话人」，开关取值显示「是」（原「已启用」），`preset_field_speaker_colors` / `preset_field_enabled` 已更新。 |

## 第三轮用户反馈逐条状态

| # | 反馈 | 状态 | 处理结果 |
| --- | --- | --- | --- |
| 1 | 「新建预设」也先创建再改名 | 已修复 | `createPresetFromForm()`：输入框为空时自动取「未命名预设」（重名自动加序号），创建后选中新预设并聚焦全选名称等待改名；输入框已有名称时仍按输入创建。 |
| 2 | 弹窗底部文案改为「预设文件夹：__path__（可在 设置 中更改）」 | 已修复 | `preset_modal_saved_in` / `preset_modal_settings_lead` / `preset_modal_settings_tail`（zh/en）同步更新。 |
| 3 | 设置区「当前预设：」→「当前预设文件夹：」 | 已修复 | `preset_current_folder`（zh/en）更新。 |
| 4 | 「恢复默认」用「重新扫描」同款小按钮，并与「当前预设文件夹」同行 | 已修复 | `resetAsrPresetRoot` 移入 `.preset-root-current` 行，`ghost small`；该行改为 `align-items: center; gap: 4px 6px`。 |
| 5 | 底部按钮行与上方需要间隔；把间距要求写入 AGENTS.md | 已修复 | `.asr-preset-modal-actions` 增加 `margin-top: 12px`；AGENTS.md 新增「UI 间距约定」小节（含截图自查要求）。 |
| 6 | 「另存为新预设」→「将当前配置存为新预设」，同样先存再改名 | 已修复 | 按钮文案（zh/en）与创建流程同上。 |
| 7 | 增加「激活中预设」的 active 样式，并考虑 .active.selected | 已修复 | 列表项按 `currentAsrPreset.name` 加 `active` 类 + 「当前」徽标（i18n `preset_active_badge`）+ accent 名称色，`aria-current="true"`；`.active.selected` 组合样式已定义；`setCurrentAsrPreset` 联动刷新列表徽标。 |

## 第四轮用户反馈逐条状态

| # | 反馈 | 状态 | 处理结果 |
| --- | --- | --- | --- |
| 1 | 「恢复默认」按钮与上方紧贴；AGENTS.md 规则没起作用 | 已修复 | 根因：`.field` 只有 `margin-top`、`.hint` 为 `margin: 0`，新行必须自带间距——`.preset-root-current` 增加 `margin-top: 10px`；「恢复默认」居右（`margin-left: auto`）。AGENTS.md 规则强化：明确 `.field`/`.hint` 的间距陷阱，验收必须用 `getComputedStyle` 实测数据，禁止截图目测。 |
| 2 | 弹窗右下「关闭」与右上 × 重复 | 已修复 | 移除 `asrPresetCloseFooter`（HTML/JS/CSS），关闭入口保留右上 ×、背景点击与 Esc；焦点圈测试改为从「设置」链接 Tab 环绕。 |
| 3 | 更新 active 预设不应弹确认；按钮文案区分状态 | 已修复 | `updateSelectedAsrPreset()`：选中项为当前激活预设时不再二次确认，覆盖其他预设仍需确认；按钮文案随状态切换——active → 「更新该预设」（`preset_update_active`），否则 → 「覆盖至预设」（`preset_update_selected`），标题同步切换。 |
| 4 | 刚加载完预设就显示 dirty（预设名 *） | 已修复 | 根因：后端 `validate_options` 会把 `qwenAudioKeepDialect` 重排到键序首位，前端 `JSON.stringify` 快照对比对键序敏感 → 恒不等。修复：前端改用键序无关的 `stablePresetString()`（排序键）比较，后端不再重排键（`setdefault`）。浏览器 mock 的 `load` 改为返回键序反转的 options 以固化回归。 |
| 5 | 默认停顿切句阈值 800 → 500ms | 已修复 | 7 个 CLI 脚本 `--gap-split` 默认值与帮助文案、`maw/local_asr.py` 引擎默认、`docs/CLI.md`、`docs/LOCAL_ASR.md`、Launcher 占位符与 i18n 同步更新；CHANGELOG 记入【🔄 变更】。 |
| 6 | 「获取 API Key」行加蓝色 Callout，不用强调色 | 已修复 | 新增独立变量 `--info` / `--info-soft` / `--info-tint`（当前复用 accent 色值，后续可独立调整），`.key-hint-callout` 采用与参考价 callout 同款结构。 |
| 7 | 首页标语更换 | 已修复 | Launcher hero 文案改为「让字幕制作变得超级轻松！」/ "Making subtitle creation super easy!"（zh/en）。 |

## 第五轮用户反馈逐条状态

| # | 反馈 | 状态 | 处理结果 |
| --- | --- | --- | --- |
| 1 | 「新建预设」与「将当前配置存为新预设」功能重复，去掉交替逻辑 | 已修复 | 按钮恒为「加载预设」，未选中时禁用；创建入口统一为「将当前配置存为新预设」（输入为空时仍自动取「未命名预设」先建后改名）；移除 `preset_create` 文案。 |
| 2 | 「双击可直接加载预设」提示居左、挨着「预设列表」（留空隙） | 已修复 | `.asr-preset-list-header` 改为 `justify-content: flex-start`（gap 8px），提示紧邻标题居左；双击加载行为本身已存在，浏览器测试补双击加载流程与提示位置（同行、间距 8–40px）断言。 |
| 3 | 「已加载预设：××」与「当前预设」重复，去掉 | 已修复 | `loadSelectedAsrPreset()` 不再显示加载成功提示（`preset_loaded` 文案移除）；热词文件丢失警告保留。 |

## 其他修复（上一轮遗留问题）

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| docs/WORKFLOW.md 行内代码空格污染 | 已修复 | 还原了上一轮 diff 引入的多处行内代码空格（`beijing`、`filetrans`、`BASE_URL= https` 等）。 |
| WORKFLOW.md 预设章节与实际 UI 一致 | 已修复 | 按钮名改为「另存为新预设 / 仅保存名称/描述 / 更新到预设 / 复制预设 / 删除预设 / 预设管理」，补充共享提示词说明。 |
| ruff：gui_web.py 未使用导入 | 已修复 | 移除未使用的 `validate_preset_name` 导入。 |
| CHANGELOG | 已修复 | 预设库条目更新为包含共享提示词、底部操作按钮与失焦保存、回收站删除。 |
| 共享提示词加载后 Soniox 字数显示 | 已修复 | `setSharedPromptContext` / `syncSharedPromptContext` 同步刷新 `renderSonioxContextCharacterCount()`。 |

## PR #152 合并前审查（macOS，2026-09-24）

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| `test_copy_generates_...` 在 macOS 失败 | 已修复 | `/var` 是 `/private/var` 的符号链接，`preset_path` 的 `resolve(strict=True)` 使 `_open_existing_path` 收到 `/private/var/...` 前缀；断言改为与 `resolve()` 后的路径比较，Windows / macOS 均成立。仓库 CI 仅在 Windows 跑单测，故未暴露。 |
| WORKFLOW.md 其余 10 处行内代码空格污染 | 已修复 | 此前记录称「更早遗留、不属本任务范围」与事实不符：与 main 逐行对比，该文件在 main 上无任何同类污染，10 处均由本分支引入（上一轮「修复」实际只修了更早一轮引入的部分），已全部还原为 main 原文。 |
| CHANGELOG 存量行内代码空格污染 | 仅说明 | main 上已存在约 27 行同类污染，非本 PR 引入，未在本次顺手改动。 |

## 验证

- `node --check web\launcher\launcher.js`（及 editor.js / waveform.js）：通过。
- `node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs`：334 项通过。
- `node --test tests\test_asr_presets_browser.mjs`（`MAW_TEST_PLAYWRIGHT` 指向主检出 Playwright）：通过，含共享提示词（Qwen/OpenAI/Soniox 三框同步）、主表单无确认更新、弹窗更新保留确认、失焦保存、新建预设切换、底部按钮行、预览高度、滚轮阻断、窄屏单列等断言。
- 第三轮补充断言：创建后自动聚焦名称输入、未命名预设默认名、底部按钮行间距、弹窗底部新文案、恢复默认按钮同行、active+selected 徽标（EN 下文案 Active）。
- 第五轮补充断言：加载按钮恒为「加载预设」且未选中时禁用、双击列表项直接加载关闭弹窗、「双击可直接加载预设」提示与标题同行且间距 8–40px。
- 第六轮补充断言：加载成功后主表单状态行保持为空（仅热词丢失时提示）。
- `python -m unittest tests.test_asr_presets tests.test_gui_web`：318 项通过、1 跳过（使用主检出 `.venv`，`PYTHONUTF8=1`）。
- 全量 `python -m unittest discover -s tests -p "test_*.py"`：1691 项通过、12 跳过（第二轮改动前基线；其后仅改前端与文档，前端已单独验证）。
- `python -m ruff check maw tests`：通过。
- `git diff --check`：通过。
- 浏览器截图抽查（临时 probe，未入库）：选中态五个按钮单行排列、预览可见；空态显示「新建预设」、其余按钮禁用；激活预设带「当前」徽标并与 selected 状态叠加；底部按钮行与上方留有 12px 间距；设置区「恢复默认」与「当前预设文件夹」同行。

## 验证边界

- 未重生成 `blank-editor.html`（按约定发布前统一重生成）。
- 后端 `open_asr_preset_file` 保留但前端已不使用（有测试覆盖，含安全防护）。
- 失焦保存与「点击列表项 / 删除」并发场景以代码审查与防重入保护覆盖，未做专项自动化用例。
- 未启动完整 Launcher 实机人工走查；浏览器交互由 Playwright 测试覆盖。
