# G09 样式域 ESM 迁移记录

基线：`cat/esm/g09` 已与上游 `main` 的 `ff8881ea` 对齐；GitHub API 在开工时确认该提交仍是最新主线。范围按 [MAW ESM 路线图](https://maw-esm-roadmap.pages.dev/#overview) 的 G09：样式数据、预览服务及相关控件接线。路线图盘点日期为 2026-10-16，文件与依赖以本次工作树为准。

| 条目 | 状态 | 处理与边界 |
| --- | --- | --- |
| 样式数据：`editor-colors.js` | 已修复 | 改为清单位置执行的 ESM init；刷新说话人标签经具名函数 import，保留可变调色板和原门面。 |
| 字幕外观与预览：`editor-appearance.js` | 已修复 | 改为 ESM init；同域函数调用改静态 import。原先从后续 classic 接线借用的颜色样式校验移回模块；DOM 句柄和仍为 classic 的控件服务使用明确兼容入口。 |
| 外观输入：`editor-appearance-inputs.js` | 已修复 | 改为 ESM init；背景色与透明度调用改为外观模块的具名 import；撤销合并状态仍由原模块持有。 |
| 说话人标签：`editor-speaker-labels.js` | 已修复 | 改为 ESM init；预览调用改静态 import；标签状态和导出选项仍保留原门面。 |
| 接线兼容与剩余 classic 消费者 | 仅说明 | ASS 管理器、字体控件和外观设置接线仍按原清单执行；只为本批跨作用域调用补充窄桥，不在 G09 内整体迁移 G16 接线。 |
| 人工交互、CI、发布产物 | 部分完成 | Chromium 自动化不能代替实机核验；后续 cat fork 强制 CI 三平台构建通过，正式发布与人工核验仍待完成；内联副本待发布前统一重生成。 |

## 验证分层

- 构建与契约：`pnpm run build:editor`、`pnpm run check:editor`、`pnpm run typecheck` 通过；`tests/test_editor_assets.py` 25/25；编辑器脚本顺序、语法、bundle 与构建产物 Node 用例 38/38。
- 单测：`pnpm run test:unit` 在显式复用已安装的 Python 解释器后 1079/1079，通过记录 `.artifacts/checks/20261110T053929Z-24c402f4/result.json`；相关 Python ASS 样式、工程导出、单句位置 44/44，通过记录 `.artifacts/checks/20261110T053700Z-c3424113/result.json`。
- 浏览器交互：`ass-preview-geometry`、`speaker-labels`、`ass-frame-preview` 三份 Chromium spec 30/30，记录 `.artifacts/checks/20261110T052921Z-a859e6aa/result.json`；`ass-export`、`ass-cue-position`、`subtitle-preview-geometry` 三份 spec 48/48，记录 `.artifacts/checks/20261110T053119Z-ae4096fb/result.json`。
- 新守卫红绿验证：临时恢复外观输入对兄弟门面的直接函数调用后，`test_editor_styles_imports.mjs` 1 失败、1 通过，见 `.artifacts/checks/20261110T054122Z-4814e41e/result.json`；恢复修复并重建后 2/2，见 `.artifacts/checks/20261110T054146Z-db02d330/result.json`。
- 环境与修复轨迹：首次 Chromium 使用默认 `uv run` 时尝试下载缺失依赖，服务器启动超时，3 失败、27 未运行，见 `.artifacts/checks/20261110T050826Z-b5dd62fa/result.json`。改用已安装的共享 Python 环境后，30 项均进入浏览器；当时外观模块暴露两处 classic 自由引用，最终由样式模块本地校验与窄桥修复。该轮真实失败见 `.artifacts/checks/20261110T051157Z-fc2bb7b0/result.json`，修复后全组通过。
- 全量 Node 首次未显式设置测试 Python，缩略图服务夹具的 2 项各等 30 秒超时，1077 通过、2 失败，见 `.artifacts/checks/20261110T053700Z-4f513417/result.json`；设置 `MAW_E2E_PYTHON` 与 `MAW_TEST_PYTHON` 后整组 1079/1079。

## 迁移边界

模块初始化仍按 `web/editor-scripts.txt` 位次调用。静态导出仅覆盖有消费者的函数；动态值、DOM 句柄和可变状态留在原冻结门面。四模块存在函数调用环，具名导出在调用时转发已初始化的浏览器单例；不能把它们解释为无状态或多实例模块。`blank-editor.html` 本批不生成。
