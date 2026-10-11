# PR #211 媒体重组修复与音频导出

基线：GitHub 实时核对的 #211 head `659e19ad9b513117ddfe3904f073b8691ead41b0`。
工作区：当前独立分支 `code/pr211-media-export-fixes`；用户在完成验证后明确授权提交并推送至 fork，不改其他工作区。

## 用户范围与验收

| 项目 | 状态 | 验收 |
| --- | --- | --- |
| HEVC 重组导出兼容与错误反馈 | 已实现、自动化通过 | 用户片段同步及任务各三次成功；全流可解码、媒体元信息保留、源 hash 不变 |
| 导出失败后重复停止警告 | 已实现、自动化通过 | 已失败且已清理只提示一次；真实清理失败仍提示，包含文件已成功保存后的清理失败 |
| 重组后音频 | 已实现、自动化通过 | WAV 保存、进度及停止；真实样本逐字节核对切点和时长；Edge 成功解码浮点 WAV |
| 提示文案 | 已实现、自动化通过 | 简明媒体文案、中英文同步；实际展开音频菜单截图已核验 |
| ASS 绿幕 | 仅说明 | 本次不修改 |

音频默认导出 WAV，保持源采样率和声道，精确裁切到最近音频样本；不默认承诺压缩音频流复制的任意切点精度。

## 独占写域

| owner | 写域 | 约定 |
| --- | --- | --- |
| root | 本报告、CHANGELOG、MAW.spec、bundle/meta、环境及整合 | Git/ref 操作和构建仅 root 执行 |
| backend | server-editor/serve.py、maw/media_jobs.py | 唯一共享后端 writer；视频修复及音频 helper 接入 |
| audio | maw/media_export_audio.py | 独立音频 helper；不写 serve.py/media_jobs.py |
| frontend | web/editor/io/editor-wiring-export-actions.js、web/editor-template.html、web/shared/editor-i18n.js、web/editor/media/editor-media-load.js、web/editor/io/editor-project-load.js、相关 e2e 测试 | 独占前端；不重建 bundle |
| validation | tests/test_gap_removed_audio_export.py、tests/test_gap_removed_video_compatibility.py、独有 .debug-runs 验证目录 | 独立真实媒体验收；不写生产代码 |

## 接口契约

- 保留原 gap-removed-video API 和旧配置字段兼容；新配置区分 media kind、source name、output extension/MIME。
- 音频输出 `.wav`，视频继续原容器；绑定身份校验、任务互斥、取消与清理继续共用。
- 新 helper：`rebuild_gap_removed_audio(source_path, intervals, output_path, *, ffmpeg_path, ffprobe_path, job=None, audio_track=0) -> Path`，错误为 ValueError 子类；整数毫秒半开区间。
- 任务快照新增 `cleanupComplete`，只有输出实际清理完成才为 true。failed 的清理完成与原导出失败分开表达。
- 启动任务可指定输出扩展名；MediaJob 临时文件按输出类型生成。
- 新配置字段 `gapRemovedMediaKind`、`gapRemovedMediaSourceName`、`gapRemovedMediaOutputExtension`、`gapRemovedMediaOutputMime`、`canGapRemovedMediaExport`。旧 `gapRemovedVideoSourceName` / `canGapRemovedVideoExport` / 路由仍兼容；前端解绑同时清除新旧 capability。
- `gapRemovedMediaAudioTrack` 提供初始音轨，点击时优先读取当前工程 metadata 选轨并冻结；POST `selectedAudioTrack` 由后端与当前 metadata 对照，不接受任意客户端音轨。保存窗口期间切轨拒绝旧导出；已接收请求的后端 runner 始终使用冻结快照。

## 验证记录

最终再次读取 GitHub #211，head 仍为 `659e19ad9b513117ddfe3904f073b8691ead41b0`。源文件、其他工作区、共享依赖未修改。验证完成后用户授权推送，目标为 origin 的独立修复分支；本报告下列路径相对于当前工作区。

### 根因与最终实现

用户片段的 HEVC hvcC 参数数组包含错误归类的 PPS，普通 FFmpeg 流复制即可复现输出空参数头及 `No start code`。#203 最早直接重组实现 `a0ebd2d7` 到 #211 都可复现，兼容缺陷不是 #211 新增。现在针对每个 HEVC 输出流使用 `hevc_mp4toannexb` 修复参数头，保持 `-map 0`、元信息、流复制及产物媒体流一致性校验。#211 的停止逻辑把原导出失败当作停止失败，造成第二次重复警告；现在按真实 `cleanupComplete` 判断清理是否完成，清理错误单独保留。

音频完整解码一次为私有 PCM 文件，按最近样本分块裁切，输出 WAV/RF64；保持采样率、声道及 PCM/浮点精度。自然媒体尾端的整数毫秒向上取整仅允许半毫秒容差，并按真实样本数收尾；更大越界仍拒绝。任务取消清理私有 PCM 和产物，源文件不变。新模块已加入两个打包 runtime 及 hidden import。

两名独立审查代理复核生产后端与前端。补齐了成功保存后的清理失败提醒、空 audio 占位器导致的视频工程菜单误分类、音轨快照及英文错误文案。最终没有阻碍交付的审查项。

