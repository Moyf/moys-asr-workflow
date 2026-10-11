// 常量与状态：扩展名集合、存储键、state/dragState 及模块级可变句柄。

const SERVER_STARTING_TEXT = { zh: "启动中……", en: "Starting…" };
// 界面暂不开放时长上限，底层参数保留。
const SHOW_LENGTH_LIMIT_FIELD = false;

const MEDIA_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v", ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"]);
const SUBTITLE_BURN_EXTS = new Set([".srt", ".ass", ".ssa"]);
const PROJECT_EXTS = new Set([".mosp", ".json"]);
const SCRIPT_EXTS = new Set([".txt", ".md", ".markdown"]);
const ERROR_TEXT = {
  zh: {
    json_not_found: "工程文件不存在，请检查路径。",
    media_not_found: "媒体文件不存在，请重新选择。",
    server_media_missing: "工程无可用媒体，请手动选择媒体文件。",
    server_stop_not_maw: "当前端口上的进程不是 MAW 字幕编辑服务器，未执行停止。",
    server_stop_failed: "无法停止当前端口上的 MAW 字幕编辑服务器。",
    api_key_missing: "请填写 API Key，或先在 ⚙ 配置/密钥区保存。",
    custom_asr_base_url_missing: "请填写自定义 ASR Base URL。",
    custom_asr_model_missing: "请填写自定义 ASR 模型名。",
    openai_keywords_invalid: "OpenAI Keywords 不能包含 < 或 >。",
    openai_diarize_openrouter_unsupported: "OpenRouter 不支持 gpt-4o-transcribe-diarize，请改用 OpenAI 官方 Base URL。",
    deepseek_transcribe_unsupported: "🐳 蓝色大肥鱼不支持语音转写，它是个文本模型！\n不过你可以在「AI处理」中使用它来翻译啥的。",
    local_runtime_missing: "本地模型运行时未安装。请先安装本地 ASR 依赖。",
    local_runtime_install_failed: (detail) => `本地运行环境安装失败：${detail || "请查看日志后重试。"}`,
    local_runtime_cancelled: "本地运行环境安装已取消。",
    local_model_missing: "尚未检测到本地模型，请先点击“下载模型”或选择已有模型目录。",
    local_model_incomplete: "本地模型不完整，请先准备缺少的模型组件。",
    firered_punc_missing: "FireRed 的 ct-punc 尚未准备，请选择“不使用”或先下载 ct-punc。",
    local_model_path_invalid: "本地模型目录不存在，或所选路径不是文件夹。",
  local_model_path_mismatch: "当前模型目录看起来属于另一种本地模型，请清空后重新选择。",
  model_cache_path_invalid: "模型缓存目录不能是一个文件。",
    local_prepare_running: "本地模型正在准备中，请等待完成。",
    local_prepare_failed: (detail) => `本地模型准备失败：${detail || "请查看日志。"}`,
    ocr_runtime_missing: "OCR 支持尚未安装。请打开设置下载安装。",
    ocr_runtime_install_failed: (detail) => `OCR 运行环境安装失败：${detail || "请查看日志后重试。"}`,
    ocr_runtime_cancelled: "OCR 运行环境安装已取消。",
    ocr_model_missing: "OCR 模型尚未安装。请打开设置下载安装。",
    ocr_runtime_path_invalid: "OCR 运行环境路径不能是一个文件。",
  local_runtime_path_invalid: "本地运行环境路径不能是一个文件。",
    local_runtime_path_non_ascii: "路径包含中文或其他非 ASCII 字符，本地运行时无法在该目录安装；请改用纯英文、数字的路径。",
    workspace_missing: "新加坡地域需要 Workspace ID。",
    context_too_long: "Qwen-Audio 上下文最多 400 个字符。",
    soniox_context_too_long: "Soniox 上下文约限制为 10000 个字符。",
    soniox_context_invalid: "Soniox 上下文格式不正确，请检查高级设置中的填写格式。",
    postprocess_config_invalid: (detail) => `自动后处理配置不完整：${detail || "请打开工具箱完成配置。"}`,
    postprocess_provider_response: (detail) => `后处理服务已返回 HTTP 错误，这不是网络中断；原始转写仍然保留，可从失败步骤重试。${detail ? ` 详细信息：${detail}` : ""}`,
    postprocess_failed: (detail) => `转写已完成，但自动后处理失败；原始转写仍然保留，可从失败步骤重试：${detail || "请查看日志。"}`,
    subtitle_invalid: (detail) => `字幕或工程解析失败：${detail || "请检查输入文件格式和时间码，或重新导出字幕。"}`,
    script_invalid: (detail) => `文稿解析失败：${detail || "请检查文稿是否为 UTF-8 编码的 .txt / .md / .markdown 文件。"}`,
    match_too_low: (_detail, context) => `文稿与字幕匹配度过低（${Number.isFinite(Number(context?.matchRate)) ? `${Math.round(Number(context.matchRate))}%` : "低于安全阈值"}）；至少需要较短文本的 ${Number.isFinite(Number(context?.minimumMatchRate)) ? `${Math.round(Number(context.minimumMatchRate))}%` : "55%"} 匹配。`,
    match_invalid: (detail) => `无法完成文稿匹配：${detail || "请检查文稿、字幕和断句设置。"}`,
    postprocess_cancelled: "自动后处理已取消，原始转写产物仍然保留。",
    waveform_unavailable: (detail) => `无法从该媒体生成可用波形：${detail || "请检查 FFmpeg 和媒体文件。"}`,
    waveform_generation_failed: (detail) => `波形工程生成失败：${detail || "请检查媒体与输出目录权限。"}`,
    media_tool_busy: "已有媒体工具正在运行，请等待完成。",
    media_tool_cancelled: "媒体处理已取消。",
    media_tool_failed: (detail) => `媒体处理失败：${detail || "请检查 FFmpeg 和输入文件。"}`,
    audio_track_invalid: "所选音轨无效，请重新选择。",
    audio_tracks_missing: "没有检测到可用音轨。",
    audio_tracks_unavailable: (detail) => `无法读取音轨：${detail || "请检查 FFprobe 和媒体文件。"}`,
    hotwords_file_missing: "请选择存在且为 UTF-8 编码的 .txt 热词文件。",
    output_missing: "请填写 SRT 输出路径。",
    segmentation_invalid: "断句参数无效：请输入整数，并确保单句上限不小于短句合并值。",
    ffmpeg_missing: "未找到 FFmpeg / FFprobe，无法读取媒体。请下载不带 lite 的完整 MAW；或在“配置 → FFmpeg”选择同时包含 ffmpeg.exe 和 ffprobe.exe 的 bin 目录。",
    ffmpeg_start_failed: "FFmpeg 被 Windows 阻止启动。请退出 MAW，对下载的 ZIP 解除锁定后重新完整解压，并检查 Windows 安全中心的拦截记录。",
    intermediate_path_too_long: "中间文件创建失败：文件名或路径过长。请缩短原文件名，或将文件移到更浅的目录，重新选择文件后重试。已有转写产物仍保留。",
    file_path_too_long: "文件创建或访问失败：文件名或路径过长。请缩短原文件名，或将文件移到更浅的目录，重新选择文件后重试。",
    intermediate_file_failed: "中间文件创建或写入失败。请检查目录权限、剩余磁盘空间和文件占用后重试；已有产物仍保留。",
    file_write_failed: "文件创建或写入失败。请检查目录权限、剩余磁盘空间和文件占用后重试。",
    transcription_failed: "转写失败，本次任务已停止。请查看日志后修正问题，再重新尝试。",
    transcription_cancelled: "转写已停止。",
    ffprobe_start_failed: "FFprobe 被 Windows 阻止启动。请退出 MAW，对下载的 ZIP 解除锁定后重新完整解压，并检查 Windows 安全中心的拦截记录。",
    config_save_failed: (detail) => `无法保存本地配置：${detail || "请检查应用数据目录权限后重试。"}`,
    server_no_response: (detail) => `编辑器服务器没有响应（${detail || "http://127.0.0.1"}）——端口可能被占用，请检查端口后重试。`,
    server_start_failed: (detail) => `编辑器服务器启动失败：${detail || "请查看下方日志。"}`,
    alignment_server_no_response: (detail) => `口播对齐 Server 没有响应：${detail || "请重试。"}`,
    alignment_server_start_failed: (detail) => `口播对齐 Server 启动失败：${detail || "请查看日志后重试。"}`,
    sticker_dir_invalid: "表情包根目录不存在。",
    postprocess_connection_failed: (detail) => `大模型连接测试失败：${detail || "请检查 API Key、API 地址和网络连接。"}`,
    postprocess_models_failed: (detail) => `获取模型列表失败：${detail || "请检查 API Key 和 API 地址是否正确。"}`,
    batch_items_invalid: "批量任务中存在无效项目，请检查媒体文件路径。",
    batch_item_invalid: "该批量项目无效，请检查媒体文件路径。",
    batch_items_required: "请添加至少一个批量任务项目。",
    script_preview_failed: (detail) => `脚本预览失败：${detail || "请检查脚本文件格式。"}`,
    script_preview_missing: "请先选择脚本文件。",
    alignment_media_invalid: "口播对齐的媒体文件不存在或格式不支持。",
    alignment_project_invalid: "口播对齐需要有效的 .mosp 或 .json 工程文件。",
    alignment_script_missing: "口播对齐需要有效的脚本文件。",
    invalid_reasoning_mode: (detail) => `推理模式设置无效：${detail || "请检查后处理配置。"}`,
  },
  en: {
    json_not_found: "Project file does not exist. Check the path.",
    media_not_found: "Media file does not exist. Choose it again.",
    server_media_missing: "The project has no usable media. Choose the media file manually.",
    server_stop_not_maw: "The current port is not used by a MAW subtitle editor server, so it was not stopped.",
    server_stop_failed: "Unable to stop the MAW subtitle editor server on the current port.",
    api_key_missing: "Enter an API Key, or save one first in Settings / API key.",
    custom_asr_base_url_missing: "Enter a custom ASR Base URL.",
    custom_asr_model_missing: "Enter a custom ASR model name.",
    openai_keywords_invalid: "OpenAI Keywords cannot contain < or >.",
    openai_diarize_openrouter_unsupported: "OpenRouter does not support gpt-4o-transcribe-diarize. Switch to the official OpenAI Base URL.",
    deepseek_transcribe_unsupported: "🐳 The big blue fish cannot transcribe audio — it's a text model!\nBut you can use it for translation in the AI Processing (toolbox) panel.",
    local_runtime_missing: "The local ASR runtime is not installed. Install the local dependencies first.",
    local_runtime_install_failed: (detail) => `Local runtime installation failed: ${detail || "check the log and retry."}`,
    local_runtime_cancelled: "Local runtime installation was cancelled.",
    local_model_missing: "No local model was detected. Download it or choose an existing model folder.",
    local_model_incomplete: "The local model is incomplete. Prepare the missing components first.",
    firered_punc_missing: "FireRed ct-punc is not ready. Choose \"Do not use\" or download ct-punc first.",
    local_model_path_invalid: "The local model folder does not exist or is not a folder.",
  local_model_path_mismatch: "This model folder appears to belong to a different local model. Clear it and choose the correct folder.",
  model_cache_path_invalid: "The model storage path cannot point to a file.",
    local_prepare_running: "The local model is being prepared. Please wait.",
    local_prepare_failed: (detail) => `Local model preparation failed: ${detail || "check the log."}`,
    ocr_runtime_missing: "OCR support is not installed. Open Settings to download it.",
    ocr_runtime_install_failed: (detail) => `OCR runtime installation failed: ${detail || "check the log and retry."}`,
    ocr_runtime_cancelled: "OCR runtime installation was cancelled.",
    ocr_model_missing: "The OCR model is not installed. Open Settings to download it.",
    ocr_runtime_path_invalid: "The OCR runtime path cannot point to a file.",
  local_runtime_path_invalid: "The local runtime path cannot point to a file.",
    local_runtime_path_non_ascii: "The path contains non-ASCII characters (such as Chinese); the local runtime cannot be installed there. Use a path with ASCII characters only.",
    workspace_missing: "Singapore region requires a Workspace ID.",
    context_too_long: "Qwen-Audio context is limited to 400 characters.",
    soniox_context_too_long: "Soniox context is limited to approximately 10,000 characters.",
    postprocess_config_invalid: (detail) => `Automatic post-processing is not configured: ${detail || "open the toolbox to finish setup."}`,
    postprocess_provider_response: (detail) => `The post-processing provider returned an HTTP error; this is not a network outage. The original transcription remains available, and you can retry from the failed step.${detail ? ` Details: ${detail}` : ""}`,
    subtitle_invalid: (detail) => `The subtitle or project could not be parsed: ${detail || "check the input format and timecodes, or export it again."}`,
    script_invalid: (detail) => `The script could not be parsed: ${detail || "check that it is a UTF-8 .txt, .md, or .markdown file."}`,
    match_too_low: (_detail, context) => `Script and subtitle match coverage is too low (${Number.isFinite(Number(context?.matchRate)) ? `${Math.round(Number(context.matchRate))}%` : "below the safe threshold"}); at least ${Number.isFinite(Number(context?.minimumMatchRate)) ? `${Math.round(Number(context.minimumMatchRate))}%` : "55%"} of the shorter text must match.`,
    match_invalid: (detail) => `Unable to match the script: ${detail || "check the script, subtitles, and split settings."}`,
    waveform_unavailable: (detail) => `No usable waveform could be generated: ${detail || "check FFmpeg and the media file."}`,
    waveform_generation_failed: (detail) => `Waveform project generation failed: ${detail || "check the media and output-folder permissions."}`,
    media_tool_busy: "Another media operation is already running. Please wait for it to finish.",
    media_tool_cancelled: "Media operation cancelled.",
    media_tool_failed: (detail) => `Media operation failed: ${detail || "check FFmpeg and the input file."}`,
    audio_track_invalid: "The selected audio track is invalid. Choose it again.",
    audio_tracks_missing: "No usable audio tracks were found.",
    audio_tracks_unavailable: (detail) => `Audio tracks could not be read: ${detail || "check FFprobe and the media file."}`,
    postprocess_failed: (detail) => `Transcription completed, but automatic post-processing failed. The original transcription remains available, and you can retry from the failed step.${detail ? ` Details: ${detail}` : ""}`,
    postprocess_cancelled: "Automatic post-processing was cancelled; the original transcription remains available.",
    soniox_context_invalid: "Soniox context format is invalid. Check the Advanced options format.",
    hotwords_file_missing: "Choose an existing UTF-8 .txt hotword file.",
    output_missing: "Enter an SRT output path.",
    segmentation_invalid: "Invalid segmentation settings: enter integers and ensure max characters is at least the merge threshold.",
    ffmpeg_missing: "FFmpeg / FFprobe was not found, so the media cannot be read. Download the full MAW package (not lite), or choose a bin folder containing both tools in Settings → FFmpeg.",
    ffmpeg_start_failed: "Windows blocked FFmpeg from starting. Close MAW, unblock the downloaded ZIP, extract the complete package again, and check Windows Security protection history.",
    intermediate_path_too_long: "Could not create an intermediate file: the filename or path is too long. Shorten the source filename or move it to a shallower folder, select it again, and retry. Existing transcription files are preserved.",
    file_path_too_long: "Could not create or access a file: the filename or path is too long. Shorten the source filename or move it to a shallower folder, select it again, and retry.",
    intermediate_file_failed: "Could not create or write an intermediate file. Check folder permissions, free disk space, and whether another app is using the file, then retry. Existing outputs are preserved.",
    file_write_failed: "Could not create or write a file. Check folder permissions, free disk space, and whether another app is using the file, then retry.",
    transcription_failed: "Transcription failed and this run has stopped. Check the log, fix the problem, and retry.",
    transcription_cancelled: "Transcription stopped.",
    ffprobe_start_failed: "Windows blocked FFprobe from starting. Close MAW, unblock the downloaded ZIP, extract the complete package again, and check Windows Security protection history.",
    config_save_failed: (detail) => `Could not save local configuration: ${detail || "check the app-data directory permissions and try again."}`,
    server_no_response: (detail) => `The editor server did not respond (${detail || "http://127.0.0.1"}). The port may be occupied; check the port and retry.`,
    server_start_failed: (detail) => `The editor server failed to start: ${detail || "check the logs below."}`,
    alignment_server_no_response: (detail) => `The speech-alignment server did not respond: ${detail || "retry the operation."}`,
    alignment_server_start_failed: (detail) => `The speech-alignment server failed to start: ${detail || "check the log and retry."}`,
    sticker_dir_invalid: "Sticker root directory does not exist.",
    postprocess_connection_failed: (detail) => `LLM connection test failed: ${detail || "check the API key, URL, and network."}`,
    postprocess_models_failed: (detail) => `Failed to get model list: ${detail || "check the API key and URL."}`,
    batch_items_invalid: "Some batch items are invalid. Check the media file paths.",
    batch_item_invalid: "This batch item is invalid. Check the media file path.",
    batch_items_required: "Add at least one batch item.",
    script_preview_failed: (detail) => `Script preview failed: ${detail || "check the script file format."}`,
    script_preview_missing: "Choose a script file first.",
    alignment_media_invalid: "The speech-alignment media file does not exist or is unsupported.",
    alignment_project_invalid: "Speech alignment requires a valid .mosp or .json project.",
    alignment_script_missing: "Speech alignment requires a valid script file.",
    invalid_reasoning_mode: (detail) => `Invalid reasoning mode: ${detail || "check the post-processing settings."}`,
  }
};
Object.assign(ERROR_TEXT.zh, {
  alignment_model_missing: "对齐模型尚未下载，请先下载对齐模型。",
  alignment_model_incomplete: "对齐模型文件不完整，请重新下载或选择正确的模型目录。",
  alignment_model_path_invalid: "对齐模型目录不存在，或缺少有效模型文件。",
  alignment_prepare_running: "对齐模型正在准备中，请等待完成。",
  alignment_prepare_failed: (detail) => `对齐模型准备失败：${detail || "请查看日志后重试。"}`,
  alignment_failed: (detail) => `字词时间码生成失败：${detail || "请检查媒体、字幕文本和对齐模型。"}`,
});
Object.assign(ERROR_TEXT.en, {
  alignment_model_missing: "The aligner is not downloaded. Download it first.",
  alignment_model_incomplete: "The aligner files are incomplete. Download it again or choose the correct model folder.",
  alignment_model_path_invalid: "The aligner folder does not exist or has no valid model files.",
  alignment_prepare_running: "The aligner is being prepared. Please wait.",
  alignment_prepare_failed: (detail) => `Aligner preparation failed: ${detail || "check the log and retry."}`,
  alignment_failed: (detail) => `Word/character timestamp generation failed: ${detail || "check the media, subtitle text, and aligner."}`,
});
Object.assign(STRINGS.zh, {
  start_server_editor: "🎬 打开编辑器",
  toolbox_chain_hint: "每次生成新文件，并自动作为下一步输入；选择工具后运行。",
  error_notice_title: "任务未完成",
  error_notice_close: "关闭提示",
  error_open_ffmpeg_settings: "FFmpeg 配置项",
  error_open_faq: "查看常见问题",
  error_open_faq_failed: "无法打开常见问题，请查看下方日志。",
  error_open_issue: "打开项目主页",
  error_open_issue_failed: "无法打开项目主页，请检查网络并查看下方日志。",
  error_copy_report: "复制错误报告",
  error_copy_report_success: "已复制",
  error_copy_report_failed: "复制失败，请手动复制日志。",
});
Object.assign(STRINGS.en, {
  start_server_editor: "🎬 Open editor",
  toolbox_chain_hint: "Choose a tool to run; each run creates a new file and uses it as the next input.",
  error_notice_title: "Task not completed",
  error_notice_close: "Dismiss message",
  error_open_ffmpeg_settings: "FFmpeg settings",
  error_open_faq: "View FAQ",
  error_open_faq_failed: "Could not open the FAQ. Check the log below.",
  error_open_issue: "Open project homepage",
  error_open_issue_failed: "Could not open the project homepage. Check your connection and the log below.",
  error_copy_report: "Copy error report",
  error_copy_report_success: "Copied",
  error_copy_report_failed: "Copy failed; please copy the log manually.",
});
Object.assign(STRINGS.zh, {
  toolbox_alignment_hint: "适合初版 ASR 中有口吃、重录、重复或顺序混乱的口播；需要 MAW 工程和校对文稿，人工选择 take 后导出新工程。",
  toolbox_alignment_input_project: "MAW 工程",
  toolbox_alignment_project_hint: "默认跟随当前 Launcher 工程；口播对齐需要 MAW 工程中的 ASR 时间码，不能只使用 SRT。",
  toolbox_alignment_input_script: "校对文稿",
  toolbox_alignment_script_placeholder: "选择或拖入 UTF-8 .txt / .md 校对文稿",
  toolbox_alignment_script_hint: "每个非空行视为一行校对文稿。",
  toolbox_alignment_gap_heading: "自动标记静音",
  toolbox_alignment_gap_hint: "仅作用于口播对齐导出的自动空隙；与 MAWE 设置分开保存。",
  toolbox_alignment_gap_minimum: "最短静音（ms）",
  toolbox_alignment_gap_minimum_hint: "短于此值的静音不处理。",
  toolbox_alignment_gap_threshold: "音量阈值（dB）",
  toolbox_alignment_gap_threshold_hint: "达到此音量才算有声。",
  toolbox_alignment_gap_lead_in: "句首保留（ms）",
  toolbox_alignment_gap_lead_in_hint: "每段空隙开头保留的静音，避免上一句收尾被切掉。",
  toolbox_alignment_gap_lead_out: "句尾保留（ms）",
  toolbox_alignment_gap_lead_out_hint: "每段空隙结尾保留的静音，避免下一句贴得太紧。",
  toolbox_alignment_gap_hysteresis: "滞回（dB）",
  toolbox_alignment_gap_hysteresis_hint: "恢复静音需低于阈值；建议 1–3dB。",
});
Object.assign(STRINGS.en, {
  toolbox_alignment_hint: "For rough first-pass ASR with stutters, retakes, repeats, or reordered speech. Requires a MAW project and proofreading script; choose takes manually, then export a new project.",
  toolbox_alignment_input_project: "MAW project",
  toolbox_alignment_project_hint: "Follows the current Launcher project by default; speech alignment needs ASR timestamps from a MAW project and cannot use SRT alone.",
  toolbox_alignment_input_script: "Proofreading script",
  toolbox_alignment_script_placeholder: "Choose or drop a UTF-8 .txt / .md proofreading script",
  toolbox_alignment_script_hint: "Each non-empty line is treated as one proofreading-script line.",
  toolbox_alignment_gap_heading: "Auto-mark silence",
  toolbox_alignment_gap_hint: "Applies only to gaps generated during speech-alignment export; saved separately from MAWE settings.",
  toolbox_alignment_gap_minimum: "Minimum silence (ms)",
  toolbox_alignment_gap_minimum_hint: "Silence shorter than this is ignored.",
  toolbox_alignment_gap_threshold: "Volume threshold (dB)",
  toolbox_alignment_gap_threshold_hint: "A level at or above this counts as speech.",
  toolbox_alignment_gap_lead_in: "Keep at line start (ms)",
  toolbox_alignment_gap_lead_in_hint: "Silence kept at each gap start so the previous line is not cut too tightly.",
  toolbox_alignment_gap_lead_out: "Keep at line end (ms)",
  toolbox_alignment_gap_lead_out_hint: "Silence kept at each gap end so the next line is not cut too tightly.",
  toolbox_alignment_gap_hysteresis: "Hysteresis (dB)",
  toolbox_alignment_gap_hysteresis_hint: "The level must fall below the threshold to close the gate; 1–3 dB is a good starting range.",
});

