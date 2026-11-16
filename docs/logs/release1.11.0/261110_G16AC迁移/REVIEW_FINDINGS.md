# G16-A/C 独立自审

审查者未参与本轮实现；审查当前 G16-A/C 未提交 diff、清单启动顺序、classic 桥及测试结果。结论：没有未处置的 blocker 或 major。

| 级别 | 证据与判断 | 处置 |
| --- | --- | --- |
| nit | `web/editor/ui/editor-dom-panels.js` 迁移后仍提及旧的模块求值行数及 G07 window 入口，注释失准。 | 已改为当前 combobox 初始化说明，并移除过期入口注释。 |
| nit | `web/editor/ui/editor-wiring-dom-panels.js` 的浮层数组未缩进到 init 函数体内。 | 已调整缩进。 |
| 接受风险 | `initMaweDomPanels` 不支持重复调用；重复执行会追加预览文本节点。构建器按清单单次调用，旧 classic 代码也无重复启动契约。 | 当前不扩展重复启动语义。 |

构建器在 `scripts/build-editor.mjs` 按 `web/editor-scripts.txt` 原序调用 init；DOM provider 在 wiring 前，预览服务在 keyboard 桥前。媒体播放模块提前导入的预览函数只在后续事件绑定时调用。`window.AsrEditorUtils.setSplitTrimSymbols` 与旧 `MULTI_SUBTITLE_UTILS` 取自同一共享工具对象。以上为源码与构建清单核对结论。

新增模块契约测试做过撤销 manifest init 的负向验证（测试失败，恢复后通过）。Node 全量单测与相关 Chromium 定向用例通过；Python 全量在 180 秒处超时，Firefox、WebKit 和人工 UI 未验证。验证结果及未测边界见 [迁移记录](G16_AC_ESM.md)。
