# 单句放大出现（`{{文字}}`）

基线：`feat/sentence-pop-in`，起始 HEAD `0b61b87c`（main 合并 #272 后）。worktree 只提交本分支，不 merge、不 push。工作树开始时有一个与本任务无关的 `uv.lock` 未提交改动，保持原状不动。

## 方案

### 标记符号

`{{文字}}` 包裹整句 = 该句以「放大出现」入场。冲突复核结论（2026-10-20 全量检查）：

- `sentenceShells` 既有 token 表 `['!!','++','--','**','__','~~','//']` 与 fade 的行首/行尾 `>>`/`<<` 均不含 `{`。
- `massMarkedRanges` 的行内配对符号 `*_+_ -~`、`//`、`!!` 不含 `{`；「左右添加字符」预设表 `WRAP_CHAR_PRESETS` 亦无花括号项。
- ASS 覆盖块本身用 `{…}`，但句级标记在导出前剥除（与 `!!` 同路径），残留花括号由 `escapeAssText` 兜底；SRT 导出同样剥除。
- 仅双符号识别（同 `!!`），不参与「单双符号」规则的单符号形式；「无」规则下不解析、保留原文（与 fade 一致）。

### 动画语义（维护者拍板）

- 终点 = 文字最终大小（scale 1）；起点 = profile 可配的 `fromScale`（默认 1.4），即文字从大缩小落定。
- ASS 实现为单事件两段式：`\fscx{起点}\fscy{起点}\t(0,{inMs},{accel},\fscx{终点}\fscy{终点})`。`\t` 从「当前值」渐变到目标值，因此必须先写显式 `\fscx\fscy` 设定起点，再由 `\t` 缓动到终点；窗口结束后停在终点。
- 起点倍率基于样式自身 `ScaleX/ScaleY`（默认 100）：起点 = `scaleX × fromScale`，终点 = `scaleX`。避免 `ScaleX≠100` 的样式被 pop 拉回 100。
- accel 语义与既有 `\t` 变换一致（progress = linear^accel，帧对照法已验证过该公式）；默认 1（线性）。accel < 1 呈 ease-out 落定手感。
- 分片（震动拆分 / 排布分片）沿用既有负相对时钟模式：`\t({-offset},{inMs-offset},…)`；片起点已越过入场窗口时不发射 pop 标签。

### pop 参数 schema（样式库 profile）

```text
animations.pop = { enabled: false, fromScale: 1.4, inMs: 250, accel: 1 }
```

- `enabled` 只控制「全局自动应用到每一句」；`fromScale` 归一化 1–10，`inMs` 0–60000，`accel` 0.01–100。
- 单句标记复用参数而不看 `enabled`：与既有 fad 的「单句标记覆盖全局」同模式。

### fad / pop 参数解耦（维护者拍板）

样式库 UI 的 `data-ass-animation` 统一 disabled 联动（fad/fade/move/t 参数字段随 `enabled` 禁用）拆开：`fad` 与 `pop` 两组的数值字段不再随开关联动禁用，因为单句 `>>` / `{{}}` 标记会在全局开关关闭时复用这些时长/倍率参数；`fade` / `move` / `t` 保持原联动。

### 组合语义

- 句级 pop 进入 `sentenceShells` 的壳剥离循环，可与 `>>…<<` 淡入淡出、`!!…!!` 震动、行内格式（`**` 等）、单句缩放按任意嵌套顺序组合；剥除一类标记时保留其余外层（同既有 fade/shake）。
- pop 与全局 `\t` 自定义变换并存时两个 `\t` 链式生效（pop 落定后的 `\fscx` 成为自定义变换的起点值）；pop 起点的显式 `\fscx` 只在本事件内生效，不改样式行。
- 叠加优先级：`单句标记` 与 `全局 enabled` 任一命中即应用 pop；两者都命中时等同（同一组参数）。
- 堆叠包围盒把入场最大状态（`fontSize × fromScale`）计入采样最大值，预览与导出共用同一排布计划，帧对照语义一致。

### 消费链路

