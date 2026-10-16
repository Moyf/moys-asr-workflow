# 子代理调查报告：去空隙导出卡顿（#29）

只读子代理调查（2026-10-15，含 FFmpeg 官方文档与 LosslessCut 资料核对），主会话抽查核对
（`serve.py:586-590` 的 `-f concat … -c copy` 命令、`:450-465` ffconcat 清单、导出链路零关键帧
处理、测试夹具 `-g 1` 全 intra 自认规避 GOP 行为）全部吻合后并入账本。
file:line 以核对时 HEAD `1d961b90` 为准。

## 1. 现状实现全景（三条并行链路，视频主链路为 Server Editor 导出）

### 1a. Server Editor「去空隙重组后视频」（主链路）

- UI 入口：`web/editor-template.html:103`、`web/editor/io/editor-wiring-export-actions.js:431`。
- 保留区间来源（客户端）：`editor-wiring-export-actions.js:466` → `editor-export-srt.js:116-133`
  `gapRemovedExportContext()` → `web/shared/gap-remove-core.js:1394-1406` `buildGapRemovedIntervals()`。
  **切点 = 静音 gap 边界的原始毫秒值取补集，完全没有关键帧信息**。
- 提交：`:488` 转 `{startMs, endMs}`，`:675-680` POST `/api/exports/gap-removed-video/jobs`
  （后台 MediaJob）或 `:713-723` 旧同步路由。
- 服务端：`server-editor/serve.py:2285-2292` → `start_gap_removed_video_job`（:2576-2631）与
  `export_gap_removed_video`（:2699-2745）；区间校验 `normalize_gap_removed_intervals`
  （:424-447，上限 `MAX_GAP_REMOVED_INTERVALS = 100_000`）。
- FFmpeg 命令构造 `rebuild_gap_removed_video`（serve.py:555-638）：
  - **ffconcat 清单**：`_gap_removed_ffconcat_text`（:450-465）——每区间
    `file '<源文件>'` + `inpoint <…>` + `outpoint <…>`；in/out 加容器 `format.start_time` 偏移
    （:460-463，probe 于 :520-535）。清单写到输出旁 `.ffconcat`（:581-585）。同源文件按区间重复引用。
  - **命令**（:586-590）：`ffmpeg -y -nostdin -hide_banner -loglevel error -f concat -safe 0
    -i <清单> -map 0 -c copy`。
  - **结论**：纯 `-c copy` 流复制（音视频均不重编码）；**切割点不对齐关键帧**（全仓导出链路
    零关键帧查询）；拼接 = concat demuxer + ffconcat 清单；**无任何时间戳治理参数**
    （无 `-avoid_negative_ts`/`-fflags +genpts`/`-copyts`）；音频 AAC 原始包直接复制；
    容器强制与源一致（:571-572），无 `-movflags`。
  - 每流附加：HEVC 加 `-bsf hevc_mp4toannexb`（:598-599）；恢复 disposition/language/title
    元数据；导出后校验流签名一致（:630、:635-637、:539-552）。

### 1b. Launcher 工具箱「媒体重组」（外部 .ffconcat 入口）

- `web/launcher/postprocess.js:2489` → `maw/gui_web.py:1496-1516` → `maw/postprocess_ffmpeg.py:189-242`。
  同样 `-f concat … -c copy`，无关键帧处理、无时间戳参数；清单校验 `parse_ffconcat`
  （:152-186）。编辑器导出的 .ffconcat 文件路径（`buildFfconcat`，export-workflow.js:35-48）
  **不加** start_time 偏移（与 serve.py:462-463 不同）。

### 1c. 音频重组（对照组，样本精确）

- `maw/media_export_audio.py:165-274`：整轨解码 PCM（:213-218）、毫秒→样本（:208-209）、
  字节级拼接（:241-257）、自建 WAV 头（:137-162）。**音频不受关键帧影响——问题只在视频链路**。

## 2. 卡顿成因分析（FFmpeg 官方文档背书）

concat demuxer 官方文档（doc/demuxers.texi）：对非 intra 编码，`inpoint` 通常会多出 inpoint 之前
的包（seek 回退到前关键帧）；「packets before the In point 的 timestamps 会小于该段计算出的起始
时间戳」→「两个拼接文件之间 packet timestamps 可能重叠」；`outpoint` 侧同样会溢出。

逐条对应：

1. **切点任意、非关键帧**：区间来自静音边界，原样透传进清单（:450-465）。每个 `inpoint` 落在
   GOP 中间 → demuxer 回退到**前一个关键帧**，多出 `[前关键帧, inpoint)` 一整个 GOP 尾部的包。
2. **`-c copy`（:589）**：这些提前包被映射到小于该段名义起点的时间戳 → 每个拼接点两侧时间戳
   **重叠甚至倒退**（被删空隙短于 GOP 时直接与上一段尾部重叠重复播放）。
