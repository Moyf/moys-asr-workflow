# PR #166 审查报告（2026-10-02）

范围：ASS 实际帧、CSS 样式预览与样式库、双语空副轨生命周期、SRT 菜单与整合导出、localhost 接口、对应测试与文档。审查基线为 `abc5a80f`，对比 main `d50020bc`，工作区开始时干净。

## 设计与代码质量

- 实际渲染复用当前 ASS 导出方案和绑定媒体，CSS 保留播放时的低延迟预览；不把派生 PNG 或波形当作工程真源，职责边界合理。
- 客户端串行渲染、合并最新请求，媒体代次、seek 和样式快照共同防止旧响应覆盖；服务端使用固定参数、临时 ASS 文件、令牌校验、输入限制与超时，不增加任意文件浏览或写入能力。
- 双语 SRT 采用时间边界扫描，保留未匹配字幕；空副轨复用既有导入、编辑、历史和保存契约，无需改动工程 schema。
- 新模块遵循脚本装配顺序；JS/Python 样式默认值与 alpha 换算有对照测试。修改保持在领域模块内，没有扩张启动入口。

## 发现与处理

| 状态 | 优先级 | 问题与决定 | 证据 |
| --- | --- | --- | --- |
| 已修复 | P2 | 实际帧窗口关闭且舞台叠加禁用时仍后台构建 ASS 并启动 FFmpeg。改为仅窗口打开或舞台叠加需要时自动渲染；重新打开时按当前状态更新。 | 新增真实 Chromium 回归在原代码失败：无可见消费者仍收到 1 次请求。修复后实际帧模块 17/17 通过（含新增 3 项）。 |
| 已修复 | P2 | 手动渲染后普通预览刷新无条件清空当前快照，未修改画面也显示“画面已过期”。手动模式继续防抖核对快照，保持最新帧；实际编辑后标记过期但不自动请求。 | 新增真实 Chromium 回归在原代码失败：相同位置/字幕刷新后过期层可见。修复后实际帧模块 17/17 通过（含新增 3 项）。 |
| 已修复 | P2 | 播放时暂停在帧回调之间，当前时钟变化导致丢弃已呈现帧 PTS，渲染与标注回退到播放头时间。暂停事件在无 seek 时保留最后呈现 PTS；seek 仍按既有逻辑失效并等待新帧。 | 截图检查发现标注与画面时间码不同；新增回归复现 PTS 1200ms、暂停时钟/标注 1192.988ms。修复后实际帧模块 17/17 通过；小数 seek、末帧和播放中手动捕获回归均通过。 |
| 仅说明 | 优化建议 | 实际帧接线模块虽有 362 行，但状态机集中且已有浏览器覆盖，本轮不做结构拆分。未来增加批量渲染时再抽出独立渲染控制器，并考虑服务端跨标签页并发限制。 | 单标签页请求已串行，未发现必须阻止本次合并的其他设计缺陷。 |

## 验证账本

- 修复前 Node 全量：431/431 通过。
- Python 全量：1763 项，1755 通过、8 跳过；真实 libass 像素验证另行执行，不能以跳过代替。
- TypeScript 和相关 Ruff 检查通过。
- 原提交远端 Ruff 与 Windows x64 MAW-lite preview CI 成功。
- 修复后 Node 核心/脚本/波形 357/357；TypeScript 与 diff 检查通过。
- 实际帧浏览器 17/17 通过；真实 libass RGB 像素专项 1/1 通过。
- ASS 导出、多重字幕、叠加轨、说话人、几何浏览器联合 143/143 通过。共 160 个不同浏览器用例通过，新增 3 项均先在原实现复现失败。
- 相关截图已自查，窗口入口/控制区、样式字段、菜单等间距实测 ≥8px；深浅主题波形轮廓像素断言通过。
- 手动启动空白 Server，监听 127.0.0.1 随机端口；HTTP 200，页面包含最终实际帧模块和双语菜单。检查后停止服务器。
- 修复提交的最终 CI 和合并 SHA 以 GitHub PR 与收尾报告为准，不把原提交 CI 当作修复提交验证。

## 边界

本机 macOS/Chromium/合成媒体验证。Windows/Linux 实际字体、原反馈媒体、HDR/非方形像素和高分辨率性能未验证；无打包、tag 或 Release。内联副本待发布前统一重生成，本轮不生成 `blank-editor.html`。

## 复验命令

Python 使用开发者已有解释器，Node 依赖通过临时链接复用共享目录；未修改依赖清单、锁文件或共享环境。Node 全量测试的既有 uv 子进程在审查工作区建立了忽略的 `.venv`；后续 Python 与浏览器测试直接指定已有解释器，避免重复同步。临时 Node 链接已移入回收站。

```sh
node --test tests/test_*.mjs
python -m unittest discover -s tests -p 'test_*.py'
node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_waveform_js.mjs
node_modules/.bin/tsc -p tsconfig.typecheck.json
ruff check maw/ass_styles.py maw/postprocess_ffmpeg.py server-editor/serve.py
python -m unittest tests.test_local_editor_server.LocalEditorServerTests.test_ass_frame_render_uses_real_libass_when_available
node_modules/.bin/playwright test tests/e2e/ass-frame-preview.spec.mjs --project=chromium --workers=1
node_modules/.bin/playwright test tests/e2e/ass-export.spec.mjs tests/e2e/multi-subtitle.spec.mjs tests/e2e/overlay-track.spec.mjs tests/e2e/speaker-labels.spec.mjs tests/e2e/subtitle-preview-geometry.spec.mjs --project=chromium --workers=1
python server-editor/serve.py --blank --no-open --no-waveform --port 0
git diff --check
```

浏览器使用 `MAW_E2E_PYTHON` 指定已有环境、`FFMPEG_PATH` 指定带 libass 的构建。真实像素专项也使用该 FFmpeg；Python 全量不设置临时 `FFMPEG_PATH`，避免污染 GUI 环境隔离用例。

无待处理、进行中或阻塞的代码问题。保留以上未验证边界与后续优化建议，不要求本次合并前进行跨平台打包或结构性重构。
