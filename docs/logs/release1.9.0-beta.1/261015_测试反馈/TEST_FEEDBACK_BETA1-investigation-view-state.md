# 子代理调查报告：纯文本编辑「编辑视图」状态持久化到工程文件（#13）

只读子代理调查（2026-10-15），主会话抽查核对（`view: 'rows'` 硬编码 `editor-timed-text-edit.js:757`、
唯一写入点 `editor-wiring-text-tools.js:409`、条件写出模式 `editor-json-repair.js:46-49`、
`DATA.workspace` 载入 `editor-project-load.js:106`）全部吻合后并入账本。
file:line 以核对时 HEAD `1d961b90` 为准。

## 1. 视图状态现状：组件内运行时草稿，无任何持久化

**状态载体**：`MaweDom.timedTextEditDraft.view`（运行时草稿对象，非 localStorage、非工程字段）。

- 草稿在 `loadTimedTextEditTrack` 创建，`view: 'rows'` **硬编码默认值**：
  `web/editor/cues/editor-timed-text-edit.js:749-762`（`view` 在 `:757`）
- 状态读取/渲染：`renderTimedTextEditView`，`web/editor/cues/editor-timed-text-edit.js:317-344`
  （读 `draft.view` 在 `:326-327`；single 可用性检查 `timedTextEditCanUseSingleView` 在 `:309-313`，
  含换行的字幕不能切整体编辑；`:326` 已有 single 不可用自动降级 rows 的兜底）
- 打开面板入口 `openTimedTextEdit`：`web/editor/cues/editor-timed-text-edit.js:999-1017`
  （每次打开都重建草稿 → 恢复视图的挂点在 `loadTimedTextEditTrack`）
- 关闭时草稿置 null：`closeTimedTextEdit`，`:781-788` —— 选择不跨会话保留
- **按钮接线不在 `editor-timed-text-edit.js`**，在 `web/editor/cues/editor-wiring-text-tools.js:398-416`：
  click 委托 → `syncTimedTextEditDraftFromDom()` → **`MaweDom.timedTextEditDraft.view = nextView`
  （`:409`，这是唯一状态写入点）** → `renderTimedTextEditView()` + `flushTimedTextEditReport()`
- DOM 节点 `timedTextEditView = #timed-text-edit-view`：`web/editor/ui/editor-dom.js:435`、`:1166`；
  按钮组 HTML：`web/editor-template.html:2452`；样式：`web/editor.css:3406-3423`
- 全编辑器 localStorage 盘点（34 处）无 timedTextEdit 相关 key，确认不走 localStorage

## 2. 工程 JSON 加载/保存链路

**数据对象**：`MaweBoot.DATA`，由模板注入 `const DATA = __DATA_JSON__`：
`web/editor/boot/editor-boot.js:10`（类型声明 `web/editor/boot/editor-globals.d.ts:76`）。

**保存链路**：三个保存入口（服务器/句柄/另存为）全部调 `MaweJsonRepair.buildJson()`：
- `web/editor/io/editor-project-save.js:87-134`（`:95`）、`:139-157`（`:143`）、`:172-205`（`:192`）
- `buildJson`：`web/editor/io/editor-json-repair.js:10-142`。顶层字段逐一显式写出；
  **条件字段模式**：`language_source` `:44`、`preserve_punctuation` `:45`、`split_mode` `:46`、
  `timestamp_granularity` `:47-49`；`workspace` `:126-127`；`preview` `:129-140`（始终写入）；
  markers「无标记不写、保持旧工程 diff 干净」`:122-124`
- 脏检查指纹 `projectSaveFingerprint` 包含 `preview`/`workspace` 等字段：
  `web/editor/io/editor-project-save.js:10-14`

**加载链路**：`MaweProjectLoad.applyCanonicalProject`：`web/editor/io/editor-project-load.js:71+`
- `MaweBoot.DATA.workspace = data.workspace || null`：`:106`；应用 workspace/显示设置：`:134-138`
- `DATA.preview`：`:113`；UI 恢复钩子 `MaweProjectSettings.syncControls()`：`:146`

**字段白名单**：`CANONICAL_PROJECT_FIELDS`（含 `workspace`、`preview`）：
`web/editor/io/editor-wiring-export-context.js:62-67`；未列入的未知顶层字段经
`projectExtensionFields`（`:68-70` + `editor-project-load.js:84-86` + `editor-json-repair.js:19`）透传 round-trip。

**UI 偏好双轨现状**：跨工程浏览器偏好走 localStorage（`web/editor/state/editor-settings.js:1`、
`web/editor/ui/editor-settings-panels.js:27/73/84/103`、`web/editor/media/waveform/settings.js:7-58`）；
随工程的状态走工程 JSON（见第 3 节）。Python 侧校验：顶层枚举字段 `maw/project.py:416-427`；
preview 块 `maw/project_preview.py:31-72`；workspace 本身 Python 不深校验
（仅 serve.py 剥 `navigation`，`server-editor/serve.py:1024-1032`）。

