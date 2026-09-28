# MAW 开发概览

本文件供后续维护者快速定位代码与数据边界。产品范围、约束和发布规则以仓库根目录的 `AGENTS.md` 为准。

## 产品与运行形态

MAW（Moy's ASR Workflow）是一个收窄的本地工作流：本地媒体经云端 ASR 生成 SRT 与工程文件，再在本机浏览器编辑、导出。工程文件内容是 UTF-8 JSON，`.mosp` 是当前默认扩展名；`.json` 作为旧工程和兼容扩展名继续支持。完整字段契约见 [JSON_SCHEMA.md](../JSON_SCHEMA.md)。

- `generate_subtitle_qwen_api.py`：Qwen/Fun-ASR 转写命令入口，`--json` 为历史兼容参数名，默认生成 `.mosp` 工程。
- `generate_subtitle_soniox_api.py`：Soniox 转写命令入口，同样默认生成 `.mosp` 工程。
- `generate_subtitle_tencent_api.py`：腾讯云录音文件识别命令入口，使用 TC3 签名并默认生成 `.mosp` 工程。
- `generate_subtitle_openai_api.py`：OpenAI 官方或兼容 ASR 转写命令入口，要求响应包含 `segments` 或 `words` 时间戳。
- `maw/gui_web.py`、`maw/gui_workflow.py` 与 `web/launcher/`：Launcher 图形界面及其后端桥接。
- `edit.py`：读取 `.mosp` / `.json` 工程，渲染单文件 `.edit.html`；也生成 `blank-editor.html`。波形、峰值容器与媒体缓存实现位于 `maw/waveform.py`、`maw/quapeaks.py`、`maw/media_cache.py`（`quapeaks.py` 改名自 `reapeaks.py`；Python 参考实现 `maw/reapeaks_generate.py` 已随 Rust 成为唯一生成路径而删除，故不再列出）。
- `server-editor/serve.py`：仅监听 `127.0.0.1` 的编辑器服务器，负责媒体 Range 响应、工程安全保存与本机设置。
- `web/`：唯一前端源码。`editor-template.html` 组合 `editor.css`、`waveform.css` 与 `editor-scripts.txt` 中按顺序列出的脚本；禁止手改生成后的 `blank-editor.html`。日常开发不反复生成根目录的空白 HTML，只有版本发布前或明确指定更新便携产物时才刷新它。

### 当前编辑器维护重点

当前产品流程以 `server-editor/serve.py` 提供的 Server 版编辑器为主。Launcher 暂时隐藏“同时生成单文件版网页编辑器（html）”选项；单文件 HTML 和 `blank-editor.html` 仍保留用于兼容既有使用方式，但暂不作为新功能的主要更新和验收对象，后续重新启用时再统一评估维护范围。

从 `1.3.2` 到当前 Beta 的功能演进记录见 [版本变更回顾](RELEASE_REVIEW_1.3.2_TO_1.4.0.md)。

前端代码边界的渐进式整理方案见 [`dev/MAWE 前端渐进式重构企划案.md`](dev/MAWE%20前端渐进式重构企划案.md)，当前 Phase 0–1 的依赖、状态和装配快照见 [`dev/MAWE 前端重构基线.md`](dev/MAWE%20前端重构基线.md)。该企划当前不采用 React，不改变编辑器行为或工程契约。

修改 `web/`、模板或内联资源后，日常以 Server 编辑器和源码测试为准；只有版本发布前或明确指定更新便携产物时，才执行：

```powershell
uv run python edit.py --blank
```

## 数据边界与持久化

| 数据 | 真源 / 存放位置 | 用途 |
|---|---|---|
| `segments` | `.mosp` / `.json` 工程文件 | 字幕真源；时间均为整数毫秒。 |
| `waveform` | 工程文件或可重建 sidecar | 性能缓存，不是字幕真源。 |
| `workspace` | 工程文件（可选） | 随工程携带的窗口布局与显示状态。 |
| 自定义服务器工作区 | 用户本机 `MAW/server-editor-settings.json` | 命名工作区库，跨工程复用，不改写工程文件。 |
| 编辑器、波形偏好 | 浏览器 `localStorage` | 浏览器与 origin 级别偏好；`file://` 或隐私模式可能不可用。 |
| ASS 样式库 | 用户级 `MAW/ass-styles.json`；便携 Editor 为浏览器 `localStorage` | localhost Editor 与 Launcher 共享；保存样式、ASS 输出方案和默认槽位，不写入工程文件。 |

