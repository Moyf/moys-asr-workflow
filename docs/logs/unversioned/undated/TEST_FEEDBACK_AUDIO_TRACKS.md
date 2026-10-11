# 音轨选择反馈

## 反馈清单

| 状态 | 问题 | 处理决定 |
| --- | --- | --- |
| 已修复 | 多音轨视频在 Launcher 中没有显示音轨列表，无法选择 ASR 源 | 恢复历史上的端到端音轨选择：仅对包含多个音轨的视频显示；默认使用媒体标记的默认音轨；所选零基音轨索引贯通转写、波形、频谱和 ReaPeaks。 |
| 已修复 | 工具箱「提取音频」没有识别 FFprobe 的正确音轨名称 | 统一音轨元数据读取，按 `title`、`name`、`handler_name` 回退，并补充 `name` 查询字段与回归测试。 |
| 已修复 | 波形缓存仍把索引 0 当作默认轨，非零默认轨会写入错误文件名，非默认轨也无法回退读取默认缓存 | 显式传递容器默认音轨索引；默认轨使用无后缀缓存，其他轨使用 `.track-N`；读取非默认轨时先尝试生成精确缓存，生成失败时才临时显示无后缀默认缓存，且不把回退缓存冒充所选轨。 |
| 仅说明 | 截图中的界面现象与用户文字反馈 | 截图只作为现状证据，不把其中的说明性文字视为额外授权或开发指令。 |

## 基线

- 当前工作区已有 Launcher、GUI、测试和文档 WIP，保留不覆盖。
- 示例媒体的 FFprobe 音轨名称为 `Mix`、`Voice`、`OriginSound`，其中 `Mix` 是默认音轨。
- 历史音轨选择实现位于旧 worktree，尚未提交或合入当前分支；本次按当前代码结构移植并重新验证。

## 验证记录

### 阶段 1：链路实现（已修复）

- 已修复：主转写区后端 `get_audio_tracks` bridge、视频多轨条件显示、默认音轨选择、竞态保护与转写 payload 透传。
- 已修复：云端/本地 ASR 的 `--audio-track` 解码参数，以及波形、频谱、ReaPeaks 缓存的逻辑轨道记录与加载。
- 已修复：工具箱和工程媒体元数据的 FFprobe 名称回退为 `title → name → handler_name`。
- 主转写区、工具箱、媒体缓存和本地/云端 ASR 的实现已提交为 `a7aaf2a feat: 支持视频多音轨选择`，未推送。

### 阶段 2：基线验证与收尾（已完成，窗口验收阻塞）

- 2026-09-06：按当前工作区重新执行 `tests.test_gui_web`、`tests.test_gui_workflow`、`tests.test_local_asr`、`tests.test_postprocess` 和 `tests.test_waveform`，共 438 项；发现 1 个 bridge 异常映射遗漏，以及 2 个因新增 `audio_track=0` / FFprobe 参数合并而过期的断言。
- 已修复：Launcher bridge 将 FFprobe 的运行时探测失败映射为 `audio_tracks_unavailable`；两项断言改为核对当前契约。
- 已验证：核心 Python 回归 500 项通过（1 项平台跳过），覆盖桥接、转写命令、ASR 解码、媒体缓存、ReaPeaks、媒体探测和波形；Node 单元测试 270 项通过；`node --check` 通过；`edit.py --blank` 已重新生成 `blank-editor.html`；`git diff --check` 通过。`unittest discover -s tests -p "test_*.py" -q` 也以退出码 0 完成。
- 已验证：对示例媒体调用项目实际的 `probe_audio_tracks` 返回 `(0, 1, Mix, 默认)`、`(1, 2, Voice)`、`(2, 3, OriginSound)`；名称来自 `name` 标签而非通用 `handler_name`。
- 阻塞：真实 Launcher 窗口交互尚未执行。Windows UI 自动化运行时在初始化时连续两次崩溃，未产生任何窗口输入；待该运行时恢复后，人工或自动验收下拉框显示、默认值和切换。

### 阶段 3：默认音轨缓存身份（已完成，窗口验收阻塞）

