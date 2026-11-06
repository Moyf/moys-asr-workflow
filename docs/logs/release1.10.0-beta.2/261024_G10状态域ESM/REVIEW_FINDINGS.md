# G10 rebase 后的修复与复核

分支：`esm/g10-state-io`。基线：上游 `main` 的 `50314a03`；G10 rebase 后为 `9d2a903b`。本记录只描述该分支的修复，不代表远端 CI 已运行。

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| 工程加载与多字幕导入调用 `MULTI_SUBTITLE_UTILS` 报 `ReferenceError` | 已修复 | 旧绑定属于 classic `initializeLegacy` 的局部作用域；两个 ESM init 内补同值局部绑定。rebase 后原样 Chromium 两例失败，修复后两例及相关三组 25/25 通过。 |
| 5 个 VM 测试文件无法装载 G10 的 ESM 源码 | 已修复 | 全量 Node 单测中的 52 条因 `export` 或单导出 helper 的文本拆解失败；用 `invokedInitModuleSource` 执行实际 init 函数体。定向 52/52、全量 984/984 通过。 |
| Launcher bundle 过期 | 仅说明 | rebase 后本地产物过期；重建后 `test_launcher_bundle` 8/8 通过，不涉及 G10 源码。 |
| VM helper 剥离 import，不能单独验证 ESM 接线 | 仅说明 | 独立自审接受的测试边界；构建检查与 Chromium 实际 bundle 交互覆盖接线。本轮没有新增此限制。 |

## 验证记录

- rebase：6 个 G10 提交无冲突重放到 `50314a03`。
- 修复前：`check:editor`、`typecheck` 通过；`test:unit` 984 条中 53 条失败，其中 52 条为上述 VM 装载问题、1 条为本地 Launcher 产物过期。
- 修复前：`new-project` 与 `project-async-lifecycle` 两条定向 Chromium 用例因 `MULTI_SUBTITLE_UTILS` 失败。
- 修复中：5 个测试文件的定向 Node 用例 52/52 通过。
- 修复后：`pnpm run test:unit` 984/984；`pnpm run typecheck`、`pnpm run check:editor`、`pnpm run check:launcher` 均通过。
- 修复后：`tests/test_editor_assets.py`、`tests/test_editor_manifest.py`、`tests/test_web_build.py` 合计 55/55；Chromium 的 `new-project`、`open-project-attach`、`project-async-lifecycle` 合计 25/25，`multi-subtitle` 定向导入与交换 2/2。
- 全量 Python 套件尝试一次，240 秒超时且运行器未产生测试输出；未视为通过，也未重复启动。相关的 55 条 Python 用例已单独通过。
- 自动化边界：未运行全量 Chromium e2e，Cat fork 远端 CI 尚未触发；人工交互仍待维护者核验。`blank-editor.html` 按仓库规则未生成。
- 本次全量 Python 超时后未发现残留的本工作树 `python`、`uv` 或 `node` 测试进程。
- 独立自审：未发现 blocker 或 major；核对两个工具对象绑定与原 classic `editor.js` 同值，5 个 VM 测试夹具均执行对应 init。`git diff --check`、清单格式检查通过。

## 合作者反馈复核（2026-10-27）

| 条目 | 状态 | 处理与证据 |
| --- | --- | --- |
| 构建检查可能放过提前执行的代码 | 已修复 | 检查模板字符串、运算符和对象属性名内部的表达式，并拒绝对象展开和顶层解构。七个测试用例在修复前能通过检查，修复后被拒绝。该检查仍有下文所述的限制。 |
| 两个测试包含未使用的 `module_exports` | 已修复 | 删除两个无用字段；测试仍然检查原来的函数行为，相关 Node 检查共 42 项通过。 |
| PR 正文高估了模块间的静态导入迁移进度 | 仅说明 | 本次修改的状态和工程读写模块之间，没有新增静态导入关系；构建入口新增了对初始化模块的静态导入。本地已修正相关源码注释；维护者决定保留 PR 原文。 |

本地验证：编辑器 bundle 已重建并通过新鲜度检查；相关 Node 检查 42 项、Python 编辑器资产与构建检查 49 项、TypeScript 检查及个人路径检查通过。G08-a `82882b69` 和 G08-b `9bf051ab` 的快照使用新规则均能构建。

Astra high 独立复查未发现新增阻塞问题。其单独运行相关 Node 测试 35 项，并分别检查 G08-a 的 60 个、G08-b 的 73 个初始化模块，均通过当前构建检查。

剩余边界：如果代码把外部对象转换成数字，对象中的转换方法仍可能在加载时运行。实测 `+externalValue` 能通过检查并触发一次转换。当前代码和上述 G08 快照没有这种顶层常量。该检查不能证明加载文件时一定不会执行其他操作。远端 CI 应以包含上述修复的提交为准。

## 待办

- [x] 重建编辑器 bundle，复跑两条 Chromium 反例与受影响整组。
- [x] 全量 Node 单测、类型检查、编辑器/Launcher 构建检查、相关 Python 套件。
- [x] 独立自审、差异检查与个人路径检查；未获授权前不推送远端。
