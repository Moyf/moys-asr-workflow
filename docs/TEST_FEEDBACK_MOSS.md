# 本地引擎分段整理失效反馈记录（MOSS / 共享层）

来源：用户 2026-08-27 实测反馈。使用本地 MOSS（MOSS-Transcribe-Diarize）转写后：

1. 标点符号拆分不生效，一句长文本留在同一条字幕里。
2. 配置「字数上限 15」不生效，仍出现超长字幕；第二次把「停顿切句（间隔）」从 1500 改成 300，两版字幕几乎完全一致。
3. 「去除结尾句号」未去除。

## 处理清单

| 编号 | 范围 | 需求摘要 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | maw/local_asr.py | `build_local_segments` 在引擎自带 segments 时忽略 max_len / min_len / gap_split_ms（Qwen3-ASR、FunASR、MOSS 三个本地引擎全部命中）| 修改 | 已修复 |
| 2 | maw/local_asr.py | 粗粒度分段（MOSS 一句一项、FunASR 无词级时间戳回退）需要按字符权重估计子段时间后再重切 | 修改 | 已修复 |
| 3 | maw/local_asr.py | 本地管线补默认剥尾标点步骤（与云端 Qwen 版 rstrip("，。") 行为对齐） | 修改 | 已修复 |
| 附注 | docs/LOCAL_ASR.md | 用户追问确认：MOSS 输出契约无字词级时间码，仅段级 `[start][Sxx]text[end]` 一对时间戳；已写入文档说明估算语义与 ForcedAligner 后续可选项 | 仅说明 | 已修复 |

## 事实基线

- 开始时工作区已有多个并行任务的 WIP（`git status --short` 大量改动、`tests/test_moss_runtime.py` 含另一任务的 sys.platform mock）。本任务只改 `maw/local_asr.py`、`tests/test_local_asr.py` 与两份文档，不触碰其他文件。
- 根因确认：`build_local_segments`（maw/local_asr.py:974）只有当引擎未返回 segments 时才调用 `split_segments_auto(items, ...)`；三个本地引擎都返回 segments，因此 Launcher 的「最大字数 / 短句合并阈值 / 停顿切句（毫秒）」从未作用于本地输出——解释了"两次配置不同但输出几乎一致"。
- 尾标点剥离在云端管线是显式步骤（generate_subtitle_qwen_api.py:1763 起），本地管线从建立至今没有对应步骤。
- MOSS 分段粒度：`MossDiarizeEngine.transcribe` 每个 parse_transcript entry → 一个 item + 一个 segment，时间仅句级 start/end；文本内含中文标点。
- FunASR 有词/字级 timestamp 时 items 粒度足够细分；无 timestamp 回退时同样是"一句一大 item"。Qwen3-ASR 本地为词级 items。
- 修复方案：修在共享层 `build_local_segments`，三个本地引擎一并生效；不修改 `generate_subtitle_qwen_api.py` 云端管线。
  - 对超长且无可复用子级时间的 segment/item：按字符权重（CJK=1、其他=0.5）线性展开为虚拟字符 items，再交给既有 `split_segments_auto`（静音预切 + 强标点切句 + 短句合并 + 弱标点/jieba 拆长）重组；
  - 结果段回填 speaker（来自成员 item）；
  - 全分支统一默认剥尾标点（暂不加 `--keep-punct` 开关，保持与云端默认一致，如需开关另行立项）。

## 处理结论