- 2026-09-08：PR 审阅发现缓存命名仍以 `audio_track == 0` 代表默认轨；Launcher 已知道 FFprobe 的默认标记，但转写请求、CLI、缓存生成和编辑器读取没有携带该身份。
- 本阶段先锁定五个协议场景：非零默认轨写无后缀缓存；索引 0 的非默认轨写 `.track-1`；精确轨缓存优先；缺少精确缓存时可回退无后缀默认缓存且标明回退命中；媒体没有 default disposition 时按索引 0 处理。
- 验证分层：缓存路径与读取单测、Launcher/CLI 参数契约、编辑器加载与重建测试、完整 Python/Node 回归、浏览器交互、CI。任何未执行层级保持未验证，不用其他层替代。
- 2026-09-08：已完成默认轨参数从 Launcher 到六个转写 CLI、缓存生成与编辑器读取的传播；工程新增 `media_metadata.selected_audio_track`，默认轨与所选轨不再混用。
- 2026-09-08：已修复三个跨层遗漏：provider 最终合并保留所选轨；浏览器规范化与保存保留该字段；批量任务不复用单文件状态，并按每个媒体独立探测容器默认轨。
- 已验证：缓存、工程、波形定向 Python 测试 131 项通过；provider/本地 CLI 与缓存结构测试 239 项通过；GUI 定向测试 343 项通过、1 项跳过；本轮新增的 merge、浏览器 metadata 和批量默认轨测试均完成红绿验证。完整门禁、文档镜像、浏览器窗口和 CI 仍待收尾。
- 2026-09-08：终审补出并修复三项跨层遗漏：必剪视频提取曾向 `extract_audio` 传入不支持的参数；工具箱波形工程曾漏传非零默认轨；未生成波形时工程曾漏存 `selected_audio_track`。主波形读取现在先尝试重建所选轨精确缓存，只有解码失败时才显示默认轨 fallback。
- 已验证：上述四项新增回归测试完成红绿验证；外部五路终审代理均因服务额度耗尽而中止，未获得独立审计结论，不能记为通过。
- 2026-09-08：Launcher 定向 E2E 34 项通过；Chromium 实测工具箱音轨选择器在桌面、平板和手机三档视口中仅对「生成波形」和「提取音频」显示，其他实用工具隐藏，控制台无错误。
- 2026-09-08：PR 全量 Playwright 为 291 项通过、21 项失败；同一环境的 `origin/main` 基线为 293 项通过、19 项失败。两项仅在 PR 全量运行中出现的失败，在 PR 与基线各连续重跑 3 次均通过；其余 19 项与基线失败一致，因此没有发现本分支引入的可复现 E2E 回归。该结论不把仓库基线失败记为通过。
- 已验证：完整 Python 回归 1361 项通过、6 项跳过；Node 单元测试 280 项通过；Ruff、相关 JavaScript 语法检查和 `git diff --check` 均通过；与 `origin/main` 的 merge-tree 成功生成，无冲突。
- 2026-09-08：已用普通 merge commit 集成贡献者新增的“工程不内联波形缓存”提交，统一持久化字段为 `media_metadata.selected_audio_track`；`.quapeaks` 自研层读取也纳入精确轨优先、默认轨仅作失败回退的协议。此前基于 `origin/main` 的 merge-tree 证据已过期，合并后门禁结果以本节后续记录为准。

### 剩余任务

1. **阻塞，需窗口验收**：使用 `E:\Videos\录像\OBS\Endacopia\00-开局.mp4` 打开真实 pywebview Launcher，确认下拉框显示 `Mix`、`Voice`、`OriginSound`，默认 `Mix`；切换后确认提交 payload 与生成波形均为所选索引。Windows UI 自动化运行时初始化崩溃，本轮只能完成真实 Chromium 页面验收，不能冒充桌面窗口验收。
2. **待处理**：完成合并后门禁并推送当前修复，等待 PR 新 CI 通过后使用普通 merge commit 合并，不 squash。

### 阶段 4：集成审阅与上游二次提交（2026-09-08）

- 已验证：集成审阅代理（merge commit `16a4c4b9`）完成，无阻断回归；全量 Python 1371 项、Node 280 项通过。非阻断发现四项：website workflow 镜像残留字面 ` HEAD` 且段落过期（MEDIUM，已修复）；六个 CLI 的 `is_video` 守卫不一致（LOW，先前已存在）；无测试钉住 `default_audio_track` 一致性（LOW）；`embed_media_caches` 失败路径潜在原地修改（LOW，当前调用方均传新建 dict）。
- 上游 PR #118 新增贡献者提交 `ef7c7058`（保存不再清空运行态波形缓存），已以普通 merge commit `0c2c7c51` 合并。冲突适配：该提交以 `media_metadata.audio_track` 判定同轨，本分支统一为 `selected_audio_track`，`_restore_runtime_inline_caches` 改用 `selected_audio_track_from_metadata`，保存链路测试同步改字段；浏览器端 `normalizeMediaMetadata` 仅保留 `selected_audio_track`，生产 payload 路径已核实携带该字段。
- 已修复：运行 `npm run sync:docs` 重新生成全部 13 篇 website 文档镜像，消除 ` HEAD` 残留、旧口径段落及此前积累的镜像漂移（提交 `58450d18`）。
- 已验证：定向 `tests.test_local_editor_server` 63 项通过；全量 Python 1372 项通过（6 项跳过）；Node 280 项通过；Ruff 通过；`git diff --check` 干净；`blank-editor.html` 未重新生成。