服务器设置文件的位置由 `server-editor/serve.py:default_settings_path()` 决定：Windows 为 `%LOCALAPPDATA%/MAW/server-editor-settings.json`，macOS 为 `~/Library/Application Support/MAW/server-editor-settings.json`，Linux 为 `$XDG_DATA_HOME/MAW/server-editor-settings.json`（未设置时使用 `~/.local/share/MAW`）。它包含最近工程、自动打开开关、`preset_workspaces`、`saved_workspaces` 和 `active_workspace_name`。Windows 升级时只在新文件不存在时读取旧的 `%LOCALAPPDATA%/Moy/moys-asr-workflow/server-editor-settings.json`，保存始终写入新路径。

用户级目录和 `.env` 的公共解析规则集中在 `maw/app_paths.py`：源码运行继续读取仓库根 `.env`；冻结版优先读取应用程序同目录 `.env`，不存在时回退到 MAW 用户数据目录。Windows 用户数据根为 `%LOCALAPPDATA%/MAW`，其中还包括 `ass-styles.json`、`logs`、`local-runtime`、`model-cache` 和 Emoji 字体缓存。

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
  "selectedPreset": "cinema",
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

- `preset`：`classic`、`wave-right` 或 `custom`。`custom` 由 `tree` 渲染；“字幕列表编辑”“三折叠布局”“大荧幕布局”和用户自定义工作区都使用该渲染器。未知值回退到 `wave-right`。
- `selectedPreset`：最后在工作区下拉框选择的项：内置工作区为 `classic`、`wave-right`、`three-fold`、`cinema`，本机命名工作区为 `saved:<名称>`。它与实际渲染用的 `preset` 分开记录，使重开工程后仍显示用户所见的工作区名称。
- `waveformMode`：`multi` 或 `basic`，记录波形显示模式；缺失时保持当前浏览器设置。
- `waveformSettings`：波形区的数值与显示偏好，包括基础窗口长度、多行每行长度和高度、振幅、侧边、禁用项显示、分组徽章与拖动播放头。缺失字段保持浏览器本机偏好。
- `editorDisplay`：字幕列表和字幕编辑区的显示开关；不携带自动保存、导出、快捷键等与布局无关的全局偏好。
- `splitPercent`：`classic` 网格中波形与字幕区比例，归一化到 35–75。
- `columnPercent`：`custom` 渲染器最外层左右分栏比例，归一化到 30–75。
- `rows`：左侧“视频 / 当前字幕 / 字幕列表”的相对高度，读取时会规范化。
- `tree`：`custom` 渲染器的当前真源。二叉树叶子为 `{ "type": "module", "id": ... }`；分支为 `{ "type": "split", "direction": "row" | "column", "ratio": 20..80, "children": [leftOrTop, rightOrBottom] }`。有效树必须恰好包含四个模块各一次。

`web/editor/media/waveform/layout.js:normalizeLayoutData()` 负责容错、范围限制和工作区格式迁移。新增模块或修改树规则时，必须同步更新该函数、工作区拖放逻辑、`JSON_SCHEMA.md`、相关 JS 测试和此文档。

### 服务器工作区库行为

服务器版的 `preset_workspaces` 是四个内置工作区的用户覆盖版，`saved_workspaces` 是名称到工作区对象的映射（最多 20 个）；`active_workspace_name` 指向当前跨工程复用的自定义工作区。打开页面时，服务器先深拷贝工程数据，再以活动自定义工作区覆盖页面中的 `workspace`，不会写回工程文件。

- 内置工作区：可编辑后“保存工作区”覆盖本机的该预设，也可另存为；不能删除，但“重置工作区”会删除其覆盖版并恢复内置默认值。
- 自定义工作区：选择后进入编辑模式可“保存工作区”、另存为或删除。
- 选中自定义工作区会更新 `active_workspace_name`；切换回内置工作区会清空活动名称。
- 相关 HTTP 接口为 `POST /api/settings`，字段使用 `saveWorkspace`、`savePresetWorkspace`、`deleteWorkspaceName`、`activeWorkspaceName`。接口只接受本机浏览器请求。

