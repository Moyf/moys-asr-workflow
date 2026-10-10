# MAW 开发概览

本页说明当前代码与数据边界；贡献流程见 [CONTRIBUTING](../CONTRIBUTING.md)，仓库约束与发布规则以 [AGENTS](../AGENTS.md) 为准。用户文档入口见 [文档索引](README.md)。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `maw_gui.py`、`maw/cli.py` | Launcher 启动、公开转写 CLI 与 Server 管理。 |
| `generate_subtitle_*_api.py` | 六个云端/接口生成器；Qwen 入口也处理 Fun-ASR。 |
| `generate_subtitle_local.py`、`maw/local_asr.py` | 实验本地模型与统一字幕输出。 |
| `maw/gui_web.py`、`maw/gui_workflow.py`、`web/launcher/` | 图形桥接、任务快照、单文件及批量任务。 |
| `maw/runtimes/`、`maw/local_models.py` | 独立运行环境与模型准备；MOSS 依赖单独声明。 |
| `edit.py`、`web/` | 唯一编辑器前端源码及便携 HTML 渲染。 |
| `maw/waveform.py`、`maw/quapeaks.py`、`maw/mopeaks.py`、`maw/media_cache.py` | 波形提取、容器与缓存编排。 |
| `server-editor/serve.py` | 仅 loopback 的媒体 Range、受限保存、最近工程与本机设置。 |
| `desktop/` | Electron 原生窗口与受限 IPC；复用同一 Server，提供三端构建配置。 |
| `website/` | Astro 官网与源文档的静态副本。 |

MOSE 与浏览器入口都复用 Server；Launcher 优先查找 MOSE，不可用时回退浏览器。底层生成器与公开 CLI 的参数、默认输出不同，不应据某个生成器的帮助推断所有入口；区别见 [CLI](CLI.md)。

## 数据与持久化

| 数据 | 真源 / 位置 | 边界 |
| --- | --- | --- |
| 字幕 `segments` 与可选轨道 | `.mosp` / 兼容 `.json` | UTF-8 JSON，字幕及 items 时间为整数毫秒。 |
| 波形、频谱 | `.quapeaks` / `.mopeaks` 等缓存 | 可重建，当前工程落盘剥离内联缓存；仍兼容旧内嵌工程。 |
| `workspace` | 可选工程字段 | 随工程携带的布局。 |
| 最近工程与命名工作区 | 用户级 `server-editor-settings.json` | Server 本机状态，活动工作区可覆盖页面布局。 |
| 编辑器偏好 | 浏览器存储 / MOSE userData 的 `editor-preferences.json` | 普通浏览器按 origin 隔离；MOSE 使用受限存储跨重启恢复。 |
| ASS 样式库 | 用户级 `ass-styles.json`，便携版浏览器副本 | Launcher 与 localhost Editor 共用，不写入工程。 |
| Key 与路径配置 | 本机 `.env` / 环境变量 | 不进入工程、日志或测试夹具。 |

目录与配置优先级由 `maw/app_paths.py` 统一决定，用户侧说明集中在 [PROVIDERS](PROVIDERS.md)。工程序列化边界由 `maw/project_io.py` 定义；波形运行态仍可内嵌，不能将“落盘剥离”误读为整个运行态没有 waveform。

覆盖工程先保留 `.mosp.bak` / `.json.bak`；多版本备份使用 `.mosp-bak`。两者与 `.workspace.json`、交换 JSON 的用途不同，恢复操作见 [编辑器指南](EDITOR_GUIDE.md)。

正式字段与迁移契约集中在 [JSON_SCHEMA](../JSON_SCHEMA.md)，不在本页维护另一份 JSON 示例。修改字段必须同步契约、测试和 changelog。

## 工作区维护

工作区 schema 为 `moy.asr.editor.workspace.v1`，控制 player、panel、cues、wave 四个模块。`web/editor/media/waveform/layout.js` 的 `normalizeLayoutData()` 负责容错和迁移；新增模块或修改树规则需同步拖放逻辑、schema 与相关测试。

Server 的内置预设覆盖、命名工作区和活动名称保存在本机设置。启动时先复制工程，再应用活动工作区；不直接写回原文件。便携页面通过 `.workspace.json` 迁移布局，不使用 Server 工作区库。

## 编辑器源码地图

`web/editor-scripts.txt` 是 esbuild 的源码执行顺序，也是 Server、便携 HTML 与 Electron 桌面壳共用的编辑器装配清单；`web/editor-modules.json` 标出 59 个真正的 ESM 工厂与外部桥。其余 121 个文件暂时在同一 classic 作用域中执行，目录不决定顺序。构建器拒绝路径穿越、重复输入及符号链接越界。便携 HTML 与 localhost 都内联同一份已提交的 `web/editor/boot/editor-bundle.js`，用户运行编辑器不需要 Node。

编辑器 JS、清单或构建配置变化后执行 `pnpm run build:editor`，提交 bundle 和 `.meta.json`；`pnpm run check:editor` 只读检查新鲜度，不会自动修复。Server 调试时另开 `pnpm run watch:editor`，CSS 和模板仍按请求读取。构建和 Node 测试要求 Node 22.13+；源码目录显式声明 `type: module`，不依赖语法自动检测。类型检查包括迁移的全部工厂与既有六文件范围。实施、实验及上游合并经验见 [ESM 迁移台账](dev/ESM_MIGRATION.md)。

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