### 自动化结果

| 验证 | 最终结果 | 证据 |
| --- | --- | --- |
| 用户视频 production 同步及 MediaJob | 6/6 成功，所有流可解码、视频帧对应源内容、流及元信息保留；20–21ms 极短区间拒绝缺失音轨的产物且清理完成 | `.debug-runs/media-export-validation-final/user-media-result.json`；`.debug-runs/20261011T130320Z-ca3f0276/result.json` |
| 用户 AAC 三段按样本拼接 | 48000Hz 双声道；35232 样本，0.734 秒；与完整解码后切片逐字节相同 | 同上 |
| 独立媒体回归 | 12/12，通过 PCM16/24/32、float32/64、AAC/MP3、5.1、选轨、尾端、取消、禁止覆盖、RF64 头和多流异常 HEVC | `.debug-runs/media-export-validation/combined-regression/20261011T125647Z-955cc383/result.json` |
| 后端 binding/jobs/shutdown/重组/API | 50/50，包含新增 8 项 | `.debug-runs/backend-fixes-checks/20261011T125838Z-5d547716/result.json` |
| 浏览器 handler 回归 | 43/43 | `.debug-runs/media-frontend/20261011T130022Z-f855cb9e/result.json` |
| 最终 bundle 真实编辑器 | 5/5；真实视频保存提交、音频 WAV、压缩立体声 MP3 浮点 WAV 解码、工程 reload/rebind | `.debug-runs/media-frontend/20261011T130203Z-66968ee5/result.json` |
| 实际展开音频导出菜单补证 | 1/1，root 已打开截图核验 | `.debug-runs/media-frontend/20261011T130354Z-784be78b/result.json`；`.debug-runs/media-frontend-menu/gap-removed-audio-export-r-a16a4-aves-the-real-server-output-chromium/real-audio-export-menu.png` |
| Python 全量 | 2016 项，1990 通过、26 跳过，exit 0 | `.debug-runs/20261011T130131Z-0f76d198/result.json` |
| Node 全量 | 571/571，exit 0 | `.debug-runs/20261011T130117Z-48113b5b/result.json` |
| 打包契约 | 28/28 | `.debug-runs/20261011T125643Z-128ba2d3/result.json` |
| TypeScript / bundle fresh / Ruff / diff | 通过 | `.debug-runs/20261011T130201Z-2f144589/result.json`；`.debug-runs/20261011T130201Z-8d6d3266/result.json`；`.debug-runs/20261011T125928Z-3f0d2999/result.json`；`git diff --check` |

实际 MP3 → 浮点 WAV 浏览器解码结果：44100Hz、2 声道、41675 样本、0.9450113378684807 秒。JSON：`.debug-runs/media-frontend-rendered/gap-removed-audio-export-r-64811-AV-decodable-by-the-browser-chromium/browser-decoded-audio.json`。

用户视频 SHA256 前后均为 `6ba5197cd32b452443ec6ba6093fc7c71f37d14c83514bc3c48ad963c6e19c74`。最终生产文件 SHA256 已保存在用户媒体验证 JSON 中，区分诊断候选与最终修复。

### 命令、环境和验证边界

- 检查均经 `scripts/run_check.py --timeout N -- ...`；Python 全量使用 `scripts/run_tests.py`，Node 全量使用 `node --test tests/*.mjs`；编辑器构建及 fresh check 使用 `node scripts/build-editor.mjs --write / --check`。
- 只读复用锁文件一致的 `J:/workspace/worktree/maw-premerge-device-check-20261011/maw-fork/.venv/Scripts/python.exe` 及 node_modules，未安装/同步共享依赖。浏览器使用已安装 Edge，媒体使用 PATH 上 FFmpeg/FFprobe。
- 初轮沙箱浏览器启动失败，Python 全量仅 `test_run_check` 自建进程树清理被沙箱阻止；最后获自动审批在沙箱外完成上述最终回归。初轮较广后端 132 项有一次 sticker 目录 rename `WinError 5`，随后定向及全量通过。初轮 Node 未传正确 Python/Edge 环境且 bundle 正在修改，最后设置正确环境与最终 bundle 后 571 项通过。这些初轮结果不计为通过。
- 最终 Python 全量日志开始仍有一条子进程 reader 的 UTF-8 解码异常诊断，但 unittest 结果为 `OK (skipped=26)`；记录该诊断，不把退出码通过描述成日志无异常。
- 最终真实用户媒体验证复跑第一次触发已有 WAV 产物的防覆盖检查；使用独立新验证目录后通过，旧证据/产物未被覆盖。
- 视频保持原有 GOP 预卷/包边界行为，没有声称帧级精准。极短保留区间可能无音轨，继续保守拒绝，不移除流一致性保护。
- 浏览器保存选择器及写入句柄由 E2E 替身驱动；实际操作系统保存窗口、人工听看及打包应用启动未执行。提供仓库外 HTML 核对清单逐项人工验收。ASS 绿幕不在本次范围。

人工清单：`C:/Users/JingKe/.codex/visualizations/2026/10/11/01a12ae4-0cbf-7ed2-af37-3685edb15ecc/pr211-media-export-checklist.html`。