- 根因：`build_local_segments` 只有当引擎未返回 segments 时才走 `split_segments_auto`；三个本地引擎都返回分段，「最大字数 / 短句合并阈值 / 停顿切句（毫秒）」从未作用于本地输出——与"两次配置不同但输出几乎一致"的现象吻合。尾标点剥离在云端管线是显式步骤，本地管线一直没有对应实现。
- 修在共享层，三个本地引擎一并生效；不修改 `generate_subtitle_qwen_api.py` 云端管线。
- 新增 `_resplit_engine_segment`：仅当分段文本超过 max_len 时触发重组，正常分段逐字节原样保留（词级真实时间戳仍优先、既有测试断言不变）。重组前先经 `_expand_coarse_item` 把"一句一大 item"按字符权重（CJK/数字=1，其他=0.5）线性插值为虚拟字符项，块首尾保持原始真实时间码；重组后由 `_segment_speaker` 回填段级说话人（MOSS 说话人分色依赖 `speaker` 字段），不受影响。
- 新增 `_strip_trailing_punct`：所有分支统一剥离每条字幕结尾的全角逗号/句号（同步清理末尾 items 文本），与云端默认一致；`！`、`？` 保留。暂不加 `--keep-punct` 开关，需要时另行立项。
- `min_len` 与 `gap_split_ms` 在重切路径内继续使用共享切句逻辑的原生语义（组内短句合并、静音预切）；引擎短分段之间的跨段合并维持原状，避免把 FunASR/MOSS 有意的 VAD/说话人边界粘连。

## 验证记录

分层记录：

1. **语法 / 单元测试**
   - `uv run python -m unittest tests.test_local_asr -v`：32 项通过，其中新增 `LocalSegmentationTuningTests` 5 项：
     - 超长 MOSS 式分段按标点拆为 ≤15 字的多条，speaker 回填、首尾真实时间保持、整数毫秒单调不重叠；
     - 尾部全角句号去除（文本 + 末 item 同步）；
     - 引擎短分段原样通过（起始/结束毫秒不变）；
     - 词级时间戳场景切分边界取真实时间码而非插值；
     - max_len=40 与 max_len=8 输出不同，证明参数生效。
   - `uv run python -m unittest discover -s tests -p "test_*.py"`：785 项通过（5 项跳过为原有平台条件跳过），确认三个引擎的存量行为测试未回归。
   - `node --check web\editor.js`、`web\waveform.js` 与 `node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs`：通过（本任务未改前端，属例行检查）。
2. **冒烟**：模拟用户场景（一条约 30 字含多种标点的中文句 + max_len=15 + gap_split=300）实际跑出 4 条连续字幕，验证拆分点、插值区间与 speaker 保持。
3. **CLI 参数链路核对**：`generate_subtitle_local.py` 存在 `--min-len`（默认 5）、`--gap-split`（默认 1000）；Launcher → `gui_web._segmentation_option` → `gui_workflow --max-len/--min-len/--gap-split` 全链路已在代码中核读确认。
4. **静态检查**：`uv run ruff check maw/local_asr.py tests/test_local_asr.py` 全部通过；本会话 LSP 诊断工具因工作目录解析异常不可用（绝对/相对路径均被拒绝），以 ruff + 测试套件覆盖同等检查面；改动文件复核无 CRLF，保持 UTF-8 + LF。
5. **`git diff --check`**：通过（重命名后复核重跑亦通过）。
6. **浏览器交互**：不涉及（未改 `web/`、无需重新生成 `blank-editor.html`）。

## 未验证边界 / 待办

- 真实 MOSS 推理产物未经本机 GPU 环境复跑（开发机无该运行环境），上述验证基于 parse_transcript 产物的等价模拟输入；建议维护者在 Launcher 中用同一段媒体以 max_len=15 重跑一次比对。
- 子段时间估算假设"块内匀速"，语速剧烈起伏的段会有秒内偏差；如需精确可立项接入 Qwen3-ForcedAligner 强制对齐（上游查证：MOSS 无字词级时间码）。
- transformers 的 `feature_extractor_class` 弃用警告（用户先前反馈）：确认为上游 OpenMOSS 处理器声明方式触发的良性 warning_once 日志噪音，不影响功能；MAW 侧不作代码处理，待上游注册映射后自然消失。

## 2026-09 追问：MOSS 粗粒度时间码与英文切句配置

本节的新决定覆盖上文“按字符权重展开 MOSS 段”的历史行为；上文仅保留为旧反馈记录。

用户进一步确认：截图中的英文字幕被切到单词中间，且每条恰好约 13 个字符。核对结果是共享英文切句器的默认 `WESTERN_MAX_WORDS = 13`；此前 MOSS 适配器把每个段级时间码伪造成一个字符 item，导致“13 个词”实际被错误地解释成 13 个字符。MOSS 没有字词时间码，因此不能用这个边界安全地切字幕。

