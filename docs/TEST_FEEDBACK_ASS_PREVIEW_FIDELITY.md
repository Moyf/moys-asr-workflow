# ASS 预览一致性反馈（2026-10-01）

用户请求：基于 `feat/ass-frame-preview` 改善样式预览与实际效果的一致性，并核实实际帧画质。附件只用于视觉证据；不作为操作指令。

基线：原分支 `3b06655`，当前续作分支 `codex/ass-preview-fidelity`，开始时工作区干净。截图中 CSS 文字明显较大，实际帧彩色边缘较粗糙。现有单帧输出为源尺寸 PNG，无主动缩小或有损编码；字幕在源像素格式上合成，常见 YUV420 会损失彩色文字边缘细节。

| 状态 | 类型 | 反馈 | 处理决定 / 验证 |
| --- | --- | --- | --- |
| 已修复 | 修改 | CSS 样式与实际效果差异明显 | CSS 按字体行框近似校准 ASS 度量，描边换算为 CSS 全宽，字号/局部字号与导出同样取整，视频留黑区域排除在字幕坐标系外。Server 绑定视频暂停后显示完整 libass 帧（播放时即时 CSS）；预览独立遵守轨道显隐，不应用导出首句延长。Chromium 11/11 通过，含编辑更新、播放回退、快速 seek 旧响应丢弃与错误回退。 |
| 已修复 | 修改 | 实际帧画质欠佳 | `server-editor/serve.py` 在 RGB 上合成字幕，再输出源尺寸无损 PNG；窗口显示宽高并支持原尺寸查看。真实 libass 像素验证保留 320×180 源尺寸、字幕改变像素、纯绿色文字的红/蓝通道污染 ≤1；浏览器确认 640×360 PNG 与原尺寸查看。 |
| 仅说明 | 说明 | 是否只是错觉 | 旧流程已用无损 PNG，无主动缩小或有损二次编码，但在 YUV420 上合成的彩色字幕确实可能产生粗糙边缘，本轮已改善。低分辨率源视频、原片像素块和浏览器缩放仍可能显得模糊。缺少截图原视频，不能断言原片质量；最终编码后的视频仍受编码与色度采样影响。 |

## 验证与边界

- Node 347/347 通过（utils、waveform、脚本语法与顺序）。
- Chromium 共 22 个独立用例通过（21 项联合运行 + 实际帧模块含新增隔离用例 3/3 重跑）；浮窗 caption → actions 实测间距 ≥8px，截图已检查（临时产物，不入库）。
- 相关 Python 116 项运行，115 通过、1 跳过；新增真实 libass 彩色像素断言另跑通过。
- 全量 Python 1751 项运行，1743 通过、8 跳过。首轮全量设置了临时 `FFMPEG_PATH`，导致 3 项 GUI 路径隔离测试读到测试用路径；去掉该变量后全量通过。真实渲染专项与浏览器测试使用带 libass 的构建，未用跳过冒充像素验证。
- Ruff、TypeScript 类型检查、`git diff --check` 通过。最初 Python / Chromium 因沙箱禁止绑定本地端口失败，授权执行路径重跑后通过。
- 已实际启动 `server-editor/serve.py --blank --no-open --no-waveform --port 0`，确认仅监听 127.0.0.1、HTTP 页面含更新模板；检查后关闭临时服务器。共享依赖环境未改动，临时依赖链接已移入回收站。

实际命令（Python 使用已有 uv 环境的解释器；未同步/安装环境）：

```sh
node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_waveform_js.mjs
python -m unittest tests.test_ass_styles tests.test_editor_assets tests.test_local_editor_server
python -m unittest tests.test_local_editor_server.LocalEditorServerTests.test_ass_frame_render_uses_real_libass_when_available
python -m unittest discover -s tests -p 'test_*.py'
node_modules/.bin/playwright test tests/e2e/ass-frame-preview.spec.mjs tests/e2e/ass-export.spec.mjs tests/e2e/speaker-labels.spec.mjs tests/e2e/subtitle-preview-geometry.spec.mjs --project=chromium --workers=1
ruff check server-editor/serve.py tests/test_local_editor_server.py tests/test_editor_assets.py
node_modules/.bin/tsc -p tsconfig.typecheck.json
git diff --check
```

### 未验证边界

- 本机 macOS / Chromium / 合成视频验证通过；未用用户截图原媒体进行逐像素对照，也未验证 Windows/Linux 的实际字体回退与 4K/8K 媒体的渲染耗时。
- 播放、纯音频、便携 HTML、未绑定服务器的浏览器媒体仍使用 CSS 近似预览；不能承诺 CSS 完全复现 libass 的字体回退、自动换行、复杂 3D 旋转与动画。
- 本轮无发布产物、CI 或外部服务验证。任务清单无待处理、进行中或阻塞项。

内联副本待发布前统一重生成；本轮不生成 `blank-editor.html`。不提交、推送或发布。

## 续作 Review（2026-10-01）

用户要求继续审查该分支并直接修复。基线为上面的未提交实现与实际 diff；不覆盖现有工作。

