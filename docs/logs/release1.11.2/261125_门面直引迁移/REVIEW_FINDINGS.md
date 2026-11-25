# 浏览器全局门面迁移自审

审查基线为 `origin/2.0dev@3cf512a2`。提交前由两位未参与实现的审查者分别检查 Editor 与共享依赖、Launcher 与离线工具，以及迁移脚本和测试装配。

| 发现 | 处置与验证 |
| --- | --- |
| Major · `editor-text-process.js:718` 的文本预设新建、重命名和删除继续调用原生对话框。移除全局翻译后，英文界面的新建提示显示「预设名称」。 | 三处改用 `editorDialogs`。运行 `warma-i18n.spec.mjs --grep 'English preset editing'`，用例在修复前失败，修复后通过，并增加重命名提示和默认值断言。 |
| Major · `editor-global-migration.mjs:82` 对应的迁移逻辑将迭代和解构的赋值目标改成只读 import，标签模板改写会丢失接收者。重新赋值的 IIFE 参数也可能被误判为窗口别名。 | 识别写入目标链和标签模板接收者，保留并报告这些用法。排除会重新赋值的参数别名。`node --test tests/test_editor_global_migration.mjs` 的三个复现用例在修复前失败，修复后通过。 |
| Major · `editor-global-migration.mjs:127` 的所有者模块使用别名导出时，脚本会生成指向导出名的未绑定引用。条件内的发布赋值还可能被当作独立语句删除。 | 根据导出关系解析模块内的实际绑定。只有位于语句列表中的发布赋值才可自动移除。脚本测试中的别名导出复现和条件赋值回归均通过。 |
| Nit · `launcher-media-server.js:134` 的最近工程注释仍引用已移除的全局名。 | 注释更新为当前运行时绑定，Launcher bundle 新鲜度检查通过。 |

独立复核通过 7 项 Chromium 用例，覆盖生产 Editor 启动、命令面板、离线译文、对齐录制审查和新手引导。Acorn 对照了 2528 项有效翻译及导出名称，值一致。Launcher 和离线工具通过 80 项 Node、63 项 Python、7 个生成资源新鲜度检查及 CHANGELOG 对拍。审查范围内无未处置的 blocker 或 major。