- 解析：`text-processing.js` 新增 `parseSentencePopMarkers` / `stripSentencePopMarkers`（壳 kind `pop`）；`ass-animation.js` 的 `assSentenceFadeTags` 更名 `assSentenceAnimationTags`，返回 `{ text, fad, pop }`。
- 导出：`ass-export.js` 三轨（主/副/叠加）入栈前剥除 pop 并携带 `pop` 参数；`addStackItem` 的 `fad` 形参扩为 `{ text, fad, pop }`；标签由 `assAnimationOverrideTags` / `assAnimationSliceTags` 生成。legacy 原文快路径安全：pop 标记在事件文本构建前已剥除。
- 预览：`assPreviewAnimationState` 新增 `popScale` 插值（与导出同一公式）；Canvas `drawTrack` 把 `popScale` 乘进缩放矩阵与命中包围盒（围绕锚点缩放，等价 libass 的 origin 缩放）；`assStackFrame` 的 item 携带 `pop` 透传。
- SRT：导出清理链加入 `stripSentencePopMarkers`（`{{}}` 仅在 ASS 语境是动画标记，纯文本输出剥除）。
- 拆分/合并：`completeSplitMassPairs` 补齐跨刀点 pop 对（左补 `}}`、右补 `{{`，嵌套时按外层壳顺序一起补，如 `!!{{aa bb}}!!` → `!!{{aa }}!!` / `!!{{bb}}!!`）；`foldMassPairJunction` 支持整句 pop 壳折叠（`{{甲}}` + `{{乙}}` → `{{甲乙}}`，拆分-合并往返无损）。pop 只认「句级壳位置」的 `{{…}}` 对（行首或外层壳开符号序列内，`popShellPositionRange` 按外层开/闭符号镜像序列判定，与 `sentenceShells` 识别范围一致）；行内字面花括号对不补齐——补了会把字面括号复制成可见文本。复验仍走位置公式 + `parseSentencePopMarkers`，失败回退字面；该侧已剥出完整 pop 壳时不重复补（分层体系守卫，同 fade）。
- Python 镜像：`maw/ass_styles.py` 的 `_animation_defaults` / `_normalize_animation` 增加 pop 组，样式库往返不丢参。

## 清单

| 项目 | 状态 | 决定 / 证据 |
| --- | --- | --- |
| 标记符号与冲突复核 | 已修复 | `{{}}` 无既有冲突，仅双符号，见上 |
| 解析层 | 已修复 | sentenceShells pop 壳 + parse/strip + 预设表 + 句级插入最外层 |
| schema 与归一化 | 已修复 | JS `normalizeAssAnimations` 与 Python `_normalize_animation` 同步 pop 组 |
| 导出标签 | 已修复 | 单事件两段式 `\fscx…\t`，分片负时钟，快路径安全 |
| 预览插值 | 已修复 | popScale 与导出同一公式；Canvas 矩阵与命中盒乘算 |
| 拆分补齐 / 合并折叠 | 已修复 | 壳位置判定的 pop 补齐与整句壳折叠，字面括号不补 |
| fad/pop UI 解耦 | 已修复 | `editor-wiring-ass-manager.js` 的 disabled 逻辑按组解锁 |
| 测试 | 已修复 | 新增 `tests/test_ass_animation.mjs`；扩展 `tests/test_ass_styles.py` |
| 文档 | 已修复 | ASS_STYLES / EDITOR_GUIDE / CHANGELOG / 本账本 + INDEX 登记；JSON_SCHEMA.md 经核实不含动画与标记契约，无需同步 |

## 验证

HEAD `0b61b87c` 工作树（未提交时点）逐层执行，全部通过：

- Node 单测（`run_check.py` 包裹，exit 0）：
  - `node --test tests/test_ass_animation.mjs tests/test_mass_markers.mjs` → 33/33（含新增 pop 拆分补齐 3 项、合并折叠 1 项）。
  - `node --test tests/test_editor_utils.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_assets.mjs tests/test_waveform_js.mjs tests/test_srt_export.mjs` → 408/408。
- Python：`python scripts/run_tests.py --parallel 8` → 2636 tests（skipped 18），wall 34.3s，全部 OK（含 `test_ass_styles.py` pop 归一化、`test_editor_assets.py` pop 绑定断言）。
- 构建与类型：`node scripts/build-editor.mjs --write` 后 `pnpm run check:editor` fresh；`pnpm run typecheck` 通过。
- 文档与卫生：`scripts/check_docs.py` → 0 new broken links / 0 structure errors；`git diff --check` 干净；`scripts/check_personal_paths.py --diff-ref main` 通过。
- 未验证边界（人工实机验收）：真实 libass 渲染帧对照、浏览器拖动/播放/seek 体验、样式库 pop 卡片间距实测；`blank-editor.html` 按约定留待发布前统一重生成。