## 3. 「记到工程里」的既有先例

| 字段 | 读/写位置 | schema | 校验/测试 |
|---|---|---|---|
| **`workspace`**（最强先例：纯 UI 布局+显示状态随工程保存恢复） | 写 `editor-json-repair.js:126-127` + `buildCurrentWorkspaceData` `web/editor/io/editor-export-timeline.js:17-24`（含 `editorDisplay`）；历史快照 `web/editor/state/editor-history.js:246`；载 `editor-project-load.js:106/135-138` | `JSON_SCHEMA.md:73`、§1.2 `:207-261` | 前端 schema `moy.asr.editor.workspace.v1`（`web/editor/media/waveform/constants.js:18`） |
| **`preview.ass_mode`**（UI 模式开关存工程的直接先例） | `EDITOR_SETTINGS.assMode` ↔ `DATA.preview.ass_mode` 桥接：`web/editor/state/editor-project-settings.js:8-13`；写 `editor-json-repair.js:130`；载 `editor-project-load.js:113` + `:146` | `JSON_SCHEMA.md:412`、`:911` | `maw/project_preview.py:40-41`；`tests/test_project_contract.py:26-43` |
| `preview.subtitle.speaker_labels.export_enabled` | `editor-project-settings.js:14-25`；写 `editor-json-repair.js:134` | `JSON_SCHEMA.md:414`、`:924` | `project_preview.py:57-59`；`test_project_contract.py:29-42` |
| `multi_subtitle.main_split_mode` | `editor-project-settings.js:26-37`；写 `editor-json-repair.js:55-56` | `JSON_SCHEMA.md:532` | `maw/project.py:524-526` |

特别参考 `waveformScaleAuto`：`JSON_SCHEMA.md:254` 明确论述了「为什么必须落在工程内而不是
localStorage」——跨工程共享的 localStorage 值无法判断*本*工程是否定过值。本次需求
（「打开工程恢复上次关闭时的选择」）同理属于工程级状态。

## 4. 实现建议

**挂载位置：新顶层可选字段，不建议塞进 workspace 或 preview**：
- workspace 有独立 schema 且可被「命名工作区库」跨工程复用/`.workspace.json` 导入导出
  （`JSON_SCHEMA.md:209/261`），混入会把模态面板视图泄漏到其他工程；
  preview 被定义为「预览呈现设置」（`JSON_SCHEMA.md:416`），语义不符。
- 命名建议 `timed_text_edit_view`（`"rows" | "single"`），完全仿照 `split_mode`/`timestamp_granularity`
  的「仅有效值才写」模式（`editor-json-repair.js:46-49`）：`rows` 为默认时不写字段，
  旧工程 diff 干净（同 markers 先例 `:122` 注释）。

**落点清单**：
1. **写**：`editor-wiring-text-tools.js:409` 设置 `draft.view` 后同步
   `MaweBoot.DATA.timed_text_edit_view = nextView`；`buildJson`（`editor-json-repair.js`，仿 `:46`）条件写出
2. **读**：`applyCanonicalProject`（`editor-project-load.js:92-94` 附近模式）加
   `DATA.timed_text_edit_view` 归一化；`loadTimedTextEditTrack`（`editor-timed-text-edit.js:757`）改为
   `view: DATA.timed_text_edit_view === 'single' ? 'single' : 'rows'`——
   `renderTimedTextEditView:326` 已有「single 不可用自动降级 rows」的兜底，旧字段非法值/不可用视图自然安全
3. **白名单**：`CANONICAL_PROJECT_FIELDS` 加 `'timed_text_edit_view'`
   （`editor-wiring-export-context.js:62-67`；不加也能经 extension fields 透传，但会失去显式契约）
4. **脏标记**：可选将字段加入 `projectSaveFingerprint`（`editor-project-save.js:10-14`，
   与 workspace/preview 对齐）
5. **默认值**：旧工程无字段 / 值非法 → `rows`；schema 文档标注「缺失时 rows」

**需同步更新的测试/文档**：
- `JSON_SCHEMA.md`：§一 顶层字段表（`:73` 附近）、§九 字段速查（`:910` 附近）
- `maw/project.py:416-427`：仿 `split_mode` 加枚举校验（`$.timed_text_edit_view must be rows or single`）
- `tests/test_project_contract.py`：仿 `:26-43` 加 round-trip + 非法值拒绝用例
- `tests/e2e/timed-text-edit.spec.mjs`：已有视图切换用例（`:83/:98/:262/:283/:311`），
  可加「保存 → 重开 → 视图恢复」断言
- `CHANGELOG.md` 按发布约定登记
