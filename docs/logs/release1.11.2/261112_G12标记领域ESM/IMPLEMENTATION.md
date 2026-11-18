# G12 标记领域 ESM 迁移

初始基线：`cat/esm/g12`，`12daf4d2`。2026-11-17 按维护者要求移至 `origin/2.0dev` 的 `76bb330a`；通过系统代理刷新远端后重放本任务改动，未发生 Git 冲突。开放 PR 未直接修改两个目标文件；PR 9 修改 ESM 清单，后续合并需核对。

## 最小迁移计划与结果

| 项目 | 状态 | 结果 |
| --- | --- | --- |
| 编辑逻辑 | 已修复 | `editor-marker-editing.js` 在原清单位次初始化；标记数组、会话开关仍由既有工程与初始化闭包持有。ID 继续由 `nextMarkerId` 生成。 |
| 面板与接线 | 已修复 | `editor-markers-panel.js` 静态 import 编辑操作；过滤、选中、展开与批量选择仍属于面板初始化闭包。classic 接线保持原位。 |
| 消费边 | 已修复 | ESM 波形初始化、历史、工程加载、设置面板与 Gap UI 显式 import 标记操作。classic 启动、快捷键接线及纯波形工厂的可选面板调用保留 `window.MaweMarkerEditing` / `window.MaweMarkersPanel` 门面。 |
| G16-B | 仅说明 | 不属于本次范围。 |

## 验证

- `build:editor`、`check:editor`、`typecheck`：通过。
- 标记 Node 测试 20 项，脚本语法、顺序和 bundle 契约 18 项：通过。
- Playwright Chromium 三个标记 spec：21 项通过，覆盖选区、批量删除、撤销/重做、保存重载和状态同步；这是实际 Server 编辑器页面的浏览器自动化验证。
- 未做人工媒体拖动与试听；交给维护者核对。未生成 `blank-editor.html`。

构建产物和原始日志均留在忽略目录。提交前需按最新 diff 完成独立审查、负向验证与个人路径检查。

## 2.0dev 基线复验（2026-11-17）

`build:editor`、`check:editor`、`typecheck` 通过；标记相关 Node 测试 24 项通过。三组 Chromium 标记 spec 21 项通过。清单现为 156 个输入、122 个 ESM 模块。旧基线的浏览器结论不能代替此轮。

## PR 前范围复核（2026-11-17）

新增 ESM 消费边：历史恢复、工程加载、设置面板和 Gap UI 通过静态 import 调用标记门面；VM 历史测试补入等价导入垫片。classic 接线与启动脚本继续使用全局门面；波形子模块保留面板未初始化时的可选降级。

波形 `media/waveform/markers.js` 虽已登记为 ESM 工厂，构建器要求其工厂无导入求值边；尝试静态 import 标记 init 模块时 `build:editor` 报 `ESM factory must export createWaveformModule without evaluation effects`，类型检查同时失败。因此保留该处可选面板桥，试验已回退并重建。

## PR 辅助 CI 分诊（2026-11-18）

`Targeted auxiliary tests` 在旧提交选中 59 个浏览器 spec、845 条测试；单命令双 worker 运行 900 秒后超时。日志中先出现的 AI 清理用例失败来自 2.0 工程格式迁移：旧夹具不能静默覆盖保存，Python 产物已经是 v2，测试却读取旧 `segments` 顶层字段。相关三组 spec 的夹具及断言已按 v2 契约修复；本地单独复验分别为 1、2、10 条通过。

首次修复提交 `4428ee89` 将至少 20 个 spec 分成两片串行执行。新 run 第一片的 518 条用例运行约 14.8 分钟，454 条通过、数项失败；第二片因 job 总上限 25 分钟被取消，故串行方案不足。改为两个独立的矩阵 job 并行执行，逐片保留 900 秒命令上限与独立报告；两片均跑完整个选择集的各自部分，失败仍保持红灯。第一片真实失败继续分诊，不能把基础工程的通过项冒充辅助浏览器通过。

并行矩阵在 `b8fa2b05` 上确实跑完两片，均因已有用例断言失败而红灯。逐项复现发现：Gap 撤销/重做恢复数据后未刷新字幕预览；本地行为修复后原有 `S3-T05` 用例通过。其余已确认的测试契约漂移来自 2.0：旧工程夹具不能静默覆盖保存，序列化结构改为 `tracks`，以及波形双击改为气泡快速编辑。对应的音频处理、工程接管、拖入打开、叠加轨与双击用例已按现行行为修正并局部复验。ASS 字体/像素相关的 Linux 失败尚未定因，不能标记完成。

本轮修复后 `ai-cleanup-scope-integration`、`open-project-attach`、`open-project-drop` 三组 Chromium 共 16 条通过；三组 G12 标记 spec 共 21 条通过；音频保存、波形双击、叠加轨贴纸四个定向用例通过。`ass-export` 与 `ass-stacking-boundaries` 的 CI 失败用例在 Windows 单独运行通过，Linux 差异仍待复验。`build:editor`、`check:editor`、`typecheck` 通过。未生成独立 HTML。
