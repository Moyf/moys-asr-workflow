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
