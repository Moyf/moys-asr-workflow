# MAW 开发概览

本页说明当前代码与数据边界；贡献流程见 [CONTRIBUTING](../../CONTRIBUTING.md)，仓库约束与发布规则以 [AGENTS](../../AGENTS.md) 为准。用户文档入口见 [文档索引](../INDEX.md)。

## 代码入口

按本次操作查对应行。涉及具体字段、页面装配或 CI 时，再读本页相应章节或链接的契约。

| 位置 | 职责 |
| --- | --- |
| `maw_gui.py`、`maw/cli.py` | Launcher 启动、公开转写 CLI 与 Server 管理。 |
| `maw/asr/{qwen,soniox,doubao,bcut,tencent,openai,local}.py` | 七个高级 ASR 模块入口；Qwen 入口也处理 Fun-ASR。 |
| `maw/asr/common.py`、`maw/asr/segmentation.py` | 服务商共享的媒体、SRT、断句与时间码修复，不依赖云端入口。 |
| `maw/local_asr.py` | 实验本地模型与统一字幕输出。 |
| `maw/gui_web.py`、`maw/gui_workflow.py`、`web/launcher/` | 图形桥接、任务快照、单文件及批量任务。 |
| `maw/runtimes/`、`maw/local_models.py` | 独立运行环境与模型准备；MOSS 依赖单独声明。 |
| `edit.py`、`web/` | 本地编辑器页面渲染、共享前端源码与 1.x 的历史便携入口。 |
| `maw/waveform.py`、`maw/quapeaks.py`、`maw/mopeaks.py`、`maw/media_cache.py` | 波形提取、容器与缓存编排。 |
| 编辑器打开旧工程、保存与另存 | 先读 [v2 保存约束](JSON_SCHEMA.md#当前目标v2-统一字幕轨道)。`web/editor/io/editor-project-save.js` 处理另存，成功写入前保持待迁移状态。`editor-project-load.js` 标记浏览器导入的旧工程，`editor-server-save.js` 管保存状态。`server-editor/serve.py` 标记从 Server 打开的旧工程，并保护 Server 写入目标。前端先选 `tests/test_v2_migration_save.mjs`，Server 先选 `tests/test_v2_migration_save.py`，交互加 `tests/e2e/v2-migration-save.spec.mjs`。 |
| 烧录字幕与视频导出 | 编辑器 `web/editor/io/editor-wiring-burn-video.js` 走 `server-editor/serve.py` 的烧录作业，先分清原视频和移除空隙后的时间轴，查 `tests/test_burn_video_export.py`。Launcher 工具箱由 `web/launcher/postprocess.js` 经 `maw/gui_web.py` 调用 `maw/postprocess_ffmpeg.py`，查 `tests/test_gui_web.py` 或 `tests/test_postprocess.py`。两端共用部分编码和字幕转换逻辑。 |
| `server-editor/serve.py` | 仅 loopback 的媒体 Range、受限保存、最近工程与本机设置。 |
| `desktop/` | Electron MOSE 桌面壳；Tauri 实验已移除，决策见 [desktop README](../../desktop/README.md)。 |
| `website/` | Astro 官网与源文档的静态副本。 |

当前日常编辑以 Server 为主。底层生成器与公开 CLI 的参数、默认输出不同，不应据某个生成器的帮助推断所有入口；区别见 [CLI](../user/CLI.md)。

## 独立编辑入口的版本边界

`maw/editor_entry_policy.py` 以 `pyproject.toml` 的应用主版本为准，打包环境缺少元数据时使用随发行同步的 `maw/diagnostics.py` 版本。1.x 保留过渡生成能力；从 2.0 的首个预发布版本开始，`.edit.html` / `blank-editor.html` 和在线编辑器停止生成、打包与维护。不能仅升级 UI 的版本文字；发布前运行版本同步检查。无法识别的版本按不支持独立入口处理。

- `edit.py` 命令和 `build_blank_html()`、`render_editor_html()` 拒绝生成；公开 CLI 的显式 `--html` 在调用 ASR 前退出。生成器隐式生成及旧 Launcher 配置跳过 HTML，保留正常 SRT / 工程输出；`--no-html` 和 `--json` 继续接受。
- `MAW.spec` 在 2.0+ 不收录仓库的 `blank-editor.html`；Windows、macOS、AppImage 共用这一清单。收集前校验元数据与全部 bundled 版本标记，防止源码已切换、安装包却按旧 fallback 启用入口；不一致时先运行 `python scripts/sync_launcher_version.py --write`，再重建 bundle 和打包。仓库旧文件留作历史，不自动删改，不再要求 2.0 发布重生成。
- Pages 在网站构建后执行 `scripts/prepare_editor_pages.py`：1.x 可生成在线页面，2.0+ 不生成 `/editor/`，发现残留目录时失败，避免上传混合版本。此脚本不删除历史文件；重新构建网站后再执行。网站推荐入口集中到本地应用。
- `render_editor_page()`、模板、bundle、文件导入、下载式保存降级、Server 保存、备份恢复和媒体导出供本地应用共用，继续保留。HTML 对比报告、人工核验页也不属于此次退役范围。

切换实现不代表发布验收完成。发布 2.0 前仍需在最终集成版本验证：本地应用打开旧工程及媒体、新建/保存/取消/失败保护、备份恢复、字幕与媒体导出，以及三个平台安装包和 Pages 实际产物。历史 HTML 不承诺兼容新版工程；历史发行附件与用户副本保持原样。

## 数据与持久化

| 数据 | 真源 / 位置 | 边界 |
| --- | --- | --- |
| v2 字幕及轨道 | `.mosp` / 兼容 `.json` 的 `tracks[*].segments` | 旧格式顶层 `segments` 从导入边界转换。字幕及字词时间为源媒体整数毫秒。 |
| 波形、频谱 | `.quapeaks` / `.mopeaks` 等缓存 | 可重建，当前工程落盘剥离内联缓存；仍兼容旧内嵌工程。 |
| `workspace` | 可选工程字段 | 随工程携带的布局。 |
| 最近工程与命名工作区 | 用户级 `server-editor-settings.json` | Server 本机状态，活动工作区可覆盖页面布局。 |
| 编辑器偏好 | 浏览器存储 | origin/端口隔离，file:// 不承诺共享。 |
| ASS 样式库 | 用户级 `ass-styles.json`，便携版浏览器副本 | Launcher 与 localhost Editor 共用，不写入工程。 |
| Key 与路径配置 | 本机 `.env` / 环境变量 | 不进入工程、日志或测试夹具。 |

目录与配置优先级由 `maw/app_paths.py` 统一决定，用户侧说明集中在 [PROVIDERS](../user/PROVIDERS.md)。工程序列化边界由 `maw/project_io.py` 定义；波形运行态仍可内嵌，不能将“落盘剥离”误读为整个运行态没有 waveform。

覆盖工程先保留 `.mosp.bak` / `.json.bak`；多版本备份使用 `.mosp-bak`。两者与 `.workspace.json`、交换 JSON 的用途不同，恢复操作见 [编辑器指南](../user/EDITOR_GUIDE.md)。

正式字段与迁移契约集中在 [JSON_SCHEMA](JSON_SCHEMA.md)，不在本页维护另一份 JSON 示例。修改字段必须同步契约、测试和 changelog。

## 工作区维护

工作区 schema 为 `moy.asr.editor.workspace.v1`，控制 player、panel、cues、wave 四个模块。`web/editor/media/waveform/layout.js` 的 `normalizeLayoutData()` 负责容错和迁移；新增模块或修改树规则需同步拖放逻辑、schema 与相关测试。

Server 的内置预设覆盖、命名工作区和活动名称保存在本机设置。启动时先复制工程，再应用活动工作区；不直接写回原文件。便携页面通过 `.workspace.json` 迁移布局，不使用 Server 工作区库。

## 编辑器源码地图

`web/editor-scripts.txt` 定义源码执行顺序，`web/editor-modules.json` 登记 ESM 模块。其余接线保留 classic 共享作用域，目录位置不决定执行顺序。实际模块和源码数量读 `pnpm run build:editor` 输出。Server 和 Electron 使用装配后的 `web/editor/boot/editor-bundle.js`，1.x 便携入口也使用该产物。发布包自带 bundle，运行无需 Node。

编辑器或 Launcher 的 JS、清单或构建配置变化后，先重建对应 bundle，再运行 `pnpm run check:editor` 或 `pnpm run check:launcher`。产物及 `.meta.json` 由构建器生成并留在 Git 之外。源码启动可重建过期产物，CSS 和模板仍在渲染时读取。开发命令见[开发入口与 bundle](DEBUG_WORKFLOW.md#开发入口与-bundle)。实施与实验沿革见 [ESM 迁移台账](../logs/unversioned/undated/ESM_MIGRATION.md)。

字幕域同域函数通过静态 import 接通；现阶段具名函数仍在调用时转发既有浏览器单例门面，不代表这些模块已能独立实例化。初始化只在清单原位执行一次，import 求值不注册。可变状态、常量与 DOM 句柄继续由既有门面按值访问，不应包装成可调用的函数导出。

| 位置 | 职责 |
| --- | --- |
| `web/shared/` | utils 兼容门面、i18n、编辑器与对齐页共用的空隙处理核心 |
| `web/shared/utils/` | 字幕 / 时间 / 设置 / 多轨 / ASS / 导出 / 文本 / 控制台反馈镜像等领域工厂；显式注入依赖 |
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

领域模块主要发布已有命名空间。已登记的 `editor-wiring-*.js` 由装配器在原位置调用 init，事件监听和会话状态在此时创建。其余接线仍共享 classic 作用域。非连续的同领域接线仍为独立文件，保持监听器顺序。新业务代码进入所属领域模块。

`shared/editor-utils.js` 与 `media/waveform.js` 只初始化领域工厂并重建原有 `AsrEditorUtils` / `AsrWaveform` 出口。跨领域依赖由装配门面显式传入，工厂内部不去查其他领域的命名空间。工厂的可变状态只属于该次实例，应用只装配一次；拆分符号与调色板的后续更新通过同一实例的函数共享。

波形类的构造器留在门面，方法按职责放在 `waveform/`。通过 `Object.getOwnPropertyDescriptors` / `Object.defineProperty` 复制方法与 getter，保持原来非枚举、可写和可配置属性；不能使用 `Object.assign` 复制类方法。新方法加入相应工厂并同步装配顺序；有 `super`、私有字段或继承需求时应重新评估这个组合边界。

`boot/editor-host.js` 在业务模块加载前装配 `MaweHost`。宿主工厂接收环境对象或独立的 storage / files / server / runtime 服务；当前用浏览器实现，未来 Electron 入口可传入替代服务。写入服务接收 Blob 构造回调，在取得 writable 后才构造正文，保留原有新建 / 另存为取值时机。文件取消、写入失败、保存指纹与脏状态判断仍由业务模块处理；响应校验也由调用者处理，传输层只负责 URL 解析和 fetch。Canvas 与播放帧仍走原 DOM / rAF 路径，不经通用状态广播。

`MaweState` 持有模板注入的原工程对象；偏好、播放器、面板、行内编辑和选择状态均不写入工程。选择集对外提供实时只读视图，增删 / 重排 / 锚点写入只经过 owner。旧 `MaweCoreState` / `MaweSelection` / `MaweCuePanelState` 的状态访问器转发同一个 owner，待现有消费者迁移后再退役。新手引导仍使用现有窄桥接。

字幕写入使用 `MaweCommands.run(label, mutate, options)`；长交互使用 `begin()` 后在确认时 `commit()`，取消时 `cancel()`。暂存不会清空 redo；成功且实际有变化才发布一次历史。同步事务中先完成数据写入，再提交和刷新视图；提交后只处理选中结果、提示与焦点。异常在提交前回滚，提交之后的视图错误不视为数据事务失败。文本输入框保留浏览器原生撤销；面板连续输入 / 波形预览只暂存一个事务，保存可确认输入而不移动光标。

`MaweViewUpdates.invalidate()` 明确列表、波形（`none` / `overlay` / `full`）、滚动锚点、预览与保存范围；命令提交统一调度保存。行内标签和播放帧等高频局部更新仍直接操作原组件，避免每次输入或播放帧重建整个列表。布局、空隙和预览几何保留各自历史快照，未强行并入字幕快照。成功保存记录实际写入的字幕指纹；字幕撤销 / 重做只重新判断本编辑域与最后写入内容的差异，不回滚其它域的脏标记，也不把波形缓存作为字幕真源。

重构阶段的审计方式与已验证范围见 [日志索引](../logs/INDEX.md)中的职责拆分、状态与命令重构账本。不要把早期机械拆分的 AST 一致性结论用于后续行为变更。所有重构工具应通过装配清单枚举源码。

## 开发检查

Agent 调试与测试使用[有界输出与分层调试](DEBUG_WORKFLOW.md)中的入口：默认按模块依赖与功能选择消费者，完整日志落盘并保留退出码。维护目标和验收准则见[2.0dev 测试治理](https://github.com/Moyf/moys-asr-workflow/blob/2.0dev/docs/engineering/TEST_GOVERNANCE.md)。

环境准备以当前分支的 [Node 和 pnpm 配置](../../package.json)与锁文件为准，使用 `pnpm install --frozen-lockfile`。开发者用 `uv sync --group dev` 准备 Python 开发依赖。涉及真实媒体夹具时加 `--group test` 准备 NumPy。Agent 使用已准备环境并给 `uv run` 加 `--no-sync`。下面是各层常用入口，按改动选择。

```sh
uv run --no-sync ruff check
pnpm run check:editor
node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs
node --test tests/test_editor_utils.mjs tests/test_waveform_js.mjs
node --test tests/test_editor_state.mjs tests/test_editor_commands.mjs
pnpm run typecheck
uv run --no-sync python scripts/run_tests.py
git diff --check
```

交互改动还需启动 `uv run --no-sync python server-editor/serve.py --blank`，验证拖动、播放、Seek、布局与保存。新增界面文字保持可读字号，元素垂直间隔至少 8px，并实测间距和截图自查。文本统一 UTF-8 / LF。

### PR 提交前检查

按[根 AGENTS 的 PR 规则](../../AGENTS.md)同步实际目标仓库与分支，并确认本次 Git 操作的授权。

### 日常变更准入与手动辅助检查（2.0dev）

`scripts/ci_impact.py` 对 PR 使用事件目标 base 到合并结果的整个 diff（要求第一父提交与事件 base 一致），对 `main` / `2.0dev` push 使用事件 before/after。不只看最后一个提交；重命名同时审查旧/新路径。无法确认的 diff、shared 或未知代码只扩大到有限准入集合，不触发全量 Node/Python、浏览器或真实 FFmpeg。

普通工程说明、计划、日志只做文档检查；真实官网源文档以 `website/scripts/sync-maw-docs.mjs` 的 curated map 为准（其中部分工程说明仍是网站消费者），用户指南/网站、发布正文、工具说明/核对清单分别选择对应消费者。夹具、data 目录及非说明程序输入不因 `.md` 扩展名降级；离线 FAQ 是安装包输入。网站同步后验证已跟踪副本未被悄悄覆盖，再做 check/build。

唯一汇总门禁为 **Change acceptance**，仅依赖 selection 与所选 checks。`scripts/ci_acceptance.py` 是明确的文件/测试 ID 准入清单，不等于整个 Node 集合或 Python common：数据契约、序列化、v2 独占写入失败保护；保存/状态/命令 VM 单测；打包路径安全及 schema 写入拒绝等低成本已有契约优先。Node 文件和静态名称清单在 `scripts/ci-node-admission.json`，每组只执行一次 JUnit，不用名称过滤伪装成无执行发现。Python 与 Node 报告、集合、命令结果及日志按摘要绑定到 receipt；运输后 gate 实际重读，Python 重新发现 ID，Node 对照静态名称，拒绝漏报告、篡改、错 SHA、取消、异常 skip、失败及不一致计划。直接保存相关组和 gate 仅安装锁定哈希的 Send2Trash，不同步整个应用环境。清单没有宣称历史稳定率，也不覆盖完整 Host/Origin/HTTP 路由、真实磁盘恢复、浏览器交互或媒体行为。

既有完整 Editor Node/E2E/媒体与 Windows Python/E2E/缓存/打包检查分别保留在 `full-checks-manual.yml` 与 `windows-full-manual.yml`，**仅 workflow_dispatch**，没有新增每周频率或平台矩阵。它们与 `Windows release preview (advisory)` 不传播到 Change acceptance；失败仍红灯并需分诊，不能当作全部测试通过。Windows 预览只为打包/启动/runtime 输入或手动运行申请 Windows runner；坏 diff 只告警并扩大有限 checks，不额外启动 Windows 包。预览保留构建、真实 exe 启动 smoke 与归档上传，不再附带完整 Python/E2E。Ruff 保留独立检查，但只安装 Ruff，不同步应用环境。

由维护者核对 GitHub 分支保护的必需检查是否包含 `Change acceptance`，并按需移除旧 Editor / Windows 必需状态。发布 `release.yml` 完全不使用此调度，保持本分支原有发布与 2.0 独立 HTML 停止生成边界。执行证据和未测范围见[本分支实施记录](../logs/release1.11.2/261117_2devCI门禁纠偏/实施记录.md)。

### 浏览器回归

`tests/e2e/helpers.mjs` 默认用 `uv run --no-sync python` 启动服务并清理继承的 `PYTHONPATH`。用 `MAW_E2E_PYTHON` 指定已准备的解释器时沿用显式解释器的环境。不同 spec 的夹具可能有自己的启动方式，排障时以对应入口为准。

通用 helpers 与 cue-scroll 的进程边界见 [E2E 服务排障](E2E_SERVER_HANG.md)。

Windows 使用 `scripts/run-e2e.ps1`，脚本检查 quapeaks，并在需要时按 lockfile 准备临时隔离环境。浏览器受限时可设置 `MAW_E2E_CHROMIUM_PATH` 指向已安装的 Chromium 系浏览器。

```powershell
.\scripts\run-e2e.ps1 tests/e2e/ass-export.spec.mjs --reporter=line
```

语法/单元、Server 契约、浏览器、打包与 CI 是不同验证层，报告时分别说明。

### 提交前自审

Greptile 复审是提交后的既定环节；把同一标准提前到提交前执行，在 PR 提交前消灭问题，减少被打回后来回修的循环。批量改动、功能开发与反馈修复在自检通过之后、提交 / 提 PR 之前执行一轮独立自审；一两行笔误修复与纯文档措辞由开发者自行判断是否省略。

流程（agent 用后台 subagent 承担审查者；人类开发者换一个视角通读）：

1. **确定范围并独立通读**。审查者未参与实现。按要审查的快照取证。
   - 待提交改动先用 `git status --short --untracked-files=all` 确认本次路径。用 `git diff HEAD -- <本次路径>` 查看已跟踪文件相对 HEAD 的工作区差异，另行打开本次新增的未跟踪文件。核对暂存用 `git diff --cached -- <本次路径>`，核对未暂存用 `git diff -- <本次路径>`。同一文件混有他人改动时，先协调或隔离本次内容，再确认要交付的快照。
   - 审已提交的 PR 时，核对目标仓库、分支和 PR 头。更新目标引用后用 `git diff <实际目标引用>...<PR 头>`。如需连同本地后续改动审查，两种范围都要检查。记录所审快照，变化后复核新增差异。大改动按产品代码、测试和规范分工，各自记录发现。
2. **标准对标 Greptile**：正确性 bug、边界条件、异常与降级路径、回归风险、跨平台差异（Windows / macOS / Linux）、性能影响、测试有效性（测试是否真的守住修复）、仓库约定（AGENTS.md、CHANGELOG 小节归属、文档同步、个人路径与 CRLF）。每条 finding 必须给出证据——文件:行加实际执行过的命令或验证输出；禁止臆测式风格点评。
3. **双向验证**：新增回归测试须在修复前的代码上真实失败。行为修复用既有用例做旧行为对照。需要回退验证时可用基线工作树，保护其他会话的改动。之后恢复本次临时修改并重建受影响产物。
4. **分诊**：真实缺陷立即修复并复验；nit 与「接受的风险」逐条记录，不静默丢弃，也不为表格好看伪装成已修复。
5. **记录在案**：审查发现与处置写入 `docs/logs/release<基线>/<YYMMDD>_<主题>/REVIEW_FINDINGS.md`，按[文档约定](../README.md#doc-policy)登记日志索引，供后续 Greptile 复审对照与下次开发参考。
6. **放行门槛**：没有未处置的 blocker / major 才提交；PR 描述如实写自审发现、处置与未测边界。审查过程中的临时修改全部恢复，不残留进程与脏文件。

## 文档与发布

README 只保留入口；主线放 WORKFLOW，高级操作放专题，字段放 [JSON_SCHEMA](JSON_SCHEMA.md)。反馈和开发进度写任务账本。官网文档由 [同步脚本](../../website/docs/CONTENT_SYNC.md) 生成，不手改副本。

软件版本、发布正文和上线验收见[版本与发布入口](../INDEX.md#engineering-releases)。涉及打包或 Pages 时核对[独立编辑入口的版本边界](#独立编辑入口的版本边界)。提交、远端操作、tag 与发布按[根 AGENTS](../../AGENTS.md)取得对应授权。
