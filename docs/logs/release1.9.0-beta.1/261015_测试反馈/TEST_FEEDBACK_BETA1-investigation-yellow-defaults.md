# 子代理调查报告：默认黄色全盘清点（#28，目标 `#f9ca1f`）

只读子代理调查（2026-10-15），主会话抽查核对（`maw/colors.py:16`、`maw/ass_styles.py:134/170/178/179/245/401`、
`web/shared/utils/settings.js:23`）全部吻合后并入账本。file:line 以核对时 HEAD `1d961b90` 为准。

先给结论：仓库里的「黄」分四组——**A 调色板黄 `#c4a019`**（单一来源 `maw/colors.py`）、
**B 副字幕默认主色 `#eac953`**、**C SRT/内置样式强调色 `#ffd34d`**（OGRAF/Lottie 高亮默认同源）、
**D ASS 主/副样式强调色 `#ffaa00`（偏橙）**。语义色「选中黄/琥珀」系列不在范围内（见第 3 节）。

## 1. 调色板（字幕颜色选择器）的默认黄色

调色板唯一权威定义在 `maw/colors.py`，渲染时由 `edit.py:251` 注入 `window.ASR_EDITOR_PALETTE`
（`server-editor/serve.py:54` 直接 `import edit` 复用，无第二处注入）；编辑器侧
`web/editor/styles/editor-colors.js:17-22` 只读注入值并补中文标签，**不持有色值**。

| 文件:行 | 现值 | 用途 |
|---|---|---|
| `maw/colors.py:16` | `("yellow", "#c4a019")` | **调色板权威定义**（源头，改此一处即全局联动） |
| `web/shared/utils/settings.js:23` | `yellow: '#c4a019'` | JS 侧 normalize 回退默认（镜像，必须同步） |
| `web/shared/utils/ass-style.js:41` | `{ name: 'yellow', value: '#c4a019' }` | JS fallback 调色板（镜像，必须同步） |
| `web/editor-template.html:1247` | `value="#c4a019"` ×2 | 设置面板「自定义色值」黄控件 HTML 初始值 |
| `JSON_SCHEMA.md:744` | `\| yellow \| #c4a019 \|` | 契约文档色值表 |
| `website/src/pages/docs/json-schema.md:751` | 同上 | 网站镜像文档 |

注：`tests/test_editor_palette.py:10,16` 断言注入来自 `colors.py`，改源头自动通过。

## 2. 「默认字幕颜色」的黄色

### B. 副字幕默认主色 `#eac953` — Python/JS 双权威 + 多处硬编码

- `maw/ass_styles.py:178`：**Python 权威** `DEFAULT_ASS_EXTENSION_STYLE.primaryColor`
- `web/shared/utils/ass-style.js:211`：**JS 镜像** `ASS_DEFAULT_EXTENSION_STYLE`
- `web/editor/state/editor-settings.js:270`：预览副字幕文字颜色默认常量（:421 导出）
- `web/editor-template.html:1039`：设置面板颜色 input 初始值
- `web/editor.css:723`（`.subtitle-extension-text`）、`:3156`、`:3199`：CSS 硬编码
- `JSON_SCHEMA.md:424, 439, 930` + `website/.../json-schema.md:431, 446, 937`：文档
- 迁移判断 **不改**：`maw/ass_styles.py:401-402` 与 `ass-style.js:476` 的
  `if primaryColor == "#ffd34d": 迁移到 DEFAULT`（`#ffd34d` 是历史旧默认，保持原样，
  迁移目标引用 DEFAULT 常量自动跟随新值）
- 历史记录不改：`CHANGELOG.md:56`、`docs/releases/1.9.0-beta.1.md:41`

### C. 内置样式默认强调色 `#ffd34d`（「重点 **xx**」标记色，SRT 默认与所有内置样式底默认）

- `maw/ass_styles.py:134`（`_style_defaults`）+ `:245`（normalize 回退）
- `web/shared/utils/ass-style.js:168` + `:295`（JS 镜像/回退）
- 同源衍生：`web/shared/utils/ograf.js:15`（`OGRAF_DEFAULT_HIGHLIGHT_COLOR`，:276 内联、:332 引用）、
  `web/shared/utils/lottie.js:19`（`LOTTIE_DEFAULT_HIGHLIGHT_COLOR`，:199/:273 引用）、
  `maw/lottie_glyphs.py:563`（RGB 浮点三元组 `[1, 0.827, 0.302]` → 新值应为 `[0.976, 0.792, 0.122]`）

### D. ASS 主/副样式强调色 `#ffaa00`（偏橙，需确认是否算「黄」）

- `maw/ass_styles.py:170, 179` + `web/shared/utils/ass-style.js:203, 211`
- `docs/user/ASS_STYLES.md:60`、`website/src/pages/docs/ass-styles.md:67`（文字记载需同步）

另：主字幕默认色是白（`maw/ass_styles.py:133`、`ass-style.js:27`、`editor-settings.js:267`），无需改。

## 3. 不属于本任务范围的近似黄（语义色，均**不改**）

- **选中黄/琥珀**：`web/editor.css:145-148`（`--selection-yellow: #ffd54a` 等）、亮色主题 :354-357；
  消费点 waveform.css:963/1130-1131/801-802/859/870 等
- **拆分闪黄**：`web/editor.css:176-179, 2761-2762`；`web/waveform.css:626-627, 642, 646`
- **暖色提示语义**：`web/editor.css:153, 259, 267`；`web/waveform.css:691, 792`
- **标记色板黄**：`web/shared/utils/markers.js:17,24`（`#f5b81b`，2026-10-10 定版，非字幕调色板）；
  `editor-export-timeline.js:130-131`（历史映射，按 name 映射不受影响）
- **独立工具/实验**：`server-align/index.html:19`；`web/experiments/filmstrip/lab.mjs:132`；
  `web/shared/templates/ai-comparison.html:5`
- **颜色名字（键名非色值）**：`maw/project_preview.py:26`、`speakers.js:8,12`、`settings.js:19`、
  `ass-style.js:35` 等——色值由调色板供给，改 `colors.py` 即联动

## 4. 测试断言需随改同步

`tests/test_ass_styles.py:29,32,35,63,65,117,139`；`tests/test_project_contract.py:639,650,702`；
`tests/test_editor_utils.mjs:3879,3882,5537,6456-6529`；`tests/test_editor_markers.mjs:17`；
`tests/test_waveform_js.mjs:12`；`tests/test_postprocess_resegment.py:137`；`tests/test_soniox.py:278`；
e2e：`tests/e2e/speaker-labels.spec.mjs:354,491,537,539`、`multi-subtitle.spec.mjs:1831,1851,1855,2644,4338`、
`multi-subtitle-metadata.spec.mjs:101,128`。（部分为任意夹具数据，仅断言默认值的必须改。）

## 5. 收尾注意

① 改 `web/` 后重建 bundle 并跑 `pnpm run check:editor`（blank-editor.html 不主动重生成）；
② 已存工程里旧的色值快照按设计保持不变（`JSON_SCHEMA.md:740` 有明文）；
③ 旧工程存储的 `#c4a019` 快照是否要加迁移（如 ass-extension 那样的旧值迁移）建议维护者拍板。
