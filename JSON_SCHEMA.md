# 字幕工程文件规范（`.mosp` / `.json`）

本文档定义 MAWE（Moy's ASR Workflow Editor）、`edit.py` 生成的 `.edit.html` 以及 `blank-editor.html` 共同接受的工程文件格式。工程文件内容是 UTF-8 JSON；`.mosp` 是当前默认和推荐的扩展名，`.json` 作为旧工程与兼容输入/输出扩展名继续支持。

用途：让任意来源（ASR、第三方模型生成、人工手写）的 JSON 都能直接被编辑器加载、编辑、再导出。

适用版本：对应 `edit.py` / `generate_subtitle_qwen_api.py` 当前实现。

---

## 一、顶层结构

```json
{
  "media": "...",
  "language": "...",
  "model": "...",
  "sticker_root": "...",
  "waveform": { ... },
  "gap_remove": { ... },
  "workspace": { ... },
  "preview": { ... },
  "segments": [ ... ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `segments` | `array<object>` | **必填** | 字幕段数组。**缺失或不是数组时，页面直接弹「文件格式不对，缺少 segments 字段」并拒绝加载** |
| `media` | `string` | 否 | 媒体文件路径（绝对/相对均可）。便携 HTML 会在“打开工程”时用它的文件名匹配同一次选择的媒体；只选工程文件时会提示用户继续选择媒体。浏览器安全限制下不能自行读取该路径或跳转其目录。服务器编辑器可按该路径自动加载 |
| `language` | `string` | 否 | 语言代码，如 `Chinese`、`English`。仅用于显示 |
| `model` | `string` | 否 | ASR 模型名，如 `qwen3-asr`。仅用于显示 |
| `sticker_root` | `string` | 否 | 表情包根目录绝对路径。打开工程时会覆盖编辑器内的 `STICKER_ROOT` |
| `waveform` | `object` | 否 | 可丢弃的紧凑波形缓存。由 `edit.py` 或浏览器自动生成；不影响字幕语义 |
| `gap_remove` | `object` | 否 | 可逆的空隙移除决定。保留原始媒体/字幕时间，仅描述导出与跳过播放时使用的派生时间轴 |
| `workspace` | `object` | 否 | 编辑器工作区：四个功能区的窗口布局与显示状态；不影响字幕和波形缓存。服务器版也可使用独立的本机命名工作区库跨工程复用 |
| `preview` | `object` | 否 | 预览呈现设置。含 `preview.subtitle`（主字幕预览框与样式）、可选的 `preview.extension_subtitle`（拓展字幕样式）和 `preview.sticker`（表情包预览层）。不影响字幕时间与文本 |

### 1.0 工程文件扩展名

- 转写器和 Launcher 默认生成 `.mosp`；命令行的 `--json` 参数名称为历史兼容名称，含义是“同时生成工程文件”。
- `.mosp` 文件不是新的二进制容器，而是普通 UTF-8 JSON，方便脚本、版本控制和其他工具读取。
- 编辑器、服务器和桌面入口都继续接受 `.json`。打开旧 `.json` 工程时可以原扩展名保存，也可以通过“另存为”改成 `.mosp`。
- 服务器覆盖保存会保留当前扩展名，并先创建同目录备份：`project.mosp.bak` 或 `project.json.bak`。
- `.workspace.json` 是可选的独立工作区迁移文件，不是字幕工程文件；Resolve JSON、保留区域 JSON 等导出文件也不应重新作为工程打开。

### 1.1 waveform 波形缓存

`waveform` 不是工程真源，而是从媒体派生的性能缓存。第三方生成 JSON 时可以完全省略；编辑器加载媒体后会补算。

```json
{
  "schema": "moy.asr.waveform.v1",
  "encoding": "i8-minmax-base64",
  "peaks_per_second": 100,
  "peak_count": 123456,
  "duration_ms": 1234560,
  "data": "base64 编码的 [min,max] int8 峰值对",
  "source": {
    "name": "audio.wav",
    "size": 987654321,
    "modified_ms": 1784000000000
  }
}
```

- `data` 每个峰占 2 字节：有符号 int8 的最小值、最大值，整体再做 base64。
- `source` 用于缓存失效；媒体文件名、字节大小或最后修改时间变化时会重新计算。
- 默认密度 100 峰/秒。三小时音频约产生 108 万峰、2.88 MB base64 字符串。
- 未识别的 `schema` / `encoding` 会被忽略，不阻止工程加载。
- Qwen/Soniox 命令行生成器默认不内嵌波形；加 `--with-waveform` 时可在转写生成工程文件时把同一 payload 写入顶层 `waveform`。GUI 转写默认开启该模式。
- 编辑器首次打开缺少有效 `waveform` 的工程时，仍可能在媒体旁写入 `<媒体名>.waveform.json` sidecar；它使用同一 `source` 签名，可被后续工程复用。sidecar 不属于字幕真源，删除后可重新提取。

### 1.2 workspace 工作区

`workspace` 使用独立 schema `moy.asr.editor.workspace.v1`。一个工作区 = **窗口布局**（“视频、当前字幕编辑区、字幕列表、波形”四个功能区的停靠方式与尺寸）+ **显示状态**（波形显示模式与偏好、字幕列表/编辑区的显示开关）。保存或恢复工作区时两部分一起生效。

```json
{
  "schema": "moy.asr.editor.workspace.v1",
  "preset": "custom",
  "selectedPreset": "cinema",
  "waveformMode": "basic",
  "waveformSettings": { "visibleSeconds": 20, "secondsPerRow": 10, "rowHeight": 120, "waveformScale": 1, "side": "left", "disabledDisplay": "dim", "showGroupBadges": true, "dragPlayhead": true },
  "editorDisplay": { "cueListShowIndex": true, "cueListShowTime": true, "cueListShowSticker": false, "cueListShowCharcount": true, "cueEditorShowNavigation": false, "cueEditorShowTimeActions": true, "cueEditorShowSticker": false },
  "splitPercent": 60,
  "columnPercent": 58,
  "rows": [42, 27, 31],
  "tree": {
    "type": "split",
    "direction": "row",
    "ratio": 58,
    "children": [
      {
        "type": "split",
        "direction": "column",
        "ratio": 42,
        "children": [
          { "type": "module", "id": "player" },
          {
            "type": "split",
            "direction": "column",
            "ratio": 46.55,
            "children": [
              { "type": "module", "id": "panel" },
              { "type": "module", "id": "cues" }
            ]
          }
        ]
      },
      { "type": "module", "id": "wave" }
    ]
  }
}
```

- `preset` 是**渲染器**，决定这份窗口布局如何绘制：`classic`（标准堆叠网格）、`wave-right`（右侧整列波形网格）或 `custom`（由 `tree` 渲染；「字幕列表编辑」「大荧幕布局」与用户自定义工作区都走这条路）。未知值回退到 `wave-right`。
- `selectedPreset` 记录用户最后在**工作区下拉框**选择的项：内置工作区为 `classic` / `wave-right` / `three-fold` / `cinema`（大荧幕布局），本机命名工作区为 `saved:<名称>`。它与 `tree` 一起保存，使内部以 `custom` 渲染的工作区在重开工程后仍显示用户所见的名称。
- `waveformMode` 可为 `multi`（多行）或 `basic`（单行）。工作区中存在该字段时随恢复一并切换；缺失时保持当前浏览器设置。
- `waveformSettings` 保存波形区数值与显示偏好：基础模式窗口长度、多行每行长度及高度、振幅、左右侧、禁用字幕显示、分组徽章与拖动播放头。字段缺失时保持浏览器本机设置。
- `editorDisplay` 保存“字幕列表显示”和“字幕编辑显示”两组开关。它只包含工作区可见性，不包含导出、自动保存或快捷键等全局偏好。
- `splitPercent` 是 classic 网格中多行波形与字幕列表比例，范围会被限制在 35–75；它与工作区一起导出，因此拖动后可撤销、复用。
- `columnPercent` 是 `custom` 渲染器最外层左右分栏的比例，范围会被限制在 30–75。
- `rows` 是左侧“视频 / 当前字幕 / 字幕列表”的相对高度，编辑器会自动归一化并保证每区可用的最小高度。
- `tree` 是 `custom` 渲染器的二叉 split tree。`type: "module"` 是功能区叶子；`type: "split"` 的 `direction` 为 `row`（左右）或 `column`（上下），`ratio` 是第一个子区的比例。
- 布局编辑模式拖动标题条时，中央区域会显示“对换”预览；靠近上/下/左/右边沿会显示对应半区的“插入”预览。松开后目标叶子会被拆成新的横向或纵向 split，可继续嵌套。
- 工程文件导出会包含 `workspace`。单文件 HTML 在「工作区配置 ▾」提供“导出工作区配置 / 导入工作区配置”，以 `.workspace.json` 文件显式迁移该结构；服务器版的「保存工作区」则把同一结构保存到用户本机：内置工作区保存为该预设的本机覆盖版（可重置回默认），自定义工作区保存到命名工作区库（可另存、删除），均可供其他工程复用；该操作不会写回字幕工程文件。
- 拖动模块、拖动任一布局分隔条、导入和重置工作区都会进入统一的 `Ctrl(Cmd)+Z` 撤销栈；「编辑布局」中可用「重置工作区」恢复当前内置工作区的默认状态。

### 1.3 gap_remove 空隙移除

`gap_remove` 是编辑决策，不会重写 `segments[*].start/end` 或原媒体。编辑器把其中 `removed: true` 的区间从**派生时间轴**压缩掉，用于自动跳过播放、去空隙 SRT 和去空隙 OTIO；`removed: false` 表示用户已恢复该空隙。

```json
{
  "schema": "moy.asr.gap_remove.v1",
  "detector": "audio_gate",
  "minimum_ms": 500,
  "threshold_db": -24,
  "hysteresis_db": 2,
  "lead_in_ms": 40,
  "lead_out_ms": 80,
  "skip_playback": true,
  "manual_corrections": false,
  "operation_mode": "middle_drag",
  "gaps": [
    { "start": 1280, "end": 2440, "removed": true },
    { "start": 6120, "end": 7050, "removed": false }
  ]
}
```

- `detector` 固定为 `audio_gate`：扫描波形峰值包络，声音高于 `threshold_db` 时打开 gate，低于 `threshold_db - hysteresis_db` 后才关闭；不会用字幕之间的时间差推断空隙。
- `minimum_ms` 的允许范围是 100–60000，单位为毫秒；默认 500。判定基于应用前/后端预留后的最终移除区间，预留吃完整段时不纳入移除。
- `threshold_db` 的范围是 -96–0，默认 -24；`hysteresis_db` 的范围是 0–30，默认 2。比如阈值 -24、滞回 2 时，声音达到 -24 才算有声，低于 -26 才重新算静音。建议使用 1–3dB；过高会延迟回到静音。滞回位于「高级设置」折叠区内。
- `lead_in_ms` / `lead_out_ms` 是每段空隙两侧保留的静音毫秒数，范围 0–2000，默认前端 40、后端 80。扫描得到的原始静音区间会在起点加 `lead_in_ms`、终点减 `lead_out_ms` 后再写入 `gaps`，避免剪掉空隙后两句贴得太急；预留后的区间短于 `minimum_ms` 时整段保留。
- `manual_corrections` 表示当前结果是否包含人工修正。Alt+左键切换整段、边界拖动、中键范围操作和“全部恢复”都会设为 `true`；重新扫描前会要求确认，扫描成功后重置为 `false`。
- `operation_mode` 控制人工修正交互：`none` 仅保留 Alt+点击整段切换，`boundary_drag` 在 hover 空隙时显示左右边界手柄，`middle_drag` 默认用中键增加静音、按住 Alt 才恢复声音；默认 `middle_drag`。边界拖入另一段空隙时会直接合并两段。
- 扫描不会移除开头或结尾的素材。
- 波形将 `removed: true` 画为橙色斜纹、`removed: false` 画为灰蓝斜纹；左键仅跳转播放头，Alt+左键才在两种状态间切换。
- 旧版按字幕间隔扫描的结果会保留在工程中，但为避免误删已停用；重新扫描后会写入 `detector: "audio_gate"`。

### 1.4 preview 预览呈现

`preview` 记录预览呈现层的设置，与字幕时间/文本完全解耦。目前定义两个子几何：`preview.subtitle`（字幕预览框，编辑器里 `#overlay`）与 `preview.sticker`（表情包预览层，编辑器里 `#sticker-overlay-layer`），都是在播放器区域内的几何，以 player-wrap 矩形的**归一化分数**存储，因此在播放器缩放和跨机传输后仍然一致。