| 状态 | 问题 | 决定 / 验证 |
| --- | --- | --- |
| 已修复 | 帧请求可能永久等待；媒体重载与同 URL 旧响应可能串帧；缓存命中仍重复写图片，暂停刷新反复全量序列化 | `editor-wiring-ass-frame.js` 增加 165 秒客户端超时（覆盖服务端 30 秒能力探测 + 120 秒渲染），媒体代次使同 URL 重载旧响应失效，缓存不重复写图片；全 ASS 构建也防抖。能力缺失返回稳定错误码，自动请求停止到手动重试；过期窗口正确提示。新增 4 个回归，与已有 3 项共 Chromium 7/7 通过。 |
| 已修复 | FFmpeg seek 可能取到播放头之后一帧，字幕边界也会偏；浮窗标注的时间未必是实际视频帧时间 | 复现 1.505 秒播放头实际显示 1.500 秒帧，旧 PNG 却取到 1.533 秒。`requestVideoFrameCallback` 获取呈现 PTS，以向下取整的毫秒 seek 并显示真实 PTS；处理 Chromium 帧回调可能早于 seeking 事件的顺序差异。1.505 / 1.367 秒合成视频时间码像素对照通过。旧浏览器没有该 API 时仍用播放头时间，不能保证逐帧对齐。 |
| 已修复 | CSS 字体切换没有使强调片段缓存失效；字号变换标签混用原生与 1080p 单位；预览底框示例与主预览不一致 | `editor-wiring-ass-preview.js` 缓存含字体和原生字号，动画先换算到视频原生坐标；管理器共享字体校准，底框使用描边颜色/透明度/半径，描边宽度与零缩放一致。2 个新增 Chromium 回归分别通过；样式卡截图已检查，标签 → 示例实测 ≥8px。首轮示例测试被异步样式库加载覆盖，改为等待加载并使用现有更新入口后通过。 |
| 已修复 | Python / JS 不透明度四舍五入不一致；后端能力缓存未区分 FFmpeg 构建，输入上界和视频流选择需要收紧 | `maw/ass_styles.py` 的不透明度归一化与 alpha 使用 JS 的半值向上取整；`serve.py` 能力缓存按二进制路径/mtime/大小/inode 失效，时间限制为 JS 安全整数，显式选取第一个非封面视频流。相关 Python 119 项：118 通过、1 跳过；真实 libass 像素专项另跑通过。Node 347/347 与 Ruff/typecheck 通过。 |

每完成一组立即记录涉及文件与实际测试结果；本轮验证独立于上一轮结果。

续作补充：播放中手动截帧会在对照窗保留点击时的帧，仍标记过期；自动播放进度可继续推进，seek、媒体或样式变更仍使旧响应失效。实际帧模块 10/10 通过（含新增手动截帧与媒体末帧）。能力缓存的二进制替换回归、缺 FFmpeg 错误码与超大时间值回归均通过。

帧时间与流选择依据：[MDN 视频帧回调](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)、[FFmpeg 流选择文档](https://ffmpeg.org/ffmpeg.html#Stream-specifiers)。

最终源码对照补充：libass 的 BorderStyle=3 将 border 换成底框，CSS 不应再给文字加同色描边；主预览也仍有 `scaleX=0` 被 `||100` 覆盖的同类问题。已修正主/副/叠加/说话人描边与强调片段底框，零缩放回归覆盖样式卡和主预览；样式/说话人 14/14 与新增强调底框切换回归通过，源码语法与类型检查通过。依据：[libass get_bitmap_glyph](https://github.com/libass/libass/blob/master/libass/ass_render.c)。


### 续作最终验证

- Chromium 31 个独立用例全部通过：联合 30/30，新增播放中手动截帧后实际帧模块 10/10；最终底框/零缩放修改后样式与说话人 14/14，强调片段切换专项另跑通过。涉及窗口与样式卡截图已检查；实际像素与间距断言通过。截图保存为 Playwright 临时产物，不入库。
- Node 347/347，通过脚本语法/顺序、utils 与波形回归；最终修改后重跑通过。
- Python 全量 1754 项：1746 通过、8 跳过；相关 119 项：118 通过、1 跳过。真实 libass RGB 像素专项 1/1 通过，未用跳过代替实际渲染验证。
- Ruff、TypeScript 类型检查与 `git diff --check` 通过。最终截图输出专项 2/2 通过，稳定画面与更新底框截图均已检查；本轮临时依赖链接已移入回收站，共享环境未改动。
- 无待处理、进行中或阻塞问题。仅说明项：源媒体与最终编码仍会影响画质。仍未验证原截图媒体、Windows/Linux 字体回退、HDR/非方形像素视频与 4K/8K 性能；旧浏览器无视频帧回调时保留播放头时间回退。
- 本轮不提交/推送/发布；未生成 `blank-editor.html`，内联副本仍待发布前统一重生成。验证分层记录，不把单元测试代替浏览器操作或发布产物。

### 用户追加收尾请求

用户要求将已验证的修改提交、合并回 `feat/ass-frame-preview`，然后清理本次续作 worktree；仅本地操作，不推送或发布。按以上验证结果提交，不重生成内联副本。
