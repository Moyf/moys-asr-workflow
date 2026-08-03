# MAW 开发概览

本文件供后续维护者快速定位代码与数据边界。产品范围、约束和发布规则以仓库根目录的 `AGENTS.md` 为准。

## 产品与运行形态

MAW（Moy's ASR Workflow）是一个收窄的本地工作流：本地媒体经云端 ASR 生成 SRT 与工程文件，再在本机浏览器编辑、导出。工程文件内容是 UTF-8 JSON，`.mosp` 是当前默认扩展名；`.json` 作为旧工程和兼容扩展名继续支持。完整字段契约见 [JSON_SCHEMA.md](../JSON_SCHEMA.md)。

- `generate_subtitle_qwen_api.py`：Qwen/Fun-ASR 转写命令入口，`--json` 为历史兼容参数名，默认生成 `.mosp` 工程。
- `generate_subtitle_soniox_api.py`：Soniox 转写命令入口，同样默认生成 `.mosp` 工程。
- `maw/gui_web.py`、`maw/gui_workflow.py` 与 `web/launcher/`：Launcher 图形界面及其后端桥接。
- `edit.py`：读取 `.mosp` / `.json` 工程，渲染单文件 `.edit.html`；也生成 `blank-editor.html`。
- `server-editor/serve.py`：仅监听 `127.0.0.1` 的编辑器服务器，负责媒体 Range 响应、工程安全保存与本机设置。
- `web/`：唯一前端源码。`editor-template.html` 组合 `editor.css`、`waveform.css`、`editor.js`、`waveform.js` 与 i18n；禁止手改生成后的 `blank-editor.html`。

修改 `web/`、模板或内联资源后，必须执行：

```powershell
uv run python edit.py --blank
```

## 数据边界与持久化

| 数据 | 真源 / 存放位置 | 用途 |
|---|---|---|
| `segments` | `.mosp` / `.json` 工程文件 | 字幕真源；时间均为整数毫秒。 |
| `waveform` | 工程文件或可重建 sidecar | 性能缓存，不是字幕真源。 |
| `workspace` | 工程文件（可选） | 随工程携带的窗口布局与显示状态。 |
| 自定义服务器工作区 | 用户本机 `server-editor-settings.json` | 命名工作区库，跨工程复用，不改写工程文件。 |
| 编辑器、波形偏好 | 浏览器 `localStorage` | 浏览器与 origin 级别偏好；`file://` 或隐私模式可能不可用。 |

服务器设置文件的位置由 `server-editor/serve.py:default_settings_path()` 决定：Windows 为 `%LOCALAPPDATA%/Moy/moys-asr-workflow/server-editor-settings.json`，其他系统为用户数据目录下的 `Moy/moys-asr-workflow/server-editor-settings.json`。它包含最近工程、自动打开开关、`preset_workspaces`、`saved_workspaces` 和 `active_workspace_name`。

覆盖保存工程时，服务器保留原扩展名并先创建同目录备份：`project.mosp.bak` 或 `project.json.bak`。`.workspace.json`、Resolve JSON 和保留区域 JSON 是交换/配置文件，不是字幕工程真源。

## 工作区数据契约

工作区 schema 是 `moy.asr.editor.workspace.v1`。一个工作区同时控制四个模块的摆放、分隔比例和显示状态：

- `player`：媒体播放器
- `panel`：当前字幕编辑区
- `cues`：字幕列表
- `wave`：波形

典型数据如下（工程字段名为 `workspace`）：