```json
{
  "subtitle": { "x": 0.175, "y": 0.76, "width": 0.65, "height": 0.16, "font_size": 32, "font_family": "yahei", "color": "#ffffff" },
  "extension_subtitle": { "font_size": 30, "font_family": "yahei", "color": "#ffd34d" },
  "sticker": { "x": 0.73, "y": 0.04, "width": 0.24, "height": 0.3 }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `x` | `number` | 是 | 左上角横坐标，占播放器宽度的分数，范围 `[0, 1]` |
| `y` | `number` | 是 | 左上角纵坐标，占播放器高度的分数，范围 `[0, 1]` |
| `width` | `number` | 是 | 预览框宽度，占播放器宽度的分数，范围 `[0, 1]` |
| `height` | `number` | 是 | 预览框高度，占播放器高度的分数，范围 `[0, 1]` |
| `font_size` | `number` | 否 | 字幕预览字号，单位 px，范围 `[12, 96]`；缺失时使用原来的响应式默认字号 |
| `font_family` | `string` | 否 | 字幕预览字体族键：`default`、`yahei`、`hei`、`song` 或 `sans` |
| `color` | `string` | 否 | 六位十六进制颜色，如 `#ffffff`；主字幕默认白色，拓展字幕默认黄色 `#ffd34d` |
| `preview.extension_subtitle` | `object` | 否 | 拓展字幕样式；同样支持 `font_size`、`font_family`、`color`，没有字号时默认比主字幕小 2px |

