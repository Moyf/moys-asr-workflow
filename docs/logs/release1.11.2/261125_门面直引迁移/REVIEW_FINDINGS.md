# 浏览器全局门面迁移自审

Editor 初始化与导出清理后的独立复查和人工步骤见 [Editor 手动验收清单](Editor手动验收.checklist.md)。

审查基线为 `origin/2.0dev@3cf512a2`。提交前由两位未参与实现的审查者分别检查 Editor 与共享依赖、Launcher 与离线工具，以及迁移脚本和测试装配。

| 发现 | 处置与验证 |
| --- | --- |
| Major · `editor-text-process.js:718` 的文本预设新建、重命名和删除继续调用原生对话框。移除全局翻译后，英文界面的新建提示显示「预设名称」。 | 三处改用 `editorDialogs`。运行 `warma-i18n.spec.mjs --grep 'English preset editing'`，用例在修复前失败，修复后通过，并增加重命名提示和默认值断言。 |
| Major · `editor-global-migration.mjs:82` 对应的迁移逻辑将迭代和解构的赋值目标改成只读 import，标签模板改写会丢失接收者。重新赋值的 IIFE 参数也可能被误判为窗口别名。 | 识别写入目标链和标签模板接收者，保留并报告这些用法。排除会重新赋值的参数别名。`node --test tests/test_editor_global_migration.mjs` 的三个复现用例在修复前失败，修复后通过。 |
| Major · `editor-global-migration.mjs:127` 的所有者模块使用别名导出时，脚本会生成指向导出名的未绑定引用。条件内的发布赋值还可能被当作独立语句删除。 | 根据导出关系解析模块内的实际绑定。只有位于语句列表中的发布赋值才可自动移除。脚本测试中的别名导出复现和条件赋值回归均通过。 |
| Nit · `launcher-media-server.js:134` 的最近工程注释仍引用已移除的全局名。 | 注释更新为当前运行时绑定，Launcher bundle 新鲜度检查通过。 |

独立复核通过 7 项 Chromium 用例，覆盖生产 Editor 启动、命令面板、离线译文、对齐录制审查和新手引导。Acorn 对照了 2528 项有效翻译及导出名称，值一致。Launcher 和离线工具通过 80 项 Node、63 项 Python、7 个生成资源新鲜度检查及 CHANGELOG 对拍。审查范围内无未处置的 blocker 或 major。

## PR #458 Windows 打包复核

`521a615b` 的 Windows 打包预览在真实 exe 启动后报告 `Packaged editor has no application bundle`。用生产渲染器取出空白 Editor 页，旧检查复现失败，且页面里存在一个构建器写入的 SHA-256 产物头。

`scripts/packaging/smoke_editor.py:17` 改为识别带代码的构建产物头。独立复核验证实际渲染结果、空标记和仅有旧全局名称的负例，确认启动、项目身份、资源请求与退出检查继续执行。资产与打包契约共 65 项通过，Ruff 通过。

## PR #458 辅助测试复核

- 浏览器测试夹具将可写门面与真实 ESM 绑定连接，让 ASS 序列化计数、渲染参数和跳空导出绑定的测试替身作用于实际调用方。独立复核对照了生产和测试 bundle，确认只有后者注入测试访问器。
- 字幕滚动的源码用例复用 Editor Server 夹具，卡拉 OK 表单复用门面发布辅助函数。Dashboard 的长标题通过模拟 API 返回。缩略图测试监听页面画布的 `drawImage`，确认加载和重载后均收到实际图像绘制。常规及独立滚动配置的 Chromium 用例均通过。
- 选测扫描识别 Launcher 夹具 URL 导航和 JSDoc 标注的 DOM 查询。ASR 预设测试使用自己构建的临时 bundle。影响选测和工作流回归共 51 项通过，独立复核无未处置的 blocker 或 major。

## Editor 清理后的选测复核

- P2 · `368c07b6` 移除相邻合并门面后，Chromium 用例通过 Ctrl/Cmd+Shift+D 触发合并。单独更改合并实现或快捷键接线时，选测器均漏掉该用例。已在 `web_behavior_consumers` 声明两个源码入口对应的浏览器用例。
- 新回归在修复前对两个入口均失败，修复后通过。选测与工作流共 54 项通过，Chromium 的叠加字幕键盘合并用例通过。独立复核确认两个入口均只选中该浏览器 spec，且相邻的对齐绑定模块仍不选中 E2E。无待处置发现。