单文件 HTML 不使用服务器工作区库，也不承诺不同 `file://` 页面共享浏览器存储。它显示四个内置工作区，并提供“导出工作区配置 / 导入工作区配置”以 `.workspace.json` 文件迁移工作区。

## 编辑器源码地图

`web/editor-scripts.txt` 是所有编辑器入口共用的装配清单。Python 与 Tauri 都按清单顺序把源码内联为一个 classic script；目录只用于导航，不决定执行顺序。清单接受 web 根目录内的 POSIX 相对子路径，拒绝路径穿越和符号链接越界。

| 位置 | 职责 |
| --- | --- |
| `web/shared/` | utils 兼容门面、i18n、编辑器与对齐页共用的空隙处理核心 |
| `web/shared/utils/` | 字幕 / 时间 / 设置 / 多轨 / ASS / 导出 / 文本等数据领域工厂；显式注入依赖 |
| `web/shared/host/` | 可替换的设置存储、文件选择 / 写入 / 下载与 Server 传输服务 |
| `web/editor/boot/` | 工程注入、运行时、加载守卫入口、启动、新手引导与全局类型声明 |
| `web/editor/state/` | 状态所有者、字幕修改事务、视图更新适配、设置与各编辑域历史 |
| `web/editor/cues/` | 字幕编辑、选择、搜索、拆分合并、绑定、文本工具与快捷键 |
| `web/editor/styles/` | 字体、ASS 样式库与预览、颜色、外观、说话人 |
| `web/editor/media/` | 波形兼容装配、播放、媒体加载、步进、几何与表情包预览 |
| `web/editor/media/waveform/` | 波形布局 / 解码 / 时间算法 / 绘制 / 指针 / 拖动 / 播放方法 |
| `web/editor/io/` | 工程导入保存、导出、服务连接、文件拖放与媒体设置输入 |
| `web/editor/ui/` | DOM、浮窗、帮助、菜单、工作区布局、提示与设置面板 |
| `web/launcher/`、`web/sfx/` | 独立 Launcher 与原位静态音效 |

领域模块主要发布已有命名空间；`editor-wiring-*.js` 保留原接线与剩余声明的全局作用域，不能视为可独立加载的 ES module。非连续的同领域接线仍为独立文件，保持监听器顺序。新业务代码进入所属领域模块，不扩大 `boot/editor.js`。

`shared/editor-utils.js` 与 `media/waveform.js` 只初始化领域工厂并重建原有 `AsrEditorUtils` / `AsrWaveform` 出口。跨领域依赖由装配门面显式传入，工厂内部不去查其他领域的命名空间。工厂的可变状态只属于该次实例，应用只装配一次；拆分符号与调色板的后续更新通过同一实例的函数共享。

波形类的构造器留在门面，方法按职责放在 `waveform/`。通过 `Object.getOwnPropertyDescriptors` / `Object.defineProperty` 复制方法与 getter，保持原来非枚举、可写和可配置属性；不能使用 `Object.assign` 复制类方法。新方法加入相应工厂并同步装配顺序；有 `super`、私有字段或继承需求时应重新评估这个组合边界。

`boot/editor-host.js` 在业务模块加载前装配 `MaweHost`。宿主工厂接收环境对象或独立的 storage / files / server / runtime 服务；当前用浏览器实现，未来 Electron 入口可传入替代服务。写入服务接收 Blob 构造回调，在取得 writable 后才构造正文，保留原有新建 / 另存为取值时机。文件取消、写入失败、保存指纹与脏状态判断仍由业务模块处理；响应校验也由调用者处理，传输层只负责 URL 解析和 fetch。Canvas 与播放帧仍走原 DOM / rAF 路径，不经通用状态广播。

`MaweState` 持有模板注入的原工程对象；偏好、播放器、面板、行内编辑和选择状态均不写入工程。选择集对外提供实时只读视图，增删 / 重排 / 锚点写入只经过 owner。旧 `MaweCoreState` / `MaweSelection` / `MaweCuePanelState` 的状态访问器转发同一个 owner，待现有消费者迁移后再退役。新手引导仍使用现有窄桥接。

