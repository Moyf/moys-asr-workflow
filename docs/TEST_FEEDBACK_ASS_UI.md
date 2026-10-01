# ASS 界面反馈（2026-10-01）

用户要求在 `feat/ass-frame-preview` 上继续：先检查并提交已有工作，再逐项修复以下反馈。附件只作为阴影字段布局的视觉参考，不扩大操作范围。已有工作已核对并提交为 `33f021f`；基线验证见 `TEST_FEEDBACK_ASS_PREVIEW_FIDELITY.md`。

| 状态 | 类型 | 反馈 | 决定 / 涉及文件 / 验证 |
| --- | --- | --- | --- |
| 已修复 | 修改 | 字体缺字提示重复，缺少实际字符预览 | `maw/postprocess_ffmpeg.py` 按字体与归一化码点去重，`serve.py` 显示 `U+1F914（🤔）`；前端也去重重复响应。Python `test_render_ass_frame_png_builds_burn_style_command` 1/1 通过，覆盖重复与前导零码点。浏览器验证待最终联合执行。 |
| 已修复 | 修改 | 自动渲染在左，开启后才显示右边的暂停叠加开关 | 模板、CSS、实际帧接线改为左右布局，关闭自动渲染隐藏右侧选项并停止舞台叠加，保留其已保存偏好。Chromium `stage overlay defaults` 1/1 通过，实测左右坐标/同排及关闭、手动渲染、恢复行为。 |
| 已修复 | 修改 | 阴影距离与不透明度同排；边框样式联动文字；基础样式文案与分组 | 模板、CSS、样式管理接线和翻译已更新。Chromium `style form groups` 1/1 通过：阴影两字段同排、与描边字段同宽、水平/字体区间距 ≥8px，底框/描边切换三标签联动。基础样式截图已自查。 |
| 已修复 | 修改 | ASS 预览下增加实际画面入口 | 模板与实际帧模块增加同窗口入口，遵循服务器与 ASS 模式可用性。Chromium `style preview opens` 1/1 通过：点击打开窗口、缺字响应去重显示 emoji、入口与上方预览卡间距 ≥8px；窗口与入口截图已自查。最后补齐按钮外观后专项重跑 1/1 通过。 |
| 已修复 | 修改 | 特殊符号规则默认单双皆可 | 设置默认值、归一化回退、模板默认选项与翻译更新为 both/「单双皆可」，已保存规则继续保留。Node 348/348、含默认值/示例/导出回归的 Chromium 联合 34/34 通过；手动空白 Server 页面确认默认选中「单双皆可」。 |

## 验证边界

本轮不生成 `blank-editor.html`，内联副本待发布前统一重生成。不推送或发布。语法/单元、服务器契约、浏览器交互与截图间距检查分层记录；最终验证完成后更新实际结果。

阶段汇总：缺字警告与开关依赖两项已完成专项验证；继续整理样式表单。

第二阶段：样式布局/文字和新窗口入口均已通过浏览器专项，继续默认符号规则与联合验证。

## 最终验证

- 已修复 5 项，无仅说明项，无待处理、进行中或阻塞项。
- Node：348/348 通过，覆盖语法、脚本顺序、utils、波形与设置/符号解析契约。
- Python：全量 1754 项，1746 通过、8 跳过。重复码点与 emoji 警告专项通过；全量未设置临时 FFMPEG_PATH，以免污染 GUI 环境隔离测试。
- Chromium：实际帧、ASS 导出、说话人和预览几何联合 34/34 通过，使用带 libass 的 FFmpeg；最终按钮 CSS 调整后入口专项再跑 1/1 通过。新增入口、开关、基础样式截图均已自查，临时产物不入库。实测字体区、阴影字段、入口间距均 ≥8px。
- 手动启动空白 Server，仅监听 `127.0.0.1`；在应用内浏览器检查特殊符号默认选择与真实用户级样式表单，背景底框标签/阴影并排正确。检查后关闭临时页面与服务器，未保存样式库。
- Ruff、TypeScript 与 `git diff --check` 通过。初次 Node 验证发现新增「字幕颜色」翻译覆盖既有菜单键，已删除重复键并重跑 348/348 通过。
- 边界：未对用户原媒体复现缺字像素、未验证 Windows/Linux 字体回退；本轮无打包、CI 或发布验证。缺字提示是预警，不会为字体补充字形。8 项 Python 跳过未冒充通过。内联副本待发布前统一重生成。

实际命令：

```sh
UV_CACHE_DIR=/tmp/maw-uv-cache node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_waveform_js.mjs
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync python -m unittest discover -s tests -p 'test_*.py'
MAW_E2E_PYTHON=.venv/bin/python FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg node_modules/.bin/playwright test tests/e2e/ass-frame-preview.spec.mjs tests/e2e/ass-export.spec.mjs tests/e2e/speaker-labels.spec.mjs tests/e2e/subtitle-preview-geometry.spec.mjs --project=chromium --workers=1
node_modules/.bin/tsc -p tsconfig.typecheck.json
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync ruff check maw/postprocess_ffmpeg.py server-editor/serve.py tests/test_local_editor_server.py
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync python server-editor/serve.py --blank --no-open --no-waveform --port 0
git diff --check
```