| 编号 | 范围 | 处理决定 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 4 | maw/local_asr.py | MOSS 只输出段级 `start/end/text`，删除虚拟字符 items；`timestamp_granularity` 标为 `segment`，`build_local_segments` 保留模型段，不再按字数硬切 | 修改 | 已修复 |
| 5 | maw/language.py、各转写器 `.mosp` 输出 | 统一语言别名为小写代码，并记录 `language_source`、`split_mode`、`timestamp_granularity`；没有语言数据时从脚本选择切句模式，拉丁文本默认单词型但语言保持未知 | 修改 | 已修复 |
| 6 | Launcher / GUI / CLI | 新增英文单词型 `--max-words`（默认 13）与 `--min-words`（默认 3），通过 Launcher → GUI 请求 → 生成器完整传递 | 修改 | 已修复 |
| 7 | docs/LOCAL_ASR.md、JSON_SCHEMA.md、docs/CLI.md | 补充 MOSS 无 items 语义、语言元数据契约、无语言时的回退规则及英文参数说明 | 文档 | 已修复 |
| 附注 | 生成器尾标点处理 | “保留符号”设置继续只影响转写后的尾标点剥除候选集，不改变切句标点；空集合仍表示禁用剥除 | 仅说明 | 已修复 |

### 本次验证记录

- 已完成静态语法检查：`python -m py_compile` 覆盖本次修改的 Python 文件，结果通过。
- `uv run --no-sync python -m unittest tests.test_language tests.test_local_asr tests.test_segmentation tests.test_openai_asr tests.test_project_contract tests.test_gui_workflow tests.test_gui_web`：393 个通过，1 个既有跳过项。
- 合并运行本地 Runtime、语言模块、ASR、Launcher、工程契约、打包和 BCut 回归：476 个通过，1 个跳过。
- 全量 Python 测试：1072 个中 1051 个通过、6 个失败、9 个错误、6 个跳过；剩余 15 个失败/错误均集中在本机 `reapeaks` 模块缺少 `ReapeaksStreamer`，以及因此无法生成 `.ReaPeaks` 的缓存断言，不涉及本次语言/切句改动。
- `uv run --no-sync python edit.py --blank`：成功生成 `blank-editor.html`，源码产物无额外 diff。
- 全量 Python 测试仍有既有本机 ReaPeaks 原生扩展环境失败（`reapeaks` 缺少 `ReapeaksStreamer`，以及由此导致的波形缓存断言）；不把这些失败归因于本次语言/切句改动。首次 `uv run` 还因 `.venv` 原生文件被占用而无法同步，因此验证使用 `--no-sync` 复用现有环境。
- Node 编辑器测试：通过 `MAW_TEST_PYTHON=C:\Python314\python.exe node --test tests\\test_editor_utils.mjs tests\\test_waveform_js.mjs`，254 个通过；默认测试命令内部调用 `uv` 时会撞到本机 `uv` 路径权限，因此使用显式标准库 Python 解释器完成 XML 辅助校验。`node --check web\\launcher\\launcher.js` 也已通过。
- 收口复核：`uv run --no-sync python -m unittest tests.test_tencent tests.test_cli` 的 20 项通过；本次修改涉及的 Python 文件重新 `py_compile` 通过，`git diff --check` 通过。

### 当前边界

- MOSS 仍只能提供模型返回的段级边界；不设置字数上限的行为是有意的，因为没有可信的词/字符时间码。若需要“最多 13 个词”这类严格限制，必须先接入强制对齐或其他字词级时间码来源。

### 2026-09 进度反馈

- MOSS 固定运行包提供输入准备和 token 回调；`MossDiarizeEngine` 已接入这两个回调，Launcher 日志会显示“音频特征已准备，开始生成转写”“已生成 N tokens”和“生成完成：共 N tokens”。
- 由于 MOSS 没有可预知的最终输出长度，进度条继续表示进行中状态，文本显示真实 token 计数，不把 `max_new_tokens` 上限误当成百分比总量。
- 状态：已修复；新增适配器回调测试通过，真实 GPU 推理仍需在用户环境中复核显示频率和首 token 等待体验。
