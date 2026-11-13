# G11 与 G16-F Editor ESM 迁移

基线：`cat/esm/g09` 的 G09 提交 `3a19bd2f`；路线图为 [MAW ESM roadmap](https://maw-esm-roadmap.pages.dev/#overview)。本轮继续迁移 G11 导入导出与媒体控制，以及 G16-F ASS 预览接线。源码和清单以当前上游 `main` 为准，路线图的旧 PR 等待项已随上游合并解除。

## 范围与结果

| 范围 | 结果 |
| --- | --- |
| G11 的 16 个目标文件 | 全部在 `web/editor-modules.json` 以 `init` 登记，仍在 `web/editor-scripts.txt` 原位执行。原有 IIFE 状态与公开门面保留给 classic 消费者。 |
| G16-F 的 8 个目标文件 | 全部在原位初始化。Canvas、帧预览、逐句定位的 DOM 和监听器只在 init 阶段创建。 |
| ASS 样式库 | 存储模块独占库、修订号、就绪状态和加载 Promise；管理面板通过静态导入的函数读写同一份状态。原有测试与外部脚本使用的全局库、加载函数保留可读写桥。 |
| 预览与播放 | 播放循环静态导入 ASS 预览接口；媒体绑定通过窄门面调用后续安装的 ResizeObserver 接线，保留原刷新时机。 |
| DOM 控件 | 样式面板与字体接线从 `MaweDomPanelsWiring` 读取已取得的控件引用；可变 combobox 使用访问器，避免快照与重复安装。 |

`ASS_STYLE_LIBRARY_READY` 仍仅在异步加载或持久化结果到达时更新；没有用立即完成的 Promise 代替服务器响应。已有 classic 消费者继续使用兼容门面。`blank-editor.html` 未重生成，内联副本待发布前统一重生成。

## 验证

- `pnpm run build:editor`、`pnpm run check:editor`、`pnpm run typecheck` 通过；Editor 为 114 个 ESM init/factory、151 个源文件。
- 全量 Node 单测 1079/1079 通过：`.artifacts/checks/20261110T091410Z-9ada9059/result.json`。相关 Python 构建、清单和资源测试 55/55 通过：`.artifacts/checks/20261110T091954Z-d8e4a534/result.json`。
- Chromium：ASS 导出 21/21、预览启动 1/1，G11 Server 页面相关回归 27/27，ASS 帧预览、逐句定位与堆叠边界 79/79。记录分别为 `.artifacts/checks/20261110T090219Z-990c6aaa/result.json`、`20261110T090138Z-64d83d5b/result.json`、`20261110T091801Z-cfdc48d9/result.json`、`20261110T092208Z-87ed51b4/result.json`。
- 新增 `tests/test_editor_g11_g16f_imports.mjs` 检查目标文件、静态依赖与 import 阶段无浏览器副作用，3/3 通过。临时把 `editor-drag-drop.js` 的 manifest 项改回非 init 时测试按预期失败，恢复后通过且 bundle 新鲜。
- G11 浏览器组中的 `media-controls-layout.spec.mjs` 单项失败：它只打开未更新的 `blank-editor.html`，旧页缺少 `.media-volume-control`；Server 页面同组 27 项通过。根据仓库便携模式弃维护约定，本次不重生成内联副本，此项不计作 Server 页面通过。

## 尚需维护者核验

真实浏览器中拖动逐句锚点、播放与 Seek、替换媒体、ASS 样式库跨窗口同步，以及导出后的外部播放器效果仍需人工确认。远端 CI 尚未运行。本轮迁移没有改动字幕 schema 或导出格式。

后续验证：[cat fork 强制构建](https://github.com/drunkenQCat/moys-asr-workflow/actions/runs/42798868589) 在提交 `7c4144d3` 上通过 Windows、Linux、macOS 三平台。首次 macOS 作业未获得 GitHub 托管 runner，重跑后成功；发布步骤因测试 tag 不以 `v` 开头而跳过。PR 专用检查与上述人工交互仍需分别核验。
