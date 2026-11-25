# 浏览器全局门面迁移

来源分支 `cat/esm/window-facade-migration` 以 `9f10cbe1` 为起点，终点为 `4b69b5c8`。下文记录来源分支尝试的批次。当前工作区的调整与验证见末节。

## 摸底结论

- 编辑器与共享源码共 109 个 window 门面命名空间（106 个有明确定义处），另有 `AsrEditorUtils`（1629 处）、`MAWE_I18N`（178 处）等非 Mawe 前缀全局。
- 103 个门面有跨文件消费者；6 个仅定义文件自用。
- 外部消费者决定保留面：45 个 Node 测试经 `editor-module-loader` vm 夹具断言门面；server-align 与 filmstrip-lab 注入 `gap-remove-core.js`；Launcher 页面 classic 加载 `tooltip.js`；e2e 经 `page.evaluate(window.X)` 驱动 66 个全局。

## 迁移批次

| 批次 | 内容 | 结果 |
| --- | --- | --- |
| A | `window.AsrEditorUtils` → `editor-utils.js` 模块级 `export const` + 87 文件具名 import；window 别名保留 | Node 1763/1763 |
| B | `window.MAWE_I18N` → `editor-i18n.js` 模块级导出（`language` 保持 getter）+ 37 文件 import | Node 1763/1763 |
| C | 99 个有跨文件消费者的 `Mawe*` 门面：init 内挂 window 改为模块常量 + descriptors 同步（accessor/value 分类，可写可配置）+ window/global 别名 | Node 1763/1763 |
| D | `MaweHost` 增加模块级导出，waveform 两处直引；`MAWE_EDITOR_BRIDGE`/`MAWE_ONBOARDING` 保留 window 通道（e2e 运行时接口）；`MaweTooltip` 保留（Launcher classic 加载） | Node 1763/1763 |
| E | 暴露面收缩复核：全部 106 个门面均有外部消费者（vm 夹具或 e2e），无可移除赋值 | 无改动 |
| F | classic 时代注释更新为现行语义（window 别名服务 vm 夹具与 e2e 通道） | 30 文件 |

## vm 夹具适配

- `initModuleSource`：共享模块（`shared/…`）import 在 classic 体还原为**动态转发代理**（测试可在加载后整体换装 spy；代理识别自身遮蔽并回退到首次捕获的真门面）。顶层 `export const` 门面声明并入 classic 体并降为 var（vm 无脚本级词法隔离）。
- `plainModuleSource`：同样的共享 import 剥离后以 `var X = window.X` 恢复。
- `track-golden`：project 与 stickers 两组夹具捆绑并初始化共享门面（同一 bundle 内 import 读到已填充门面）。
- 新增 `init-real-editor-utils`：Node ESM 直连测试在真实模块图里一次性填充门面。
- `editor-module-loader` 夹具保持 window 门面注入；`window.AsrEditorUtils` 等别名因此保留在生产源码中。

## 行为语义

- 门面对象不再整体替换，改为 `Object.defineProperties` 同步 descriptors：getter 语义保留（`language`、`projectEpoch` 等）；消费方持模块常量引用，init 后内容一致。
- `editor-wiring-ass-preview` 的 `window.X || Object.freeze` 桥接收敛为直接门面。
- 双出口（window 冻结门面 + 具名导出经门面转发）保留：vm 夹具与 e2e 通道仍经 window 读，生产 bundle 内经静态 import。

## 验证

- Node 全量 1763/1763；Python 全量 3646 项，除 3 项 ffmpeg 计时（基线 `g16-bgd` 同样失败，见下）全部通过。
- 来源分支记录 Editor 220 输入、Launcher 构建均 fresh，entry 门禁与 Ruff 通过。类型检查以末节复核结果为准。
- e2e（Playwright chromium）：`overlay-track` 30/30、`editor-transactions`+`burn-video-jobs`+`editor-command-palette` 40/40。
- e2e 全量 144 文件：1271 通过；`tool-markdown` 10 项失败为基线即有（`g16-bgd` 同样失败，工具页既有问题），与本次迁移无关。

