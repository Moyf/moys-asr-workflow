# PR #208：Launcher 波形与响度预研

## 结论

Launcher 在启动生成器时传入 `--with-waveform`，但各生成器实际在 ASR 与字幕整理之后才生成缓存。常见空文本错误在此之前退出，因此本次转写的波形无法普遍作为空结果诊断的前置证据。保持现有时序；本次未实现缓存读取或响度判定。

## 调用链核查

| 入口 | 当前源码执行顺序 |
| --- | --- |
| Launcher | `maw/gui_workflow.py:build_transcribe_command` 添加波形参数；`run_transcription` 等待子进程，随后检查有效字幕，之后才执行后处理与可选 HTML 输出 |
| Qwen | `generate_subtitle_qwen_api.py`：`transcribe` → 空文本错误 / 字幕整理 → `embed_media_caches` |
| Soniox | `generate_subtitle_soniox_api.py`：ASR → 空文本错误 / 字幕整理 → `embed_media_caches` |
| Doubao | `generate_subtitle_doubao_api.py`：ASR → 空文本错误 / 字幕整理 → `embed_media_caches` |
| Bcut | `generate_subtitle_bcut_api.py`：ASR → 空文本错误 / 字幕整理 → `embed_media_caches` |
| Tencent | `generate_subtitle_tencent_api.py`：ASR → 无文本时返回 2 → `embed_media_caches` |
| OpenAI | `generate_subtitle_openai_api.py`：ASR → 文本 / 字幕为空时失败 → `embed_media_caches` |
| 本地模型 | `generate_subtitle_local.py`：`engine.transcribe` → 字幕构造 → 无字幕时返回 1 → `write_local_outputs`；`maw/local_asr.py` 的输出阶段调用 `embed_media_caches` |

少数生成器可能在整理后写出空工程而仍生成缓存，Launcher 随后才拒绝空字幕；旧成功任务也可能留下缓存。这些例外不能保证每次失败都有缓存。

## 已有数据能提供什么

`maw/media_cache.py:embed_media_caches` 调用波形与 `.quapeaks` 生成流程，并记录选中音轨和实际源媒体信息。`maw/quapeaks.py:extract_loudness_stats` 返回 `moy.asr.loudness.v1`：包含音轨、声道、bin 数量、最大值、均值、RMS、p95 与来源，值是相对 full-scale 的线性 RMS，不是 dB、LUFS 或 true peak。关闭频谱时仍保留 loudness 层。

逐 bin 跨声道取最大值，可避免另一声道独有信号被忽略；非有限值会剔除。长片只在末尾说一句话时，均值和 p95 仍可能接近零，不能据此报告整轨无声。统计值也不能区分人声、游戏、音乐或噪音。

`load_loudness_stats` 已有选轨、媒体大小及时间戳匹配，缓存缺失、失效、损坏或没有该层时返回不可用。匹配依赖大小与时间戳，不是内容哈希。缓存读取与解析仍受缓存大小影响，本次未实测两小时缓存的读取耗时，不宣称固定成本。

轻量波形 fallback（`maw/waveform.py`）使用量化的 min/max 数据，不能把量化后零值当成严格静音；`.mopeaks` 也不能保证提供相同响度层。

## 后续可选方案（仅预研）

若以后需要辅助说明，可只尝试复用已存在、媒体与所选音轨匹配的缓存，缺失就跳过，绝不为错误提示重新生成波形。还须核对完整覆盖范围：全媒体统计不等于本次快速测试范围，不能把后段有声音推给只处理开头的任务；所有数据无效也不能当静音。即使证据有效，仍只适合说明缓存记录的信号强弱，不应判定选错轨或噪音过大。

当前用户要求的提示已经不依赖这些统计，因此不增加读取、扫描或解码开销。真实 OBS 素材、供应商返回与完整打包验收仍待维护者复核。