const HOME_URL = "https://github.com/Moyf/moys-asr-workflow";
const TUTORIAL_VIDEO_URL = "https://www.bilibili.com/video/BV1S9bZ6pEHg";
const LAST_MODEL_KEY = "MAW_GUI_LAST_MODEL";
const LAST_LANGUAGE_KEY = "MAW_GUI_LAST_LANGUAGE";
const ZOOM_PERCENT_KEY = "MAW_GUI_ZOOM_PERCENT";
const ZOOM_DEFAULT = 100;
const ZOOM_STEP = 5;
const ZOOM_MIN = 80;
const ZOOM_MAX = 150;
const THEME_KEY = "MAW_GUI_THEME";
const $ = (id) => document.getElementById(id);
const HOTWORD_WEIGHTS = new Set([1, 2, 3, 4, 5, 50]);
const MAX_HOTWORDS = 2000;
const MAX_SUPER_HOTWORDS = 50;
const OPENAI_ASR_CUSTOM_MODEL_ID = "custom-asr";
const OPENAI_ASR_OFFICIAL_MODEL_IDS = new Set(["whisper-1", "gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-transcribe-diarize", "whisper-large-v3-turbo", "whisper-large-v3"]);
const SERVER_STATUS_MONITOR_INTERVAL_MS = 2000;
const SERVER_STATUS_MONITOR_FAILURE_THRESHOLD = 2;
const state = { lang: "zh", serverRunning: false, serverStarting: false, serverStopping: false, serverProjectPath: "", running: false, localPreparing: false, localProgressMessage: "", localProgress: null, localModelId: "", localModelPaths: {}, alignmentPreparing: "", alignmentProgressMessage: "", alignmentModelSelection: "", alignmentModelManagementId: "", localRuntimeInstalling: false, localRuntimeProgress: 0, localRuntimeProgressMessage: "", localRuntimeInventoryOpen: false, localRuntimeInventory: null, localRuntimeInventoryError: "", ocrRuntimeInstalling: false, ocrRuntimeProgress: 0, ocrRuntimeProgressMessage: "", lastLogMessage: "", result: null, errorReport: null, errorCopyTimer: 0, config: null, srtAuto: true, testSuffixAdded: false, serverMediaOk: false, detectedServerUrl: "", dropTarget: "", theme: "system", toolboxBusy: false, toolboxOpen: false, audioTracks: [], audioTrack: null, audioTrackPath: "", audioTrackProbeToken: 0, audioTrackProbeTimer: 0, batchNotification: null };
const dragState = { depth: 0 };
let api = null;
let prefsTimer = 0;
let pendingPrefs = {};
let defaultOutputRequest = 0;
let ffmpegRequest = 0;
let serverStatusRequest = 0;
let serverStatusMonitorTimer = 0;
let serverStatusMonitorInFlight = false;
let serverStatusMonitorEnabled = false;
let serverStatusMonitorFailureCount = 0;
let serverStatusMonitorState = "idle";
// 服务器断开时记录当时的工程路径；之后点击「启动字幕编辑器」若工程未变，
// 说明用户的编辑器页面大概率还开着（可能有未保存内容），重启后只更新提示、
// 不再重复打开新页面。null 表示当前没有待处理的断线重启场景。
let serverRestartProjectPath = null;
let ocrRuntimeRequest = 0;
let localRuntimeRequest = 0;
let localModelsRequest = 0;
let alignmentModelsRequest = 0;
// Runtime and model checks both update localRuntime.  A single revision
// prevents an older request of either kind from putting stale status back
// after a newer check has already completed.
let localStatusRequest = 0;
let activeSettingsTab = "general";
