# ASS 样式库与字幕模式反馈记录

本记录对应 `feat/ass-style-library` 的 ASS 样式库、ASS 字幕模式和样式设置反馈，覆盖两轮用户反馈（截图仅作视觉参考）。已全部处理完毕，无「进行中」「待处理」「阻塞」项。

## 修改项

| 状态 | 反馈 | 处理决定 / 涉及文件 | 验证 |
| --- | --- | --- | --- |
| 已修复 | 共享用户级样式存储、默认槽位、Editor 样式管理窗口 | `maw/ass_styles.py`、`server-editor/serve.py`、`web/editor.js`、Launcher 读写链路；写入接口要求页面请求令牌 | `tests.test_ass_styles`、`tests.test_local_editor_server`（round-trip + 403/200 令牌链路）通过 |
| 已修复 | ASS 导出使用 ASS 方案；SRT 压制使用 SRT 默认样式 | `web/editor-utils.js`（`buildAssPayload` 读取 `ass_color_style`）、`maw/postprocess_ffmpeg.py`（`_subtitle_filter` 共享默认样式 + filter 层转义）、`maw/gui_web.py` | `tests.test_editor_utils.mjs`、`tests/test_ass_styles.py`（含真实 ffmpeg 压制回归）、`tests/test_gui_web.py` 通过 |
| 已修复 | `\fad`、`\fade`、`\move`、`\t` 逐句附加与 ASS 预览 | 序列化、预览动画插值、大字号布局 | `tests.test_editor_utils.mjs` 动画用例通过；e2e `ass-export.spec.mjs` 通过 |
| 已修复 | ASS 字幕模式开关位于「设置 → 字幕样式」，在「主字幕」上方 | `web/editor-template.html` | `tests.test_waveform.py` 结构断言通过 |
| 已修复 | 管理按钮改为「🎨 管理 ASS 样式」 | `web/editor-template.html` | 页面截图确认 |
| 已修复 | 解释“样式”和“ASS 方案”的区别 | 第二轮反馈：说明块不需要，已从 UI 移除（模板、CSS、i18n 一并清理） | 页面截图确认 |
| 已修复 | 颜色字幕样式：作为字幕颜色 / 作为描边颜色 / 无影响 | 第二轮反馈修正归属：移入「ASS 字幕模式」组，由新工程字段 `preview.subtitle.ass_color_style` 驱动导出与预览；【字幕颜色】页恢复 下划线/文字颜色/描边；契约校验与 `JSON_SCHEMA.md` 同步 | `tests.test_project_contract.py`、`tests.test_waveform.py`、e2e `speaker-labels.spec.mjs` 通过 |
| 已修复 | 五种字幕颜色支持用户自定义，无自定义时使用内置色值 | 第二轮反馈：改为「自定义颜色色值」开关，勾选后才显示五色配置；「恢复默认」作为网格第三行第二项；关闭时全编辑器回落内置五色 | `tests.test_editor_utils.mjs`（`subtitleColorPaletteEnabled`）、`tests.test_waveform.py` 结构断言、页面截图确认 |
| 已修复 | ASS 预览字号超过 42px 仍能看到差异 | `web/editor.js`、`web/editor.css` | 页面截图确认 |
| 已修复 | 样式窗口分为基础样式、拓展样式、边框与阴影 | `web/editor-template.html`、`web/editor.css`；第二轮统一 label 上置等宽布局，对齐九宫格缩小并与边距并排 | 页面截图确认 |
| 已修复 | 对齐改为 3×3 单选矩阵 | `web/editor-template.html`、`web/editor.css` | 结构断言 + 页面截图确认 |
| 已修复 | 样式库标题简化、左侧列表错乱、字体输入可搜索、「使用预览字体」按钮（第二轮反馈） | 窗口只保留「ASS 样式库」标题并移除说明块；≤760px 侧栏双列网格显式定位修复交错；字体输入改为 datalist 搜索（映射逻辑在 `web/editor-utils.js`，本机字体本地化别名提交时还原为真实族名）；「使用预览字体」把预览字体映射为具体字体名写入 ASS 样式 | `tests.test_editor_utils.mjs` 映射回归、e2e 全部通过、页面截图确认 |
| 已修复 | 导出字号未按 PlayResY 换算（e2e 发现） | 库样式字号按 1080p 参考存储，导出时按 `PlayResY / 1080` 换算（`web/editor-utils.js`）；legacy 外观导出分支不重复换算 | e2e `ass-export.spec.mjs`（4K 断言 36 = 18 × 2160/1080）通过 |

## 仅说明

- “样式”描述字幕的绘制属性；“ASS 方案”选择样式并组合导出时逐句附加的动画。第二轮反馈后窗口内不再保留说明卡片。
- 字幕颜色页的「颜色样式」（underline / text / stroke）只影响 CSS 预览；ASS 的颜色映射由独立的 `ass_color_style`（text / stroke / none）控制，两者语义不同。历史值 `shadow` 仅保留读取兼容。
- ASS 导出读取默认方案样式，主字幕预览的字体/字号/颜色不再写入导出文件（`docs/EDITOR_GUIDE.md` 已按此更新）。

## 未验证项

- 本机字体扫描需要浏览器 `local-fonts` 授权，自动化环境未授予；预设字体过滤已验证，扫描字体的实机表现待人工确认。
- 移动端窄屏（≤760px）侧栏双列网格已按显式定位重写，真机观感待人工过目。
- 浏览器中的拖动、播放、Seek 以及 ASS 大字号和动画视觉效果需要真实页面检查。
- `blank-editor.html` 暂不生成；仓库约定要求发布前统一生成内联副本（`test_blank_editor_inlines_modular_assets` 使用现渲染构建，不受影响）。