## 已知边界

- 基线即失败的 3 项 ffmpeg 用例（`test_nonzero_start_pts_is_normalized`、`test_long_gop_cuts_*`、`test_video_only_precise_cuts_*`）与本次迁移无关，基线 `g16-bgd` 复现同样失败。
- `scripts/test_impact_graph.py` 的门面正则已同步新赋值形态，e2e 影响选择恢复 `overlay-track` / `editor-transactions`。
- `cue-blocks.js` 的两处 `window.AsrEditorUtils?.` 可选读取保留：该文件经测试工厂以 classic 体直跑，import 形态会破坏夹具。
- `editor-multi-subtitle-core.js` 一处 `window.AsrEditorUtils.LegacyProjectAdapter` 保留：`track-golden` 夹具在独立 bundle 初始化门面，直引会读到空对象。

## 继承审查

- 在 `cat/esm/editor-dependency-boundaries` 继承来源快照。原先冻结的门面曾被复制到可写对象中。整理版让模块级绑定和浏览器别名指向初始化时创建的原对象，保留冻结属性、访问器和重新初始化时替换实例的语义。VM 对照确认来源快照的 `MaweBoot` 可写而整理版已冻结，原有 `PROJECT_NAME` setter 在两版均可使用。编辑器 Chromium 启动用例新增门面冻结断言。
- 用同一 TypeScript 编译器复核来源快照，发现其直接 import 将 i18n 和共享工具引入类型检查，暴露了重复字面量键、缺失声明、工厂参数和门面类型问题。整理版保留重复键最终生效的值及键顺序，修正工厂接线与类型声明，通过原有类型检查配置。
- 按实际生产入口的 AST 复核，100 个以 `Mawe` 开头的模块级门面中，只有 `MaweHost` 出现在静态具名 import 中。另有 504 个具名函数仍直接转发到 `window.Mawe*`。共享工具和 i18n 已有成批静态 import。后续迁移仍需处理 `MaweBoot.DATA`、启动引导桥和这些转发出口。
- 本工作区通过 Editor 构建与新鲜度检查、TypeScript、Node 全量 1763 项、Python 定向 81 项、Chromium 定向 32 项及新增冻结断言复跑。未重跑全量 Python 与 Chromium。

## 去除全局依赖的任务范围

验收覆盖自有应用接口的定义与消费，包括裸标识符、`window`／`globalThis` 访问、参数别名和字符串键。浏览器自带 API 和宿主提供的 API 仍由宿主提供。检查实际打包入口、Python 注入点、Launcher 的本地文件入口、共用工具页及其离线副本。第三方库内的全局与历史发布附件沿现有契约保留。

| 工作 | 可机械完成的部分 | 需要专项验收的部分 |
| --- | --- | --- |
| 编辑器既有所有者和调用点 | 对唯一导出自动补 import，去掉调用路径上的全局属性读取 | 检查初始化先后、可选读取和循环依赖。以完整入口启动为准 |
| 启动状态、桥接、调色板、波形 | 自动列出未绑定符号和剩余赋值 | 为 Python 启动数据、按需引导、命令面板和诊断选择明确接口。保留源工程、数据对象及访问器的既有生命周期 |
| Node／Chromium 夹具与类型检查 | 按编码形态生成测试依赖映射，机械修正依赖全局门面的测试源码 | 夹具注入应仅存在于测试入口。检查真实 ESM 实例、重复启动、新增类型诊断与独立页面的状态隔离 |
| Launcher 与工具页 | 盘点经典全局定义与调用点，按页面入口批量改写已经定位的接口 | 保留 pywebview 的 file URI、Launcher 的回调先后，以及离线工具与服务器实验页的加载方式 |
| 上游合并 | 同一变换投影到共同祖先和两侧，输出可供审核的三方合并候选 | 处理新增/删改入口、业务改动、测试断言和生成物。至少对一个真实 PR 完成隔离合并与验证 |