3. **无时间戳治理**（:586-608）→ muxer 在拼接点遇到 non-monotonic DTS，输出 stts 折叠/回退 →
   播放器丢帧或停住。**卡顿时长 ≈ 切点回退到前关键帧的距离（GOP 长度，常见 2–10s），随拼接点
   数量累积**——与「播放到中间整段卡住好几秒」完全吻合。
4. **次因 A/V 错位**：视频回退一整个 GOP，AAC 音频包约 21ms 几乎精确落点 → 每个拼接点引入
   最多一个 GOP 的音画错位。
5. **次因 解码器等待**：pre-inpoint 包被裁掉的路径下段首非关键帧 → 解码器无参考帧，冻结到
   下一关键帧（≤1 GOP）。同根：**切点不落关键帧 + 纯流复制**。

旁证：项目 UI 文案已承认——「流复制切点可能出现重复帧或时间戳边界」（editor-i18n.js:503/:1333）、
「切点可能受关键帧影响」（editor-wiring-export-actions.js:498）。LosslessCut 不卡的根本原因是
默认把切点对齐关键帧；MAW 没有做任何对齐。`-bsf hevc_mp4toannexb` 与本卡顿无关。

## 3. LosslessCut 方案对照

- **Keyframe cut（默认且推荐）**：起始切点回退到最近**前**关键帧（`-ss` 前置）；全程无损，
  代价是切点内容偏差（可能多出几秒）。
- **Normal cut**：`-ss` 后置精确切，段首可能非关键帧 → 冻结/坏帧。**MAW 现状 ≈ 对每区间
  Normal cut 再拼接，且无任何关键帧处理。**
- **Smart cut（实验性，issue #126）**：切点重编码到段内第一个关键帧的小头 + 其余流复制再拼回；
  官方自标 experimental。
- 其他经验：`avoid_negative_ts` 只是排错选项；坏文件先 remux 统一参数。
- **结论：LosslessCut 不卡 = 默认保证每段从关键帧开始。MAW 需要补的正是这一步。**

## 4. 修复方向（按改动量从小到大）

**① inpoint 关键帧对齐（推荐首选；无损、改动最小）——与维护者接受的 MergeCuts/关键帧延伸一致**
- 导出前 ffprobe packet 级关键帧扫描（`-select_streams v -show_entries packet=pts_time,flags`，
  不解码、快），把每个区间 `inpoint` 向前吸附到最近关键帧（`outpoint` 可不动）。
- 改动面：仅 `rebuild_gap_removed_video`（serve.py:555）+ `_gap_removed_ffconcat_text`（:450-465）
  加吸附逻辑 + 一个探测 helper；流签名校验、客户端区间、去空隙字幕完全不动。
- 代价：每段开头含 ≤1 GOP 的被删空隙尾部（语音场景多为静音/换气，几乎不可感知）；输出时间线
  略长（需文档说明）。收益：每段关键帧开始 → 根除卡顿；保持同容器流复制契约。

**② Smart cut（中等偏大改动）**：每段 `[inpoint, 段内第一个关键帧)` 小头重编码 + 其余流复制；
需处理 PTS 衔接、进度/取消；对「整段卡住」症状属过度修复，适合后续「精确切点」增强。

**③ 整段重编码（最简单正确；代价最高）**：`-c copy` 换编码参数；需放宽流签名校验与同容器契约；
适合做 UI「兼容模式」。

**④ 音视频分策略（可与①组合）**：视频 inpoint 关键帧吸附 + 音频保持毫秒精确（样本级做法已在
`media_export_audio.py:208-209`），最后合 mux。代码路径翻倍；段头音画错位 ≤ GOP（多为静音画面）。

**不建议**：仅加 `-avoid_negative_ts`/`-fflags +genpts`——只止痛，不解决重复内容与解码器等待。

## 5. 测试覆盖现状与补测建议

- 命令构造（mock）：`tests/test_local_editor_server.py:84-116`（断言 `-map 0`/`-c copy` 与
  inpoint/outpoint 文本）、`:140-187`（start_time 映射）、`:189-213`、`:215-298`、`:300-377`。
- 真实 ffmpeg：`tests/test_gap_removed_video_compatibility.py:53-123` 与
  `tests/test_gap_removed_media_jobs.py:343-387`。**关键盲区：两处夹具均用 `-g 1`（全 intra，
  compatibility.py:78、jobs.py:355，注释自认隔离 GOP seek 行为）——长 GOP 真实样本（卡顿场景）
  零覆盖。**
- 工具箱 ffconcat：`tests/test_postprocess.py:2860-2955`。任务生命周期：`test_gap_removed_media_jobs.py`
  等。前端：`test_editor_utils.mjs:5892-5906`。e2e：gap-removed 系列 5 个 spec。
- **补测建议**：修复①落地时补一个真实长 GOP（如 `-g 250`）夹具，断言输出帧时间戳单调递增、
  拼接点无重复帧。