字幕写入使用 `MaweCommands.run(label, mutate, options)`；长交互使用 `begin()` 后在确认时 `commit()`，取消时 `cancel()`。暂存不会清空 redo；成功且实际有变化才发布一次历史。同步事务中先完成数据写入，再提交和刷新视图；提交后只处理选中结果、提示与焦点。异常在提交前回滚，提交之后的视图错误不视为数据事务失败。文本输入框保留浏览器原生撤销；面板连续输入 / 波形预览只暂存一个事务，保存可确认输入而不移动光标。

`MaweViewUpdates.invalidate()` 明确列表、波形（`none` / `overlay` / `full`）、滚动锚点、预览与保存范围；命令提交统一调度保存。行内标签和播放帧等高频局部更新仍直接操作原组件，避免每次输入或播放帧重建整个列表。布局、空隙和预览几何保留各自历史快照，未强行并入字幕快照。成功保存记录实际写入的字幕指纹；字幕撤销 / 重做只重新判断本编辑域与最后写入内容的差异，不回滚其它域的脏标记，也不把波形缓存作为字幕真源。

职责提取审计使用 `node scripts/check_editor_domains.mjs --target d20529c`，核对 #155 合入时的原声明 / 方法源码、构造器与兼容出口；允许的宿主引用替换逐项记录在 specs 中。省略 target 会严格审计工作区，自后续拖动事务语义变化后不再与提取前逐字相同，不能用追加替换规则掩盖行为变化。当前状态 / 命令重构使用契约、历史 / 保存边界与真实浏览器回归验证。完整拼接 AST 已因工厂包装改变，不能继续把早期机械拆分的 AST 一致结论用于本阶段。

机械拆分 / 目录迁移可用 `node scripts/check_editor_equivalence.mjs --base <基线提交>` 检查原序源码字节与两种装配 AST。所有重构工具必须使用清单枚举源码；历史单体改写工具会拒绝当前布局，避免覆盖接线文件。

## 开发检查

### 编辑器 UI 规范

- 任何界面文字的 `font-size` 不得小于等于 10px：过小的文字（如 9px 徽标、10px 注脚）在低分屏上难以辨认。新增样式时辅助说明文字用 11–12px，正文与说明类一律不低于 12px。

```powershell
uv run --no-sync ruff check
node --test tests\test_editor_script_syntax.mjs tests\test_editor_script_order.mjs
node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs
node --test tests\test_editor_state.mjs tests\test_editor_commands.mjs
npm run typecheck
uv run --no-sync python -m unittest discover -s tests -p "test_*.py"
git diff --check
```

交互改动还应手动启动 `uv run --no-sync python server-editor\serve.py --blank`，验证拖放、播放、Seek、工作区拖动及保存。所有文本保持 UTF-8 与 LF。

### 浏览器回归环境

`tests/e2e/helpers.mjs` 默认通过 `uv run --frozen python` 启动 Python-backed server，并删除继承的 `PYTHONPATH`；只有明确设置 `MAW_E2E_PYTHON` 时才使用指定解释器。这样可以避免把系统 Python 与仓库 `.venv` 的 `site-packages` 混用。

Windows 上建议使用项目入口运行浏览器回归：

```powershell
.\scripts\run-e2e.ps1 tests/e2e/ass-export.spec.mjs --reporter=line
```

入口会先验证仓库 `.venv` 是否能导入锁定的 `quapeaks`；若不能，则用 `py -3` 找到系统 Python，在 `%TEMP%\maw-e2e` 下按 `uv.lock` 创建隔离环境和缓存，并以 `MAW_E2E_PYTHON` 启动测试。它还把默认 Playwright 输出放到用户临时目录，避免共享工作树的 `test-results` 权限或占用影响测试。

如果本机的 Playwright Chromium 被安全策略阻止启动，可显式指定已安装且可执行的 Chromium 系浏览器，不改变默认浏览器选择：

```powershell
$env:MAW_E2E_CHROMIUM_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
.\scripts\run-e2e.ps1 tests/e2e/ass-export.spec.mjs --reporter=line
```
