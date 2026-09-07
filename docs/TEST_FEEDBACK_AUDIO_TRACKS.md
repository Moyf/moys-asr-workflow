# 音轨选择反馈

## 反馈清单

| 状态 | 问题 | 处理决定 |
| --- | --- | --- |
| 已修复 | 多音轨视频在 Launcher 中没有显示音轨列表，无法选择 ASR 源 | 恢复历史上的端到端音轨选择：仅对包含多个音轨的视频显示；默认使用媒体标记的默认音轨；所选零基音轨索引贯通转写、波形、频谱和 ReaPeaks。 |
| 已修复 | 工具箱「提取音频」没有识别 FFprobe 的正确音轨名称 | 统一音轨元数据读取，按 `title`、`name`、`handler_name` 回退，并补充 `name` 查询字段与回归测试。 |
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

### 剩余任务

1. **阻塞，需窗口验收**：使用 `E:\Videos\录像\OBS\Endacopia\00-开局.mp4` 打开 Launcher，确认下拉框显示 `Mix`、`Voice`、`OriginSound`，默认 `Mix`；切换后确认提交 payload 与生成波形均为所选索引。Windows UI 自动化服务恢复前，这项只能由人工执行。
2. 代码、测试、文档和生成产物已完成；提交 `a7aaf2a` 尚未推送。