```json
{
  "schema": "moy.asr.editor.workspace.v1",
  "preset": "custom",
  "selectedPreset": "traditional",
  "waveformMode": "basic",
  "waveformSettings": { "visibleSeconds": 20, "secondsPerRow": 10, "rowHeight": 120, "waveformScale": 1 },
  "editorDisplay": { "cueListShowIndex": true, "cueListShowTime": true, "cueListShowSticker": false, "cueListShowCharcount": true, "cueEditorShowNavigation": false, "cueEditorShowTimeActions": true, "cueEditorShowSticker": false },
  "splitPercent": 60,
  "columnPercent": 58,
  "rows": [42, 27, 31],
  "tree": {
    "type": "split",
    "direction": "row",
    "ratio": 44,
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
            "ratio": 31,
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

字段说明：

- `preset`：`classic`、`wave-right` 或 `custom`。`custom` 由 `tree` 渲染；“字幕列表编辑”“三折叠布局”“传统字幕编辑器”和用户自定义工作区都使用该渲染器。未知值回退到 `wave-right`。
- `selectedPreset`：最后在工作区下拉框选择的项：内置工作区为 `classic`、`wave-right`、`three-fold`、`traditional`，本机命名工作区为 `saved:<名称>`。它与实际渲染用的 `preset` 分开记录，使重开工程后仍显示用户所见的工作区名称。
- `waveformMode`：`multi` 或 `basic`，记录波形显示模式；缺失时保持当前浏览器设置。
- `waveformSettings`：波形区的数值与显示偏好，包括基础窗口长度、多行每行长度和高度、振幅、侧边、禁用项显示、分组徽章与拖动播放头。缺失字段保持浏览器本机偏好。
- `editorDisplay`：字幕列表和字幕编辑区的显示开关；不携带自动保存、导出、快捷键等与布局无关的全局偏好。
- `splitPercent`：`classic` 网格中波形与字幕区比例，归一化到 35–75。
- `columnPercent`：`custom` 渲染器最外层左右分栏比例，归一化到 30–75。
- `rows`：左侧“视频 / 当前字幕 / 字幕列表”的相对高度，读取时会规范化。
- `tree`：`custom` 渲染器的当前真源。二叉树叶子为 `{ "type": "module", "id": ... }`；分支为 `{ "type": "split", "direction": "row" | "column", "ratio": 20..80, "children": [leftOrTop, rightOrBottom] }`。有效树必须恰好包含四个模块各一次。

`web/waveform.js:normalizeLayoutData()` 负责容错、范围限制和工作区格式迁移。新增模块或修改树规则时，必须同步更新该函数、工作区拖放逻辑、`JSON_SCHEMA.md`、相关 JS 测试和此文档。

### 服务器工作区库行为

服务器版的 `preset_workspaces` 是四个内置工作区的用户覆盖版，`saved_workspaces` 是名称到工作区对象的映射（最多 20 个）；`active_workspace_name` 指向当前跨工程复用的自定义工作区。打开页面时，服务器先深拷贝工程数据，再以活动自定义工作区覆盖页面中的 `workspace`，不会写回工程文件。

- 内置工作区：可编辑后“保存工作区”覆盖本机的该预设，也可另存为；不能删除，但“重置工作区”会删除其覆盖版并恢复内置默认值。
- 自定义工作区：选择后进入编辑模式可“保存工作区”、另存为或删除。
- 选中自定义工作区会更新 `active_workspace_name`；切换回内置工作区会清空活动名称。
- 相关 HTTP 接口为 `POST /api/settings`，字段使用 `saveWorkspace`、`savePresetWorkspace`、`deleteWorkspaceName`、`activeWorkspaceName`。接口只接受本机浏览器请求。

单文件 HTML 不使用服务器工作区库，也不承诺不同 `file://` 页面共享浏览器存储。它显示四个内置工作区，并提供“导出工作区配置 / 导入工作区配置”以 `.workspace.json` 文件迁移工作区。

## 开发检查

```powershell
node --check web\editor.js
node --check web\waveform.js
node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs
uv run python -m unittest discover -s tests -p "test_*.py"
git diff --check
```

交互改动还应手动启动 `uv run python server-editor\serve.py --blank`，验证拖放、播放、Seek、工作区拖动及保存。所有文本保持 UTF-8 与 LF。