`boot/editor-host.js` 在业务模块加载前装配 `MaweHost`。宿主工厂接收环境对象或独立的 storage / files / server / runtime 服务；浏览器实现继续用于普通入口，Electron 的原生文件操作通过窄 `MOSEDesktop` 桥接。写入服务接收 Blob 构造回调，在取得 writable 后才构造正文，保留原有新建 / 另存为取值时机。文件取消、写入失败、保存指纹与脏状态判断仍由业务模块处理；响应校验也由调用者处理，传输层只负责 URL 解析和 fetch。Canvas 与播放帧仍走原 DOM / rAF 路径，不经通用状态广播。

`MaweState` 持有模板注入的原工程对象；偏好、播放器、面板、行内编辑和选择状态均不写入工程。选择集对外提供实时只读视图，增删 / 重排 / 锚点写入只经过 owner。旧 `MaweCoreState` / `MaweSelection` / `MaweCuePanelState` 的状态访问器转发同一个 owner，待现有消费者迁移后再退役。新手引导仍使用现有窄桥接。

字幕写入使用 `MaweCommands.run(label, mutate, options)`；长交互使用 `begin()` 后在确认时 `commit()`，取消时 `cancel()`。暂存不会清空 redo；成功且实际有变化才发布一次历史。同步事务中先完成数据写入，再提交和刷新视图；提交后只处理选中结果、提示与焦点。异常在提交前回滚，提交之后的视图错误不视为数据事务失败。文本输入框保留浏览器原生撤销；面板连续输入 / 波形预览只暂存一个事务，保存可确认输入而不移动光标。

`MaweViewUpdates.invalidate()` 明确列表、波形（`none` / `overlay` / `full`）、滚动锚点、预览与保存范围；命令提交统一调度保存。行内标签和播放帧等高频局部更新仍直接操作原组件，避免每次输入或播放帧重建整个列表。布局、空隙和预览几何保留各自历史快照，未强行并入字幕快照。成功保存记录实际写入的字幕指纹；字幕撤销 / 重做只重新判断本编辑域与最后写入内容的差异，不回滚其它域的脏标记，也不把波形缓存作为字幕真源。

重构阶段的审计方式与已验证范围见 `docs/dev/` 的职责拆分、状态与命令重构账本。不要把早期机械拆分的 AST 一致性结论用于后续行为变更。所有重构工具应通过装配清单枚举源码。

## 开发检查

开发者手动维护环境：`uv sync --group dev`；前端验证工具使用根目录 `pnpm install --frozen-lockfile`。Agent 执行已安装环境中的命令时一律加 `--no-sync`。

```sh
uv run --no-sync ruff check
pnpm run check:editor
node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs
node --test tests/test_editor_utils.mjs tests/test_waveform_js.mjs
node --test tests/test_editor_state.mjs tests/test_editor_commands.mjs
pnpm run typecheck
uv run --no-sync python -m unittest discover -s tests -p "test_*.py"
git diff --check
```

交互改动还需启动 `uv run --no-sync python server-editor/serve.py --blank`，验证拖动、播放、Seek、布局与保存。新增界面文字保持可读字号，元素垂直间隔至少 8px，并实测间距和截图自查。文本统一 UTF-8 / LF。

### 浏览器回归

`tests/e2e/helpers.mjs` 默认以 `uv run --frozen python` 启动服务并清理继承的 PYTHONPATH；明确设置 `MAW_E2E_PYTHON` 时用指定解释器。Agent 已有环境时可设置该变量避免测试 helper 再同步依赖。

Windows 使用 `scripts/run-e2e.ps1`，脚本检查 quapeaks，并在需要时按 lockfile 准备临时隔离环境。浏览器受限时可设置 `MAW_E2E_CHROMIUM_PATH` 指向已安装的 Chromium 系浏览器。

```powershell
.\scripts\run-e2e.ps1 tests/e2e/ass-export.spec.mjs --reporter=line
```

语法/单元、Server 契约、浏览器、打包与 CI 是不同验证层，报告时分别说明。

### Electron 与系统集成

Windows 在同套件中共享 `MAW.exe` 与 FFmpeg；macOS/Linux 把原生后端放入 MOSE resources。各平台必须在对应系统和架构构建，步骤见 [desktop README](../desktop/README.md)。工程打开、原生另存为、真实路径、系统关联和手动更新范围见 [MOSE](MOSE.md)。

`npm test --prefix desktop` 检查后端定位、文件写入、进程清理和打包契约；`node --test desktop/e2e/*.mjs` 检查真实 Electron/Server 流程，原生对话框选值使用替身。可通过 `MAW_MOSE_PYTHON` 指定源码后端解释器，通过 `MOSE_TEST_EXECUTABLE` 指定已打包编辑器。安装/卸载、文件管理器双击、macOS/Linux 原生运行仍须对应系统验收，不能以配置检查代替。

## 文档与发布

README 只保留入口；主线放 WORKFLOW，高级操作放专题，字段放 JSON_SCHEMA。反馈和开发进度写任务账本。官网文档由 [同步脚本](../website/docs/CONTENT_SYNC.md) 生成，不手改副本。

日常改编辑器 JS 要重建 esbuild 产物，但不重生成 `blank-editor.html`。在 PR 描述注明“内联副本待发布前统一重生成”；发布前或维护者明确要求时才执行：

```sh
uv run --no-sync python edit.py --blank
```

发布时核对版本号、CHANGELOG、README、生成产物、许可与第三方声明，检查没有密钥、媒体或个人路径。GitHub Release 前用 `scripts/prepare_release_notes.py --tag VERSION --output PATH` 生成并检查 notes；发布不等于只建 tag。远端、push、tag 和 Release 均需维护者明确要求。
