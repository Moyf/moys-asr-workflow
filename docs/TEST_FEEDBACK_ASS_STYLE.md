# ASS 样式库与字幕模式反馈记录

本记录对应 `feat/ass-style-library` 的 ASS 样式库、ASS 字幕模式和样式设置反馈。截图仅作为视觉参考；实现范围以用户消息为准。

## 修改项

| 状态 | 反馈 | 处理决定 / 涉及文件 | 验证 |
| --- | --- | --- | --- |
| 进行中 | 共享用户级样式存储、默认槽位、Editor 样式管理窗口 | 复核 `maw/ass_styles.py`、Server 路由、Editor 与 Launcher 读写链路 | 待运行测试与页面检查 |
| 进行中 | ASS 导出使用 ASS 方案；SRT 压制使用 SRT 默认样式 | 复核 `web/editor-utils.js`、`maw/postprocess_ffmpeg.py`、Launcher 后处理契约 | 待运行测试 |
| 进行中 | `\\fad`、`\\fade`、`\\move`、`\\t` 逐句附加与 ASS 预览 | 复核序列化、预览动画和大字号布局 | 待运行测试与浏览器检查 |
| 已修复 | ASS 字幕模式开关位于「设置 → 字幕样式」，在「主字幕」上方 | `web/editor-template.html` | 待结构断言 |
| 已修复 | 管理按钮改为「🎨 管理 ASS 样式」，保持原字号 | `web/editor-template.html` | 待页面检查 |
| 已修复 | 解释“样式”和“ASS 方案”的区别 | 样式管理窗口说明卡片 | 待页面检查 |
| 进行中 | 颜色字幕样式：作为字幕颜色 / 作为描边颜色 / 无影响，默认字幕颜色 | `web/editor-utils.js`、`web/editor.js`、模板与契约文档 | 待测试 |
| 进行中 | 五种字幕颜色支持用户自定义，无自定义时使用内置色值 | Editor 设置、波形、导出与持久化链路 | 待测试 |
| 已修复 | ASS 预览字号超过 42px 仍能看到差异 | `web/editor.js`、`web/editor.css` | 待浏览器检查 |
| 已修复 | 样式窗口分为基础样式、拓展样式、边框与阴影 | `web/editor-template.html`、`web/editor.css` | 待页面检查 |
| 已修复 | 对齐改为 3×3 单选矩阵 | `web/editor-template.html`、`web/editor.css` | 待结构与浏览器检查 |

## 仅说明

- “样式”描述字幕的绘制属性；“ASS 方案”选择样式并组合导出时逐句附加的动画。
- ASS 无法独立表达“只给下划线换色”这一旧 CSS 行为，因此不再保留单独的 underline 颜色模式；旧值 `underline` 兼容映射为 `text`。

## 未验证项

- 浏览器中的拖动、播放、Seek 以及 ASS 大字号和动画视觉效果需要真实页面检查。
- `blank-editor.html` 暂不生成；仓库约定要求发布前统一生成内联副本。