此前工作树留下了门面清单、分类和计划。来源分支的提交未包含这批门面改写的可执行脚本。历史 `full-convert.mjs` 依赖退役清单，同步搬用会重新引入过渡装配。现有作用域分析和三方投影是可复用的部分。新工具及操作见 [refactor-tools](../../../../scripts/refactor-tools/README.md#editor-门面迁移与上游合并)。

### 首轮冲突基线

来源快照为 `4b69b5c8`。对照上游为 `origin/2.0dev@3cf512a2`，双方分别对固定 PR HEAD 运行 `git merge-tree`。重叠文件数包含共同祖先以来双方修改过的路径。

| PR | HEAD | PR 文件 | 重叠文件 | 直接合并冲突 | 上游对照冲突 |
| --- | --- | ---: | ---: | ---: | ---: |
| #437 | `19974a7d` | 54 | 17 | 8 | 0 |
| #376 | `596d90df` | 62 | 52 | 18 | 16 |
| #347 | `a527b01e` | 35 | 18 | 5 | 5 |

#437 适合衡量门面迁移直接带来的额外冲突。#376 和 #347 的头基于更旧的入口，直接冲突数还包含此前的目录、装配及测试变化。

### 首轮改写与实际合并预演

- 初次扫描为 139 个 Editor／shared 文件生成 8047 处引用改写。保留现有模块初始化顺序。随后为命令面板、缩略图配置和波形补充显式依赖，并移除诊断和引导的全局赋值。工具的复跑结果是已识别所有者没有待改写的读取，还有全局发布别名及需要专项处理的共享和宿主接口。
- #437 在独立本地副本运行真实 Git 合并，8 个冲突文件中 6 个由三方 AST 投影生成可解析候选并采用。剩下的工程导入冲突保留上游新设的迁移另存规则，测试冲突采用上游新增的样式更新依赖。
- 第一轮合并虽然构建通过，却在实际启动时把旧来源分支的空对象当作已初始化服务，导致调用 `renderSample` 和 `sync` 失败。预演中将可变空门面改为首次初始化时赋值的模块绑定，恢复初始化前缺席语义。此后 Editor 构建、新鲜度检查及 17 项 PR 相关 Chromium 用例通过。预演保留在本地隔离副本。
- 当前主工作区的 Node 全量已通过 1767 项，类型检查仍因导入图扩展报错。尚需拆分纯工厂到编辑器接线的反向依赖，处理纳入检查的 UI 类型，再迁移外部夹具、共享 classic 入口、Launcher 和工具页，最后用生产入口扫描验证发布别名归零。

### Editor 和共用页面的生产别名移除

- 生产 Editor 删除服务、ASS 调试接口及长任务状态的全局发布。保留内部断言的测试使用独立的 Playwright 产物，真实 Server 启动用例直接请求生产产物，并验证无应用全局且命令面板可用。完整测试产物也保留初始化顺序和门面的既有属性。
- 空隙算法、悬停提示、对齐页录制审查、离线译文审查走模块绑定。调色板来自页面 JSON。Editor 对话框在调用点翻译消息，由宿主保留原生对话框实现。
- Launcher 原生事件传递改为 DOM 事件，保留批次和顺序。Launcher 主界面与子功能间的全局对象仍需迁移。
- Editor／shared 的 `editor-global-migration.mjs --check` 已识别 110 个模块所有者，待改写引用、发布别名和其他命中均为零。此处的静态扫描范围不包含 Launcher 或所有工具脚本。进阶验收还包括在最终迁移快照重跑上游合并预演和处理完整类型检查。
- 本阶段复跑通过 Editor／Launcher 构建与新鲜度、生产 Editor 启动、对齐和录制审查、Launcher 悬停提示和原生事件接收、烧录与空隙移除任务，以及文件协议下的译文审查。Node 全量在局部清理前通过 1768 项。此阶段结束时类型检查有 382 项诊断，后续已处理。

### 生产入口与离线工具收尾

- Launcher 批量处理、后处理和主界面在同一个 bundle 内初始化，子模块接收同一运行时实例；原生后端通过 `maw:backend-events` 事件按原有批次和顺序交付。真实文件入口用例覆盖批量模式启动，并检查应用对象和浏览器模拟诊断没有挂到页面上。
- 转写对比和时间码对比使用页内模块。时间码嵌入工程、波形对比、Filmstrip 便携页改用页面 JSON。工具目录及 CHANGELOG 编辑器从 ESM 工厂生成各自的离线脚本，保留原有文件入口、文档源校验、DOMPurify 白名单及写盘确认。开发看板通过原 localhost 服务加载模块。Filmstrip 用合成媒体实测生成、导出、断网重开，全程保持离线页面零 HTTP 请求。
- 共享工具工厂从 Editor 入口接收浏览器平台、工程、调色板和字体服务。ASS 导出复核找出三处 `globalThis.window` 间接读取，并切换到同一个字体服务。同步移除旧的窗口类型声明和注释，对类型检查沿 import 图新纳入的 DOM 元素、时间轴与导出选项补充类型。原 TypeScript 配置通过。
- 作用域扫描覆盖 275 个维护中的网页及脚本、273 个脚本单元，命中为零。Editor 迁移工具识别 110 个模块所有者，待改写引用、发布别名、未决位置均为零。测试专用别名只在夹具产物发布。
- 工具页的桌面深浅主题、窄屏和局部滚动由 Chromium 用例留证。生成工具使用合成数据。工具页文档、说明副本和 CHANGELOG 编辑器脚本经新鲜度检查。
- 使用 CI 指定的 Node 22.23.4 完成当前分支复验。全量 Node 1771 项和定向 Chromium 48 项通过。定向 Python 405 项中通过 404 项，1 项仅适用于非 Windows 的外部路径打开测试按条件跳过。两端构建与新鲜度、原 TypeScript 配置、文档导航及 Ruff 均通过。此次复验的 Python 与 Chromium 采用定向集合。

### 清理后的合并预演

同一批上游 PR 使用固定 HEAD，和清理及类型校验后的本地快照 `073718e9` 对比。上游对照沿用 `origin/2.0dev@3cf512a2`。

| PR | 改动文件 | 重叠 | 迁移快照的 Git 冲突 | 上游对照冲突 |
| --- | ---: | ---: | ---: | ---: |
| #437 | 54 | 19 | 8 | 0 |
| #376 | 62 | 52 | 19 | 16 |
| #347 | 35 | 18 | 5 | 5 |

#437 在两份独立本地检出实际执行 `git merge --no-commit --no-ff`。首份快照 `a7fc43d6` 有 6 个机械候选和 2 个人工冲突。类型修正后，最新快照有 5 个机械候选和 3 个人工冲突，Git 的冲突文件总数仍为 8。工程导入采用上游的 `requiresProjectMigrationSaveAs` 并从 ESM 绑定调用，样式更新用例改为显式提供 `cueStyleUpdates`。字幕面板在上一轮已审阅的合并结果上保留选择控件、事件目标和重绘选项的三处类型标注。#376 与 #347 的数字来自 Git 预演。操作和逐项审阅方法见 [合并指南](../../../../scripts/refactor-tools/README.md#审阅和应用候选)。

最新隔离合并通过 Editor／Launcher 构建、Editor 新鲜度、TypeScript、全局审计、37 项 Node 测试和 17 项 Chromium 测试。浏览器用例覆盖单句样式跟随和固定、撤销以及旧工程迁移另存。隔离检出及原始结果保存在 `.artifacts/esm-verified-rehearsal-pr437/`，候选在 `.artifacts/esm-verified-pr437-candidates/`。
