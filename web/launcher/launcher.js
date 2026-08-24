(function () {
  "use strict";

  const STRINGS = {
    zh: { media_output: "1️⃣ 媒体与输出", recognition: "2️⃣ 识别设置", server: "5️⃣ 字幕编辑器设置", logs: "4️⃣ 日志", provider: "识别方式", test_run: "测试运行", test_run_title: "仅截取前2分钟内容，用于测试功能和 API", test_run_override: "测试运行已限定前 2 分钟", debug_raw: "调试运行（保存完整返回数据）", debug_raw_title: "额外保存 ASR 服务端返回的原始 JSON，便于排查断句、标点和时间码问题", hero_desc: "本地媒体 ➜ AI 转写 ➜ 可编辑字幕工程", project_home: "项目官网", media: "媒体文件", srt_output: "SRT 输出", choose: "选择", model: "模型", region: "地域", workspace: "工作空间 ID", language: "语言", length_limit: "时长上限", language_reset: "重置（自动识别）", language_multi_hint: "可多选；不选即自动识别（仅偏向，不限制）。", language_filter_hint: "默认仅显示常用语言，其余可在「配置」中开启。", settings_language: "语言", show_rare_langs: "显示相对小众的语言", show_rare_langs_hint: "开启后，「语言」列表显示供应商支持的全部语种；关闭时只显示 8 种常用语言。", key: "API Key", save_key: "存入本地环境", key_hint_prefix: "在", key_hint_suffix: "获取 API Key ↗", json_project: "工程文件", json_placeholder: "生成工程后会自动填入，也可以手动选择之前的工程", server_media: "服务器媒体（可选）", server_media_missing: "工程未记录媒体，或文件已移动，请手动选择。", flv_media_hint: "flv 无法预览，将会自动转换成 mp4 格式", port: "端口", advanced: "高级选项", open_mawe: "🎬 启动字幕编辑器", server_stop: "⏹️ 停止服务器", start: "✨ 生成字幕和工程", open_folder: "📁 打开输出文件夹", open_html: "打开 html 编辑器", open_blank_html: "打开 html 空模板", demo_mode: "演示模式", settings_title: "配置", settings_ffmpeg: "FFmpeg", settings_stickers: "默认表情包路径", stickers_explain: "表情包根目录供 HTML 编辑器使用；支持嵌套子目录（如 大狗/、Nox/ 等）。", current_value: "当前", unset: "未设置", sticker_dir: "表情包根目录", choose_folder: "选择文件夹", change: "更改", ffmpeg_found: "成功定位到 ffmpeg", ffmpeg_path: "FFmpeg 路径", ffmpeg_placeholder: "ffmpeg.exe / ffprobe.exe 所在 bin 目录，或 ffmpeg.exe", ffmpeg_help: "如何安装 FFmpeg ↗", ffmpeg_missing: "未找到 ffmpeg / ffprobe", ffmpeg_need: "需要依赖 ffmpeg 先将视频转成音频后才能发送给服务器转录", sticker_missing: "请选择一个存在的文件夹。", ready: "就绪", running: "转写中…", saved: "设置已保存", failed: "失败", done: "完成", key_empty: "未配置密钥", key_loaded: "已加载密钥 {key}", workspace_hint: "北京地域选填（推荐），新加坡地域必填。", other_language: "English", drop_hint: "拖入音频/视频文件，或点击选择。", drop_reject: "只支持音频、视频或工程文件。", media_required: "请选择存在的媒体文件。", output_required: "请填写 SRT 输出路径。", key_required: "请填写 API Key，或先保存到 .env。", workspace_required: "新加坡地域需要 Workspace ID。", json_required: "请选择工程文件后再打开 MAWE。", server_media_required: "工程没有可用媒体，请手动选择媒体文件。", speaker_colors: "给不同说话人分配字幕颜色", speaker_colors_hint: "最多 5 种颜色；说话人超过 5 个时颜色循环复用。", speaker_colors_title: "转写时按说话人自动着色（生成后仍可在编辑器修改）" },
    en: { media_output: "1️⃣ Media & Output", recognition: "2️⃣ Recognition Settings", server: "5️⃣ Subtitle Editor Settings", logs: "4️⃣ Logs", provider: "Recognition source", test_run: "Test run", test_run_title: "Trim to the first 2 minutes to test the workflow and API", test_run_override: "Test run is limited to the first 2 minutes", debug_raw: "Debug run (save full response)", debug_raw_title: "Also save the raw ASR service response as JSON for investigating segmentation, punctuation, and timestamps.", hero_desc: "Local media ➜ AI transcription ➜ Editable subtitle projects", project_home: "Project", media: "Media file", srt_output: "SRT output", choose: "Choose", model: "Model", region: "Region", workspace: "Workspace ID", language: "Language", length_limit: "Length limit", language_reset: "Reset (auto-detect)", language_multi_hint: "Multi-select; empty = auto (bias only).", language_filter_hint: "Only common languages are shown by default. Enable the rest in Settings.", settings_language: "Language", show_rare_langs: "Show less common languages", show_rare_langs_hint: "When enabled, the language list shows every supported language; otherwise it shows 8 common languages.", key: "API Key", save_key: "Save locally", key_hint_prefix: "Get an API Key from", key_hint_suffix: "↗", json_project: "Project file", json_placeholder: "Auto-filled after generation, or choose an earlier project", server_media: "Server media (optional)", server_media_missing: "The project has no media, or the file moved. Choose it again.", flv_media_hint: "flv cannot be previewed and will be converted to mp4 automatically", port: "Port", advanced: "Advanced options", open_mawe: "🎬 Launch Subtitle Editor", server_stop: "⏹️ Stop server", start: "✨ Generate subtitles & project", open_folder: "📁 Open output folder", open_html: "Open HTML editor", open_blank_html: "Open blank HTML template", demo_mode: "Demo mode", settings_title: "Settings", settings_ffmpeg: "FFmpeg", settings_stickers: "Default sticker path", stickers_explain: "Sticker root directory for the HTML editor; nested folders are supported.", current_value: "Current", unset: "Not set", sticker_dir: "Sticker root", choose_folder: "Choose folder", change: "Change", ffmpeg_found: "Located ffmpeg successfully", ffmpeg_path: "FFmpeg path", ffmpeg_placeholder: "bin directory containing ffmpeg/ffprobe, or ffmpeg executable", ffmpeg_help: "How to install FFmpeg ↗", ffmpeg_missing: "ffmpeg / ffprobe not found", ffmpeg_need: "ffmpeg is required to convert video to audio before sending it to the transcription server", sticker_missing: "Choose an existing folder.", ready: "Ready", running: "Running…", saved: "Settings saved", failed: "Failed", done: "Done", key_empty: "No key configured", key_loaded: "Loaded key {key}", workspace_hint: "Optional (recommended) for Beijing; required for Singapore.", other_language: "中文", drop_hint: "Drop an audio/video file here, or choose one.", drop_reject: "Only audio, video, or project files are supported.", media_required: "Choose an existing media file.", output_required: "Enter an SRT output path.", key_required: "Enter an API key, or save one to .env first.", workspace_required: "Workspace ID is required for Singapore.", json_required: "Choose a project file before opening MAWE.", server_media_required: "The project has no usable media. Choose media manually.", speaker_colors: "Assign subtitle colors to speakers", speaker_colors_hint: "Up to 5 colors; colors cycle when there are more than 5 speakers.", speaker_colors_title: "Color subtitles by speaker during transcription (editable afterwards)" }
  };
  Object.assign(STRINGS.zh, {
    test_run: "快速测试",
    test_run_title: "仅截取前2分钟内容，用于快速测试功能和 API",
    test_run_override: "快速测试已限定前 2 分钟",
    drop_reject_media: "仅支持以下媒体文件类型：\n{extensions}",
    output_collision: "检测到同名输出文件，为避免覆盖，生成的新文件已自动添加后缀。"
  });
  Object.assign(STRINGS.en, {
    test_run: "Quick test",
    test_run_title: "Trim to the first 2 minutes for a quick workflow and API test",
    test_run_override: "Quick test is limited to the first 2 minutes",
    drop_reject_media: "Only the following media file types are supported:\n{extensions}",
    output_collision: "An output file with the same name already exists. To avoid overwriting it, the new output has been given a suffix."
  });
  Object.assign(STRINGS.zh, {
    mode_label: "转写模式",
    mode_single: "单文件",
    mode_batch: "批量",
    mode_single_hint: "一次处理一个媒体文件。",
    mode_batch_hint: "按队列顺序逐个转写，所有文件共用识别设置。",
    batch_drop_zone: "拖入多个音频/视频文件，或点击添加。",
    batch_queue: "文件队列",
    batch_queue_label: "批量转写队列",
    batch_add: "添加文件",
    batch_clear: "清空",
    batch_drop_hint: "拖入多个音频/视频文件，或反复添加文件；所有文件共用下方识别设置。",
    batch_empty: "尚未添加媒体文件。",
    batch_rejected: "已忽略 {count} 个不支持的文件。",
    batch_duplicate: "文件已在当前列表内",
    batch_outcome_missing: "批量结束时未收到该文件的结果。",
    batch_manuscript_disabled: "批量模式不支持逐文件文稿映射。本次批量运行会跳过文稿匹配；单文件设置保持不变。",
    batch_start: "✨ 开始批量生成",
    batch_stop: "停止全部",
    batch_srt_only: "只生成 SRT 字幕",
    batch_skip_completed_confirm: "队列中有已处理完成的文件。是否跳过已处理完成的文件？",
    batch_confirm_title: "确认",
    batch_confirm_yes: "是",
    batch_confirm_no: "否",
    stop: "停止",
    batch_starting: "正在启动批量转写……",
    batch_running: "批量转写中……",
    batch_progress: "正在处理第 {current}/{total} 个文件：{name}",
    batch_item_done: "第 {index} 个文件处理完成：{name}",
    batch_item_failed: "第 {index} 个文件处理失败：{name}（详见上方“查看错误”）",
    batch_item_cancelled: "第 {index} 个文件已取消：{name}",
    batch_progress_done: "批量处理完成：成功 {done} 个，失败 {failed} 个。",
    batch_stopping: "正在停止批量转写……",
    batch_complete: "批量转写完成",
    batch_cancelled: "批量转写已停止",
    batch_status_queued: "等待中",
    batch_status_running: "转写中",
    batch_status_done: "已完成",
    batch_status_failed: "失败",
    batch_status_cancelled: "已取消",
    batch_status_skipped: "已跳过",
    batch_log_details: "查看日志",
    batch_error_details: "查看错误",
    batch_open_project: "打开工程",
    batch_open_folder: "打开文件夹",
    batch_remove: "移除",
  });
  Object.assign(STRINGS.en, {
    mode_label: "Transcription mode",
    mode_single: "Single file",
    mode_batch: "Batch",
    mode_single_hint: "Process one media file at a time.",
    mode_batch_hint: "Transcribe the queue sequentially with shared settings.",
    batch_drop_zone: "Drop multiple audio/video files, or click Add files.",
    batch_queue: "File queue",
    batch_queue_label: "Batch transcription queue",
    batch_add: "Add files",
    batch_clear: "Clear",
    batch_drop_hint: "Drop multiple audio/video files or add them repeatedly. Every file uses the shared recognition settings below.",
    batch_empty: "No media files added yet.",
    batch_rejected: "Ignored {count} unsupported file(s).",
    batch_duplicate: "The file is already in the current list.",
    batch_outcome_missing: "No result was reported for this file when the batch finished.",
    batch_manuscript_disabled: "Batch mode does not support per-file manuscript mapping. Script match is skipped for this batch; your single-file setting is unchanged.",
    batch_start: "✨ Generate batch",
    batch_stop: "Stop all",
    batch_srt_only: "Generate SRT subtitles only",
    batch_skip_completed_confirm: "Some files in the queue are already complete. Skip completed files?",
    batch_confirm_title: "Confirm",
    batch_confirm_yes: "Yes",
    batch_confirm_no: "No",
    stop: "Stop",
    batch_starting: "Starting batch transcription…",
    batch_running: "Batch transcription in progress…",
    batch_progress: "Processing file {current}/{total}: {name}",
    batch_item_done: "File {index} completed: {name}",
    batch_item_failed: "File {index} failed: {name} (see ‘View error’ above)",
    batch_item_cancelled: "File {index} cancelled: {name}",
    batch_progress_done: "Batch complete: {done} succeeded, {failed} failed.",
    batch_stopping: "Stopping batch transcription…",
    batch_complete: "Batch transcription complete",
    batch_cancelled: "Batch transcription stopped",
    batch_status_queued: "Queued",
    batch_status_running: "Transcribing",
    batch_status_done: "Done",
    batch_status_failed: "Failed",
    batch_status_cancelled: "Cancelled",
    batch_status_skipped: "Skipped",
    batch_log_details: "View log",
    batch_error_details: "View error",
    batch_open_project: "Open project",
    batch_open_folder: "Open folder",
    batch_remove: "Remove",
  });
  Object.assign(STRINGS.zh, {
    auto_postprocess_title: "3️⃣ 转写后自动处理 （Beta）",
    auto_postprocess_hint: "转写完成后按固定顺序处理字幕；首次启用某一步前，请先在工具箱中完成配置。",
    auto_postprocess_enable: "启用转写后自动处理",
    auto_postprocess_steps: "后处理步骤",
    auto_configure: "配置",
    auto_status_disabled: "未启用",
    auto_status_config: "需要配置",
    auto_status_ready: "已就绪",
    auto_step_match: "文稿匹配",
    auto_step_replace: "固定处理",
    auto_step_proofread: "LLM 校对",
    auto_step_resegment: "重新断句",
    auto_step_ocr: "OCR 字幕去重",
    auto_step_translate: "翻译",
    auto_translate_target: "翻译目标",
    auto_translate_zh: "中文",
    auto_translate_en: "英文",
    auto_retain_intermediate: "保留中间产物",
    auto_retain_hint: "默认不保留；中间文件统一放在媒体目录的 MAW-Postprocess 子文件夹中。失败或取消时会保留以便排查。",
    auto_summary_disabled: "自动处理未启用。",
    auto_summary_empty: "请在下方「后处理步骤」中勾选需要的工序。",
    auto_summary_steps: "已选择 {count} 步：{steps}",
    auto_summary_invalid: "仍有步骤需要配置：{steps}",
    auto_step_hint_no_file: "未选择文稿",
    auto_step_hint_no_rules: "未配置批量替换规则",
    auto_step_hint_rules: "{count} 条批量替换规则",
    auto_step_hint_no_video: "未选择视频",
    retry_postprocess: "从失败步骤重试后处理",
    generate_html: "同时生成单文件版网页编辑器（html）",
    generate_html_title: "单文件版编辑器直接在浏览器打开就能用，优势是便携，但是会缺少保存功能（只能通过导出下载）",
    open_html: "📝 打开该工程的 HTML 编辑器",
    open_blank_html: "📝 打开空的 HTML 编辑器",
    server_already_running: "🌐 当前字幕编辑服务器已在运行中：",
    server_address: "🌐 当前服务器地址：",
    server_start_hint: "请点击「启动字幕服务器」",
    server_no_response_hint: "编辑器服务器没有响应，请检查端口或下方状态。",
    server_start_failed_hint: "编辑器服务器启动失败，请查看下方状态和日志。",
    open_editor: "🚀 打开字幕编辑器",
    server_refresh: "刷新",
    local_model_path: "已有模型目录（可选）",
    local_model_cache_path_label: "模型保存目录",
    local_model_cache_path_hint: "默认使用本地环境的模型缓存目录；需要时可改到其他磁盘。",
    local_refresh: "重新扫描",
    local_prepare: "下载模型",
    local_device: "设备",
    device_auto: "自动",
    device_cpu: "CPU",
    device_cuda: "CUDA",
    local_runtime_missing: "本地运行时未安装",
    local_missing: "未检测到本地模型",
    local_partial: "已检测到主模型，但仍缺少组件",
    local_installed: "已检测到本地模型",
    local_path_selected: "已使用指定的模型目录",
    local_prepare_hint: "下载/准备会使用 QwenASR 或 FunASR 的上游缓存；模型文件不写入 MAW 工程。",
    local_prepare_running: "正在准备模型……",
    local_prepare_cancelling: "正在取消模型准备……",
    local_prepare_cancel: "取消准备",
    local_prepare_cancelled: "模型准备已取消；已完成的缓存会保留，可切换模型或稍后继续。",
    local_prepare_done: "模型已准备完成",
    local_prepare_again: "重新准备模型",
    local_beta_note: "当前为 beta 版本，未经过充分测试，不保证后续的维护和更新，请谨慎使用。",
    local_runtime_install: "安装本地模型支持",
    local_runtime_repair: "修复运行环境",
    local_runtime_cancel: "取消安装",
    local_runtime_missing: "本地运行环境未安装",
    local_runtime_installing: "正在安装本地运行环境……",
    local_runtime_ready: "本地运行环境已就绪",
    local_runtime_broken: "本地运行环境需要修复",
    local_runtime_hint: "将安装到用户目录；运行环境与模型缓存分开保存。首次安装需要下载约 2–3 GB。",
    local_runtime_ready_hint: "运行环境已就绪。现在可以下载所选模型。",
    local_runtime_path: "运行环境：",
    local_model_cache_path: "模型缓存：",
    local_runtime_install_done: "本地模型支持已安装完成",
    local_runtime_install_failed: "本地运行环境安装失败",
    local_runtime_cancelled: "本地运行环境安装已取消"
  });
  Object.assign(STRINGS.en, {
    auto_postprocess_title: "3️⃣ Post-transcription processing (Beta)",
    auto_postprocess_hint: "Process subtitles in a fixed order after transcription. Configure a step in the toolbox before enabling it.",
    auto_postprocess_enable: "Enable automatic post-processing",
    auto_postprocess_steps: "Post-processing steps",
    auto_configure: "Configure",
    auto_status_disabled: "Not enabled",
    auto_status_config: "Needs configuration",
    auto_status_ready: "Ready",
    auto_step_match: "Script match",
    auto_step_replace: "Fixed processing",
    auto_step_proofread: "LLM proofread",
    auto_step_resegment: "Resegment",
    auto_step_ocr: "OCR subtitle dedup",
    auto_step_translate: "Translate",
    auto_translate_target: "Translation target",
    auto_translate_zh: "Chinese",
    auto_translate_en: "English",
    auto_retain_intermediate: "Keep intermediate artifacts",
    auto_retain_hint: "Off by default. Intermediate files stay in a MAW-Postprocess subfolder beside the media; failures and cancellations keep them for diagnosis.",
    auto_summary_disabled: "Automatic processing is disabled.",
    auto_summary_empty: "Select the processing steps you need in the “Post-processing steps” section below.",
    auto_summary_steps: "{count} selected step(s): {steps}",
    auto_summary_invalid: "Steps still need configuration: {steps}",
    auto_step_hint_no_file: "No script selected",
    auto_step_hint_no_rules: "No batch replacement rules",
    auto_step_hint_rules: "{count} batch replacement rule(s)",
    auto_step_hint_no_video: "No video selected",
    retry_postprocess: "Retry post-processing from the failed step",
    generate_html: "Also generate a single-file web editor (HTML)",
    generate_html_title: "The single-file editor works directly in a browser and is portable, but cannot save changes locally; export/download instead.",
    open_html: "📝 Open this project's HTML editor",
    open_blank_html: "📝 Open blank HTML editor",
    server_already_running: "🌐 A subtitle editor server is already running: ",
    server_address: "🌐 Current server address: ",
    server_start_hint: "click \"Launch Subtitle Editor\"",
    server_no_response_hint: "The editor server did not respond. Check the port or the status below.",
    server_start_failed_hint: "The editor server failed to start. Check the status and logs below.",
    open_editor: "🚀 Open Subtitle Editor",
    server_refresh: "Refresh",
    local_model_path: "Existing model folder (optional)",
    local_model_cache_path_label: "Model storage directory",
    local_model_cache_path_hint: "The local environment cache is used by default; you can move it to another drive if needed.",
    local_refresh: "Rescan",
    local_prepare: "Download model",
    local_device: "Device",
    device_auto: "Auto",
    device_cpu: "CPU",
    device_cuda: "CUDA",
    local_runtime_missing: "Local runtime is not installed",
    local_missing: "No local model detected",
    local_partial: "Main model found, but components are missing",
    local_installed: "Local model detected",
    local_path_selected: "Using the selected model folder",
    local_prepare_hint: "Download/preparation uses the QwenASR or FunASR upstream cache; model files are not written into the MAW project.",
    local_prepare_running: "Preparing model…",
    local_prepare_cancelling: "Cancelling model preparation…",
    local_prepare_cancel: "Cancel preparation",
    local_prepare_cancelled: "Model preparation was cancelled. Completed cache files are kept; you can switch models or continue later.",
    local_prepare_done: "Model is ready",
    local_prepare_again: "Prepare model again",
    local_beta_note: "Currently in beta: not fully tested, and ongoing maintenance or updates are not guaranteed. Please use with caution.",
    local_runtime_install: "Install local model support",
    local_runtime_repair: "Repair runtime",
    local_runtime_cancel: "Cancel installation",
    local_runtime_missing: "Local runtime is not installed",
    local_runtime_installing: "Installing the local runtime…",
    local_runtime_ready: "Local runtime is ready",
    local_runtime_broken: "Local runtime needs repair",
    local_runtime_hint: "Installed in your user directory; runtime and model cache are kept separate. The first install downloads about 2–3 GB.",
    local_runtime_ready_hint: "The runtime is ready. You can now download the selected model.",
    local_runtime_path: "Runtime: ",
    local_model_cache_path: "Model cache: ",
    local_runtime_install_done: "Local model support is ready",
    local_runtime_install_failed: "Local runtime installation failed",
    local_runtime_cancelled: "Local runtime installation was cancelled"
  });
  Object.assign(STRINGS.zh, {
    advanced_params: "识别参数",
    advanced_misc: "其他",
    generate_spectral: "生成 ReaPeaks 频谱数据",
    generate_spectral_hint: "默认只生成 ReaPeaks 波形层；勾选后会额外计算频谱，耗时和文件体积都会增加。",
    generate_spectral_title: "为媒体旁的 .ReaPeaks 缓存额外生成频谱层；不影响自研波形。",
    segmentation: "字幕切句",
    max_len: "最大字数",
    min_len: "短句合并阈值",
    gap_split: "停顿切句（毫秒）",
    max_len_placeholder: "默认 21",
    min_len_placeholder: "默认 5",
    gap_split_placeholder: "默认 1500",
    segmentation_hint: "留空使用模型默认值（停顿切句：云端 1500ms，本地 1000ms）；最大/最小字数主要作用于中文，停顿阈值单位为毫秒。",
    qwen_audio_options_title: "Qwen 上下文与热词",
    toolbox_group_ocr_video: "视频来源",
    toolbox_group_ocr_region: "识别区域与模型",
    toolbox_group_ocr_output: "判定与输出",
    toolbox_group_llm_model: "模型",
    toolbox_group_llm_prompt: "提示词",
    toolbox_group_fixed_replacements: "批量替换",
    toolbox_group_fixed_conversion: "简繁转换",
    qwen_audio_context: "附加上下文（Prompt）",
    qwen_audio_context_placeholder: "额外用来辅助 AI 判断的上下文提示词，例如：这是一段关于医药公司的会议记录，参与人员有阿米娅、凯尔希、M3 等人，他们讨论的主要话题是……",
    qwen_audio_context_hint: "领域词表或前文提示；本次任务最多发送 400 个字符，不是通用系统指令。",
    qwen_audio_context_count: "当前字符数：{count}/400",
    qwen_audio_hotwords: "即时热词",
    qwen_audio_hotwords_mode_text: "直接输入",
    qwen_audio_hotwords_mode_file: "从文件读取",
    qwen_audio_hotwords_placeholder: "哔哩哔哩\nMoy\n扑热息痛\nWubba Lubba Dub Dub",
    qwen_audio_hotwords_hint: "如果有容易识别错的单词，可以在此填入，每行一个。模型会在解码过程中提高它们的匹配概率（也可拖入 .txt 文件自动填入）",
    qwen_audio_hotwords_file_placeholder: "拖入或选择 .txt 热词文件",
    qwen_audio_hotwords_file_hint: "支持 UTF-8 编码的 .txt 文件，每行一个热词。",
    qwen_audio_hotwords_weight_override_hint: "支持用“热词: 权重”单独指定某个词的权重，如“obsidian: 5”（中英文冒号皆可）；未指定的热词使用默认权重。",
    qwen_audio_hotwords_loaded: "已将热词文件内容添加到输入框。",
    qwen_audio_hotwords_warning: "有 {count} 项热词不符合规范，发送时会忽略：",
    qwen_audio_hotword_issue_empty: "未填写热词名称",
    qwen_audio_hotword_issue_invalid_weight: "单项权重只能是 1–5 或 50",
    qwen_audio_hotword_issue_text_too_long: "含非 ASCII 字符时最多 15 个字符",
    qwen_audio_hotword_issue_too_many_ascii_words: "纯 ASCII 热词最多 7 个空格分隔的单词",
    qwen_audio_hotword_issue_too_many: "即时热词最多 2000 个",
    qwen_audio_hotword_issue_too_many_super: "权重 50 的热词最多 50 个",
    qwen_audio_hotword_warning_item: "{label}：{reason}",
    qwen_audio_hotword_warning_index: "第 {index} 项",
    qwen_audio_hotword_warning_more: "……其余项目也会在发送时忽略。",
    qwen_audio_hotword_weight: "默认热词权重",
    qwen_audio_hotword_weight_hint: "权重 50 适合少量必须命中的词，最多 50 个。",
    drop_reject_json: "这里只接受 .mosp / .json 工程文件。",
    drop_reject_txt: "热词来源只支持 .txt 文本文件。",
    context_too_long: "Qwen-Audio 上下文最多 400 个字符。",
    soniox_context_title: "Soniox 上下文",
    soniox_context_hint: "可按需填写；四个分区会直接发送到 Soniox 的 context 对象。",
    soniox_context_docs_link: "查看 context 文档 ↗",
    soniox_context_general: "General（键值信息）",
    soniox_context_general_placeholder: "domain=医疗\ntopic=糖尿病管理咨询\norganization=St John's Hospital",
    soniox_context_general_hint: "每行一个 key=value；也可粘贴 general JSON 数组。",
    soniox_context_text: "Text（背景文本）",
    soniox_context_text_placeholder: "补充会议摘要、脚本或参考文档……",
    soniox_context_text_hint: "适合会议摘要、脚本或参考文档。",
    soniox_context_terms: "Terms（术语）",
    soniox_context_terms_placeholder: "阿莫西林\nQwen\nMoy",
    soniox_context_terms_hint: "领域词、品牌名或人名；每行一个，也支持逗号分隔。",
    soniox_context_translation_terms: "Translation terms（翻译术语）",
    soniox_context_translation_terms_placeholder: "MRI => 核磁共振\nSt John's => St John's",
    soniox_context_translation_terms_hint: "每行一个 source => target；也可粘贴 translation_terms JSON 数组。",
    soniox_context_count: "当前字符数：{count}/10000",
    soniox_context_too_long: "Soniox 上下文约限制为 10000 个字符。"
  });
  Object.assign(STRINGS.en, {
    advanced_params: "Parameters",
    advanced_misc: "Other",
    generate_spectral: "Generate ReaPeaks spectral data",
    generate_spectral_hint: "By default only the ReaPeaks wave layer is generated. Spectral data adds processing time and file size.",
    generate_spectral_title: "Add a spectral layer to the .ReaPeaks cache beside the media; this does not change the built-in waveform.",
    segmentation: "Subtitle segmentation",
    max_len: "Max characters",
    min_len: "Short-phrase merge threshold",
    gap_split: "Pause split (ms)",
    max_len_placeholder: "Default: 21",
    min_len_placeholder: "Default: 5",
    gap_split_placeholder: "Default: 1500",
    segmentation_hint: "Leave blank to use the model defaults (pause split: cloud 1500 ms, local 1000 ms); character thresholds mainly apply to CJK, and the pause threshold is in milliseconds.",
    qwen_audio_options_title: "Qwen context & hotwords",
    toolbox_group_ocr_video: "Video source",
    toolbox_group_ocr_region: "Region & model",
    toolbox_group_ocr_output: "Decision & output",
    toolbox_group_llm_model: "Model",
    toolbox_group_llm_prompt: "Prompts",
    toolbox_group_fixed_replacements: "Batch replacement",
    toolbox_group_fixed_conversion: "Chinese conversion",
    qwen_audio_context: "Prompt / context",
    qwen_audio_context_placeholder: "An additional context prompt to help the AI interpret the audio, e.g.: This is a meeting transcript from a pharmaceutical company. Participants include Amiya, Kal'tsit, M3, and others. Their main topic is…",
    qwen_audio_context_hint: "Domain terms or prior context; at most 400 characters per request, not a general system prompt.",
    qwen_audio_context_count: "Characters: {count}/400",
    qwen_audio_hotwords: "Instant hotwords",
    qwen_audio_hotwords_mode_text: "Direct input",
    qwen_audio_hotwords_mode_file: "Load from file",
    qwen_audio_hotwords_placeholder: "Bilibili\nMoy\nParacetamol\nWubba Lubba Dub Dub",
    qwen_audio_hotwords_hint: "If there are words that are easy to misrecognize, enter them here, one per line. The model will increase their matching probability during decoding (you can also drop a .txt file here to fill them in automatically).",
    qwen_audio_hotwords_file_placeholder: "Drop or choose a .txt hotword file",
    qwen_audio_hotwords_file_hint: "UTF-8 .txt files are supported; one hotword per line.",
    qwen_audio_hotwords_weight_override_hint: "Use “hotword: weight” to override one term, e.g. “obsidian: 5” (English or Chinese colon); other terms use the default weight.",
    qwen_audio_hotwords_loaded: "Hotword file content was added to the input.",
    qwen_audio_hotwords_warning: "{count} hotword entries do not meet the format rules and will be ignored:",
    qwen_audio_hotword_issue_empty: "hotword text is empty",
    qwen_audio_hotword_issue_invalid_weight: "individual weight must be 1–5 or 50",
    qwen_audio_hotword_issue_text_too_long: "terms containing non-ASCII characters may have at most 15 characters",
    qwen_audio_hotword_issue_too_many_ascii_words: "ASCII-only terms may contain at most 7 space-separated words",
    qwen_audio_hotword_issue_too_many: "at most 2,000 instant hotwords are supported",
    qwen_audio_hotword_issue_too_many_super: "at most 50 weight-50 hotwords are supported",
    qwen_audio_hotword_warning_item: "{label}: {reason}",
    qwen_audio_hotword_warning_index: "Item {index}",
    qwen_audio_hotword_warning_more: "…the remaining items will also be ignored.",
    qwen_audio_hotword_weight: "Default hotword weight",
    qwen_audio_hotword_weight_hint: "Weight 50 is for a small number of must-hit terms; up to 50 terms.",
    drop_reject_json: "Only .mosp / .json project files can be dropped here.",
    drop_reject_txt: "Hotword source only accepts .txt text files.",
    context_too_long: "Qwen-Audio context is limited to 400 characters.",
    soniox_context_title: "Soniox context",
    soniox_context_hint: "Fill in only what is useful; all four sections are sent as Soniox's context object.",
    soniox_context_docs_link: "View context docs ↗",
    soniox_context_general: "General (key/value information)",
    soniox_context_general_placeholder: "domain=Healthcare\ntopic=Diabetes management consultation\norganization=St John's Hospital",
    soniox_context_general_hint: "One key=value pair per line; a general JSON array can also be pasted.",
    soniox_context_text: "Text (background text)",
    soniox_context_text_placeholder: "Add a meeting summary, script, or reference document…",
    soniox_context_text_hint: "Use for summaries, scripts, or reference documents.",
    soniox_context_terms: "Terms",
    soniox_context_terms_placeholder: "Amoxicillin\nQwen\nMoy",
    soniox_context_terms_hint: "Domain terms, brand names, or people; one per line or comma-separated.",
    soniox_context_translation_terms: "Translation terms",
    soniox_context_translation_terms_placeholder: "MRI => magnetic resonance imaging\nSt John's => St John's",
    soniox_context_translation_terms_hint: "One source => target pair per line; a translation_terms JSON array can also be pasted.",
    soniox_context_count: "Characters: {count}/10000",
    soniox_context_too_long: "Soniox context is limited to approximately 10,000 characters."
  });
  Object.assign(STRINGS.zh, {
    settings_appearance: "外观",
    theme_light: "明亮模式",
    theme_dark: "暗色模式",
    theme_system: "跟随系统设置",
    settings_llm: "LLM 后处理",
    settings_llm_hint: "文稿匹配之外的 LLM 工具会使用这里保存的供应商配置。密钥只保存在本机环境文件。",
    llm_model: "模型",
    llm_api_key: "API Key",
    llm_custom_display_name: "自定义显示名称",
    llm_custom_display_name_placeholder: "可选",
    llm_test_connection: "测试连接",
    llm_test_connection_title: "使用当前填写的 API Key、URL 和模型发送最小测试请求",
    llm_get_models: "获取模型",
    llm_get_models_title: "使用当前填写的 API Key 获取可用模型列表",
    llm_models_loading: "正在获取模型列表……",
    llm_models_loaded: "已获取 {count} 个模型，可在上方快速选择",
    llm_models_empty: "供应商没有返回可用模型。",
    llm_model_choices_title: "展开已获取模型列表",
    llm_quick_actions: "快捷功能",
    llm_connection_testing: "正在测试连接……",
    llm_connection_success: "连接成功。",
    llm_base_url: "API URL",
    llm_base_url_hint: "远程服务使用 HTTPS；明文 HTTP 只允许本机环回地址。",
    llm_reasoning_mode: "思考强度",
    llm_reasoning_auto: "自动（跟随模型默认）",
    llm_reasoning_off: "关闭思考",
    llm_reasoning_low: "低",
    llm_reasoning_medium: "中",
    llm_reasoning_high: "高",
    llm_reasoning_mode_hint: "默认关闭；自动表示跟随模型默认。"
  });
  Object.assign(STRINGS.en, {
    settings_appearance: "Appearance",
    theme_light: "Light",
    theme_dark: "Dark",
    theme_system: "Follow system",
    settings_llm: "LLM post-processing",
    settings_llm_hint: "LLM tools use the provider configuration saved here. Keys stay in the local environment file.",
    llm_model: "Model",
    llm_api_key: "API Key",
    llm_custom_display_name: "Custom display name",
    llm_custom_display_name_placeholder: "Optional",
    llm_test_connection: "Test connection",
    llm_test_connection_title: "Send a minimal request using the current API key, URL, and model",
    llm_get_models: "Get models",
    llm_get_models_title: "Fetch available models using the current API key",
    llm_models_loading: "Fetching model list…",
    llm_models_loaded: "Fetched {count} models; choose one above.",
    llm_models_empty: "The provider returned no usable models.",
    llm_model_choices_title: "Show fetched model list",
    llm_quick_actions: "Quick actions",
    llm_connection_testing: "Testing connection…",
    llm_connection_success: "Connection successful.",
    llm_base_url: "API URL",
    llm_base_url_hint: "Use HTTPS for remote services; plain HTTP is limited to loopback addresses.",
    llm_reasoning_mode: "Reasoning effort",
    llm_reasoning_auto: "Auto (follow model default)",
    llm_reasoning_off: "Disable thinking",
    llm_reasoning_low: "Low",
    llm_reasoning_medium: "Medium",
    llm_reasoning_high: "High",
    llm_reasoning_mode_hint: "Off is the default; Auto follows the model default."
  });
  Object.assign(STRINGS.zh, {
    toolbox_open: "打开工具箱", toolbox_title: "工具箱", toolbox_group_postprocess: "后处理", toolbox_group_utilities: "实用工具", toolbox_chain_hint: "每次生成新文件，并自动作为下一步输入。", toolbox_no_media: "未选择媒体", toolbox_input_empty: "未选择文件", toolbox_chain_heading: "处理产物（点击文件名切换输入）", toolbox_resize_width: "调整工具箱宽度", toolbox_resize_height: "调整工具箱高度",
    toolbox_input: "处理文件", toolbox_input_placeholder: "跟随工程文件，也可拖入 .mosp / .json / .srt", toolbox_input_hint: "默认跟随「工程文件」并随每次处理更新；手动选择或拖入后以这里为准。", toolbox_drop_reject: "这里只接受 .mosp / .json / .srt 字幕或工程文件。", toolbox_utility_media: "媒体文件", toolbox_utility_media_placeholder: "默认跟随 Launcher 媒体，也可选择或拖入媒体文件", toolbox_utility_media_hint: "默认跟随 Launcher 媒体；选择或拖入媒体后，以这里为准。清空可恢复跟随。", toolbox_utility_media_reject: "这里仅接受媒体文件。", toolbox_ffconcat_reject: "这里只接受 .ffconcat 文件。",
     toolbox_waveform: "生成波形", toolbox_waveform_hint: "仅使用上方媒体生成带内嵌波形的媒体工程，不需要字幕或转写；打开编辑器后可扫描静音空隙并导出去空隙 OTIO。", toolbox_generate_waveform: "生成波形文件", toolbox_run_waveform: "生成波形并打开编辑器", toolbox_match: "文稿匹配", toolbox_script: "文稿文件", toolbox_script_placeholder: "UTF-8 .txt / .md 文稿", toolbox_script_hint: "文稿文字会替换字幕文字；原字幕时间保持不变。", toolbox_script_preview: "文稿预览（前 240 字）", toolbox_script_reject: "文稿只支持 .txt / .md / .markdown 文件。", toolbox_extra_split_punctuation: "额外断句符号", toolbox_extra_split_punctuation_placeholder: "？\n！\n——\n~", toolbox_extra_split_punctuation_hint: "每行一个符号；默认逗号、句号和换行仍然生效。", toolbox_preserve_punctuation: "保留符号", toolbox_preserve_punctuation_placeholder: "？\n！\n~", toolbox_preserve_punctuation_hint: "断句后仍将符号保留在对应字幕末尾。", toolbox_preserve_punctuation_invalid: "保留符号必须存在于额外断句符号中：", toolbox_match_hint: "匹配度过低时会停止，不写出可能错配的结果。", toolbox_run_match: "匹配文稿",
     toolbox_llm: "LLM 处理", toolbox_replace: "固定处理", toolbox_ffconcat: "媒体重组", toolbox_provider: "供应商", toolbox_operation: "任务", toolbox_proofread: "校对文本", toolbox_resegment: "重新断句", toolbox_translate_en: "翻译成英文", toolbox_translate_zh: "翻译成中文", toolbox_custom: "自定义",
    toolbox_open_settings: "在 ⚙️ 设置中配置 API Key", toolbox_preset_prompt: "预设提示词", toolbox_preset_prompt_hint: "由当前任务决定，不可编辑。", toolbox_prompt: "自定义提示词", toolbox_prompt_placeholder: "例如：保留专有名词，不要使用书面腔。", toolbox_prompt_hint: "可按需追加要求；留空则只使用预设提示词。", toolbox_task_none: "（无）", toolbox_task_proofread: "校对字幕中的错别字、漏字和明显识别错误，不扩写事实。", toolbox_task_resegment: "重新整理句子的字幕拆分。可以合并或拆分连续字幕，但不得删除内容。", toolbox_task_translate_en: "翻译为自然英文。必须保持原字幕的段数、顺序和每段时间范围，一条输入字幕只能对应一条输出字幕；不得合并、拆分或重排相邻字幕。", toolbox_task_translate_zh: "翻译为自然中文。必须保持原字幕的段数、顺序和每段时间范围，一条输入字幕只能对应一条输出字幕；不得合并、拆分或重排相邻字幕。", toolbox_time_hint: "模型只处理带 ID 的文字；本地时间槽始终是时间真源。", toolbox_output: "输出", toolbox_output_both: "工程 + SRT", toolbox_output_project: "仅工程", toolbox_output_srt: "仅 SRT", toolbox_run: "运行处理",
     toolbox_group_fixed_replacements: "批量替换", toolbox_group_fixed_conversion: "简繁转换", toolbox_conversion: "转换方向", toolbox_conversion_off: "不转换", toolbox_conversion_to_simplified: "转为简体", toolbox_conversion_to_traditional: "转为繁体（通用）", toolbox_conversion_to_traditional_tw: "转为繁体（台湾）", toolbox_conversion_to_traditional_twp: "转为繁体（台湾增强）", toolbox_conversion_to_traditional_hk: "转为繁体（香港）", toolbox_conversion_hint: "先执行批量替换，再转换文字；不访问网络。", toolbox_replace_rules: "批量替换规则", toolbox_replace_placeholder: "错别字 => 正确文字\n旧名称 => 新名称", toolbox_replace_separator: "替换分隔符号", toolbox_replace_separator_arrow: "=>", toolbox_replace_separator_comma: "中英文逗号", toolbox_replace_separator_tab: "Tab 制表符", toolbox_replace_separator_custom: "自定义", toolbox_replace_custom_separator: "自定义分隔符", toolbox_replace_trim: "自动去除前后空白", toolbox_replace_preview: "规则预览", toolbox_replace_preview_hint: "输入规则后显示解析结果。", toolbox_replace_preview_empty: "没有识别到有效规则。", toolbox_replace_hint: "每行一条替换规则；修改文本后会移除失真的逐词时间。", toolbox_replace_safe: "分段起止时间保持不变。", toolbox_run_replace: "执行固定处理",
     toolbox_ffconcat_placeholder: "选择或拖入 FFconcat 文件；将通过 FFmpeg 按清单重组当前媒体", toolbox_ffconcat_warning: "先在编辑器中执行「移除静音空隙」，然后可选择导出 FFconcat 文件。只允许引用当前媒体；重组会生成新媒体，但不会改写字幕时间轴。", toolbox_run_media: "生成新媒体", toolbox_ready: "选择工具后运行；始终生成新文件，不覆盖源文件。", toolbox_running: "处理中……", toolbox_status_starting: "正在准备处理……", toolbox_status_reading: "正在读取字幕文件……", toolbox_status_matching: "正在匹配文稿……", toolbox_status_fixed_processing: "正在执行固定处理……", toolbox_status_preparing_llm: "正在准备大模型……", toolbox_status_llm_batch: "正在处理第 {current}/{total} 批字幕……", toolbox_status_llm_batch_done: "已完成第 {current}/{total} 批字幕。", toolbox_status_reorganizing: "正在整理模型结果……", toolbox_status_writing: "正在写出处理结果……", toolbox_status_validating_media: "正在校验媒体清单……", toolbox_status_rebuilding_media: "正在重组媒体……", toolbox_stream_title: "模型实时输出", toolbox_thinking: "思考", toolbox_model_output: "模型输出（JSON）", toolbox_stream_batch: "第 {batch} 批", toolbox_stream_chars: "{count} 个字符", toolbox_saved: "LLM 设置已保存。", toolbox_key_empty: "未保存此供应商的密钥", toolbox_key_loaded: "已保存密钥 {key}", toolbox_chain_match: "[文稿匹配]", toolbox_chain_replace: "[固定处理]", toolbox_chain_llm_proofread: "[LLM 处理/校对]", toolbox_chain_llm_resegment: "[LLM 处理/重新断句]", toolbox_chain_llm_translate: "[LLM 处理/翻译]", toolbox_chain_llm_custom: "[LLM 处理/自定义]",
      toolbox_need_source: "请先选择工程或 SRT。", toolbox_need_script: "请选择文稿文件。", toolbox_need_rules: "请至少填写一条有效批量替换规则或选择简繁转换。", toolbox_need_ffconcat: "请选择 .ffconcat 文件。", toolbox_need_media: "请先选择当前媒体。", toolbox_custom_prompt_required: "自定义任务需要填写提示词。", toolbox_done: "处理完成，已切换到新产物：", toolbox_media_done: "媒体重组完成，已切换到新媒体：", toolbox_config_only_hint: "这里只配置自动后处理；生成后会自动执行。"
   });
   Object.assign(STRINGS.en, {
     toolbox_open: "Open toolbox", toolbox_title: "Toolbox", toolbox_group_postprocess: "Post-processing", toolbox_group_utilities: "Utilities", toolbox_chain_hint: "Each run creates a new file and uses it as the next input.", toolbox_no_media: "No media selected", toolbox_input_empty: "No file selected", toolbox_chain_heading: "Artifacts (click a filename to use it as input)", toolbox_resize_width: "Resize toolbox width", toolbox_resize_height: "Resize toolbox height",
    toolbox_input: "File to process", toolbox_input_placeholder: "Follows the project file, or drop a .mosp / .json / .srt", toolbox_input_hint: "Auto-follows the project file and updates after each run; a chosen or dropped file takes priority.", toolbox_drop_reject: "Only .mosp / .json / .srt subtitle or project files can be dropped here.", toolbox_utility_media: "Media file", toolbox_utility_media_placeholder: "Uses Launcher media by default, or choose or drop a media file", toolbox_utility_media_hint: "Uses the Launcher media by default; a chosen or dropped file takes priority. Clear it to follow again.", toolbox_utility_media_reject: "Only media files can be used here.", toolbox_ffconcat_reject: "Only .ffconcat files can be used here.",
      toolbox_waveform: "Generate waveform", toolbox_waveform_hint: "Use the media above to create an embedded-waveform project; no subtitles or transcription are required. In the editor, scan silence gaps and export a gap-removed OTIO.", toolbox_generate_waveform: "Generate waveform project", toolbox_run_waveform: "Generate waveform and open editor", toolbox_match: "Script match", toolbox_script: "Script file", toolbox_script_placeholder: "UTF-8 .txt / .md script", toolbox_script_hint: "Script text replaces subtitle text; original subtitle timing stays unchanged.", toolbox_script_preview: "Script preview (first 240 chars)", toolbox_script_reject: "Scripts must be .txt, .md, or .markdown files.", toolbox_extra_split_punctuation: "Extra split punctuation", toolbox_extra_split_punctuation_placeholder: "?\n!\n--\n~", toolbox_extra_split_punctuation_hint: "One symbol per line; commas, periods, and line breaks remain enabled.", toolbox_preserve_punctuation: "Preserve punctuation", toolbox_preserve_punctuation_placeholder: "?\n!\n~", toolbox_preserve_punctuation_hint: "Keep these symbols at the end of the resulting cue.", toolbox_preserve_punctuation_invalid: "Preserved symbols must be listed as extra split punctuation:", toolbox_match_hint: "Runs stop when the match is too low to avoid writing a bad alignment.", toolbox_run_match: "Match script",
     toolbox_llm: "LLM", toolbox_replace: "Fixed processing", toolbox_ffconcat: "Media rebuild", toolbox_provider: "Provider", toolbox_operation: "Task", toolbox_proofread: "Proofread text", toolbox_resegment: "Resegment", toolbox_translate_en: "Translate into English", toolbox_translate_zh: "Translate into Chinese", toolbox_custom: "Custom",
    toolbox_open_settings: "Configure the API key in ⚙️ Settings", toolbox_preset_prompt: "Preset prompt", toolbox_preset_prompt_hint: "Determined by the current task and cannot be edited.", toolbox_prompt: "Custom prompt", toolbox_prompt_placeholder: "Example: preserve product names and use conversational language.", toolbox_prompt_hint: "Add extra requirements as needed; leave empty to use only the preset prompt.", toolbox_task_none: "(None)", toolbox_task_proofread: "Proofread subtitle typos, omissions, and obvious recognition errors without expanding facts.", toolbox_task_resegment: "Reorganize subtitle sentence breaks. You may merge or split consecutive subtitles, but do not delete content.", toolbox_task_translate_en: "Translate into natural English. Preserve the original cue count, order, and time ranges; each input cue must produce exactly one output cue. Do not merge, split, or reorder adjacent cues.", toolbox_task_translate_zh: "Translate into natural Chinese. Preserve the original cue count, order, and time ranges; each input cue must produce exactly one output cue. Do not merge, split, or reorder adjacent cues.", toolbox_time_hint: "The model edits ID-tagged text only; local time slots remain authoritative.", toolbox_output: "Output", toolbox_output_both: "Project + SRT", toolbox_output_project: "Project only", toolbox_output_srt: "SRT only", toolbox_run: "Run",
      toolbox_group_fixed_replacements: "Batch replacement", toolbox_group_fixed_conversion: "Chinese conversion", toolbox_conversion: "Conversion direction", toolbox_conversion_off: "No conversion", toolbox_conversion_to_simplified: "Convert to Simplified", toolbox_conversion_to_traditional: "Convert to Traditional (General)", toolbox_conversion_to_traditional_tw: "Convert to Traditional (Taiwan)", toolbox_conversion_to_traditional_twp: "Convert to Traditional (Taiwan enhanced)", toolbox_conversion_to_traditional_hk: "Convert to Traditional (Hong Kong)", toolbox_conversion_hint: "Apply batch replacements first, then convert text locally.", toolbox_replace_rules: "Batch replacement rules", toolbox_replace_placeholder: "old text => new text", toolbox_replace_separator: "Replacement separator", toolbox_replace_separator_arrow: "=>", toolbox_replace_separator_comma: "English or Chinese comma", toolbox_replace_separator_tab: "Tab", toolbox_replace_separator_custom: "Custom", toolbox_replace_custom_separator: "Custom separator", toolbox_replace_trim: "Trim surrounding whitespace automatically", toolbox_replace_preview: "Rule preview", toolbox_replace_preview_hint: "Parsed rules will appear here.", toolbox_replace_preview_empty: "No valid rules detected.", toolbox_replace_hint: "One replacement rule per line. Stale word timings are removed when text changes.", toolbox_replace_safe: "Segment start and end times stay unchanged.", toolbox_run_replace: "Run fixed processing",
     toolbox_ffconcat_placeholder: "Choose or drop an FFconcat file; FFmpeg will rebuild the current media from its entries", toolbox_ffconcat_warning: "First use the editor to remove silence gaps, then export an FFconcat file. Only the current media may be referenced; rebuilding creates a new media file without changing subtitle timing.", toolbox_run_media: "Build media", toolbox_ready: "Choose a tool and run it; tools always write new files and never overwrite sources.", toolbox_running: "Processing…", toolbox_status_starting: "Preparing the operation…", toolbox_status_reading: "Reading subtitle files…", toolbox_status_matching: "Matching the script…", toolbox_status_fixed_processing: "Applying fixed processing…", toolbox_status_preparing_llm: "Preparing the LLM…", toolbox_status_llm_batch: "Processing subtitle batch {current}/{total}…", toolbox_status_llm_batch_done: "Completed subtitle batch {current}/{total}.", toolbox_status_reorganizing: "Organizing the model result…", toolbox_status_writing: "Writing the processed files…", toolbox_status_validating_media: "Validating the media list…", toolbox_status_rebuilding_media: "Rebuilding the media…", toolbox_stream_title: "Live model output", toolbox_thinking: "Thinking", toolbox_model_output: "Model output (JSON)", toolbox_stream_batch: "Batch {batch}", toolbox_stream_chars: "{count} chars", toolbox_saved: "LLM settings saved.", toolbox_key_empty: "No saved key for this provider", toolbox_key_loaded: "Saved key {key}", toolbox_chain_match: "[Script match]", toolbox_chain_replace: "[Fixed processing]", toolbox_chain_llm_proofread: "[LLM / Proofread]", toolbox_chain_llm_resegment: "[LLM / Resegment]", toolbox_chain_llm_translate: "[LLM / Translate]", toolbox_chain_llm_custom: "[LLM / Custom]",
      toolbox_need_source: "Choose a project or SRT first.", toolbox_need_script: "Choose a script file.", toolbox_need_rules: "Enter at least one valid batch replacement rule or choose a conversion.", toolbox_need_ffconcat: "Choose an .ffconcat file.", toolbox_need_media: "Choose the current media first.", toolbox_custom_prompt_required: "Enter a custom prompt before running the Custom task.", toolbox_done: "Done. Chained to the new artifact:", toolbox_media_done: "Media rebuilt. Chained to the new media:", toolbox_config_only_hint: "Configure automatic post-processing here; it will run after generation."
  });
  Object.assign(STRINGS.zh, {
    toolbox_ocr_dedup: "OCR 字幕去重", toolbox_ocr_video: "视频画面", toolbox_ocr_video_placeholder: "优先使用工程视频，也可选择视频文件", toolbox_ocr_video_hint: "工程有可用视频时自动使用；独立 SRT 会回退到当前 Launcher 视频；如果当前媒体是音频或无视频，必须选择视频。", toolbox_ocr_video_reject: "请选择支持的视频文件。", toolbox_ocr_region: "画面字幕区", toolbox_ocr_region_full: "100% 完整画面", toolbox_ocr_region_bottom: "底部 30%", toolbox_ocr_region_custom: "自定义百分比区域", toolbox_ocr_region_hint: "缩小处理区域可减少 OCR 输入量。", toolbox_ocr_model: "OCR 模型", toolbox_ocr_model_tiny: "PP-OCRv6 tiny（CPU）", toolbox_ocr_model_small: "PP-OCRv6 small（CPU）", toolbox_ocr_model_hint: "tiny 更快；small 对复杂画面更稳，但会占用更多 CPU 和内存。", toolbox_ocr_x1: "左（X1）%", toolbox_ocr_y1: "上（Y1）%", toolbox_ocr_x2: "右（X2）%", toolbox_ocr_y2: "下（Y2）%", toolbox_ocr_threshold: "相似度阈值", toolbox_ocr_threshold_hint: "参考算法取三种相似度的最高值；默认 0.5。", toolbox_ocr_threshold_invalid: "相似度阈值必须是 0 到 1 之间的数字。", toolbox_ocr_report: "生成 OCR 判定报告（CSV）", toolbox_ocr_hint: "画面文字与字幕高度相似的段会被禁用或从 SRT 移除。", toolbox_run_ocr: "执行 OCR 字幕去重", toolbox_status_ocr_initializing: "正在初始化 OCR 模型……", toolbox_status_ocr_frame: "正在识别第 {current}/{total} 条字幕画面……", toolbox_ocr_report_path: "OCR 报告：", toolbox_chain_ocr: "[OCR 字幕去重]"
  });
  Object.assign(STRINGS.en, {
    toolbox_ocr_dedup: "OCR subtitle deduplication", toolbox_ocr_video: "Video source", toolbox_ocr_video_placeholder: "Uses the project video first; you can also choose a video", toolbox_ocr_video_hint: "A project video is used automatically; an external SRT falls back to the current Launcher video. Choose a video when the current media is audio-only or unavailable.", toolbox_ocr_video_reject: "Choose a supported video file.", toolbox_ocr_region: "On-screen text region", toolbox_ocr_region_full: "Full frame (100%)", toolbox_ocr_region_bottom: "Bottom 30%", toolbox_ocr_region_custom: "Custom percentage region", toolbox_ocr_region_hint: "A smaller region reduces OCR input.", toolbox_ocr_model: "OCR model", toolbox_ocr_model_tiny: "PP-OCRv6 tiny (CPU)", toolbox_ocr_model_small: "PP-OCRv6 small (CPU)", toolbox_ocr_model_hint: "tiny is faster; small is more robust on complex frames but uses more CPU and memory.", toolbox_ocr_x1: "Left (X1)%", toolbox_ocr_y1: "Top (Y1)%", toolbox_ocr_x2: "Right (X2)%", toolbox_ocr_y2: "Bottom (Y2)%", toolbox_ocr_threshold: "Similarity threshold", toolbox_ocr_threshold_hint: "Uses the highest of the three reference similarities; default 0.5.", toolbox_ocr_threshold_invalid: "Similarity threshold must be a number from 0 to 1.", toolbox_ocr_report: "Generate OCR decision report (CSV)", toolbox_ocr_hint: "Cues highly similar to on-screen text are disabled or removed from SRT.", toolbox_run_ocr: "Run OCR subtitle deduplication", toolbox_status_ocr_initializing: "Initializing the OCR model…", toolbox_status_ocr_frame: "Recognizing subtitle frame {current}/{total}…", toolbox_ocr_report_path: "OCR report:", toolbox_chain_ocr: "[OCR subtitle deduplication]"
  });
  Object.assign(STRINGS.zh, {
    settings_ocr: "OCR 支持",
    settings_ocr_hint: "OCR 识别功能用于去除与画面上的文本重复的字幕，常用于配音游戏实况等视频内容。主程序不预装 OCR 依赖，首次使用时在这里下载独立运行环境。",
    ocr_runtime_path: "OCR 运行环境目录",
    ocr_runtime_path_hint: "默认安装到用户目录；可改到空间更充足的磁盘。运行环境和模型随这里保存。",
    ocr_runtime_refresh: "重新扫描",
    ocr_runtime_install: "安装 OCR 支持",
    ocr_runtime_repair: "修复 OCR 支持",
    ocr_runtime_cancel: "取消安装",
    ocr_runtime_missing: "OCR 支持未安装",
    ocr_runtime_installing: "正在安装 OCR 支持……",
    ocr_runtime_ready: "OCR 支持已就绪",
    ocr_runtime_broken: "OCR 支持需要修复",
    ocr_runtime_install_done: "OCR 支持已安装完成",
    ocr_runtime_cancelled: "OCR 支持安装已取消",
    toolbox_ocr_open_settings: "在 ⚙️ 设置中下载安装 OCR 支持",
    toolbox_ocr_model_ready: "已安装，可直接使用",
    toolbox_ocr_model_missing: "尚未安装，请打开设置下载安装",
  });
  Object.assign(STRINGS.zh, {
    artifact_type_project: "MOSP 工程",
    artifact_type_srt: "SRT 字幕",
    artifact_menu_label: "产物操作",
    artifact_set_target: "设为处理目标",
    artifact_open_folder: "打开所在文件夹",
    artifact_open_file: "打开文件",
  });
  Object.assign(STRINGS.en, {
    artifact_type_project: "MOSP project",
    artifact_type_srt: "SRT subtitles",
    artifact_menu_label: "Artifact actions",
    artifact_set_target: "Set as processing target",
    artifact_open_folder: "Open containing folder",
    artifact_open_file: "Open file",
  });
  Object.assign(STRINGS.en, {
    settings_ocr: "OCR support",
    settings_ocr_hint: "OCR removes subtitles that duplicate text visible in the video, which is useful for dubbed game playthroughs and similar content. The main app does not preinstall OCR dependencies; download its separate runtime here when needed.",
    ocr_runtime_path: "OCR runtime directory",
    ocr_runtime_path_hint: "Installed in your user directory by default; move it to a drive with more space if needed. The runtime and model are kept here.",
    ocr_runtime_refresh: "Rescan",
    ocr_runtime_install: "Install OCR support",
    ocr_runtime_repair: "Repair OCR support",
    ocr_runtime_cancel: "Cancel installation",
    ocr_runtime_missing: "OCR support is not installed",
    ocr_runtime_installing: "Installing OCR support…",
    ocr_runtime_ready: "OCR support is ready",
    ocr_runtime_broken: "OCR support needs repair",
    ocr_runtime_install_done: "OCR support is installed",
    ocr_runtime_cancelled: "OCR support installation was cancelled",
    toolbox_ocr_open_settings: "Download OCR support in ⚙️ Settings",
    toolbox_ocr_model_ready: "Installed and ready",
    toolbox_ocr_model_missing: "Not installed; open Settings to download it",
  });
  const SERVER_STARTING_TEXT = { zh: "启动中……", en: "Starting…" };
  // Launcher 暂时面向国内用户默认北京；地域和 Workspace 仍保留在请求契约中，后续可重新开放。
  const SHOW_REGIONAL_FIELDS = false;
  // 界面暂不开放时长上限，底层参数保留。
  const SHOW_LENGTH_LIMIT_FIELD = false;

  const MEDIA_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v", ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"]);
  const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"]);
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
      local_runtime_missing: "本地模型运行时未安装。请先安装本地 ASR 依赖。",
      local_runtime_install_failed: (detail) => `本地运行环境安装失败：${detail || "请查看日志后重试。"}`,
      local_runtime_cancelled: "本地运行环境安装已取消。",
      local_model_missing: "尚未检测到本地模型，请先点击“下载模型”或选择已有模型目录。",
      local_model_incomplete: "本地模型不完整，请先准备缺少的模型组件。",
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
      workspace_missing: "新加坡地域需要 Workspace ID。",
      context_too_long: "Qwen-Audio 上下文最多 400 个字符。",
      soniox_context_too_long: "Soniox 上下文约限制为 10000 个字符。",
      soniox_context_invalid: "Soniox 上下文格式不正确，请检查高级设置中的填写格式。",
      postprocess_config_invalid: (detail) => `自动后处理配置不完整：${detail || "请打开工具箱完成配置。"}`,
      postprocess_failed: (detail) => `转写已完成，但自动后处理失败：${detail || "请查看日志。"}`,
      postprocess_cancelled: "自动后处理已取消，原始转写产物仍然保留。",
      waveform_unavailable: "无法从该媒体生成可用波形，请检查 FFmpeg 和媒体文件。",
      waveform_generation_failed: (detail) => `波形工程生成失败：${detail || "请检查媒体与输出目录权限。"}`,
      hotwords_file_missing: "请选择存在且为 UTF-8 编码的 .txt 热词文件。",
      output_missing: "请填写 SRT 输出路径。",
      segmentation_invalid: "切句参数无效：请输入整数，并确保最大字数不小于短句合并阈值。",
      ffmpeg_start_failed: "FFmpeg 启动失败（Windows 错误 0xC0000142）。请检查 FFmpeg 是否完整、可执行文件是否被安全软件拦截；本次任务已停止，可以修复后重新尝试。",
      transcription_failed: "转写失败，本次任务已停止。请查看日志后修正问题，再重新尝试。",
      transcription_cancelled: "转写已停止。",
      ffprobe_start_failed: "ffprobe 启动失败（Windows 错误 0xC0000142）。请重新运行 MAW；如果仍然失败，请重新下载并完整解压 MAWxFF，并检查 Windows 安全中心是否拦截了 ffprobe.exe。",
      config_save_failed: (detail) => `无法保存本地配置：${detail || "请检查应用数据目录权限后重试。"}`,
      server_no_response: (detail) => `编辑器服务器没有响应（${detail || "http://127.0.0.1"}）——端口可能被占用，请检查端口后重试。`,
      server_start_failed: (detail) => `编辑器服务器启动失败：${detail || "请查看下方日志。"}`,
      sticker_dir_invalid: "表情包根目录不存在。"
    },
    en: {
      json_not_found: "Project file does not exist. Check the path.",
      media_not_found: "Media file does not exist. Choose it again.",
      server_media_missing: "The project has no usable media. Choose the media file manually.",
      server_stop_not_maw: "The current port is not used by a MAW subtitle editor server, so it was not stopped.",
      server_stop_failed: "Unable to stop the MAW subtitle editor server on the current port.",
      api_key_missing: "Enter an API Key, or save one first in Settings / API key.",
      local_runtime_missing: "The local ASR runtime is not installed. Install the local dependencies first.",
      local_runtime_install_failed: (detail) => `Local runtime installation failed: ${detail || "check the log and retry."}`,
      local_runtime_cancelled: "Local runtime installation was cancelled.",
      local_model_missing: "No local model was detected. Download it or choose an existing model folder.",
      local_model_incomplete: "The local model is incomplete. Prepare the missing components first.",
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
      workspace_missing: "Singapore region requires a Workspace ID.",
      context_too_long: "Qwen-Audio context is limited to 400 characters.",
      soniox_context_too_long: "Soniox context is limited to approximately 10,000 characters.",
      postprocess_config_invalid: (detail) => `Automatic post-processing is not configured: ${detail || "open the toolbox to finish setup."}`,
      waveform_unavailable: "No usable waveform could be generated. Check FFmpeg and the media file.",
      waveform_generation_failed: (detail) => `Waveform project generation failed: ${detail || "check the media and output-folder permissions."}`,
      postprocess_failed: (detail) => `Transcription completed, but automatic post-processing failed: ${detail || "check the log."}`,
      postprocess_cancelled: "Automatic post-processing was cancelled; the original transcription remains available.",
      soniox_context_invalid: "Soniox context format is invalid. Check the Advanced options format.",
      hotwords_file_missing: "Choose an existing UTF-8 .txt hotword file.",
      output_missing: "Enter an SRT output path.",
      segmentation_invalid: "Invalid segmentation settings: enter integers and ensure max characters is at least the merge threshold.",
      ffmpeg_start_failed: "FFmpeg failed to start (Windows error 0xC0000142). Check that FFmpeg is complete and not blocked by security software, then retry.",
      transcription_failed: "Transcription failed and this run has stopped. Check the log, fix the problem, and retry.",
      transcription_cancelled: "Transcription stopped.",
      ffprobe_start_failed: "ffprobe failed to start (Windows error 0xC0000142). Please run MAW again. If it keeps happening, download and fully extract MAWxFF again, and check Windows Security for a blocked ffprobe.exe.",
      config_save_failed: (detail) => `Could not save local configuration: ${detail || "check the app-data directory permissions and try again."}`,
      server_no_response: (detail) => `The editor server did not respond (${detail || "http://127.0.0.1"}). The port may be occupied; check the port and retry.`,
      server_start_failed: (detail) => `The editor server failed to start: ${detail || "check the logs below."}`,
      sticker_dir_invalid: "Sticker root directory does not exist."
    }
  };
  Object.assign(STRINGS.zh, {
    start_server_editor: "🚀 启动字幕编辑器",
    toolbox_chain_hint: "每次生成新文件，并自动作为下一步输入；选择工具后运行。",
  });
  Object.assign(STRINGS.en, {
    start_server_editor: "🚀 Start Editor",
    toolbox_chain_hint: "Choose a tool to run; each run creates a new file and uses it as the next input.",
  });

  const HOME_URL = "https://github.com/Moyf/moys-asr-workflow";
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
  const state = { lang: "zh", serverRunning: false, serverStarting: false, serverProjectPath: "", moseStarting: false, running: false, localPreparing: false, localProgressMessage: "", localProgress: null, localModelId: "", localModelPaths: {}, localRuntimeInstalling: false, localRuntimeProgress: 0, localRuntimeProgressMessage: "", ocrRuntimeInstalling: false, ocrRuntimeProgress: 0, ocrRuntimeProgressMessage: "", lastLogMessage: "", result: null, config: null, srtAuto: true, testSuffixAdded: false, serverMediaOk: false, detectedServerUrl: "", dropTarget: "", theme: "system", toolboxBusy: false, toolboxOpen: false };
  const dragState = { depth: 0 };
  let api = null;
  let prefsTimer = 0;

  function mockApi() {
    let saved = { apiKey: "", region: "beijing", language: "", workspaceId: "", guiLang: "zh", customDisplayName: "" };
    const chainedPath = (path, operation, fallback) => path
      ? path.replace(/(\.[^.\\/]+)$/u, `.${operation}$1`)
      : fallback;
    let modelPrepareTimer = 0;
    return {
      get_config: async () => ({
        apiKey: saved.apiKey,
        maskedApiKey: saved.apiKey ? "sk-…demo" : "",
        providerId: "qwen",
        modelId: "qwen-audio-3.0-asr-flash-filetrans",
        lastModel: localStorage.getItem(LAST_MODEL_KEY),
         lastLanguage: localStorage.getItem(LAST_LANGUAGE_KEY),
         zoomPercent: Number(localStorage.getItem(ZOOM_PERCENT_KEY)) || ZOOM_DEFAULT,
        region: saved.region,
        language: saved.language,
        workspaceId: saved.workspaceId,
        guiLang: saved.guiLang,
        showRareLangs: saved.showRareLangs || false,
        appVersion: "1.4.0",
        stickerDir: saved.stickerDir || "",
        postprocessProviders: [
          { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: true, hasModel: true, selected: true },
          { id: "zhipu", label: "智谱 Coding Plan", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.2", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: true, hasModel: true, selected: false },
          { id: "qwen", label: "阿里云 Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: true, hasModel: true, selected: false },
          { id: "custom", label: saved.customDisplayName || "Custom (OpenAI-compatible)", defaultLabel: "Custom (OpenAI-compatible)", displayName: saved.customDisplayName || "", baseUrl: "", model: "", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: false, hasModel: false, selected: false }
        ],
        postprocessAutoPlan: saved.postprocessAutoPlan || { version: 1, enabled: false, retainIntermediate: false, steps: [] },
        modelCacheRoot: saved.modelCacheRoot || "D:\\Models\\MAW",
        localRuntime: { status: "missing", ready: false, path: "", pythonPath: "", modelCachePath: saved.modelCacheRoot || "D:\\Models\\MAW", detail: "" },
        ocrRuntime: { status: "missing", ready: false, path: "D:\\Users\\Demo\\AppData\\Local\\MAW\\ocr-runtime", pythonPath: "", modelId: "pp-ocrv6-tiny", modelLabel: "PP-OCRv6 tiny（CPU）", detail: "" },
        ocrModels: [
          { id: "pp-ocrv6-tiny", label: "PP-OCRv6 tiny（CPU）", installed: false, status: "missing", detail: "" },
          { id: "pp-ocrv6-small", label: "PP-OCRv6 small（CPU）", installed: false, status: "missing", detail: "" }
        ],
        ocrModelId: "pp-ocrv6-tiny",
        providers: [
          {
            id: "qwen",
            label: "阿里云百炼（QwenASR / FunASR）",
            keyUrl: "https://help.aliyun.com/zh/model-studio/get-api-key",
            apiKey: saved.apiKey,
            maskedApiKey: saved.apiKey ? "sk-…demo" : "",
            supportsSpeaker: true,
            multiLanguage: false,
            commonLanguages: ["", "zh", "yue", "en"],
            models: [
              { id: "qwen-audio-3.0-asr-flash-filetrans", label: "qwen-audio-3.0-asr（热词 / 上下文）", envKey: "DASHSCOPE_API_KEY", note: "支持即时热词、上下文与说话人分离", supportsSpeaker: true, supportsContext: true, supportsHotwords: true, supportsVocabulary: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "yue", label: "粤语 / Cantonese" }, { id: "en", label: "英语 / English" }] },
              { id: "fun-asr", label: "fun-asr（支持说话人）", envKey: "DASHSCOPE_API_KEY", note: "支持说话人分离与词级时间戳", supportsSpeaker: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "en", label: "英语 / English" }] },
              { id: "qwen3-asr-flash-filetrans", label: "qwen3-asr（准确率更高）", envKey: "DASHSCOPE_API_KEY", note: "", supportsSpeaker: false, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] }
            ],
            regions: [{ id: "beijing", label: "北京（华北 2，默认）" }, { id: "singapore", label: "新加坡（需要 Workspace ID）" }],
            languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "da", label: "丹麦语 / Danish" }]
          },
          {
            id: "soniox",
            label: "Soniox STT",
            keyUrl: "https://console.soniox.com",
            apiKey: "",
            maskedApiKey: "",
            supportsSpeaker: true,
            multiLanguage: true,
            commonLanguages: ["zh", "en", "ja", "ko"],
            models: [{ id: "stt-async-v5", label: "Soniox Async STT（v5，上下文）", envKey: "SONIOX_API_KEY", note: "支持 general、text、terms 和 translation_terms 上下文", supportsSpeaker: true, supportsContext: true, languages: [{ id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }, { id: "ko", label: "韩语 / Korean" }, { id: "fr", label: "法语 / French" }, { id: "de", label: "德语 / German" }] }],
            regions: [],
            languages: [{ id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }, { id: "ko", label: "韩语 / Korean" }, { id: "fr", label: "法语 / French" }, { id: "de", label: "德语 / German" }]
          },
          {
            id: "local",
            label: "本地模型（Beta）",
            kind: "local",
            requiresApiKey: false,
            keyUrl: "",
            apiKey: "",
            maskedApiKey: "",
            supportsSpeaker: false,
            multiLanguage: false,
            commonLanguages: ["", "zh", "en", "ja", "ko", "fr", "de", "es", "ru"],
            models: [
              { id: "qwen3-asr-local", label: "Qwen3-ASR 0.6B（推荐）", envKey: "", note: "本地运行；首次准备会加载 Qwen3-ASR 与 Forced Aligner", supportsSpeaker: false, kind: "local", engine: "qwen-asr", modelRef: "Qwen/Qwen3-ASR-0.6B", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
              { id: "qwen3-asr-1.7b-local", label: "Qwen3-ASR 1.7B", envKey: "", note: "更高识别质量；与 0.6B 共用 Qwen3 Forced Aligner", supportsSpeaker: false, kind: "local", engine: "qwen-asr", modelRef: "Qwen/Qwen3-ASR-1.7B", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
              { id: "fun-asr-nano-local", label: "Fun-ASR-Nano 2512（GPU）", envKey: "", note: "LLM-ASR 路线；中英日及中文方言，建议使用 CUDA", supportsSpeaker: false, kind: "local", engine: "funasr", modelRef: "FunAudioLLM/Fun-ASR-Nano-2512", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "yue", label: "粤语 / Cantonese" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
              { id: "funasr-local", label: "FunASR paraformer-zh", envKey: "", note: "中文向 FunASR 路线；保留作为兼容选项", supportsSpeaker: false, kind: "local", engine: "funasr", modelRef: "paraformer-zh", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "en", label: "英语 / English" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
              { id: "sensevoice-small-local", label: "SenseVoice Small", envKey: "", note: "多语种本地识别；默认配合 FSMN-VAD，CPU/GPU 都可运行", supportsSpeaker: false, kind: "local", engine: "funasr", modelRef: "iic/SenseVoiceSmall", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "yue", label: "粤语 / Cantonese" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }, { id: "ko", label: "韩语 / Korean" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } }
            ],
            regions: [],
            languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }]
          },
          {
            id: "bcut",
            label: "必剪 ASR（非官方 · 免费 · 实验性）",
            keyUrl: "https://github.com/SocialSisterYi/bcut-asr",
            apiKey: "",
            maskedApiKey: "",
            supportsSpeaker: false,
            multiLanguage: false,
            requiresApiKey: false,
            supportsLanguage: false,
            note: "非官方免费接口：无需 API Key，仅支持中文，单文件上限 2 小时；接口可能随时变更、失效或触发限流，请勿高频调用。重要或批量任务建议使用上方正式供应商。",
            commonLanguages: [],
            models: [{ id: "bcut-asr", label: "必剪 ASR（免 Key / 仅中文）", envKey: "", note: "逐字毫秒时间戳；无需 API Key", supportsSpeaker: false, languages: [{ id: "", label: "中文（自动识别）" }] }],
            regions: [],
            languages: [{ id: "", label: "中文（自动识别）" }]
          }
        ]
      }),
      default_output: async ({ mediaPath, providerId, modelId, testRun }) => ({ ok: true, path: mediaPath ? mediaPath.replace(/\.[^.\\/]+$/, `${providerId === "soniox" ? ".soniox" : (providerId === "bcut" ? ".bcut" : (providerId === "local" ? (modelId.includes("sensevoice") ? ".sensevoice-local" : ((modelId.includes("funasr") || modelId.includes("fun-asr")) ? ".funasr-local" : (modelId.includes("1.7b") ? ".qwen3-asr-1.7b-local" : ".qwen-asr-local"))) : (modelId === "fun-asr" ? ".fun-asr" : (modelId === "qwen-audio-3.0-asr-flash-filetrans" ? ".qwen-audio" : ".qwen3-asr-api"))))}${testRun ? "-test" : ""}.srt`) : "" }),
      choose_file: async ({ kind }) => ({ ok: true, path: kind === "json" ? "D:\\Demo\\project.json" : (kind === "subtitle" ? "D:\\Demo\\project.mosp" : (kind === "video" ? "D:\\Demo\\clip.mp4" : (kind === "ffconcat" ? "D:\\Demo\\clip.ffconcat" : (kind === "script" ? "D:\\Demo\\script.txt" : (kind === "hotwords" ? "D:\\Demo\\hotwords.txt" : "D:\\Demo\\clip.mp4"))))) }),
      read_hotword_file: async () => ({ ok: true, path: "D:\\Demo\\hotwords.txt", text: "张三\n阿里云百炼\n专业术语\n" }),
      save_settings: async (payload) => { saved = { ...saved, ...payload }; if (Object.prototype.hasOwnProperty.call(payload, "modelCacheRoot")) { state.config.modelCacheRoot = payload.modelCacheRoot || ""; state.config.localRuntime = { ...(state.config.localRuntime || {}), modelCachePath: payload.modelCacheRoot || "D:\\Models\\MAW" }; } return { ok: true, maskedApiKey: payload.apiKey ? "sk-…mock" : "", modelCacheRoot: Object.prototype.hasOwnProperty.call(payload, "modelCacheRoot") ? (payload.modelCacheRoot || "") : (state.config?.modelCacheRoot || ""), message: "mock saved" }; },
      get_local_runtime: async () => ({ ok: true, ...(state.config?.localRuntime || { status: "missing", ready: false }) }),
      install_local_runtime: async () => { state.config.localRuntime = { status: "ready", ready: true, path: "D:\\Users\\Demo\\AppData\\Local\\MAW\\local-runtime", detail: "本地运行环境已就绪。" }; setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "localRuntimeReady", runtime: state.config.localRuntime }), 400); return { ok: true, installing: true }; },
      cancel_local_runtime: async () => ({ ok: true }),
      get_ocr_runtime: async () => ({ ok: true, ...(state.config?.ocrRuntime || { status: "missing", ready: false }), models: state.config?.ocrModels || [] }),
      save_ocr_settings: async ({ runtimePath }) => { state.config.ocrRuntime = { ...(state.config.ocrRuntime || {}), path: runtimePath || "D:\\Users\\Demo\\AppData\\Local\\MAW\\ocr-runtime" }; return { ok: true, runtimePath: state.config.ocrRuntime.path, runtime: state.config.ocrRuntime }; },
      install_ocr_runtime: async () => { state.config.ocrRuntime = { ...(state.config.ocrRuntime || {}), status: "ready", ready: true, modelInstalled: true, detail: "OCR 模型已安装，可以在工具箱中使用。" }; state.config.ocrModels = (state.config.ocrModels || []).map((model) => ({ ...model, installed: true, status: "installed", detail: state.config.ocrRuntime.detail })); setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "ocrRuntimeReady", runtime: state.config.ocrRuntime, models: state.config.ocrModels }), 400); return { ok: true, installing: true }; },
      cancel_ocr_runtime: async () => ({ ok: true }),
      get_local_models: async ({ modelId, modelPath }) => ({ ok: true, runtime: state.config?.localRuntime || {}, models: (state.config?.providers.find((item) => item.id === "local")?.models || []).map((model) => ({ ...model, localStatus: { ...(model.localStatus || {}), ...(model.id === modelId && modelPath ? { status: "installed", installed: true, path: modelPath, detail: "已使用指定的模型目录。" } : {}) } })) }),
      prepare_local_model: async ({ modelId }) => { clearTimeout(modelPrepareTimer); modelPrepareTimer = setTimeout(() => { state.config?.providers.find((item) => item.id === "local")?.models.forEach((model) => { if (model.id === modelId) model.localStatus = { ...(model.localStatus || {}), status: "installed", installed: true, runtimeAvailable: true, canPrepare: false, detail: "已检测到本地模型。" }; }); window.MAWLauncher.onBackendEvent({ type: "modelPrepared", modelId }); }, 400); return { ok: true, preparing: true, modelId }; },
      cancel_local_model: async () => { clearTimeout(modelPrepareTimer); setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "localPrepareCancelled" }), 80); return { ok: true, cancelling: true }; },
       save_prefs: async (payload) => { if (Object.prototype.hasOwnProperty.call(payload, "modelId")) localStorage.setItem(LAST_MODEL_KEY, payload.modelId || ""); if (Object.prototype.hasOwnProperty.call(payload, "language")) localStorage.setItem(LAST_LANGUAGE_KEY, payload.language || ""); if (Object.prototype.hasOwnProperty.call(payload, "showRareLangs")) saved.showRareLangs = Boolean(payload.showRareLangs); if (Object.prototype.hasOwnProperty.call(payload, "zoomPercent")) localStorage.setItem(ZOOM_PERCENT_KEY, String(payload.zoomPercent)); return { ok: true, zoomPercent: Number(localStorage.getItem(ZOOM_PERCENT_KEY)) || ZOOM_DEFAULT }; },
      open_url: async ({ url }) => { window.open(url, "_blank"); return { ok: true }; },
      open_blank_html: async () => ({ ok: true }),
      check_ffmpeg: async () => ({ ok: true, found: true, directory: "D:\\FFmpeg\\bin", ffmpeg: "D:\\FFmpeg\\bin\\ffmpeg.exe", ffprobe: "D:\\FFmpeg\\bin\\ffprobe.exe" }),
      save_ffmpeg_path: async ({ path }) => ({ ok: Boolean(path), found: Boolean(path), directory: path || "", ffmpeg: path || "", ffprobe: path || "" }),
      choose_folder: async ({ kind } = {}) => ({ ok: true, path: kind === "model-cache" ? "D:\\Models\\MAW" : (kind === "ocr-runtime" ? "D:\\Models\\MAW\\ocr-runtime" : "D:\\Stickers") }),
      save_sticker_dir: async ({ path }) => { saved.stickerDir = path || ""; return { ok: Boolean(path), stickerDir: saved.stickerDir, field: path ? "" : "stickerDir", error: path ? "" : "missing" }; },
      save_postprocess_settings: async ({ providerId, apiKey, displayName, reasoningMode }) => { if (providerId === "custom") saved.customDisplayName = displayName || ""; return { ok: true, providerId, label: providerId === "custom" ? (displayName || "Custom (OpenAI-compatible)") : (providerId === "deepseek" ? "DeepSeek" : (providerId === "zhipu" ? "智谱 Coding Plan" : "阿里云 Qwen")), displayName: providerId === "custom" ? (displayName || "") : "", maskedApiKey: apiKey ? "sk-…mock" : "", reasoningMode: reasoningMode || "off", verified: false }; },
      test_postprocess_connection: async ({ providerId }) => ({ ok: true, providerId, verified: true }),
      save_postprocess_plan: async ({ plan }) => { saved.postprocessAutoPlan = plan; return { ok: true, plan }; },
      validate_postprocess_plan: async ({ plan }) => ({ ok: true, plan, errors: [] }),
      get_postprocess_models: async ({ providerId }) => ({ ok: true, providerId, models: providerId === "qwen" ? ["qwen-plus", "qwen3-max"] : (providerId === "zhipu" ? ["glm-5.2", "glm-4.5"] : (providerId === "custom" ? ["local-model"] : ["deepseek-v4-flash", "deepseek-chat"])) }),
      open_file: async ({ path }) => ({ ok: Boolean(path) }),
      open_containing_folder: async ({ path }) => ({ ok: Boolean(path) }),
      retry_postprocess: async () => ({ ok: false, error: "No failed automatic post-processing run." }),
      run_script_match: async ({ projectPath, srtPath, outputMode }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "matched", "D:\\Demo\\clip.matched.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "matched", "D:\\Demo\\clip.matched.srt"), warnings: [] }),
      run_ocr_dedup: async ({ projectPath, srtPath, outputMode, report }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "ocr-dedup", "D:\\Demo\\clip.ocr-dedup.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "ocr-dedup", "D:\\Demo\\clip.ocr-dedup.srt"), reportPath: report ? "D:\\Demo\\clip.ocr-dedup.csv" : "", warnings: ["OCR 字幕去重完成：新增禁用 1 条，已有禁用 0 条，实际 OCR 1 条，跳过 0 条。"] }),
      run_llm_postprocess: async ({ projectPath, srtPath, outputMode }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "llm", "D:\\Demo\\clip.llm.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "llm", "D:\\Demo\\clip.llm.srt"), warnings: [] }),
      run_fixed_process: async ({ projectPath, srtPath, outputMode }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "fixed", "D:\\Demo\\clip.fixed.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "fixed", "D:\\Demo\\clip.fixed.srt"), warnings: [] }),
      run_fixed_replacement: async (payload) => window.MAWLauncher.callBackend("run_fixed_process", payload),
      run_ffconcat_rebuild: async () => ({ ok: true, mediaPath: "D:\\Demo\\clip.gap-removed.mp4" }),
      generate_waveform_project: async ({ mediaPath }) => ({ ok: true, mediaPath, projectPath: "D:\\Demo\\clip.waveform.mosp", warnings: [], reapeaksPath: "" }),
      check_server_media: async ({ jsonPath }) => ({ ok: Boolean(jsonPath), hasMedia: Boolean(jsonPath), mediaPath: "D:\\Demo\\clip.mp4", mediaExists: Boolean(jsonPath) }),
      start_server: async () => { setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "log", message: "[mock] would open http://127.0.0.1:8250/ after server responds" }), 120); return { ok: true, url: "http://127.0.0.1:8250/" }; },
      get_server_status: async ({ port = "8250" }) => ({ ok: true, running: false, url: `http://127.0.0.1:${port}/` }),
      stop_server: async () => ({ ok: true }),
       start_transcription: async () => { setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "log", message: "[mock] 上传完成" }), 250); setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "done", result: { srtPath: "D:\\Demo\\clip.srt", jsonPath: "D:\\Demo\\clip.json", htmlPath: "D:\\Demo\\clip.edit.html" } }), 900); return { ok: true }; },
       cancel_transcription: async () => { setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "error", code: "transcription_cancelled", detail: "Transcription cancelled" }), 120); return { ok: true }; },
      start_batch_transcription: async ({ items }) => {
        window.MAWLauncher.onBackendEvent({ type: "batchStarted", total: items.length });
        items.forEach((item, index) => {
          setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "batchItem", itemId: item.id, index, mediaPath: item.mediaPath, status: "running" }), index * 650 + 100);
          setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "batchItemLog", itemId: item.id, index, message: `[mock] ${item.mediaPath}` }), index * 650 + 250);
          setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "batchItem", itemId: item.id, index, mediaPath: item.mediaPath, status: "done", result: { srtPath: item.mediaPath.replace(/\.[^.\\/]+$/u, ".srt"), jsonPath: item.mediaPath.replace(/\.[^.\\/]+$/u, ".mosp") } }), index * 650 + 550);
        });
        setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "batchDone", total: items.length, cancelled: false }), items.length * 650 + 600);
        return { ok: true };
      },
      cancel_batch_transcription: async () => { setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "batchDone", cancelled: true }), 120); return { ok: true }; },
      open_output_folder: async () => ({ ok: true }),
      open_html: async () => ({ ok: true }),
      get_emoji_font_path: async () => ({ ok: true, path: "" })
    };
  }

  const t = (key) => STRINGS[state.lang][key] || key;
  function compactDetail(detail) { return String(detail || "").replace(/\s+/g, " ").trim(); }
  function errText(code, detail) { const entry = ERROR_TEXT[state.lang][code]; const compact = compactDetail(detail); if (typeof entry === "function") return entry(compact); return entry || compact || t("failed"); }
  const ext = (path) => (path.match(/\.[^.\\/]+$/)?.[0] || "").toLowerCase();
  const provider = () => state.config.providers.find((item) => item.id === $("provider").value) || state.config.providers[0];
  const selectedModel = () => provider().models.find((item) => item.id === $("model").value) || provider().models[0];
  function appendMessageText(container, text) {
    String(text).split("\n").forEach((part, index) => {
      if (index > 0) container.append(document.createElement("br"));
      if (part) container.append(document.createTextNode(part));
    });
  }
  function renderMessage(container, message) {
    container.replaceChildren();
    const value = String(message || "");
    const urlPattern = /https?:\/\/[^\s<>"'|)\]}，。；：！？）】》」』]+/gi;
    let cursor = 0;
    for (const match of value.matchAll(urlPattern)) {
      const index = match.index ?? cursor;
      const rawUrl = match[0];
      const url = rawUrl.replace(/[),.;:!?，。；：！？）】》]+$/u, "");
      const trailing = rawUrl.slice(url.length);
      if (index > cursor) appendMessageText(container, value.slice(cursor, index));
      if (!url) {
        appendMessageText(container, rawUrl);
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.textContent = url;
        link.className = "status-link";
        link.addEventListener("click", (event) => { event.preventDefault(); bridge("open_url", { url }); });
        container.append(link);
        if (trailing) appendMessageText(container, trailing);
      }
      cursor = index + rawUrl.length;
    }
    if (cursor < value.length) appendMessageText(container, value.slice(cursor));
  }
  const setStatus = (message) => { if (state.detectedServerUrl) setServerStatus(state.detectedServerUrl, true, message); else renderMessage($("status"), message); };
  function setServerStatus(url, alreadyRunning = false, prefix = "") {
    const status = $("status");
    status.replaceChildren();
    if (prefix) { renderMessage(status, prefix); status.append(document.createTextNode(" ")); }
    status.append(document.createTextNode(alreadyRunning ? `${t("server_already_running")} ` : `${t("server_address")} `));
    const link = document.createElement("a");
    link.href = url;
    link.textContent = url;
    link.className = "status-link";
    link.addEventListener("click", (event) => { event.preventDefault(); bridge("open_url", { url }); });
    status.append(link);
  }
  const appendLog = (text, { inline = false } = {}) => { const log = $("log"); const needsSpace = inline && log.textContent && !log.textContent.endsWith("\n"); log.textContent += `${needsSpace ? " " : ""}${text}${inline ? "" : "\n"}`; log.scrollTop = log.scrollHeight; state.lastLogMessage = text; const latest = $("logLatest"); const inlineLatest = inline && latest.dataset.inline === "true"; latest.textContent = inlineLatest ? `${latest.textContent} ${text}` : text; latest.dataset.inline = String(inline); latest.classList.remove("hidden"); };
  function confirmAction(message) { $("batchConfirmMessage").textContent = String(message || ""); $("batchConfirmModal").classList.remove("hidden"); $("batchConfirmYes").focus(); return new Promise((resolve) => { window.MAWLauncher.confirmResolve = resolve; }); }
  function finishConfirm(value) { const resolve = window.MAWLauncher.confirmResolve; window.MAWLauncher.confirmResolve = null; $("batchConfirmModal").classList.add("hidden"); resolve?.(value); }

  function resolveTheme() { if (state.theme === "light" || state.theme === "dark") return state.theme; return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
  function applyTheme() { if (resolveTheme() === "light") document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme; $("themeLight").classList.toggle("active", state.theme === "light"); $("themeDark").classList.toggle("active", state.theme === "dark"); $("themeSystem").classList.toggle("active", state.theme === "system"); }
  function setTheme(pref) { state.theme = pref; try { localStorage.setItem(THEME_KEY, pref); } catch (error) { /* localStorage 不可用时仅作用于本次会话 */ } applyTheme(); }

  // keycap 表情（1️⃣ 等）依赖彩色 emoji 字体：后端把 Noto Color Emoji 缓存到本机
  // 后提供 file:// URI，这里注入 @font-face；注入一次即可，重复事件会被跳过。
  function injectEmojiFont(uri) {
    if (!uri || document.querySelector("style[data-emoji-font]")) return;
    const style = document.createElement("style");
    style.dataset.emojiFont = "1";
    style.textContent = `@font-face{font-family:"MAW Emoji";src:url("${uri}") format("truetype");font-weight:400;font-display:swap;}`;
    document.head.appendChild(style);
  }

  async function bridge(method, payload = {}) {
    try {
      return await api[method](payload);
    } catch (error) {
      const message = `${method}: ${error && error.message ? error.message : error}`;
      appendLog(`[bridge] ${message}`);
      setStatus(message);
      return { ok: false, error: message };
    }
  }

  function waitForBackend(timeoutMs = 1800) {
    if (window.pywebview && window.pywebview.api) return Promise.resolve(window.pywebview.api);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      window.addEventListener("pywebviewready", () => finish(window.pywebview && window.pywebview.api ? window.pywebview.api : null), { once: true });
      setTimeout(() => finish(window.pywebview && window.pywebview.api ? window.pywebview.api : null), timeoutMs);
    });
  }

  function setRunning(running) { state.running = running; $("progress").classList.toggle("hidden", !running); $("start").classList.toggle("hidden", running); $("stop").classList.toggle("hidden", !running); $("start").disabled = running; $("stop").disabled = !running; setStatus(running ? t("running") : t("ready")); }
  function fillSelect(id, items, value) { const el = $(id); el.innerHTML = ""; items.forEach((item) => el.add(new Option(item.label, item.id))); el.value = value ?? ""; }
  function setError(field, message) { const input = $(field); const hint = $(`${field}Error`); if (input) input.classList.toggle("invalid", Boolean(message)); if (hint) { renderMessage(hint, message); hint.classList.toggle("visible", Boolean(message)); } }
  function setOutputNotice(message) { const notice = $("srtPathNotice"); if (!notice) return; renderMessage(notice, message); notice.classList.toggle("hidden", !message); }
  function mediaDropError() { const separator = state.lang === "zh" ? "、" : ", "; return t("drop_reject_media").replace("{extensions}", Array.from(MEDIA_EXTS).join(separator)); }
  function clearErrors() { ["mediaPath", "srtPath", "apiKey", "workspaceId", "localModelPath", "localModelCachePath", "maxLen", "minLen", "gapSplit", "qwenAudioContext", "qwenAudioHotwords", "qwenAudioHotwordsFile", "sonioxContextGeneral", "sonioxContextText", "sonioxContextTerms", "sonioxContextTranslationTerms", "jsonPath", "serverMediaPath", "port", "ffmpegPath", "stickerDir"].forEach((field) => setError(field, "")); }
  function formPayload() { return { providerId: $("provider").value, modelId: $("model").value, mediaPath: $("mediaPath").value.trim(), srtPath: $("srtPath").value.trim(), apiKey: $("apiKey").value.trim(), region: $("region").value, workspaceId: $("workspaceId").value.trim(), localModelPath: $("localModelPath").value.trim(), device: $("localDevice").value, language: languageValue(), lengthLimit: $("lengthLimit").value.trim(), maxLen: $("maxLen").value.trim(), minLen: $("minLen").value.trim(), gapSplit: $("gapSplit").value.trim(), qwenAudioContext: $("qwenAudioContext").value.trim(), qwenAudioHotwordsMode: $("qwenAudioHotwordsMode").value, qwenAudioHotwords: $("qwenAudioHotwords").value.trim(), qwenAudioHotwordsFile: $("qwenAudioHotwordsFile").value.trim(), qwenAudioHotwordWeight: $("qwenAudioHotwordWeight").value, sonioxContextGeneral: $("sonioxContextGeneral").value.trim(), sonioxContextText: $("sonioxContextText").value.trim(), sonioxContextTerms: $("sonioxContextTerms").value.trim(), sonioxContextTranslationTerms: $("sonioxContextTranslationTerms").value.trim(), testRun: $("testRun").checked, debugRaw: $("debugRaw").checked, speakerColors: $("speakerColors").checked, generateSpectral: $("generateSpectral").checked, generateHtml: $("generateHtml").checked, autoPostprocess: window.MAWLauncher?.getAutoPostprocessPayload?.() || null, guiLang: state.lang }; }
  function serverPayload() { return { jsonPath: $("jsonPath").value.trim(), mediaPath: $("serverMediaPath").value.trim(), port: $("port").value || "8250", guiLang: state.lang }; }
  function renderServerButton() {
    const button = $("openMawe");
    if (!button) return;
    button.textContent = state.serverStarting
      ? SERVER_STARTING_TEXT[state.lang]
      : ((state.serverRunning || state.detectedServerUrl) ? t("open_editor") : t("start_server_editor"));
    button.disabled = state.serverStarting;
    $("stopServer").classList.toggle("hidden", !state.serverRunning && !state.detectedServerUrl);
    $("stopServer").disabled = state.serverStarting;
  }
  async function stopEditorServer() { const result = await bridge("stop_server", serverPayload()); if (!result.ok) { applyErrorResult(result); return; } state.serverRunning = false; state.serverProjectPath = ""; state.detectedServerUrl = ""; renderServerButton(); setStatus(t("ready")); }
  async function checkExistingServer(prefix = "") { const previousUrl = state.detectedServerUrl; state.detectedServerUrl = ""; const result = await bridge("get_server_status", serverPayload()); if (!result.ok || !result.running || !result.url) { state.serverRunning = false; state.serverProjectPath = ""; if (prefix) setStatus(`${prefix}，${t("server_start_hint")}`); else if (previousUrl) setStatus(t("ready")); renderServerButton(); return; } const isExternalServer = !state.serverRunning; state.detectedServerUrl = isExternalServer ? result.url : ""; setServerStatus(result.url, isExternalServer, prefix); renderServerButton(); }
  function syncHtmlMenu() { const enabled = $("generateHtml").checked; $("openHtml").classList.toggle("hidden", !enabled); $("openHtml").disabled = enabled && !state.result?.htmlPath; }
  function renderChevron(id) { const arrow = $(id).querySelector(".chevron"); if (arrow) arrow.textContent = $(id).classList.contains("collapsed") ? "▸" : "▾"; }
  function renderStickerCurrent() { $("stickerCurrent").textContent = state.config?.stickerDir || t("unset"); $("stickerDir").value = state.config?.stickerDir || ""; }
  async function saveStickerDirectory(path) { $("stickerDir").value = path; const result = await bridge("save_sticker_dir", { path }); setError("stickerDir", result.ok ? "" : errText(result.code, result.detail || result.error)); if (result.ok) { state.config.stickerDir = result.stickerDir; renderStickerCurrent(); setStatus(t("saved")); } else setStatus(errText(result.code, result.detail || result.error)); return result; }
  function renderKeyStatus() { const masked = state.config && !isLocalProvider() ? provider().maskedApiKey : ""; $("keyStatus").textContent = masked ? t("key_loaded").replace("{key}", masked) : t("key_empty"); }
  function syncQwenAudioOptions(model) { const enabled = provider().id === "qwen" && Boolean(model?.supportsContext || model?.supportsHotwords); $("qwenAudioOptions").classList.toggle("hidden", !enabled); $("qwenAudioContextField").classList.toggle("hidden", !(provider().id === "qwen" && model?.supportsContext)); $("qwenAudioHotwordsSection").classList.toggle("hidden", !(provider().id === "qwen" && model?.supportsHotwords)); syncQwenAudioHotwordsMode(); }
  function syncSonioxContextOptions(model) { const enabled = provider().id === "soniox" && Boolean(model?.supportsContext); $("sonioxContextOptions").classList.toggle("hidden", !enabled); }
  function renderPromptCharacterCount() { const count = Array.from($("qwenAudioContext").value).length; const counter = $("qwenAudioContextCount"); counter.textContent = t("qwen_audio_context_count").replace("{count}", String(count)); counter.classList.toggle("over-limit", count > 400); }
  function renderSonioxContextCharacterCount() { const value = [$("sonioxContextGeneral").value, $("sonioxContextText").value, $("sonioxContextTerms").value, $("sonioxContextTranslationTerms").value].join("\n"); const count = Array.from(value).length; const counter = $("sonioxContextCount"); counter.textContent = t("soniox_context_count").replace("{count}", String(count)); counter.classList.toggle("over-limit", count > 10000); }
  function splitHotwordEntries(value, ignoreComments = false) { return String(value || "").split(/[\n,，;；]+/u).map((word) => word.trim()).filter((word) => word && (!ignoreComments || !word.startsWith("#"))); }
  function parseHotwordEntry(value, defaultWeight) { const match = value.match(/^(.+?)\s*[:：]\s*(\d+)\s*$/u); const text = (match ? match[1] : value).trim(); if (!text) return { code: "empty" }; const weight = match ? Number(match[2]) : defaultWeight; if (!HOTWORD_WEIGHTS.has(weight)) return { code: "invalid_weight" }; const chars = Array.from(text).length; if (Array.from(text).some((char) => char.codePointAt(0) > 127) && chars > 15) return { code: "text_too_long" }; if (!Array.from(text).some((char) => char.codePointAt(0) > 127) && text.split(/\s+/u).filter(Boolean).length > 7) return { code: "too_many_ascii_words" }; return { text, weight }; }
  function collectHotwordWarnings(value, weight, ignoreComments = false) { const parsed = new Map(); const issues = []; splitHotwordEntries(value, ignoreComments).forEach((raw, index) => { const entry = parseHotwordEntry(raw, weight); if (entry.code) { issues.push({ index: index + 1, code: entry.code, text: raw }); return; } parsed.set(entry.text, { index: index + 1, entry }); }); let validCount = 0; let superCount = 0; Array.from(parsed.values()).sort((left, right) => left.index - right.index).forEach(({ index, entry }) => { if (validCount >= MAX_HOTWORDS) { issues.push({ index, code: "too_many", text: entry.text }); return; } if (entry.weight === 50 && superCount >= MAX_SUPER_HOTWORDS) { issues.push({ index, code: "too_many_super", text: entry.text }); return; } validCount += 1; if (entry.weight === 50) superCount += 1; }); return issues; }
  function hotwordWarningLabel(issue) { const text = String(issue.text || "").trim(); if (!text) return t("qwen_audio_hotword_warning_index").replace("{index}", String(issue.index)); const chars = Array.from(text); const truncated = chars.length > 16 ? `${chars.slice(0, 16).join("")}…` : text; return state.lang === "zh" ? `「${truncated}」` : `“${truncated}”`; }
  function renderHotwordWarnings(value = $("qwenAudioHotwords").value, weight = Number($("qwenAudioHotwordWeight").value), ignoreComments = false) { const warning = $("qwenAudioHotwordsWarning"); const issues = collectHotwordWarnings(value, weight, ignoreComments); if (!issues.length) { warning.textContent = ""; warning.classList.remove("visible"); return; } const details = issues.slice(0, 5).map((issue) => t("qwen_audio_hotword_warning_item").replace("{label}", hotwordWarningLabel(issue)).replace("{reason}", t(`qwen_audio_hotword_issue_${issue.code}`))); if (issues.length > details.length) details.push(t("qwen_audio_hotword_warning_more")); warning.textContent = `${t("qwen_audio_hotwords_warning").replace("{count}", String(issues.length))}\n${details.join("\n")}`; warning.classList.add("visible"); }
  function syncQwenAudioHotwordsMode() { const fileMode = $("qwenAudioHotwordsMode").value === "file"; $("qwenAudioHotwordsTextField").classList.toggle("hidden", fileMode); $("qwenAudioHotwordsFileField").classList.toggle("hidden", !fileMode); renderHotwordWarnings(fileMode ? "" : $("qwenAudioHotwords").value, Number($("qwenAudioHotwordWeight").value)); }
  function setHotwordsMode(mode) { $("qwenAudioHotwordsMode").value = mode; $("qwenAudioHotwordsModeText").classList.toggle("active", mode === "text"); $("qwenAudioHotwordsModeFile").classList.toggle("active", mode === "file"); syncQwenAudioHotwordsMode(); }
  function clearDropState() { dragState.depth = 0; state.dropTarget = ""; setDropHighlight(false); ["qwenAudioHotwords", "qwenAudioHotwordsFile", "jsonPath", "toolboxInputDropZone", "toolboxUtilityMediaDropZone", "toolboxFfconcatDropZone", "ocrVideoPathField", "postprocessScriptPath"].forEach((id) => $(id)?.classList.remove("drag-over")); }
  function setQwenAudioHotwordsFile(path) { if (ext(path) !== ".txt") { setError("qwenAudioHotwordsFile", errText("hotwords_file_missing", "")); return false; } $("qwenAudioHotwordsFile").value = path; setHotwordsMode("file"); setError("qwenAudioHotwordsFile", ""); return true; }
  async function loadHotwordFile(path, appendToText = false) { if (ext(path) !== ".txt") { setError("qwenAudioHotwordsFile", errText("hotwords_file_missing", "")); clearDropState(); return; } const result = await bridge("read_hotword_file", { path }); if (!result.ok) { applyErrorResult(result, false); clearDropState(); return; } if (appendToText) { const incoming = String(result.text || "").trim(); if (incoming) { const current = $("qwenAudioHotwords").value.trimEnd(); $("qwenAudioHotwords").value = current ? `${current}\n${incoming}` : incoming; } setHotwordsMode("text"); renderHotwordWarnings($("qwenAudioHotwords").value); setStatus(t("qwen_audio_hotwords_loaded")); } else { setQwenAudioHotwordsFile(result.path || path); renderHotwordWarnings(String(result.text || ""), Number($("qwenAudioHotwordWeight").value), true); } clearDropState(); }
  function isLocalProvider() { return provider()?.kind === "local" || provider()?.id === "local"; }
  function localStatus() { return selectedModel()?.localStatus || {}; }
  function renderLocalRuntime() {
    if (!isLocalProvider()) return;
    const runtime = state.config.localRuntime || {};
    const installing = state.localRuntimeInstalling;
    const key = installing ? "local_runtime_installing" : ({ ready: "local_runtime_ready", broken: "local_runtime_broken", missing: "local_runtime_missing" }[runtime.status] || "local_runtime_missing");
    const target = $("localRuntimeStatus");
    target.textContent = installing && state.localRuntimeProgressMessage ? state.localRuntimeProgressMessage : t(key);
    target.className = `local-status ${installing ? "warn" : (runtime.ready ? "ready" : "warn")}`;
    const location = [runtime.path && `${t("local_runtime_path")}${runtime.path}`, runtime.modelCachePath && `${t("local_model_cache_path")}${runtime.modelCachePath}`].filter(Boolean).join("\n");
    $("localRuntimeHint").textContent = [runtime.detail || (runtime.ready ? t("local_runtime_ready_hint") : t("local_runtime_hint")), location].filter(Boolean).join("\n");
    $("localModelCachePath").value = state.config.modelCacheRoot || runtime.modelCachePath || $("localModelCachePath").value || "";
    const button = $("installLocalRuntime");
    button.disabled = false;
    button.classList.toggle("hidden", !installing && runtime.status === "ready");
    button.textContent = installing ? t("local_runtime_cancel") : (runtime.status === "ready" ? t("local_runtime_repair") : t("local_runtime_install"));
    $("refreshLocalRuntime").disabled = installing;
    const progress = $("localRuntimeProgress");
    progress.classList.toggle("hidden", !installing);
    $("localRuntimeProgressBar").style.width = `${Math.max(0, Math.min(100, state.localRuntimeProgress))}%`;
    $("localRuntimeProgressMessage").textContent = state.localRuntimeProgressMessage || "";
  }
  function renderOcrRuntime() {
    const runtime = state.config?.ocrRuntime || {};
    const installing = state.ocrRuntimeInstalling;
    const key = installing ? "ocr_runtime_installing" : ({ ready: "ocr_runtime_ready", broken: "ocr_runtime_broken", missing: "ocr_runtime_missing" }[runtime.status] || "ocr_runtime_missing");
    const target = $("ocrRuntimeStatus");
    target.textContent = installing && state.ocrRuntimeProgressMessage ? state.ocrRuntimeProgressMessage : t(key);
    target.className = `local-status ${installing ? "warn" : (runtime.ready ? "ready" : "warn")}`;
    $("ocrRuntimePath").value = runtime.path || $("ocrRuntimePath").value || "";
    const location = runtime.path ? `${t("ocr_runtime_path")}: ${runtime.path}` : "";
    $("ocrRuntimeHint").textContent = [runtime.detail || (runtime.ready ? t("ocr_runtime_ready") : t("settings_ocr_hint")), location].filter(Boolean).join("\n");
    const button = $("installOcrRuntime");
    button.disabled = false;
    button.classList.toggle("hidden", !installing && runtime.status === "ready");
    button.textContent = installing ? t("ocr_runtime_cancel") : (runtime.status === "broken" ? t("ocr_runtime_repair") : t("ocr_runtime_install"));
    $("refreshOcrRuntime").disabled = installing;
    const progress = $("ocrRuntimeProgress");
    progress.classList.toggle("hidden", !installing);
    $("ocrRuntimeProgressBar").style.width = `${Math.max(0, Math.min(100, state.ocrRuntimeProgress))}%`;
    $("ocrRuntimeProgressMessage").textContent = state.ocrRuntimeProgressMessage || "";
    window.MAWLauncher?.onOcrRuntimeChanged?.();
  }
  async function refreshOcrRuntime() {
    const result = await bridge("get_ocr_runtime");
    if (!result.ok) { applyErrorResult(result); return result; }
    state.config.ocrRuntime = result;
    state.config.ocrModels = result.models || state.config.ocrModels || [];
    renderOcrRuntime();
    return result;
  }
  async function saveOcrRuntimePath(path) {
    const value = String(path || "").trim();
    const result = await bridge("save_ocr_settings", { runtimePath: value });
    if (!result.ok) {
      applyErrorResult(result);
      return result;
    }
    state.config.ocrRuntime = result.runtime || state.config.ocrRuntime || {};
    state.config.ocrRuntime.path = result.runtimePath || value;
    renderOcrRuntime();
    setError("ocrRuntimePath", "");
    setStatus(t("saved"));
    return result;
  }
  function renderLocalModelStatus() {
    if (!isLocalProvider()) { $("model").disabled = false; return; }
    const status = localStatus();
    const preparing = state.localPreparing;
    const target = $("localModelStatus");
    const key = status.status === "installed" && status.path ? "local_path_selected" : ({ installed: "local_installed", partial: "local_partial", runtime_missing: "local_runtime_missing", path_mismatch: "local_model_path_mismatch", missing: "local_missing" }[status.status] || "local_missing");
    target.textContent = preparing && state.localProgressMessage ? state.localProgressMessage : t(key);
    target.className = `local-status ${preparing ? "warn" : (status.status === "installed" ? "ready" : "warn")}`;
    $("localModelHint").textContent = status.detail || t("local_prepare_hint");
    $("localModelPath").value = status.path || $("localModelPath").value || "";
    const canPrepare = Boolean(status.canPrepare) && !preparing;
    const button = $("prepareLocalModel");
    button.disabled = preparing ? false : !canPrepare;
    button.classList.toggle("hidden", !preparing && status.status === "installed");
    button.textContent = preparing ? t("local_prepare_cancel") : (status.status === "installed" ? t("local_prepare_again") : t("local_prepare"));
    $("model").disabled = preparing;
    $("localModelProgress").classList.toggle("hidden", !preparing);
    const progress = state.localProgress || {};
    const percent = Number(progress.percent);
    const determinate = Number.isFinite(percent);
    const track = $("localModelProgressTrack");
    const bar = $("localModelProgressBar");
    track.classList.toggle("indeterminate", !determinate);
    bar.style.width = determinate ? `${Math.max(0, Math.min(99, percent))}%` : "";
    $("localModelProgressMessage").textContent = state.localProgressMessage || "";
  }
  async function refreshLocalRuntime() {
    if (!isLocalProvider()) return;
    const result = await bridge("get_local_runtime");
    if (!result.ok) { applyErrorResult(result); return result; }
    state.config.localRuntime = result;
    state.config.modelCacheRoot = result.modelCachePath || state.config.modelCacheRoot || "";
    renderLocalRuntime();
    return result;
  }
  async function refreshLocalModels() {
    if (!isLocalProvider()) return;
    const result = await bridge("get_local_models", { modelId: $("model").value, modelPath: $("localModelPath").value.trim() });
    if (!result.ok) { applyErrorResult(result); return result; }
    if (result.runtime) {
      state.config.localRuntime = result.runtime;
      state.config.modelCacheRoot = result.runtime.modelCachePath || state.config.modelCacheRoot || "";
    }
    const models = result.models || [];
    models.forEach((item) => { const local = provider().models.find((model) => model.id === item.id); if (local && item.localStatus) local.localStatus = item.localStatus; });
    renderLocalModelStatus();
    renderLocalRuntime();
    return result;
  }
  function syncLocalModelPath(model) {
    if (!isLocalProvider()) return;
    if (state.localModelId && state.localModelId !== model.id) state.localModelPaths[state.localModelId] = $("localModelPath").value.trim();
    $("localModelPath").value = state.localModelPaths[model.id] || "";
    state.localModelId = model.id;
    setError("localModelPath", "");
  }
  async function saveLocalModelCache(path) {
    const value = String(path || "").trim();
    const result = await bridge("save_settings", { providerId: "local", modelId: $("model").value, apiKey: "", guiLang: state.lang, modelCacheRoot: value });
    if (!result.ok) {
      applyErrorResult(result);
      setStatus(errText(result.code, result.detail || result.error));
      return result;
    }
    state.config.modelCacheRoot = result.modelCacheRoot || value;
    await refreshLocalRuntime();
    await refreshLocalModels();
    setError("localModelCachePath", "");
    setStatus(t("saved"));
    return result;
  }
  function renderLanguage() { document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en"; document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); }); document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); }); document.querySelectorAll("[data-i18n-title]").forEach((node) => { node.title = t(node.dataset.i18nTitle); }); document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => { node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel)); }); $("langToggle").textContent = t("other_language"); $("demoBadge").textContent = t("demo_mode"); renderKeyStatus(); renderStickerCurrent(); renderPromptCharacterCount(); renderSonioxContextCharacterCount(); renderHotwordWarnings(); renderServerButton(); renderLocalRuntime(); renderOcrRuntime(); renderLocalModelStatus(); window.MAWLauncher?.onLanguageChanged?.(); }
  function applyProvider(persistReset = false) { const current = provider(); const preferred = state.config.lastModel; const fallback = state.config.modelId || current.models[0]?.id; const modelValue = current.models.some((item) => item.id === preferred) ? preferred : (current.models.some((item) => item.id === fallback) ? fallback : current.models[0]?.id); fillSelect("model", current.models, modelValue); fillSelect("region", current.regions, state.config.region || "beijing"); const local = isLocalProvider(); $("apiKeyField").classList.toggle("hidden", local || current.requiresApiKey === false); $("localRuntimePanel").classList.toggle("hidden", !local); $("localModelPanel").classList.toggle("hidden", !local); $("localDeviceField").classList.toggle("hidden", !local); $("openKeyUrl").classList.toggle("hidden", local || current.requiresApiKey === false); $("apiKey").value = current.apiKey || ""; $("openKeyUrl").textContent = current.label; $("providerNote").textContent = current.note || ""; $("providerNote").classList.toggle("hidden", !current.note); applySelectedModel(persistReset); $("regionField").classList.toggle("hidden", !SHOW_REGIONAL_FIELDS || current.regions.length === 0); renderKeyStatus(); syncWorkspace(); syncAdvancedParamsGroup(); if (local) { renderLocalRuntime(); void refreshLocalRuntime(); void refreshLocalModels(); } }
  function applySelectedModel(persistReset = false) { const current = provider(); const model = selectedModel(); syncLocalModelPath(model); $("modelNote").textContent = model.note || ""; applyProviderLanguages(current, model, persistReset); $("speakerColorsField").classList.toggle("hidden", !model.supportsSpeaker); syncQwenAudioOptions(model); syncSonioxContextOptions(model); renderLocalModelStatus(); syncDefaultOutput(); if (persistReset) savePrefsDebounced({ modelId: model.id, language: languageValue() }); }
  function applyProviderLanguages(current, model, persistReset = false) { const el = $("language"); $("languageGroup").classList.toggle("hidden", current.supportsLanguage === false); const previous = el.multiple ? Array.from(el.selectedOptions).map((o) => o.value) : (el.value ? [el.value] : []); const remembered = state.config.lastLanguage; const wanted = previous.length && persistReset ? previous : (remembered !== null && remembered !== undefined ? (remembered ? remembered.split(",") : []) : [state.config.language].filter(Boolean)); el.multiple = Boolean(current.multiLanguage); $("advancedOptionsGrid").classList.toggle("single-language", !current.multiLanguage); if (current.multiLanguage) el.size = 6; else el.removeAttribute("size"); const showRare = Boolean(state.config.showRareLangs); const commons = current.commonLanguages || []; const available = model.languages?.length ? model.languages : current.languages; const visible = !showRare && commons.length ? available.filter((item) => commons.includes(item.id)) : available; fillSelect("language", visible, ""); const codes = new Set(visible.map((item) => item.id)); const restored = wanted.filter((code) => code && codes.has(code)); if (current.multiLanguage) { Array.from(el.options).forEach((o) => { o.selected = restored.includes(o.value); }); } else { el.value = restored[0] || ""; } $("languageHint").classList.toggle("hidden", !current.multiLanguage); $("languageFilterHint").classList.toggle("hidden", showRare || commons.length === 0); $("languageReset").classList.toggle("hidden", !current.multiLanguage); }
  function languageValue() { const el = $("language"); if (el.multiple) return Array.from(el.selectedOptions).map((o) => o.value).filter(Boolean).join(","); return el.value; }
  function syncWorkspace() { $("workspaceField").classList.toggle("hidden", !SHOW_REGIONAL_FIELDS || provider().regions.length === 0); }
  function syncAdvancedParamsGroup() { const group = $("advancedParamsGroup"); group.classList.toggle("hidden", !Array.from(group.querySelectorAll(".field")).some((field) => !field.classList.contains("hidden"))); }
  function appendTestSuffix(path) { const value = String(path || "").trim(); if (!value || /-test(?=\.[^./\\]+$)/iu.test(value)) return value; const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")); const dot = value.lastIndexOf("."); if (dot <= separator) return `${value}-test`; return `${value.slice(0, dot)}-test${value.slice(dot)}`; }
  function removeTestSuffix(path) { return String(path || "").replace(/-test(?=\.[^./\\]+$)/iu, ""); }
  function syncTestRun() { const on = $("testRun").checked; $("testRunHint").classList.toggle("hidden", !on); $("lengthLimit").disabled = on; if (state.srtAuto) { void syncDefaultOutput(); return; } const current = $("srtPath").value.trim(); if (on) { const next = appendTestSuffix(current); state.testSuffixAdded = Boolean(current && next !== current); $("srtPath").value = next; } else if (state.testSuffixAdded) { $("srtPath").value = removeTestSuffix(current); state.testSuffixAdded = false; } }
  function savePrefsDebounced(payload) { clearTimeout(prefsTimer); prefsTimer = setTimeout(() => bridge("save_prefs", payload), 300); }
  function normalizeZoomPercent(value) { const parsed = Number(value); if (!Number.isFinite(parsed)) return ZOOM_DEFAULT; return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(parsed / ZOOM_STEP) * ZOOM_STEP)); }
  function applyZoomPercent(value) { const zoomPercent = normalizeZoomPercent(value); document.documentElement.style.zoom = `${zoomPercent}%`; state.config.zoomPercent = zoomPercent; return zoomPercent; }
  function viewportPixelsToPage(value) { return value / (normalizeZoomPercent(state.config?.zoomPercent) / 100); }
  function persistZoomPercent(value) { const zoomPercent = applyZoomPercent(value); savePrefsDebounced({ zoomPercent }); }
  function handleZoomWheel(event) { if (!event.ctrlKey) return; const direction = Math.sign(event.deltaY); if (!direction) return; event.preventDefault(); const zoomPercent = applyZoomPercent(state.config.zoomPercent - direction * ZOOM_STEP); savePrefsDebounced({ zoomPercent }); }
  function handleZoomKeydown(event) {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.target?.closest?.("input, textarea, select, [contenteditable]")) return;
    const direction = event.key === "=" || event.key === "+" ? 1 : (event.key === "-" ? -1 : 0);
    if (!direction && event.key !== "0") return;
    event.preventDefault();
    persistZoomPercent(event.key === "0" ? ZOOM_DEFAULT : state.config.zoomPercent + direction * ZOOM_STEP);
  }
  async function syncDefaultOutput() { const result = await bridge("default_output", { mediaPath: $("mediaPath").value.trim(), providerId: $("provider").value, modelId: $("model").value, testRun: $("testRun").checked }); const path = result.ok ? result.path : ""; $("srtPath").placeholder = path; if (state.srtAuto) { $("srtPath").value = path; if (path) setError("srtPath", ""); setOutputNotice(result.renamed ? t("output_collision") : ""); } else setOutputNotice(""); }
  function syncFlvHints() {
    $("mediaPathFlvHint")?.classList.toggle("hidden", ext($("mediaPath").value.trim()) !== ".flv");
    $("serverMediaFlvHint")?.classList.toggle("hidden", ext($("serverMediaPath").value.trim()) !== ".flv");
  }
  function setMedia(path) { $("mediaPath").value = path; setError("mediaPath", ""); setOutputNotice(""); syncFlvHints(); syncDefaultOutput(); }
  function setJsonPath(path) { $("jsonPath").value = path; setError("jsonPath", ""); if (path !== state.serverProjectPath) $("openMawe").classList.add("attention"); refreshServerMedia(); }
  function applyErrorResult(result, logDetail = true) { const message = errText(result.code, result.detail || result.error); const fieldMessage = result.code === "server_start_failed" ? t("server_start_failed_hint") : (result.code === "server_no_response" ? t("server_no_response_hint") : message); if (result.field) setError(result.field, fieldMessage); if (result.field === "port" || result.field === "serverMediaPath" || result.field === "jsonPath") expandServer(); if (result.postprocessStep) window.MAWLauncher?.openAutoPostprocessStep?.(result.postprocessStep, result.field); else if (result.field === "autoPostprocessEnabled") $("autoPostprocessCard")?.scrollIntoView({ behavior: "smooth", block: "start" }); setStatus(message); if (logDetail && (result.detail || result.error)) appendLog(`[error] ${result.code || "backend_error"}: ${result.detail || result.error}`); }
  function validateSegmentation(data) { for (const [field, minimum] of [["maxLen", 1], ["minLen", 1], ["gapSplit", 0]]) { const value = data[field]; if (!value) continue; if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) return fail(field, errText("segmentation_invalid", "")); } if (data.maxLen && data.minLen && Number(data.maxLen) < Number(data.minLen)) return fail("maxLen", errText("segmentation_invalid", "")); return true; }
  function validateLocal() { clearErrors(); const data = formPayload(); if (!data.mediaPath) return fail("mediaPath", errText("media_not_found", "")); if (!data.srtPath) return fail("srtPath", errText("output_missing", "")); if (!validateSegmentation(data)) return false; if (isLocalProvider()) { const runtime = state.config.localRuntime || {}; const status = localStatus(); if (!runtime.ready && runtime.status !== "ready") return fail("model", errText("local_runtime_missing", "")); if (status.status === "runtime_missing") return fail("model", errText("local_runtime_missing", "")); if (status.status === "path_invalid") return fail("localModelPath", errText("local_model_path_invalid", "")); if (status.status === "path_mismatch") return fail("localModelPath", errText("local_model_path_mismatch", "")); if (status.status === "missing") return fail("model", errText("local_model_missing", "")); if (status.status === "partial") return fail("model", errText("local_model_incomplete", "")); return true; } if (provider().requiresApiKey !== false && !data.apiKey && !provider().apiKey) return fail("apiKey", errText("api_key_missing", "")); if (provider().regions.length > 0 && data.region === "singapore" && !data.workspaceId) return fail("workspaceId", errText("workspace_missing", "")); if (provider().id === "qwen" && selectedModel().supportsContext && Array.from(data.qwenAudioContext).length > 400) return fail("qwenAudioContext", errText("context_too_long", "")); if (provider().id === "soniox" && selectedModel().supportsContext && Array.from([data.sonioxContextGeneral, data.sonioxContextText, data.sonioxContextTerms, data.sonioxContextTranslationTerms].join("\n")).length > 10000) return fail("sonioxContextText", errText("soniox_context_too_long", "")); if (provider().id === "qwen" && selectedModel().supportsHotwords && data.qwenAudioHotwordsMode === "file" && ext(data.qwenAudioHotwordsFile) !== ".txt") return fail("qwenAudioHotwordsFile", errText("hotwords_file_missing", "")); return true; }
  function fail(field, message) { setError(field, message); setStatus(message); const input = $(field); if (input && input.scrollIntoView) input.scrollIntoView({ behavior: "smooth", block: "center" }); return false; }
  function toggle(id) { $(id).classList.toggle("collapsed"); renderChevron(id); }
  function setupScrollbarFlash() {
    const VISIBLE_MS = 900;
    const bind = (target, host) => { let timer = 0; target.addEventListener("scroll", () => { host.classList.add("scrolling"); clearTimeout(timer); timer = setTimeout(() => host.classList.remove("scrolling"), VISIBLE_MS); }, { passive: true }); };
    bind(window, document.documentElement);
    document.querySelectorAll(".log, .modal-card, .settings-scroll, .toolbox-content, .toolbox-chain-list").forEach((el) => bind(el, el));
  }
  function expandServer() { $("serverCard").classList.remove("collapsed"); renderChevron("serverCard"); }
  function hasFileDrag(event) { return !event.dataTransfer || Array.from(event.dataTransfer.types || []).includes("Files"); }
  function setDropHighlight(active) { $("mediaCard").classList.toggle("drag-over", active); }
  function isInsideMediaCard(node) { return node instanceof Node && $("mediaCard").contains(node); }
  function onDragEnter(event) { if (!hasFileDrag(event) || !isInsideMediaCard(event.target)) return; event.preventDefault(); if (isInsideMediaCard(event.relatedTarget)) return; dragState.depth += 1; setDropHighlight(true); }
  function onDragLeave(event) { if (!isInsideMediaCard(event.target)) return; if (isInsideMediaCard(event.relatedTarget)) return; dragState.depth = Math.max(0, dragState.depth - 1); if (dragState.depth === 0) setDropHighlight(false); }
  function bindDropField(id, target, controlId) { const field = $(id); const control = $(controlId || id); field.addEventListener("dragenter", (event) => { if (!hasFileDrag(event)) return; event.preventDefault(); state.dropTarget = target; control.classList.add("drag-over"); }); field.addEventListener("dragover", (event) => { if (!hasFileDrag(event)) return; event.preventDefault(); state.dropTarget = target; control.classList.add("drag-over"); }); field.addEventListener("dragleave", (event) => { if (!field.contains(event.relatedTarget)) { control.classList.remove("drag-over"); if (state.dropTarget === target) state.dropTarget = ""; } }); }
  function handleRoutedDrop(path) { const target = state.dropTarget; clearDropState(); const suffix = ext(path || ""); if (target === "toolboxInput") { if (PROJECT_EXTS.has(suffix) || suffix === ".srt") { $("toolboxInputPath").value = path; $("toolboxInputPath").dispatchEvent(new Event("input", { bubbles: true })); setError("toolboxInputPath", ""); } else setError("toolboxInputPath", t("toolbox_drop_reject")); return; } if (target === "toolboxUtilityMedia") { if (MEDIA_EXTS.has(suffix)) { $("toolboxUtilityMediaPath").value = path; $("toolboxUtilityMediaPath").dispatchEvent(new Event("input", { bubbles: true })); setError("toolboxUtilityMediaPath", ""); } else setError("toolboxUtilityMediaPath", t("toolbox_utility_media_reject")); return; } if (target === "toolboxFfconcat") { if (suffix === ".ffconcat") { $("postprocessFfconcatPath").value = path; $("postprocessFfconcatPath").dispatchEvent(new Event("input", { bubbles: true })); setError("postprocessFfconcatPath", ""); } else setError("postprocessFfconcatPath", t("toolbox_ffconcat_reject")); return; } if (target === "ocrVideo") { if (VIDEO_EXTS.has(suffix)) { $("ocrVideoPath").value = path; $("ocrVideoPath").dispatchEvent(new Event("input", { bubbles: true })); setError("ocrVideoPath", ""); } else setError("ocrVideoPath", t("toolbox_ocr_video_reject")); return; } if (target === "script") { if (SCRIPT_EXTS.has(suffix)) { $("postprocessScriptPath").value = path; $("postprocessScriptPath").dispatchEvent(new Event("input", { bubbles: true })); setError("postprocessScriptPath", ""); } else setError("postprocessScriptPath", t("toolbox_script_reject")); return; } if (target === "json") { if (PROJECT_EXTS.has(suffix)) { setJsonPath(path); setStatus(t("json_project")); } else setError("jsonPath", t("drop_reject_json")); return; } if (target === "text" || target === "file") { if (suffix === ".txt") { void loadHotwordFile(path, target === "text"); } else setError(target === "text" ? "qwenAudioHotwords" : "qwenAudioHotwordsFile", t("drop_reject_txt")); return; } if (PROJECT_EXTS.has(suffix)) { setJsonPath(path); setStatus(t("json_project")); return; } if (suffix === ".txt") { void loadHotwordFile(path, false); return; } if (MEDIA_EXTS.has(suffix)) { setMedia(path); setStatus(t("media")); return; } setError("mediaPath", mediaDropError()); }
  async function refreshServerMedia() { const jsonPath = $("jsonPath").value.trim(); const result = await bridge("check_server_media", { jsonPath }); state.serverMediaOk = Boolean(result.hasMedia && result.mediaExists); $("serverMediaField").classList.toggle("hidden", state.serverMediaOk || !jsonPath); return result; }
  async function refreshFfmpeg() { const result = await bridge("check_ffmpeg"); $("modalFfmpegFound").classList.toggle("hidden", !result.found); $("modalFfmpegMissing").classList.toggle("hidden", Boolean(result.found)); $("ffmpegPathBox").classList.toggle("hidden", Boolean(result.found)); $("settingsDot").classList.toggle("hidden", Boolean(result.found)); $("modalFfmpegFound").title = result.directory || ""; $("ffmpegDir").textContent = result.directory || ""; return result; }
  function ffmpegSaveError(result) { if (result.code) return errText(result.code, result.detail || result.error); if (result.found === false) return t("ffmpeg_missing"); return compactDetail(result.error) || t("failed"); }
  function openSettings(sectionId = "", focusId = "") {
    $("settingsModal").classList.remove("hidden");
    refreshFfmpeg();
    void refreshOcrRuntime();
    renderStickerCurrent();
    $("showRareLangs").checked = Boolean(state.config.showRareLangs);
    if (sectionId) {
      requestAnimationFrame(() => {
        $(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
        if (focusId) requestAnimationFrame(() => $(focusId)?.focus());
      });
    }
  }
  function closeSettings() { $("settingsModal").classList.add("hidden"); }
  async function openServerEditor() {
    clearErrors();
    $("htmlMenu").classList.add("hidden");
    if (state.serverStarting) return;
    const projectPath = $("jsonPath").value.trim();
    const currentUrl = state.detectedServerUrl || `http://127.0.0.1:${$("port").value || "8250"}/?lang=${state.lang}`;
    if ((state.serverRunning && projectPath === state.serverProjectPath) || (state.detectedServerUrl && !projectPath)) { await bridge("open_url", { url: currentUrl }); return; }
    state.serverStarting = true;
    renderServerButton();
    try {
      if (projectPath) {
        const mediaState = await refreshServerMedia();
        if ((!mediaState.hasMedia || !mediaState.mediaExists) && !$("serverMediaPath").value.trim()) {
          expandServer();
          return fail("serverMediaPath", errText("server_media_missing", ""));
        }
      }
      const result = await bridge("start_server", serverPayload());
      if (result.ok) {
        state.serverRunning = !result.serverAlreadyRunning;
        state.serverProjectPath = state.serverRunning ? projectPath : "";
        state.detectedServerUrl = result.serverAlreadyRunning ? result.url || "" : "";
        $("openMawe").classList.remove("attention");
        renderServerButton();
        if (result.url) {
          setServerStatus(result.url, Boolean(result.serverAlreadyRunning));
          await bridge("open_url", { url: result.url });
        } else setStatus(t("ready"));
      } else {
        applyErrorResult(result);
      }
    } finally {
      state.serverStarting = false;
      renderServerButton();
    }
  }

  async function init() {
    const realApi = await waitForBackend();
    api = realApi || mockApi();
    window.MAWLauncher.backend = realApi ? "real" : "mock";
    const savedTheme = localStorage.getItem(THEME_KEY);
    state.theme = savedTheme === "light" || savedTheme === "dark" || savedTheme === "system" ? savedTheme : "system";
    applyTheme();
    $("lengthLimitField").classList.toggle("hidden", !SHOW_LENGTH_LIMIT_FIELD);
    $("demoBadge").classList.toggle("hidden", window.MAWLauncher.backend !== "mock");
    state.config = await bridge("get_config");
    state.config.zoomPercent = applyZoomPercent(state.config.zoomPercent);
    window.MAWLauncher.config = state.config;
    const emojiFont = await bridge("get_emoji_font_path");
    if (emojiFont && emojiFont.ok && emojiFont.path) injectEmojiFont(emojiFont.path);
    state.lang = state.config.guiLang || "zh";
    fillSelect("provider", state.config.providers, state.config.providerId || "qwen");
    applyProvider(false);
    $("workspaceId").value = state.config.workspaceId || "";
    syncWorkspace(); syncTestRun(); renderChevron("advancedCard"); renderChevron("serverCard"); renderLanguage(); refreshFfmpeg();
    appendLog(window.MAWLauncher.backend === "real" ? "MAW launcher ready." : "[mock] Static browser demo mode enabled."); setStatus(t("ready")); await checkExistingServer(); window.dispatchEvent(new CustomEvent("mawlauncherready"));
  }

  function handleBackendEvent(event) {
    if (["batchStarted", "batchItem", "batchItemLog", "batchDone", "batch_started", "batch_item", "batch_item_log", "batch_done"].includes(event.type)) window.MAWLauncher?.onBatchEvent?.(event);
    if (event.type === "emojiFontReady" && event.path) injectEmojiFont(event.path);
    if (event.type === "log") appendLog(event.message);
    if (event.type === "postprocess_status") window.MAWLauncher?.onPostprocessStatus?.(event);
    if (event.type === "postprocess_stream") window.MAWLauncher?.onPostprocessStream?.(event);
    if (event.type === "postprocess_pipeline") window.MAWLauncher?.onPostprocessPipeline?.(event);
    if (event.type === "modelProgress") {
      state.localProgressMessage = event.message || "";
      state.localProgress = event;
      renderLocalModelStatus();
    }
    if (event.type === "modelPrepared") {
      state.localPreparing = false;
      state.localProgressMessage = "";
      state.localProgress = null;
      const model = provider().models.find((item) => item.id === event.modelId);
      if (model && event.status) model.localStatus = event.status;
      renderLocalModelStatus();
      setStatus(t("local_prepare_done"));
      appendLog(t("local_prepare_done"));
    }
    if (event.type === "localPrepareCancelled") {
      state.localPreparing = false;
      state.localProgressMessage = "";
      state.localProgress = null;
      void refreshLocalModels();
      renderLocalModelStatus();
      setStatus(t("local_prepare_cancelled"));
      appendLog(t("local_prepare_cancelled"));
    }
    if (event.type === "localRuntimeProgress") {
      state.localRuntimeInstalling = true;
      state.localRuntimeProgress = Number(event.percent || 0);
      state.localRuntimeProgressMessage = event.message || "";
      renderLocalRuntime();
    }
    if (event.type === "localRuntimeReady") {
      state.localRuntimeInstalling = false;
      state.localRuntimeProgress = 100;
      state.localRuntimeProgressMessage = "";
      state.config.localRuntime = event.runtime || { status: "ready", ready: true };
      renderLocalRuntime();
      void refreshLocalModels();
      setStatus(t("local_runtime_install_done"));
      appendLog(t("local_runtime_install_done"));
    }
    if (event.type === "localRuntimeCancelled") {
      state.localRuntimeInstalling = false;
      state.localRuntimeProgressMessage = "";
      void refreshLocalRuntime();
      renderLocalRuntime();
      setStatus(t("local_runtime_cancelled"));
      appendLog(t("local_runtime_cancelled"));
    }
    if (event.type === "ocrRuntimeProgress") {
      state.ocrRuntimeInstalling = true;
      state.ocrRuntimeProgress = Number(event.percent || 0);
      state.ocrRuntimeProgressMessage = event.message || "";
      renderOcrRuntime();
    }
    if (event.type === "ocrRuntimeReady") {
      state.ocrRuntimeInstalling = false;
      state.ocrRuntimeProgress = 100;
      state.ocrRuntimeProgressMessage = "";
      state.config.ocrRuntime = event.runtime || { status: "ready", ready: true };
      state.config.ocrModels = event.models || state.config.ocrModels || [];
      renderOcrRuntime();
      void refreshOcrRuntime();
      setStatus(t("ocr_runtime_install_done"));
      appendLog(t("ocr_runtime_install_done"));
    }
    if (event.type === "ocrRuntimeCancelled") {
      state.ocrRuntimeInstalling = false;
      state.ocrRuntimeProgressMessage = "";
      void refreshOcrRuntime();
      renderOcrRuntime();
      setStatus(t("ocr_runtime_cancelled"));
      appendLog(t("ocr_runtime_cancelled"));
    }
    if (event.type === "error" && event.code === "local_prepare_failed") {
      state.localPreparing = false;
      state.localProgressMessage = "";
      state.localProgress = null;
    }
    if (event.type === "error" && ["local_runtime_install_failed", "local_runtime_cancelled"].includes(event.code)) {
      state.localRuntimeInstalling = false;
      state.localRuntimeProgressMessage = "";
      void refreshLocalRuntime();
      renderLocalRuntime();
    }
    if (event.type === "error" && ["ocr_runtime_install_failed", "ocr_runtime_cancelled"].includes(event.code)) {
      state.ocrRuntimeInstalling = false;
      state.ocrRuntimeProgressMessage = "";
      void refreshOcrRuntime();
      renderOcrRuntime();
    }
    if (event.type === "error") {
      setRunning(false);
      $("retryPostprocess")?.classList.toggle("hidden", !event.canRetry);
      const detail = event.detail || event.message || "";
      const message = event.code ? errText(event.code, detail) : detail || t("failed");
      setStatus(message);
      appendLog(`[error] ${message}`);
      if (detail && detail !== message) appendLog(`[detail] ${detail}`);
      renderLocalModelStatus();
    }
    if (event.type === "done") {
      state.result = event.result;
      setRunning(false);
      $("retryPostprocess")?.classList.add("hidden");
      if (event.result?.srtPath) $("srtPath").value = event.result.srtPath;
      setJsonPath(event.result?.jsonPath || "");
      $("openMawe").classList.add("attention");
      $("openFolder").classList.remove("hidden");
      syncHtmlMenu();
      appendLog(t("done"));
      void checkExistingServer(t("done"));
    }
    if (event.type === "dropMedia" && window.MAWLauncher?.onBatchDrop?.(event.path || "")) return;
    if (event.type === "dropReject" && window.MAWLauncher?.onBatchDropReject?.(event.path || "")) return;
    if (event.type === "dropMedia" || event.type === "dropJson" || event.type === "dropSubtitle" || event.type === "dropHotwordFile" || event.type === "dropFfconcat" || event.type === "dropReject") handleRoutedDrop(event.path || "");
  }
  window.MAWLauncher = { backend: "pending", config: null, callBackend: bridge, translate: t, viewportPixelsToPage, openSettings, closeSettings, setJsonPath, openServerEditor, getTranscriptionPayload: formPayload, appendLog, confirm: confirmAction, confirmResolve: null, onBackendEvent: handleBackendEvent, onBackendEvents(events) { events.forEach(handleBackendEvent); }, onLanguageChanged() {} };

  $("langToggle").addEventListener("click", async () => { state.lang = state.lang === "zh" ? "en" : "zh"; renderLanguage(); const result = await bridge("save_settings", formPayload()); if (!result.ok) applyErrorResult(result); });
  $("themeLight").addEventListener("click", () => setTheme("light")); $("themeDark").addEventListener("click", () => setTheme("dark")); $("themeSystem").addEventListener("click", () => setTheme("system"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state.theme === "system") applyTheme(); });
  $("homeLink").addEventListener("click", () => bridge("open_url", { url: HOME_URL }));
  $("provider").addEventListener("change", () => applyProvider(true)); $("model").addEventListener("change", () => applySelectedModel(true)); $("language").addEventListener("change", () => savePrefsDebounced({ language: languageValue() })); $("region").addEventListener("change", syncWorkspace); $("advancedToggle").addEventListener("click", () => toggle("advancedCard"));
  $("testRun").addEventListener("change", syncTestRun);
  $("generateHtml").addEventListener("change", syncHtmlMenu);
  $("mediaPath").addEventListener("input", () => { setError("mediaPath", ""); setOutputNotice(""); syncFlvHints(); syncDefaultOutput(); }); $("srtPath").addEventListener("input", () => { state.srtAuto = false; state.testSuffixAdded = false; setError("srtPath", ""); setOutputNotice(""); });
  $("pickMedia").addEventListener("click", async () => { const result = await bridge("choose_file", { kind: "media" }); if (!result.ok) return; if (!MEDIA_EXTS.has(ext(result.path))) { setError("mediaPath", mediaDropError()); return; } setMedia(result.path); });
  $("qwenAudioHotwordsModeText").addEventListener("click", () => { setHotwordsMode("text"); setError("qwenAudioHotwordsFile", ""); }); $("qwenAudioHotwordsModeFile").addEventListener("click", () => { setHotwordsMode("file"); setError("qwenAudioHotwordsFile", ""); }); $("pickQwenAudioHotwordsFile").addEventListener("click", async () => { const result = await bridge("choose_file", { kind: "hotwords" }); if (result.ok) await loadHotwordFile(result.path || "", false); });
  $("pickJson").addEventListener("click", async () => { const result = await bridge("choose_file", { kind: "json" }); if (result.ok) setJsonPath(result.path); });
  $("jsonPath").addEventListener("input", () => setError("jsonPath", "")); $("jsonPath").addEventListener("change", refreshServerMedia); $("pickServerMedia").addEventListener("click", async () => { const result = await bridge("choose_file", { kind: "media" }); if (result.ok) { $("serverMediaPath").value = result.path; setError("serverMediaPath", ""); syncFlvHints(); } });
  ["apiKey", "workspaceId", "qwenAudioContext", "qwenAudioHotwords", "qwenAudioHotwordsFile", "qwenAudioHotwordWeight", "sonioxContextGeneral", "sonioxContextText", "sonioxContextTerms", "sonioxContextTranslationTerms", "serverMediaPath", "port", "ffmpegPath", "stickerDir"].forEach((field) => { const el = $(field); el?.addEventListener("input", () => { setError(field, ""); if (field === "qwenAudioContext") renderPromptCharacterCount(); if (field.startsWith("sonioxContext")) renderSonioxContextCharacterCount(); if (field === "qwenAudioHotwords") renderHotwordWarnings(); if (field === "qwenAudioHotwordWeight") renderHotwordWarnings(); if (field === "serverMediaPath") syncFlvHints(); if (field === "port") { state.detectedServerUrl = ""; renderServerButton(); } }); el?.addEventListener("change", () => { setError(field, ""); if (field.startsWith("sonioxContext")) renderSonioxContextCharacterCount(); if (field === "qwenAudioHotwordWeight") renderHotwordWarnings(); if (field === "serverMediaPath") syncFlvHints(); if (field === "port") void checkExistingServer(); }); });
  $("refreshServerStatus").addEventListener("click", async () => { $("refreshServerStatus").disabled = true; try { await checkExistingServer(); } finally { $("refreshServerStatus").disabled = false; } });
  $("openKeyUrl").addEventListener("click", () => bridge("open_url", { url: provider().keyUrl }));
  $("pickLocalModelPath").addEventListener("click", async () => { const result = await bridge("choose_folder", { kind: "model" }); if (result.ok) { $("localModelPath").value = result.path; state.localModelPaths[selectedModel().id] = result.path; setError("localModelPath", ""); await refreshLocalModels(); } });
  $("pickLocalModelCachePath").addEventListener("click", async () => { const result = await bridge("choose_folder", { kind: "model-cache" }); if (result.ok) { $("localModelCachePath").value = result.path; await saveLocalModelCache(result.path); } });
  $("localModelCachePath").addEventListener("input", () => setError("localModelCachePath", ""));
  $("localModelCachePath").addEventListener("change", async () => { await saveLocalModelCache($("localModelCachePath").value); });
  $("pickOcrRuntimePath").addEventListener("click", async () => { const result = await bridge("choose_folder", { kind: "ocr-runtime" }); if (result.ok) { $("ocrRuntimePath").value = result.path; await saveOcrRuntimePath(result.path); } });
  $("ocrRuntimePath").addEventListener("input", () => setError("ocrRuntimePath", ""));
  $("ocrRuntimePath").addEventListener("change", async () => { await saveOcrRuntimePath($("ocrRuntimePath").value); });
  $("refreshOcrRuntime").addEventListener("click", async () => { $("refreshOcrRuntime").disabled = true; try { await refreshOcrRuntime(); } finally { $("refreshOcrRuntime").disabled = false; } });
  $("installOcrRuntime").addEventListener("click", async () => { if (state.ocrRuntimeInstalling) { await bridge("cancel_ocr_runtime"); return; } state.ocrRuntimeInstalling = true; state.ocrRuntimeProgress = 0; state.ocrRuntimeProgressMessage = t("ocr_runtime_installing"); renderOcrRuntime(); appendLog(t("ocr_runtime_installing")); const result = await bridge("install_ocr_runtime", { repair: state.config.ocrRuntime?.status === "broken" }); if (!result.ok) { state.ocrRuntimeInstalling = false; state.ocrRuntimeProgressMessage = ""; applyErrorResult(result); renderOcrRuntime(); } });
  $("localModelPath").addEventListener("input", () => { setError("localModelPath", ""); if (isLocalProvider()) { state.localModelPaths[selectedModel().id] = $("localModelPath").value.trim(); void refreshLocalModels(); } });
  $("refreshLocalRuntime").addEventListener("click", async () => { $("refreshLocalRuntime").disabled = true; try { await refreshLocalRuntime(); await refreshLocalModels(); } finally { $("refreshLocalRuntime").disabled = false; } });
  $("installLocalRuntime").addEventListener("click", async () => { if (!isLocalProvider()) return; if (state.localRuntimeInstalling) { await bridge("cancel_local_runtime"); return; } state.localRuntimeInstalling = true; state.localRuntimeProgress = 0; state.localRuntimeProgressMessage = t("local_runtime_installing"); renderLocalRuntime(); appendLog(t("local_runtime_installing")); const result = await bridge("install_local_runtime", { repair: state.config.localRuntime?.status === "ready" }); if (!result.ok) { state.localRuntimeInstalling = false; state.localRuntimeProgressMessage = ""; applyErrorResult(result); renderLocalRuntime(); } });
  $("refreshLocalModels").addEventListener("click", async () => { $("refreshLocalModels").disabled = true; try { await refreshLocalModels(); } finally { $("refreshLocalModels").disabled = false; } });
  $("prepareLocalModel").addEventListener("click", async () => { if (!isLocalProvider()) return; if (state.localPreparing) { state.localProgressMessage = t("local_prepare_cancelling"); renderLocalModelStatus(); appendLog(t("local_prepare_cancelling")); const result = await bridge("cancel_local_model"); if (!result.ok) { state.localProgressMessage = t("local_prepare_running"); applyErrorResult(result); renderLocalModelStatus(); } return; } state.localPreparing = true; state.localProgressMessage = t("local_prepare_running"); state.localProgress = null; renderLocalModelStatus(); appendLog(t("local_prepare_running")); const result = await bridge("prepare_local_model", { modelId: $("model").value, modelPath: $("localModelPath").value.trim(), device: $("localDevice").value }); if (!result.ok) { state.localPreparing = false; state.localProgressMessage = ""; state.localProgress = null; applyErrorResult(result); renderLocalModelStatus(); } else if (result.alreadyInstalled) { state.localPreparing = false; state.localProgressMessage = ""; state.localProgress = null; renderLocalModelStatus(); setStatus(t("local_installed")); } });
  $("ffmpegHelp").addEventListener("click", () => bridge("open_url", { url: "https://ffmpeg.org/download.html" }));
  $("settingsButton").addEventListener("click", openSettings); $("settingsClose").addEventListener("click", closeSettings); $("settingsBackdrop").addEventListener("click", closeSettings); document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSettings(); });
  $("batchConfirmYes").addEventListener("click", () => finishConfirm(true)); $("batchConfirmNo").addEventListener("click", () => finishConfirm(false));
  $("changeFfmpeg").addEventListener("click", () => $("ffmpegPathBox").classList.remove("hidden"));
  $("saveFfmpeg").addEventListener("click", async () => { const result = await bridge("save_ffmpeg_path", { path: $("ffmpegPath").value.trim() }); if (!result.ok) { const message = ffmpegSaveError(result); setError("ffmpegPath", message); setStatus(message); return; } setError("ffmpegPath", ""); await refreshFfmpeg(); setStatus(t("saved")); });
  $("pickStickerDir").addEventListener("click", async () => { const result = await bridge("choose_folder"); if (result.ok) await saveStickerDirectory(result.path); });
  $("stickerDir").addEventListener("change", async () => { const path = $("stickerDir").value.trim(); if (path) await saveStickerDirectory(path); });
  $("showRareLangs").addEventListener("change", async () => { state.config.showRareLangs = $("showRareLangs").checked; applyProviderLanguages(provider(), selectedModel()); const result = await bridge("save_prefs", { showRareLangs: state.config.showRareLangs }); if (result.ok) setStatus(t("saved")); else applyErrorResult(result); });
  $("languageReset").addEventListener("click", () => { const el = $("language"); Array.from(el.options).forEach((o) => { o.selected = false; }); savePrefsDebounced({ language: "" }); });
  $("saveSettings").addEventListener("click", async () => { const result = await bridge("save_settings", formPayload()); if (result.ok) { const current = provider(); current.apiKey = $("apiKey").value.trim(); current.maskedApiKey = result.maskedApiKey; state.config.apiKey = current.apiKey; state.config.maskedApiKey = result.maskedApiKey; renderKeyStatus(); setStatus(t("saved")); } else applyErrorResult(result); });
  $("start").addEventListener("click", async () => { if (!validateLocal()) return; $("retryPostprocess")?.classList.add("hidden"); $("log").textContent = ""; state.lastLogMessage = ""; const latest = $("logLatest"); latest.textContent = ""; latest.classList.add("hidden"); setRunning(true); $("logTitle").scrollIntoView({ behavior: "smooth", block: "start" }); const result = await bridge("start_transcription", formPayload()); if (!result.ok) { setRunning(false); applyErrorResult(result, false); } else if (result.outputPath) { $("srtPath").value = result.outputPath; if (result.outputRenamed) setOutputNotice(t("output_collision")); } });
  $("stop").addEventListener("click", async () => { if (!state.running) return; $("stop").disabled = true; setStatus(t("batch_stopping")); const result = await bridge("cancel_transcription"); if (!result.ok) { $("stop").disabled = false; setStatus(result.detail || result.error || t("failed")); } });
  $("retryPostprocess").addEventListener("click", async () => { $("retryPostprocess").classList.add("hidden"); setRunning(true); const result = await bridge("retry_postprocess"); if (!result.ok) { setRunning(false); applyErrorResult(result, false); } });
  $("openMawe").addEventListener("click", openServerEditor); $("stopServer").addEventListener("click", stopEditorServer); $("openFolder").addEventListener("click", () => bridge("open_output_folder"));
  $("openMenu").addEventListener("click", () => $("htmlMenu").classList.toggle("hidden")); $("openHtml").addEventListener("click", () => { $("htmlMenu").classList.add("hidden"); bridge("open_html"); }); $("openBlankHtml").addEventListener("click", () => { $("htmlMenu").classList.add("hidden"); bridge("open_blank_html"); }); document.addEventListener("click", (event) => { if (!event.target.closest(".split-wrap")) $("htmlMenu").classList.add("hidden"); });
  $("mediaCard").addEventListener("dragenter", onDragEnter); $("mediaCard").addEventListener("dragleave", onDragLeave);
    bindDropField("qwenAudioHotwordsTextField", "text", "qwenAudioHotwords"); bindDropField("qwenAudioHotwordsFileField", "file", "qwenAudioHotwordsFile"); bindDropField("jsonPath", "json"); bindDropField("toolboxInputDropZone", "toolboxInput", "toolboxInputDropZone"); bindDropField("toolboxUtilityMediaDropZone", "toolboxUtilityMedia", "toolboxUtilityMediaDropZone"); bindDropField("toolboxFfconcatDropZone", "toolboxFfconcat", "toolboxFfconcatDropZone"); bindDropField("ocrVideoPathField", "ocrVideo", "ocrVideoPathField"); bindDropField("postprocessScriptPath", "script");
  document.addEventListener("dragover", (event) => { if (hasFileDrag(event)) event.preventDefault(); });
  document.addEventListener("dragend", clearDropState);
  document.addEventListener("dragleave", (event) => { if (!event.relatedTarget && event.target === document.documentElement) clearDropState(); });
  // 真实后端模式下 drop 由 Python 侧异步回传事件，不能在这里清理 dropTarget，否则 handleRoutedDrop 读不到目标。
  document.addEventListener("drop", (event) => { event.preventDefault(); if (window.MAWLauncher.backend === "real") return; const files = Array.from(event.dataTransfer?.files || []); let handled = false; if (window.MAWLauncher?.onBatchDrop) files.forEach((file) => { handled = window.MAWLauncher.onBatchDrop(file.path || file.name || "") || handled; }); if (handled) return; const file = files[0]; handleRoutedDrop(file?.path || file?.name || ""); });
  setupScrollbarFlash();
  document.addEventListener("DOMContentLoaded", init);
  document.addEventListener("keydown", handleZoomKeydown);
  document.addEventListener("wheel", handleZoomWheel, { passive: false });
})();
