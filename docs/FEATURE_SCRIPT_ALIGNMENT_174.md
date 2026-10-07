# #174 文稿驱动对齐开发记录

需求来源：[Issue #174](https://github.com/Moyf/moys-asr-workflow/issues/174)。基线为 `1f008d8a`，工作区无已有改动。

| 项目 | 状态 | 决定与验证 |
| --- | --- | --- |
| 文稿 + 媒体独立生成 MOSP / SRT | 已修复 | `maw/script_timestamp_alignment.py`；真实 FFmpeg WAV 流程 + 假对齐后端验证产物可由工程 / SRT 解析器重开，保留原文与标点、不会覆盖已有文件 |
| ≤300 秒单次对齐 | 已修复 | 300 秒边界单元测试通过；独立上限，不改已有时间码工具的 75 秒策略 |
| 长录音静音锚点 | 已修复 | 11 分钟合成 WAV 经真实 FFmpeg 静音检测、切块，假对齐后端验证 33 行绝对偏移无累积漂移；不对应时拒绝，支持人工锚点 |
| 脏录音与异常诊断 | 已修复 | 完整文字覆盖、时间顺序、范围、零时长、锚点数量 / 越界校验通过；失败不写部分产物；声学正确性仍需真实念稿听审 |
| Launcher / CLI / 本地运行时 / 打包接线 | 已修复 | 公开 `--align-script`、Launcher 时间码处理方式、worker 与 `MAW.spec` 已接线；CLI / GUI mock bridge / worker 参数与新浏览器交互测试通过；未构建发行包 |
| 文档、CHANGELOG、回归验证 | 已修复 | 使用指南、CLI、README、索引、工具箱与 CHANGELOG 已更新；同步 main 后 Python 1849 项（23 跳过）、Node 370 项、浏览器 54 项、Ruff 通过；内联副本待发布前统一重生成 |
| 真实 Qwen 模型推理与长素材听审 | 阻塞 | 当前默认 MAW / HF / ModelScope 缓存未找到 ForcedAligner 权重；未下载大模型，尚无真实念稿推理证据 |
| 最新 main 类型检查 | 阻塞 | `ViewInvalidation` 缺少 `cueListPatch`；干净 `origin/main` 的类型检查快照复现同一 TS2339，待上游补齐声明，不在本 PR 扩大编辑器改动 |
| CI、打包与发布 | 仅说明 | 本次提交 Draft PR；尚无远端 CI 或发行包证据，未发布 |

## 实现边界

- ForcedAligner 返回的是输入文稿的时间码，不是识别文字；对其输出再做 difflib 不能证明录音读对了。首版不以这种匹配掩盖无法判断的文本 / 音频对应关系。
- 长录音自动模式要求每个非空文稿行对应一个静音分隔的语音区间；其他录音可用人工锚点指定每组行的真实时间范围。每组必须 ≤300 秒。
- 未进行本地模型实际推理、长素材听审、打包或 CI 前，不将这些层的验证标为通过。

## 阶段验证

- `uv run --no-sync python -m unittest discover -s tests -p 'test_script_timestamp_alignment.py'`：16 项通过（使用现有开发虚拟环境）。
- `uv run --no-sync ruff check` 本次修改的 Python 模块：通过。
- 初次 Python 全量：1805 项，44 个错误、23 跳过；错误涉及沙箱拒绝 localhost 绑定，须允许本机测试后复核。
- 初次 Playwright：Chromium 启动被 macOS 沙箱拒绝（MachPortRendezvousServer），未进入测试，须允许启动浏览器后复核。
- 允许启动本机测试服务器后，Python 全量 1805 项通过（23 跳过）；使用可写 UV 缓存后，指定 Node 回归 357 项全部通过。
- `npm run typecheck`、Ruff 与 `git diff --check` 通过。
- 新增浏览器测试验证文稿 / 媒体请求不携带原工程、输出工程与 SRT 路径、听审警告、Qwen 模型限定及中英文界面；实测新增控件相邻间距均 ≥8px，已截图自查。
- 手动启动 `server-editor/serve.py --blank --no-open --no-waveform --port 0` 成功，绑定 `127.0.0.1`；生成工程经真实 Chromium 文件输入载入 Server，2 条字幕与 items 毫秒时间正确，无页面脚本错误。该检查的对齐输出由假后端产生，不是模型声学质量证明。
- PR 按 Draft 提交，真实 ForcedAligner 推理、>10 分钟念稿听审和脏录音质量验收仍待有权重 / 素材的环境验证；CI 与打包不以本地单测替代。

## 同步 main 后的最终验证（2026-10-08）

已 rebase 到 `d4e5dff2`；README、CLI 和 CHANGELOG 冲突按 main 新结构逐项整合，其他任务代码保留。

- Python 全量：1849 项，23 跳过，0 失败；新功能 16 项独立测试再次通过。
- 指定 Node 编辑器语法 / 装配 / 工具 / 波形回归：370 项全部通过。
- Playwright 新功能与 Launcher 交互：54 项全部通过；间距实测与截图已自查。
- Ruff 与 `git diff --check` 通过。
- `npm run typecheck`：TS2339，来自 main 新增的 `cueListPatch`。将 origin/main 对应六个源文件与 tsconfig 导出到临时目录后运行相同编译器，复现相同错误；本功能未改这些文件。旧基线类型检查通过不能替代此结果。