### 约束

- `x`、`y`、`width`、`height` 四个字段都必须是数字（不接受字符串、布尔），且落在 `[0, 1]`。
- 若存在 `font_size`，必须是 `[12, 96]` 内的数字；若存在 `font_family`，必须是规定的字体族键。
- 若存在 `color`，必须是 `#RRGGBB` 六位十六进制颜色；拓展字幕样式不包含独立几何，沿用 `preview.subtitle` 的预览框。
- 盒子必须留在播放器内：`x + width <= 1` 且 `y + height <= 1`。
- 编辑器额外强制最小可读尺寸 `width >= 0.20`、`height >= 0.08`（这是编辑器 UX 钳制，非数据契约的硬校验；导入时会被编辑器再钳制）。
- `preview` 缺失或 `preview.subtitle` 缺失时按**旧工程**处理，编辑器使用默认几何 `{ x: 0.175, y: 0.76, width: 0.65, height: 0.16 }`——字幕带占 76%→92%（底部留 8%），宽度 65% 居中。
- `preview.sticker` 缺失时同样按旧工程处理，使用默认几何 `{ x: 0.73, y: 0.04, width: 0.24, height: 0.3 }`（右上角）。两个几何共用同一套归一化与钳制规则。
- 该几何只移动/缩放预览框容器；内部文字 `<span>` 仍保持居中与药丸样式，`segments[*].start/end/items[*].start/end` 永不被此几何改动。

