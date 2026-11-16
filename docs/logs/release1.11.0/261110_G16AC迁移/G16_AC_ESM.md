# G16-A 与 G16-C Editor ESM 迁移

分支：`cat/esm/g09`。本轮延续 G09、G11、G16-F，将 ASS 预览刷新和编辑器启动时的 DOM 面板接线迁入 ESM。`web/editor-scripts.txt` 保持原有执行位置；尚未迁移的 classic 调用方继续使用窄兼容门面。

## 范围与结果

| 范围 | 结果 |
| --- | --- |
| G16-A | 将 ASS 预览的帧合并、100 ms 有界补帧、ResizeObserver 和播放器更换观察移入独立 ESM init。媒体播放和字体几何模块改用静态导入；键盘守卫仅转发旧接口。 |
| G16-C | 初始配置接线改为原位 ESM init。DOM 引用和可变 combobox 状态移入 ESM 提供者；10 个已迁移模块静态导入 accessor，仍为 classic 的调用方使用兼容门面。浮层激活保持原有执行位置。 |
| 清单与契约 | `web/editor-modules.json` 登记新 init，测试覆盖惰性导入、启动位置和 ASS 刷新行为。 |

`blank-editor.html` 按当前分支约定未重生成；内联副本待发布前统一重生成。没有修改字幕工程 schema 或导出格式。

## 验证

- `pnpm run build:editor`、`pnpm run check:editor`、`pnpm run typecheck` 通过；当前清单为 118 个 ESM 模块、153 个源文件。
- `pnpm run test:unit`：1086/1086 通过。编辑器资产和清单 Python 定向测试：31/31 通过。
- Chromium Server 页面启动测试：1/1 通过；ASS 预览几何、ASS 导出和设置结构的定向测试：61/61 通过（排除一条既存的过期断言）。
- 新增模块契约测试做过负向验证：临时撤销 refresh 的 manifest init 登记时测试失败，恢复后通过。
- 全量 Python `scripts/run_tests.py` 在外层 180 秒限制处超时，日志为空；它不计为通过。相关的定向 Python 测试已通过。

定向 Chromium 首轮在键盘拖动用例发生一次计时失败，单独重跑该用例通过。`settings-structure.spec.mjs` 的一条帮助分类断言仍期望 3 项，而当前未改动的模板有 10 项，因此该条没有纳入 61 项通过数；需单独更新其既存断言或在主线修复。浏览器人工交互、三平台 CI 尚待本次提交后验证。

## 后续

按 [人工核对清单](G16_AC.checklist.md) 验证暂停预览尺寸变化、媒体切换、设置窗口与字体控件；提交后核对远端 CI。G12 保持独立范围。