### 1.5 multi_subtitle 多重字幕

`multi_subtitle` 是可选的双语字幕扩展结构。旧工程缺失该字段时，编辑器按关闭状态加载；保存时会补写关闭的空结构。顶层 `segments` 始终是主轨真源，扩展字幕只放在 `tracks[*].segments` 中。

```json
{
  "multi_subtitle": {
    "schema": "moy.asr.multi_subtitle.v1",
    "enabled": true,
    "display_mode": "both",
    "main_split_mode": "word",
    "tracks": [{
      "id": "translation",
      "role": "extension",
      "name": "English",
      "language": "English",
      "split_mode": "word",
      "source_name": "translation.srt",
      "segments": [{
        "id": "translation-001",
        "start": 1100,
        "end": 2900,
        "text": "Extended subtitle"
      }]
    }],
    "bindings": [{
      "id": "binding-001",
      "track_id": "translation",
      "main_segment_ids": ["main-001"],
      "extension_segment_ids": ["translation-001"],
      "start_offset_ms": 100,
      "end_offset_ms": -100
    }]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `multi_subtitle.schema` | string | 否 | 固定为 `moy.asr.multi_subtitle.v1` |
| `multi_subtitle.enabled` | boolean | 否 | 默认 `false`；关闭只隐藏扩展数据，不删除数据 |
| `multi_subtitle.display_mode` | string | 否 | `main` / `extension` / `both`，默认 `both` |
| `multi_subtitle.main_split_mode` | string | 否 | 主字幕语言类型：`continuous`（字符型）或 `word`（单词型）；旧工程缺失时按主字幕文本自动判断 |
| `multi_subtitle.tracks` | array | 否 | 扩展轨数组；当前 UI 只管理第一条轨道 |
| `tracks[i].id` | string | 是 | 轨道稳定 ID |
| `tracks[i].role` | string | 否 | 当前固定为 `extension` |
| `tracks[i].name` | string | 否 | 用户可见轨道名 |
| `tracks[i].language` | string | 否 | 语言或语言代码 |
| `tracks[i].split_mode` | string | 否 | 副字幕语言类型：`continuous`（字符型）或 `word`（单词型）；用于近似拆分和字数统计 |
| `tracks[i].source_name` | string | 否 | 来源文件名，不保存绝对路径 |
| `tracks[i].segments` | array | 是 | 扩展字幕段；每段只有段级时间码和文本 |
| `tracks[i].segments[j].id` | string | 是 | 扩展字幕稳定 ID |
| `tracks[i].segments[j].start/end` | int | 是 | 非负整数毫秒，`start < end` |
| `tracks[i].segments[j].text` | string | 是 | 扩展字幕文本 |
| `bindings` | array | 否 | 主轨与扩展轨的绑定关系 |
| `bindings[i].track_id` | string | 是 | 指向扩展轨 ID |
| `bindings[i].main_segment_ids` | array | 是 | MVP 必须恰好一个主轨 ID |
| `bindings[i].extension_segment_ids` | array | 是 | MVP 必须恰好一个扩展轨 ID |
| `bindings[i].start_offset_ms` | int | 是 | `extension.start - main.start` |
| `bindings[i].end_offset_ms` | int | 是 | `extension.end - main.end` |

约束：

- 主轨和扩展轨段均使用不重复的稳定字符串 ID；缺失 ID 的旧工程会在规范化时补齐。
- 当前 MVP 强制每个绑定一对一；数组形式保留给未来一对多关系，但当前校验要求数组长度均为 1，且一个端点不能重复绑定。
- 自动导入按段级时间码匹配：时间区间有交集，且开始/结束时间差均不超过 `300ms`；冲突选择总差值最小的候选。未匹配段保留，可手动绑定。
- 扩展 SRT 或 mosp/json 没有可靠的字词音频时间码；扩展段中的 `items` 会被忽略/清除，不参与拆分。
- `continuous`（字符型）允许字符边界，`word`（单词型）只允许空格或安全标点附近的边界，禁止拆碎单词。切分时会清理断点两侧相邻的中英文逗号、句号及空白；两种模式也分别决定字数统计规则。
- `enabled: false` 时工程仍保留轨道、绑定、语言类型和 ID；主轨 SRT 导出语义不变，扩展轨使用独立 SRT 导出。

---

## 二、segment 对象

`segments[i]` 的字段定义：

```json
{
  "start": 1234,
  "end": 5678,
  "text": "字幕文本",
  "items": [ ... ],
  "speaker": "1",
  "sticker": null,
  "sticker_ref": null,
  "color": null,
  "color_ref": null,
  "_dirty": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `start` | `int` | **必填** | 段起始时间，**单位毫秒** |
| `end` | `int` | **必填** | 段结束时间，**单位毫秒**，要求 `end > start` |
| `text` | `string` | **必填** | 字幕显示文本。可含 `\n` 表示换行（在编辑器里渲染为 `<br>`） |
| `items` | `array<object>` | 推荐填 | 字级时间戳数组。用于「双击拆分时按字分配时间」。可填 `[]`，此时拆分会按字符比例估算时间点 |
| `speaker` | `string` | 否 | 说话人标签（非空字符串）。保存供应商返回的 opaque ID（如 Soniox 的 `"1"`/`"2"`），不转换为整数或姓名。仅当该段所有带语音 items 都是同一 speaker 时才写入；缺少该字段的旧工程继续有效 |
| `sticker` | `object\|null` | 否 | 表情包 head 信息。见第四节 |
| `sticker_ref` | `object\|null` | 否 | 引用上方 head 的表情包（跨多句用） |
| `color` | `object\|null` | 否 | 颜色标记 head。见第四节 |
| `color_ref` | `object\|null` | 否 | 引用上方 head 的颜色 |
| `_dirty` | `bool` | 否 | 是否被人工改过。**生成时不要写 `true`**，仅由编辑器内部维护 |

### 关键约束

- `start` / `end` / `items[*].start` / `items[*].end` 全部是**整数毫秒**（不是秒、不是字符串、不是浮点）
- `segments` 建议按时间升序排列，且 `segments[i].end <= segments[i+1].start`
- 代码不强校验时间重叠，但重叠会导致播放器跳转/高亮行为异常
- `items` 首元素 `start` 建议等于 segment `start`，末元素 `end` 建议等于 segment `end`
- 带 `speaker` 的工程遇到说话人变化时**必须切分字幕**，不能把两个 speaker 合入同一 segment

---

## 三、items（字级时间戳）

`segments[i].items[k]` 的字段：

```json
{
  "text": "字",
  "start": 1234,
  "end": 1300,
  "speaker": "1"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | `string` | 是 | 单字或单词。**所有 item 的 `text` 拼接后应等于所属 segment 的 `text`**（标点也应包含在内，编辑器拆分时会按需剥掉） |
| `start` | `int` | 是 | 该字/词起始时间（毫秒） |
| `end` | `int` | 是 | 该字/词结束时间（毫秒） |
| `speaker` | `string` | 否 | 该字/词的说话人标签（非空字符串），保存供应商返回的 opaque ID |

### 生成建议

- 中文逐字给时间戳，英文按词给
- 标点符号可作为零宽 item（`start == end`），或并入前一个字的 item，代码都能容忍
- 若生成模型拿不到字级时间，**填 `[]` 也可接受**，编辑器会按字符比例自动插值（拆分时间精度会下降）
- 如果 `items` 字段整个缺失，编辑器视同 `[]`

---

## 四、表情包 / 颜色（head + ref 系统）

这套机制服务于「跨多句字幕覆盖同一个表情包或颜色」的需求。

**生成 JSON 时直接全部填 `null` 即可**，让用户在编辑器里手动分配。本节仅供深度二次开发参考。

### 4.1 sticker head（首条持完整信息）

```json
{
  "name": "表情包名（去扩展名）",
  "filename": "表情包名.png",
  "rel": "相对 sticker_root 的路径，通常等于 filename",
  "start": 1234,
  "end": 9999
}
```

| 字段 | 说明 |
|---|---|
| `name` | 显示名，通常等于文件名去扩展名 |
| `filename` | 完整文件名（含扩展名） |
| `rel` | 相对 `sticker_root` 的路径。平铺目录下等于 `filename` |
| `start` / `end` | 表情包时间范围（毫秒）。导出 EDL 时使用；跨多句时通常等于 head 段的 `start` 与最后一句的 `end` |

### 4.2 sticker_ref（后续条引用 head）

```json
{
  "name": "表情包名",
  "headIdx": 5
}
```

`headIdx` 是 `segments` 数组里的整数下标（0-based），指向同属一个表情包的 head 段。拆分/合并/删除时编辑器会自动维护这个索引。

### 4.3 color head

```json
{ "name": "red", "value": "#e74c3c", "start": 1234, "end": 9999 }
```

`name` 只能是以下 5 种之一：

| name | value |
|---|---|
| `yellow` | `#f1c40f` |
| `green` | `#2ecc71` |
| `red` | `#e74c3c` |
| `purple` | `#9b59b6` |
| `blue` | `#3498db` |

### 4.4 color_ref

```json
{ "name": "red", "headIdx": 5 }
```

---

## 五、最小可用示例

下面这份 JSON 可被编辑器直接接受：

```json
{
  "media": "D:/path/to/video.mp4",
  "language": "Chinese",
  "model": "your-model-name",
  "segments": [
    {
      "start": 0,
      "end": 2150,
      "text": "大家好",
      "items": [
        { "text": "大", "start": 0, "end": 620 },
        { "text": "家", "start": 620, "end": 1280 },
        { "text": "好", "start": 1280, "end": 2150 }
      ],
      "sticker": null,
      "sticker_ref": null,
      "color": null,
      "color_ref": null
    },
    {
      "start": 2200,
      "end": 5400,
      "text": "今天给大家介绍一下字幕编辑器的 JSON 规范。",
      "items": [
        { "text": "今", "start": 2200, "end": 2350 },
        { "text": "天", "start": 2350, "end": 2510 },
        { "text": "给", "start": 2510, "end": 2680 },
        { "text": "大", "start": 2680, "end": 2850 },
        { "text": "家", "start": 2850, "end": 3020 },
        { "text": "介", "start": 3020, "end": 3200 },
        { "text": "绍", "start": 3200, "end": 3400 },
        { "text": "一", "start": 3400, "end": 3580 },
        { "text": "下", "start": 3580, "end": 3780 },
        { "text": "字", "start": 3780, "end": 3950 },
        { "text": "幕", "start": 3950, "end": 4120 },
        { "text": "编", "start": 4120, "end": 4300 },
        { "text": "辑", "start": 4300, "end": 4480 },
        { "text": "器", "start": 4480, "end": 4660 },
        { "text": "的", "start": 4660, "end": 4820 },
        { "text": "JSON", "start": 4820, "end": 5170 },
        { "text": "规", "start": 5170, "end": 5290 },
        { "text": "范", "start": 5290, "end": 5400 },
        { "text": "。", "start": 5400, "end": 5400 }
      ],
      "sticker": null,
      "sticker_ref": null,
      "color": null,
      "color_ref": null
    }
  ]
}
```

---

## 六、给 LLM 生成 JSON 的 Prompt 模板

把下面这段直接粘给任意模型当生成约束：

```
请基于我提供的字幕文本与时间信息，生成符合如下规范的 JSON：

1. 输出必须是合法 UTF-8 JSON，顶层为 object，含 segments 数组（必需）
2. 每个 segment 必须有 start、end、text 三个字段
3. 时间单位统一为毫秒整数（不是秒、不是字符串、不是浮点）
4. start < end，且 segments 按时间升序排列
5. items 数组每项 {text, start, end}；所有 item 的 text 拼接后应等于 segment.text
6. items 首项 start = segment.start，末项 end = segment.end
7. 标点作为零宽 item（start=end）或并入前一个字
8. sticker / sticker_ref / color / color_ref 全部填 null
9. 不要输出 _dirty 字段
10. 不要输出任何 JSON 之外的解释文字、Markdown 代码块标记
11. 中文逐字给时间戳，英文按词给
12. media / language / model 字段按需填写，允许省略
13. 不要生成 waveform；它是编辑器从媒体自动计算的缓存
```

---

## 七、校验方式

生成后任选其一验证：

### 方式 1：用 edit.py 直接生成 HTML

```bash
cd <MAW 仓库目录>
uv run python edit.py your_generated.mosp
```

成功会生成 `your_generated.edit.html`。

### 方式 2：用空壳编辑器加载

1. `file://` 双击打开本仓库根目录的 `blank-editor.html`
2. 点「打开工程」选 `.mosp` 或 `.json` 工程文件
3. 若弹出「文件格式不对，缺少 segments 字段」红色提示，说明顶层结构错误
4. 若正常显示字幕列表，则格式合格

### 方式 3：JSON Schema 自检（可选）

用任意 JSON 校验工具确认以下条件：

- 顶层是 object
- `segments` 是数组，且每个元素都是 object
- 每个 segment 含 `start` / `end` / `text`
- `start` / `end` 为非负整数且 `start < end`
- `segments[*].items` 若存在，每个元素含 `text` / `start` / `end`

---

## 八、字段速查表

| 字段路径 | 类型 | 必填 | 单位/取值 |
|---|---|---|---|
| `segments` | array | ✅ | 字幕段数组 |
| `segments[i].start` | int | ✅ | 毫秒 |
| `segments[i].end` | int | ✅ | 毫秒 |
| `segments[i].text` | string | ✅ | 显示文本 |
| `segments[i].items` | array | 推荐 | 字级时间戳，可 `[]` |
| `segments[i].items[k].text` | string | ✅ | 单字/词 |
| `segments[i].items[k].start` | int | ✅ | 毫秒 |
| `segments[i].items[k].end` | int | ✅ | 毫秒 |
| `segments[i].items[k].speaker` | string | ❌ | 说话人 opaque ID |
| `segments[i].speaker` | string | ❌ | 段内统一说话人才写入 |
| `segments[i].sticker` | object\|null | ❌ | 表情包 head |
| `segments[i].sticker_ref` | object\|null | ❌ | `{name, headIdx}` |
| `segments[i].color` | object\|null | ❌ | `{name, value, start, end}` |
| `segments[i].color_ref` | object\|null | ❌ | `{name, headIdx}` |
| `segments[i]._dirty` | bool | ❌ | 生成时不要写 |
| `media` | string | ❌ | 媒体文件路径 |
| `language` | string | ❌ | 语言代码 |
| `model` | string | ❌ | 模型名 |
| `sticker_root` | string | ❌ | 表情包根目录 |
| `waveform` | object | ❌ | 可丢弃的 `moy.asr.waveform.v1` 峰值缓存 |
| `gap_remove` | object | ❌ | 可逆的 `moy.asr.gap_remove.v1` 空隙移除决定 |
| `multi_subtitle` | object | ❌ | 可选的 `moy.asr.multi_subtitle.v1` 主轨/扩展轨与绑定 |
| `preview` | object | ❌ | 预览呈现设置容器 |
| `preview.subtitle.x` | number | ❌ | 归一化 `[0,1]`，`x + width <= 1` |
| `preview.subtitle.y` | number | ❌ | 归一化 `[0,1]`，`y + height <= 1` |
| `preview.subtitle.width` | number | ❌ | 归一化 `[0,1]`，编辑器最小 0.20 |
| `preview.subtitle.height` | number | ❌ | 归一化 `[0,1]`，编辑器最小 0.08 |
| `preview.subtitle.font_size` | number | ❌ | px，范围 `[12,96]`；缺失时使用响应式默认字号 |
| `preview.subtitle.font_family` | string | ❌ | `default` / `yahei` / `hei` / `song` / `sans` |
| `preview.subtitle.color` | string | ❌ | `#RRGGBB` 六位十六进制颜色，默认 `#ffffff` |
| `preview.extension_subtitle` | object | ❌ | 拓展字幕样式；沿用主字幕预览框 |
| `preview.extension_subtitle.font_size` | number | ❌ | px，范围 `[12,96]`；缺失时默认比主字幕小 2px |
| `preview.extension_subtitle.font_family` | string | ❌ | `default` / `yahei` / `hei` / `song` / `sans` |
| `preview.extension_subtitle.color` | string | ❌ | `#RRGGBB` 六位十六进制颜色，默认 `#ffd34d` |
| `preview.sticker.x` | number | ❌ | 归一化 `[0,1]`，`x + width <= 1` |
| `preview.sticker.y` | number | ❌ | 归一化 `[0,1]`，`y + height <= 1` |
| `preview.sticker.width` | number | ❌ | 归一化 `[0,1]`，编辑器最小 0.20 |
| `preview.sticker.height` | number | ❌ | 归一化 `[0,1]`，编辑器最小 0.08 |
---

## 九、版本与兼容

- 本规范与 `edit.py` / `generate_subtitle_qwen_api.py` 当前实现同步
- 设计决策（字级时间戳为何重要、长音频切片策略等）见 `CHANGELOG.md`
- 字段命名保持向后兼容：新增字段不会破坏旧 JSON 加载
- 旧编辑器会忽略新增的 `waveform` 字段；新编辑器可加载完全不含该字段的旧工程
- 删除字段会触发兼容性记录到 `CHANGELOG.md`
