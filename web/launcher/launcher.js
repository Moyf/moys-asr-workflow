(function () {
  "use strict";

  const STRINGS = {
    zh: { media_output: "1️⃣ 媒体与输出", recognition: "2️⃣ 识别设置", server: "4️⃣ 字幕编辑器设置", logs: "3️⃣ 日志", provider: "识别方式", test_run: "测试运行", test_run_title: "仅截取前2分钟内容，用于测试功能和 API", test_run_override: "测试运行已限定前 2 分钟", debug_raw: "调试运行（保存完整返回数据）", debug_raw_title: "额外保存 ASR 服务端返回的原始 JSON，便于排查断句、标点和时间码问题", hero_desc: "本地媒体 ➜ AI 转写 ➜ 可编辑字幕工程", project_home: "项目官网", media: "媒体文件", srt_output: "SRT 输出", choose: "选择", model: "模型", region: "地域", workspace: "工作空间 ID", language: "语言", length_limit: "时长上限", language_reset: "重置（自动识别）", language_multi_hint: "可多选；不选即自动识别（仅偏向，不限制）。", language_filter_hint: "默认仅显示常用语言，其余可在「配置」中开启。", settings_language: "语言", show_rare_langs: "显示相对小众的语言", show_rare_langs_hint: "开启后，「语言」列表显示供应商支持的全部语种；关闭时只显示 8 种常用语言。", key: "API Key", save_key: "存入本地环境", key_hint_prefix: "在", key_hint_suffix: "获取 API Key ↗", json_project: "工程文件", json_placeholder: "生成工程后会自动填入，也可以手动选择之前的工程", server_media: "服务器媒体（可选）", server_media_missing: "工程未记录媒体，或文件已移动，请手动选择。", flv_media_hint: "flv 无法预览，将会自动转换成 mp4 格式", port: "端口", advanced: "高级选项", open_mawe: "🎬 启动字幕编辑器", server_stop: "⏹️ 停止服务器", start: "✨ 生成字幕和工程", open_folder: "📁 打开输出文件夹", open_html: "打开 html 编辑器", open_blank_html: "打开 html 空模板", demo_mode: "演示模式", settings_title: "配置", settings_ffmpeg: "FFmpeg", settings_stickers: "默认表情包路径", stickers_explain: "表情包根目录供 HTML 编辑器使用；支持嵌套子目录（如 大狗/、Nox/ 等）。", current_value: "当前", unset: "未设置", sticker_dir: "表情包根目录", choose_folder: "选择文件夹", change: "更改", ffmpeg_found: "成功定位到 ffmpeg", ffmpeg_path: "FFmpeg 路径", ffmpeg_placeholder: "ffmpeg.exe / ffprobe.exe 所在 bin 目录，或 ffmpeg.exe", ffmpeg_help: "如何安装 FFmpeg ↗", ffmpeg_missing: "未找到 ffmpeg / ffprobe", ffmpeg_need: "需要依赖 ffmpeg 先将视频转成音频后才能发送给服务器转录", sticker_missing: "请选择一个存在的文件夹。", ready: "就绪", running: "转写中…", saved: "设置已保存", failed: "失败", done: "完成", key_empty: "未配置密钥", key_loaded: "已加载密钥 {key}", workspace_hint: "北京地域选填（推荐），新加坡地域必填。", other_language: "English", drop_hint: "拖入音频/视频文件，或点击选择。", drop_reject: "只支持音频、视频或工程文件。", media_required: "请选择存在的媒体文件。", output_required: "请填写 SRT 输出路径。", key_required: "请填写 API Key，或先保存到 .env。", workspace_required: "新加坡地域需要 Workspace ID。", json_required: "请选择工程文件后再打开 MAWE。", server_media_required: "工程没有可用媒体，请手动选择媒体文件。", speaker_colors: "给不同说话人分配字幕颜色", speaker_colors_hint: "最多 5 种颜色；说话人超过 5 个时颜色循环复用。", speaker_colors_title: "转写时按说话人自动着色（生成后仍可在编辑器修改）" },
    en: { media_output: "1️⃣ Media & Output", recognition: "2️⃣ Recognition Settings", server: "4️⃣ Subtitle Editor Settings", logs: "3️⃣ Logs", provider: "Recognition source", test_run: "Test run", test_run_title: "Trim to the first 2 minutes to test the workflow and API", test_run_override: "Test run is limited to the first 2 minutes", debug_raw: "Debug run (save full response)", debug_raw_title: "Also save the raw ASR service response as JSON for investigating segmentation, punctuation, and timestamps.", hero_desc: "Local media ➜ AI transcription ➜ Editable subtitle projects", project_home: "Project", media: "Media file", srt_output: "SRT output", choose: "Choose", model: "Model", region: "Region", workspace: "Workspace ID", language: "Language", length_limit: "Length limit", language_reset: "Reset (auto-detect)", language_multi_hint: "Multi-select; empty = auto (bias only).", language_filter_hint: "Only common languages are shown by default. Enable the rest in Settings.", settings_language: "Language", show_rare_langs: "Show less common languages", show_rare_langs_hint: "When enabled, the language list shows every supported language; otherwise it shows 8 common languages.", key: "API Key", save_key: "Save locally", key_hint_prefix: "Get an API Key from", key_hint_suffix: "↗", json_project: "Project file", json_placeholder: "Auto-filled after generation, or choose an earlier project", server_media: "Server media (optional)", server_media_missing: "The project has no media, or the file moved. Choose it again.", flv_media_hint: "flv cannot be previewed and will be converted to mp4 automatically", port: "Port", advanced: "Advanced options", open_mawe: "🎬 Launch Subtitle Editor", server_stop: "⏹️ Stop server", start: "✨ Generate subtitles & project", open_folder: "📁 Open output folder", open_html: "Open HTML editor", open_blank_html: "Open blank HTML template", demo_mode: "Demo mode", settings_title: "Settings", settings_ffmpeg: "FFmpeg", settings_stickers: "Default sticker path", stickers_explain: "Sticker root directory for the HTML editor; nested folders are supported.", current_value: "Current", unset: "Not set", sticker_dir: "Sticker root", choose_folder: "Choose folder", change: "Change", ffmpeg_found: "Located ffmpeg successfully", ffmpeg_path: "FFmpeg path", ffmpeg_placeholder: "bin directory containing ffmpeg/ffprobe, or ffmpeg executable", ffmpeg_help: "How to install FFmpeg ↗", ffmpeg_missing: "ffmpeg / ffprobe not found", ffmpeg_need: "ffmpeg is required to convert video to audio before sending it to the transcription server", sticker_missing: "Choose an existing folder.", ready: "Ready", running: "Running…", saved: "Settings saved", failed: "Failed", done: "Done", key_empty: "No key configured", key_loaded: "Loaded key {key}", workspace_hint: "Optional (recommended) for Beijing; required for Singapore.", other_language: "中文", drop_hint: "Drop an audio/video file here, or choose one.", drop_reject: "Only audio, video, or project files are supported.", media_required: "Choose an existing media file.", output_required: "Enter an SRT output path.", key_required: "Enter an API key, or save one to .env first.", workspace_required: "Workspace ID is required for Singapore.", json_required: "Choose a project file before opening MAWE.", server_media_required: "The project has no usable media. Choose media manually.", speaker_colors: "Assign subtitle colors to speakers", speaker_colors_hint: "Up to 5 colors; colors cycle when there are more than 5 speakers.", speaker_colors_title: "Color subtitles by speaker during transcription (editable afterwards)" }
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
    qwen_audio_context: "附加上下文（Prompt）",
    qwen_audio_context_placeholder: "额外用来辅助 AI 判断的上下文提示词，例如：这是一段关于医药公司的会议记录，参与人员有阿米娅、凯尔希、维什戴尔等人，它们讨论的主要话题基于“源石”的治愈方案展开。",
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
    context_too_long: "Qwen-Audio 上下文最多 400 个字符。"
  });
  Object.assign(STRINGS.en, {
    qwen_audio_context: "Prompt / context",
    qwen_audio_context_placeholder: "An additional context prompt to help the AI interpret the audio, e.g.: This is a meeting transcript from a pharmaceutical company. Participants include Amiya, Kal'tsit, Wis'adel, and others. The main topic is a healing solution based on “Originium.”",
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
    context_too_long: "Qwen-Audio context is limited to 400 characters."
  });
  Object.assign(STRINGS.zh, {
    settings_appearance: "外观",
    theme_light: "明亮模式",
    theme_dark: "暗色模式",
    theme_system: "跟随系统设置"
  });
  Object.assign(STRINGS.en, {
    settings_appearance: "Appearance",
    theme_light: "Light",
    theme_dark: "Dark",
    theme_system: "Follow system"
  });
  const SERVER_STARTING_TEXT = { zh: "启动中……", en: "Starting…" };
  // Launcher 暂时面向国内用户默认北京；地域和 Workspace 仍保留在请求契约中，后续可重新开放。
  const SHOW_REGIONAL_FIELDS = false;
  // 界面暂不开放时长上限，底层参数保留。
  const SHOW_LENGTH_LIMIT_FIELD = false;

  const MEDIA_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v", ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"]);
  const PROJECT_EXTS = new Set([".mosp", ".json"]);
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
      workspace_missing: "新加坡地域需要 Workspace ID。",
      context_too_long: "Qwen-Audio 上下文最多 400 个字符。",
      hotwords_file_missing: "请选择存在且为 UTF-8 编码的 .txt 热词文件。",
      output_missing: "请填写 SRT 输出路径。",
      ffmpeg_start_failed: "FFmpeg 启动失败（Windows 错误 0xC0000142）。请检查 FFmpeg 是否完整、可执行文件是否被安全软件拦截；本次任务已停止，可以修复后重新尝试。",
      transcription_failed: "转写失败，本次任务已停止。请查看日志后修正问题，再重新尝试。",
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
      workspace_missing: "Singapore region requires a Workspace ID.",
      context_too_long: "Qwen-Audio context is limited to 400 characters.",
      hotwords_file_missing: "Choose an existing UTF-8 .txt hotword file.",
      output_missing: "Enter an SRT output path.",
      ffmpeg_start_failed: "FFmpeg failed to start (Windows error 0xC0000142). Check that FFmpeg is complete and not blocked by security software, then retry.",
      transcription_failed: "Transcription failed and this run has stopped. Check the log, fix the problem, and retry.",
      ffprobe_start_failed: "ffprobe failed to start (Windows error 0xC0000142). Please run MAW again. If it keeps happening, download and fully extract MAWxFF again, and check Windows Security for a blocked ffprobe.exe.",
      config_save_failed: (detail) => `Could not save local configuration: ${detail || "check the app-data directory permissions and try again."}`,
      server_no_response: (detail) => `The editor server did not respond (${detail || "http://127.0.0.1"}). The port may be occupied; check the port and retry.`,
      server_start_failed: (detail) => `The editor server failed to start: ${detail || "check the logs below."}`,
      sticker_dir_invalid: "Sticker root directory does not exist."
    }
  };
  Object.assign(STRINGS.zh, {
    start_server_editor: "🚀 启动字幕编辑器",
  });
  Object.assign(STRINGS.en, {
    start_server_editor: "🚀 Start Editor",
  });

  const HOME_URL = "https://github.com/Moyf/moys-asr-workflow";
  const LAST_MODEL_KEY = "MAW_GUI_LAST_MODEL";
  const LAST_LANGUAGE_KEY = "MAW_GUI_LAST_LANGUAGE";
  const THEME_KEY = "MAW_GUI_THEME";
  const $ = (id) => document.getElementById(id);
  const HOTWORD_WEIGHTS = new Set([1, 2, 3, 4, 5, 50]);
  const MAX_HOTWORDS = 2000;
  const MAX_SUPER_HOTWORDS = 50;
  const state = { lang: "zh", serverRunning: false, serverStarting: false, serverProjectPath: "", running: false, localPreparing: false, localProgressMessage: "", localProgress: null, localModelId: "", localModelPaths: {}, localRuntimeInstalling: false, localRuntimeProgress: 0, localRuntimeProgressMessage: "", lastLogMessage: "", result: null, config: null, srtAuto: true, testSuffixAdded: false, serverMediaOk: false, detectedServerUrl: "", dropTarget: "", theme: "system" };
  const dragState = { depth: 0 };
  let api = null;
  let prefsTimer = 0;

  function mockApi() {
    let saved = { apiKey: "", region: "beijing", language: "", workspaceId: "", guiLang: "zh" };
    let modelPrepareTimer = 0;
    return {
      get_config: async () => ({
        apiKey: saved.apiKey,
        maskedApiKey: saved.apiKey ? "sk-…demo" : "",
        providerId: "qwen",
        modelId: "qwen-audio-3.0-asr-flash-filetrans",
        lastModel: localStorage.getItem(LAST_MODEL_KEY),
        lastLanguage: localStorage.getItem(LAST_LANGUAGE_KEY),
        region: saved.region,
        language: saved.language,
        workspaceId: saved.workspaceId,
        guiLang: saved.guiLang,
        showRareLangs: saved.showRareLangs || false,
        appVersion: "1.13.1-beta-5",
        stickerDir: saved.stickerDir || "",
        modelCacheRoot: saved.modelCacheRoot || "D:\\Models\\MAW",
        localRuntime: { status: "missing", ready: false, path: "", pythonPath: "", modelCachePath: saved.modelCacheRoot || "D:\\Models\\MAW", detail: "" },
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
            models: [{ id: "stt-async-v5", label: "Soniox Async STT（v5）", envKey: "SONIOX_API_KEY", note: "", supportsSpeaker: true, languages: [{ id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }, { id: "ko", label: "韩语 / Korean" }, { id: "fr", label: "法语 / French" }, { id: "de", label: "德语 / German" }] }],
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
          }
        ]
      }),
      default_output: async ({ mediaPath, providerId, modelId, testRun }) => ({ ok: true, path: mediaPath ? mediaPath.replace(/\.[^.\\/]+$/, `${providerId === "soniox" ? ".soniox" : (providerId === "local" ? (modelId.includes("sensevoice") ? ".sensevoice-local" : ((modelId.includes("funasr") || modelId.includes("fun-asr")) ? ".funasr-local" : (modelId.includes("1.7b") ? ".qwen3-asr-1.7b-local" : ".qwen-asr-local"))) : (modelId === "fun-asr" ? ".fun-asr" : (modelId === "qwen-audio-3.0-asr-flash-filetrans" ? ".qwen-audio" : ".qwen3-asr-api")))}${testRun ? "-test" : ""}.srt`) : "" }),
      choose_file: async ({ kind }) => ({ ok: true, path: kind === "json" ? "D:\\Demo\\project.json" : (kind === "hotwords" ? "D:\\Demo\\hotwords.txt" : "D:\\Demo\\clip.mp4") }),
      read_hotword_file: async () => ({ ok: true, path: "D:\\Demo\\hotwords.txt", text: "张三\n阿里云百炼\n专业术语\n" }),
      save_settings: async (payload) => { saved = { ...saved, ...payload }; if (Object.prototype.hasOwnProperty.call(payload, "modelCacheRoot")) { state.config.modelCacheRoot = payload.modelCacheRoot || ""; state.config.localRuntime = { ...(state.config.localRuntime || {}), modelCachePath: payload.modelCacheRoot || "D:\\Models\\MAW" }; } return { ok: true, maskedApiKey: payload.apiKey ? "sk-…mock" : "", modelCacheRoot: Object.prototype.hasOwnProperty.call(payload, "modelCacheRoot") ? (payload.modelCacheRoot || "") : (state.config?.modelCacheRoot || ""), message: "mock saved" }; },
      get_local_runtime: async () => ({ ok: true, ...(state.config?.localRuntime || { status: "missing", ready: false }) }),
      install_local_runtime: async () => { state.config.localRuntime = { status: "ready", ready: true, path: "D:\\Users\\Demo\\AppData\\Local\\MAW\\local-runtime", detail: "本地运行环境已就绪。" }; setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "localRuntimeReady", runtime: state.config.localRuntime }), 400); return { ok: true, installing: true }; },
      cancel_local_runtime: async () => ({ ok: true }),
      get_local_models: async ({ modelId, modelPath }) => ({ ok: true, runtime: state.config?.localRuntime || {}, models: (state.config?.providers.find((item) => item.id === "local")?.models || []).map((model) => ({ ...model, localStatus: { ...(model.localStatus || {}), ...(model.id === modelId && modelPath ? { status: "installed", installed: true, path: modelPath, detail: "已使用指定的模型目录。" } : {}) } })) }),
      prepare_local_model: async ({ modelId }) => { clearTimeout(modelPrepareTimer); modelPrepareTimer = setTimeout(() => { state.config?.providers.find((item) => item.id === "local")?.models.forEach((model) => { if (model.id === modelId) model.localStatus = { ...(model.localStatus || {}), status: "installed", installed: true, runtimeAvailable: true, canPrepare: false, detail: "已检测到本地模型。" }; }); window.MAWLauncher.onBackendEvent({ type: "modelPrepared", modelId }); }, 400); return { ok: true, preparing: true, modelId }; },
      cancel_local_model: async () => { clearTimeout(modelPrepareTimer); setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "localPrepareCancelled" }), 80); return { ok: true, cancelling: true }; },
      save_prefs: async (payload) => { if (Object.prototype.hasOwnProperty.call(payload, "modelId")) localStorage.setItem(LAST_MODEL_KEY, payload.modelId || ""); if (Object.prototype.hasOwnProperty.call(payload, "language")) localStorage.setItem(LAST_LANGUAGE_KEY, payload.language || ""); if (Object.prototype.hasOwnProperty.call(payload, "showRareLangs")) saved.showRareLangs = Boolean(payload.showRareLangs); return { ok: true }; },
      open_url: async ({ url }) => { window.open(url, "_blank"); return { ok: true }; },
      open_blank_html: async () => ({ ok: true }),
      check_ffmpeg: async () => ({ ok: true, found: true, directory: "D:\\FFmpeg\\bin", ffmpeg: "D:\\FFmpeg\\bin\\ffmpeg.exe", ffprobe: "D:\\FFmpeg\\bin\\ffprobe.exe" }),
      save_ffmpeg_path: async ({ path }) => ({ ok: Boolean(path), found: Boolean(path), directory: path || "", ffmpeg: path || "", ffprobe: path || "" }),
      choose_folder: async ({ kind } = {}) => ({ ok: true, path: kind === "model-cache" ? "D:\\Models\\MAW" : "D:\\Stickers" }),
      save_sticker_dir: async ({ path }) => { saved.stickerDir = path || ""; return { ok: Boolean(path), stickerDir: saved.stickerDir, field: path ? "" : "stickerDir", error: path ? "" : "missing" }; },
      check_server_media: async ({ jsonPath }) => ({ ok: Boolean(jsonPath), hasMedia: Boolean(jsonPath), mediaPath: "D:\\Demo\\clip.mp4", mediaExists: Boolean(jsonPath) }),
      start_server: async () => { setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "log", message: "[mock] would open http://127.0.0.1:8250/ after server responds" }), 120); return { ok: true, url: "http://127.0.0.1:8250/" }; },
      get_server_status: async ({ port = "8250" }) => ({ ok: true, running: false, url: `http://127.0.0.1:${port}/` }),
      stop_server: async () => ({ ok: true }),
      start_transcription: async () => { setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "log", message: "[mock] 上传完成" }), 250); setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "done", result: { srtPath: "D:\\Demo\\clip.srt", jsonPath: "D:\\Demo\\clip.json", htmlPath: "D:\\Demo\\clip.edit.html" } }), 900); return { ok: true }; },
      open_output_folder: async () => ({ ok: true }),
      open_html: async () => ({ ok: true })
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
    const urlPattern = /https?:\/\/[^\s<>"'|]+/gi;
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
  const appendLog = (text) => { const log = $("log"); log.textContent += `${text}\n`; log.scrollTop = log.scrollHeight; state.lastLogMessage = text; const latest = $("logLatest"); latest.textContent = text; latest.classList.remove("hidden"); };

  function resolveTheme() { if (state.theme === "light" || state.theme === "dark") return state.theme; return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
  function applyTheme() { if (resolveTheme() === "light") document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme; $("themeLight").classList.toggle("active", state.theme === "light"); $("themeDark").classList.toggle("active", state.theme === "dark"); $("themeSystem").classList.toggle("active", state.theme === "system"); }
  function setTheme(pref) { state.theme = pref; try { localStorage.setItem(THEME_KEY, pref); } catch (error) { /* localStorage 不可用时仅作用于本次会话 */ } applyTheme(); }

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

  function setRunning(running) { state.running = running; $("progress").classList.toggle("hidden", !running); $("start").disabled = running; setStatus(running ? t("running") : t("ready")); }
  function fillSelect(id, items, value) { const el = $(id); el.innerHTML = ""; items.forEach((item) => el.add(new Option(item.label, item.id))); el.value = value ?? ""; }
  function setError(field, message) { const input = $(field); const hint = $(`${field}Error`); if (input) input.classList.toggle("invalid", Boolean(message)); if (hint) { renderMessage(hint, message); hint.classList.toggle("visible", Boolean(message)); } }
  function setOutputNotice(message) { const notice = $("srtPathNotice"); if (!notice) return; renderMessage(notice, message); notice.classList.toggle("hidden", !message); }
  function mediaDropError() { const separator = state.lang === "zh" ? "、" : ", "; return t("drop_reject_media").replace("{extensions}", Array.from(MEDIA_EXTS).join(separator)); }
  function clearErrors() { ["mediaPath", "srtPath", "apiKey", "workspaceId", "localModelPath", "localModelCachePath", "qwenAudioContext", "qwenAudioHotwords", "qwenAudioHotwordsFile", "jsonPath", "serverMediaPath", "port", "ffmpegPath", "stickerDir"].forEach((field) => setError(field, "")); }
  function formPayload() { return { providerId: $("provider").value, modelId: $("model").value, mediaPath: $("mediaPath").value.trim(), srtPath: $("srtPath").value.trim(), apiKey: $("apiKey").value.trim(), region: $("region").value, workspaceId: $("workspaceId").value.trim(), localModelPath: $("localModelPath").value.trim(), device: $("localDevice").value, language: languageValue(), lengthLimit: $("lengthLimit").value.trim(), qwenAudioContext: $("qwenAudioContext").value.trim(), qwenAudioHotwordsMode: $("qwenAudioHotwordsMode").value, qwenAudioHotwords: $("qwenAudioHotwords").value.trim(), qwenAudioHotwordsFile: $("qwenAudioHotwordsFile").value.trim(), qwenAudioHotwordWeight: $("qwenAudioHotwordWeight").value, testRun: $("testRun").checked, debugRaw: $("debugRaw").checked, speakerColors: $("speakerColors").checked, generateHtml: $("generateHtml").checked, guiLang: state.lang }; }
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
  function syncQwenAudioOptions(model) { const enabled = Boolean(model?.supportsContext || model?.supportsHotwords); $("qwenAudioOptions").classList.toggle("hidden", !enabled); $("qwenAudioContextField").classList.toggle("hidden", !model?.supportsContext); $("qwenAudioHotwordsSection").classList.toggle("hidden", !model?.supportsHotwords); syncQwenAudioHotwordsMode(); }
  function renderPromptCharacterCount() { const count = Array.from($("qwenAudioContext").value).length; const counter = $("qwenAudioContextCount"); counter.textContent = t("qwen_audio_context_count").replace("{count}", String(count)); counter.classList.toggle("over-limit", count > 400); }
  function splitHotwordEntries(value, ignoreComments = false) { return String(value || "").split(/[\r\n,，;；]+/u).map((word) => word.trim()).filter((word) => word && (!ignoreComments || !word.startsWith("#"))); }
  function parseHotwordEntry(value, defaultWeight) { const match = value.match(/^(.+?)\s*[:：]\s*(\d+)\s*$/u); const text = (match ? match[1] : value).trim(); if (!text) return { code: "empty" }; const weight = match ? Number(match[2]) : defaultWeight; if (!HOTWORD_WEIGHTS.has(weight)) return { code: "invalid_weight" }; const chars = Array.from(text).length; if (Array.from(text).some((char) => char.codePointAt(0) > 127) && chars > 15) return { code: "text_too_long" }; if (!Array.from(text).some((char) => char.codePointAt(0) > 127) && text.split(/\s+/u).filter(Boolean).length > 7) return { code: "too_many_ascii_words" }; return { text, weight }; }
  function collectHotwordWarnings(value, weight, ignoreComments = false) { const parsed = new Map(); const issues = []; splitHotwordEntries(value, ignoreComments).forEach((raw, index) => { const entry = parseHotwordEntry(raw, weight); if (entry.code) { issues.push({ index: index + 1, code: entry.code, text: raw }); return; } parsed.set(entry.text, { index: index + 1, entry }); }); let validCount = 0; let superCount = 0; Array.from(parsed.values()).sort((left, right) => left.index - right.index).forEach(({ index, entry }) => { if (validCount >= MAX_HOTWORDS) { issues.push({ index, code: "too_many", text: entry.text }); return; } if (entry.weight === 50 && superCount >= MAX_SUPER_HOTWORDS) { issues.push({ index, code: "too_many_super", text: entry.text }); return; } validCount += 1; if (entry.weight === 50) superCount += 1; }); return issues; }
  function hotwordWarningLabel(issue) { const text = String(issue.text || "").trim(); if (!text) return t("qwen_audio_hotword_warning_index").replace("{index}", String(issue.index)); const chars = Array.from(text); const truncated = chars.length > 16 ? `${chars.slice(0, 16).join("")}…` : text; return state.lang === "zh" ? `「${truncated}」` : `“${truncated}”`; }
  function renderHotwordWarnings(value = $("qwenAudioHotwords").value, weight = Number($("qwenAudioHotwordWeight").value), ignoreComments = false) { const warning = $("qwenAudioHotwordsWarning"); const issues = collectHotwordWarnings(value, weight, ignoreComments); if (!issues.length) { warning.textContent = ""; warning.classList.remove("visible"); return; } const details = issues.slice(0, 5).map((issue) => t("qwen_audio_hotword_warning_item").replace("{label}", hotwordWarningLabel(issue)).replace("{reason}", t(`qwen_audio_hotword_issue_${issue.code}`))); if (issues.length > details.length) details.push(t("qwen_audio_hotword_warning_more")); warning.textContent = `${t("qwen_audio_hotwords_warning").replace("{count}", String(issues.length))}\n${details.join("\n")}`; warning.classList.add("visible"); }
  function syncQwenAudioHotwordsMode() { const fileMode = $("qwenAudioHotwordsMode").value === "file"; $("qwenAudioHotwordsTextField").classList.toggle("hidden", fileMode); $("qwenAudioHotwordsFileField").classList.toggle("hidden", !fileMode); renderHotwordWarnings(fileMode ? "" : $("qwenAudioHotwords").value, Number($("qwenAudioHotwordWeight").value)); }
  function setHotwordsMode(mode) { $("qwenAudioHotwordsMode").value = mode; $("qwenAudioHotwordsModeText").classList.toggle("active", mode === "text"); $("qwenAudioHotwordsModeFile").classList.toggle("active", mode === "file"); syncQwenAudioHotwordsMode(); }
  function clearDropState() { dragState.depth = 0; state.dropTarget = ""; setDropHighlight(false); ["qwenAudioHotwords", "qwenAudioHotwordsFile", "jsonPath"].forEach((id) => $(id)?.classList.remove("drag-over")); }
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
    button.textContent = installing ? t("local_runtime_cancel") : (runtime.status === "ready" ? t("local_runtime_repair") : t("local_runtime_install"));
    $("refreshLocalRuntime").disabled = installing;
    const progress = $("localRuntimeProgress");
    progress.classList.toggle("hidden", !installing);
    $("localRuntimeProgressBar").style.width = `${Math.max(0, Math.min(100, state.localRuntimeProgress))}%`;
    $("localRuntimeProgressMessage").textContent = state.localRuntimeProgressMessage || "";
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
  function renderLanguage() { document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en"; document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); }); document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); }); document.querySelectorAll("[data-i18n-title]").forEach((node) => { node.title = t(node.dataset.i18nTitle); }); $("langToggle").textContent = t("other_language"); $("demoBadge").textContent = t("demo_mode"); renderKeyStatus(); renderStickerCurrent(); renderPromptCharacterCount(); renderHotwordWarnings(); renderServerButton(); renderLocalRuntime(); renderLocalModelStatus(); }
  function applyProvider(persistReset = false) { const current = provider(); const preferred = state.config.lastModel; const fallback = state.config.modelId || current.models[0]?.id; const modelValue = current.models.some((item) => item.id === preferred) ? preferred : (current.models.some((item) => item.id === fallback) ? fallback : current.models[0]?.id); fillSelect("model", current.models, modelValue); fillSelect("region", current.regions, state.config.region || "beijing"); const local = isLocalProvider(); $("cloudAuthField").classList.toggle("hidden", local); $("localRuntimePanel").classList.toggle("hidden", !local); $("localModelPanel").classList.toggle("hidden", !local); $("localDeviceField").classList.toggle("hidden", !local); $("openKeyUrl").classList.toggle("hidden", local); $("apiKey").value = current.apiKey || ""; applySelectedModel(persistReset); $("openKeyUrl").textContent = current.label; $("regionField").classList.toggle("hidden", !SHOW_REGIONAL_FIELDS || current.regions.length === 0); renderKeyStatus(); syncWorkspace(); if (local) { renderLocalRuntime(); void refreshLocalRuntime(); void refreshLocalModels(); } }
  function applySelectedModel(persistReset = false) { const current = provider(); const model = selectedModel(); syncLocalModelPath(model); $("modelNote").textContent = model.note || ""; applyProviderLanguages(current, model, persistReset); $("speakerColorsField").classList.toggle("hidden", !model.supportsSpeaker); syncQwenAudioOptions(model); renderLocalModelStatus(); syncDefaultOutput(); if (persistReset) savePrefsDebounced({ modelId: model.id, language: languageValue() }); }
  function applyProviderLanguages(current, model, persistReset = false) { const el = $("language"); const previous = el.multiple ? Array.from(el.selectedOptions).map((o) => o.value) : (el.value ? [el.value] : []); const remembered = state.config.lastLanguage; const wanted = previous.length && persistReset ? previous : (remembered !== null && remembered !== undefined ? (remembered ? remembered.split(",") : []) : [state.config.language].filter(Boolean)); el.multiple = Boolean(current.multiLanguage); $("advancedOptionsGrid").classList.toggle("single-language", !current.multiLanguage); if (current.multiLanguage) el.size = 6; else el.removeAttribute("size"); const showRare = Boolean(state.config.showRareLangs); const commons = current.commonLanguages || []; const available = model.languages?.length ? model.languages : current.languages; const visible = !showRare && commons.length ? available.filter((item) => commons.includes(item.id)) : available; fillSelect("language", visible, ""); const codes = new Set(visible.map((item) => item.id)); const restored = wanted.filter((code) => code && codes.has(code)); if (current.multiLanguage) { Array.from(el.options).forEach((o) => { o.selected = restored.includes(o.value); }); } else { el.value = restored[0] || ""; } $("languageHint").classList.toggle("hidden", !current.multiLanguage); $("languageFilterHint").classList.toggle("hidden", showRare || commons.length === 0); $("languageReset").classList.toggle("hidden", !current.multiLanguage); }
  function languageValue() { const el = $("language"); if (el.multiple) return Array.from(el.selectedOptions).map((o) => o.value).filter(Boolean).join(","); return el.value; }
  function syncWorkspace() { $("workspaceField").classList.toggle("hidden", !SHOW_REGIONAL_FIELDS || provider().regions.length === 0); }
  function appendTestSuffix(path) { const value = String(path || "").trim(); if (!value || /-test(?=\.[^./\\]+$)/iu.test(value)) return value; const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")); const dot = value.lastIndexOf("."); if (dot <= separator) return `${value}-test`; return `${value.slice(0, dot)}-test${value.slice(dot)}`; }
  function removeTestSuffix(path) { return String(path || "").replace(/-test(?=\.[^./\\]+$)/iu, ""); }
  function syncTestRun() { const on = $("testRun").checked; $("testRunHint").classList.toggle("hidden", !on); $("lengthLimit").disabled = on; if (state.srtAuto) { void syncDefaultOutput(); return; } const current = $("srtPath").value.trim(); if (on) { const next = appendTestSuffix(current); state.testSuffixAdded = Boolean(current && next !== current); $("srtPath").value = next; } else if (state.testSuffixAdded) { $("srtPath").value = removeTestSuffix(current); state.testSuffixAdded = false; } }
  function savePrefsDebounced(payload) { clearTimeout(prefsTimer); prefsTimer = setTimeout(() => bridge("save_prefs", payload), 300); }
  async function syncDefaultOutput() { const result = await bridge("default_output", { mediaPath: $("mediaPath").value.trim(), providerId: $("provider").value, modelId: $("model").value, testRun: $("testRun").checked }); const path = result.ok ? result.path : ""; $("srtPath").placeholder = path; if (state.srtAuto) { $("srtPath").value = path; if (path) setError("srtPath", ""); setOutputNotice(result.renamed ? t("output_collision") : ""); } else setOutputNotice(""); }
  function syncFlvHints() {
    $("mediaPathFlvHint")?.classList.toggle("hidden", ext($("mediaPath").value.trim()) !== ".flv");
    $("serverMediaFlvHint")?.classList.toggle("hidden", ext($("serverMediaPath").value.trim()) !== ".flv");
  }
  function setMedia(path) { $("mediaPath").value = path; setError("mediaPath", ""); setOutputNotice(""); syncFlvHints(); syncDefaultOutput(); }
  function setJsonPath(path) { $("jsonPath").value = path; setError("jsonPath", ""); if (path !== state.serverProjectPath) $("openMawe").classList.add("attention"); refreshServerMedia(); }
  function applyErrorResult(result, logDetail = true) { const message = errText(result.code, result.detail || result.error); const fieldMessage = result.code === "server_start_failed" ? t("server_start_failed_hint") : (result.code === "server_no_response" ? t("server_no_response_hint") : message); if (result.field) setError(result.field, fieldMessage); if (result.field === "port" || result.field === "serverMediaPath" || result.field === "jsonPath") expandServer(); setStatus(message); if (logDetail && (result.detail || result.error)) appendLog(`[error] ${result.code || "backend_error"}: ${result.detail || result.error}`); }
  function validateLocal() { clearErrors(); const data = formPayload(); if (!data.mediaPath) return fail("mediaPath", errText("media_not_found", "")); if (!data.srtPath) return fail("srtPath", errText("output_missing", "")); if (isLocalProvider()) { const runtime = state.config.localRuntime || {}; const status = localStatus(); if (!runtime.ready && runtime.status !== "ready") return fail("model", errText("local_runtime_missing", "")); if (status.status === "runtime_missing") return fail("model", errText("local_runtime_missing", "")); if (status.status === "path_invalid") return fail("localModelPath", errText("local_model_path_invalid", "")); if (status.status === "path_mismatch") return fail("localModelPath", errText("local_model_path_mismatch", "")); if (status.status === "missing") return fail("model", errText("local_model_missing", "")); if (status.status === "partial") return fail("model", errText("local_model_incomplete", "")); return true; } if (!data.apiKey && !provider().apiKey) return fail("apiKey", errText("api_key_missing", "")); if (provider().regions.length > 0 && data.region === "singapore" && !data.workspaceId) return fail("workspaceId", errText("workspace_missing", "")); if (selectedModel().supportsContext && Array.from(data.qwenAudioContext).length > 400) return fail("qwenAudioContext", errText("context_too_long", "")); if (selectedModel().supportsHotwords && data.qwenAudioHotwordsMode === "file" && ext(data.qwenAudioHotwordsFile) !== ".txt") return fail("qwenAudioHotwordsFile", errText("hotwords_file_missing", "")); return true; }
  function fail(field, message) { setError(field, message); setStatus(message); const input = $(field); if (input && input.scrollIntoView) input.scrollIntoView({ behavior: "smooth", block: "center" }); return false; }
  function toggle(id) { $(id).classList.toggle("collapsed"); renderChevron(id); }
  function setupScrollbarFlash() {
    const VISIBLE_MS = 900;
    const bind = (target, host) => { let timer = 0; target.addEventListener("scroll", () => { host.classList.add("scrolling"); clearTimeout(timer); timer = setTimeout(() => host.classList.remove("scrolling"), VISIBLE_MS); }, { passive: true }); };
    bind(window, document.documentElement);
    document.querySelectorAll(".log, .modal-card").forEach((el) => bind(el, el));
  }
  function expandServer() { $("serverCard").classList.remove("collapsed"); renderChevron("serverCard"); }
  function hasFileDrag(event) { return !event.dataTransfer || Array.from(event.dataTransfer.types || []).includes("Files"); }
  function setDropHighlight(active) { $("mediaCard").classList.toggle("drag-over", active); }
  function isInsideMediaCard(node) { return node instanceof Node && $("mediaCard").contains(node); }
  function onDragEnter(event) { if (!hasFileDrag(event) || !isInsideMediaCard(event.target)) return; event.preventDefault(); if (isInsideMediaCard(event.relatedTarget)) return; dragState.depth += 1; setDropHighlight(true); }
  function onDragLeave(event) { if (!isInsideMediaCard(event.target)) return; if (isInsideMediaCard(event.relatedTarget)) return; dragState.depth = Math.max(0, dragState.depth - 1); if (dragState.depth === 0) setDropHighlight(false); }
  function bindDropField(id, target, controlId) { const field = $(id); const control = $(controlId || id); field.addEventListener("dragenter", (event) => { if (!hasFileDrag(event)) return; event.preventDefault(); state.dropTarget = target; control.classList.add("drag-over"); }); field.addEventListener("dragover", (event) => { if (!hasFileDrag(event)) return; event.preventDefault(); state.dropTarget = target; control.classList.add("drag-over"); }); field.addEventListener("dragleave", (event) => { if (!field.contains(event.relatedTarget)) { control.classList.remove("drag-over"); if (state.dropTarget === target) state.dropTarget = ""; } }); }
  function handleRoutedDrop(path) { const target = state.dropTarget; clearDropState(); const suffix = ext(path || ""); if (target === "json") { if (PROJECT_EXTS.has(suffix)) { setJsonPath(path); setStatus(t("json_project")); } else setError("jsonPath", t("drop_reject_json")); return; } if (target === "text" || target === "file") { if (suffix === ".txt") { void loadHotwordFile(path, target === "text"); } else setError(target === "text" ? "qwenAudioHotwords" : "qwenAudioHotwordsFile", t("drop_reject_txt")); return; } if (PROJECT_EXTS.has(suffix)) { setJsonPath(path); setStatus(t("json_project")); return; } if (suffix === ".txt") { void loadHotwordFile(path, false); return; } if (MEDIA_EXTS.has(suffix)) { setMedia(path); setStatus(t("media")); return; } setError("mediaPath", mediaDropError()); }
  async function refreshServerMedia() { const jsonPath = $("jsonPath").value.trim(); const result = await bridge("check_server_media", { jsonPath }); state.serverMediaOk = Boolean(result.hasMedia && result.mediaExists); $("serverMediaField").classList.toggle("hidden", state.serverMediaOk || !jsonPath); return result; }
  async function refreshFfmpeg() { const result = await bridge("check_ffmpeg"); $("modalFfmpegFound").classList.toggle("hidden", !result.found); $("modalFfmpegMissing").classList.toggle("hidden", Boolean(result.found)); $("ffmpegPathBox").classList.toggle("hidden", Boolean(result.found)); $("settingsDot").classList.toggle("hidden", Boolean(result.found)); $("modalFfmpegFound").title = result.directory || ""; $("ffmpegDir").textContent = result.directory || ""; return result; }
  function ffmpegSaveError(result) { if (result.code) return errText(result.code, result.detail || result.error); if (result.found === false) return t("ffmpeg_missing"); return compactDetail(result.error) || t("failed"); }
  function openSettings() { $("settingsModal").classList.remove("hidden"); refreshFfmpeg(); renderStickerCurrent(); $("showRareLangs").checked = Boolean(state.config.showRareLangs); }
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
    state.lang = state.config.guiLang || "zh";
    fillSelect("provider", state.config.providers, state.config.providerId || "qwen");
    applyProvider(false);
    $("workspaceId").value = state.config.workspaceId || "";
    syncWorkspace(); syncTestRun(); renderChevron("advancedCard"); renderChevron("serverCard"); renderLanguage(); refreshFfmpeg();
    appendLog(window.MAWLauncher.backend === "real" ? "MAW launcher ready." : "[mock] Static browser demo mode enabled."); setStatus(t("ready")); await checkExistingServer();
  }

  function handleBackendEvent(event) {
    if (event.type === "log") appendLog(event.message);
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
    if (event.type === "error") {
      setRunning(false);
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
      setJsonPath(event.result?.jsonPath || "");
      $("openMawe").classList.add("attention");
      $("openFolder").classList.remove("hidden");
      syncHtmlMenu();
      appendLog(t("done"));
      void checkExistingServer(t("done"));
    }
    if (event.type === "dropMedia" || event.type === "dropJson" || event.type === "dropHotwordFile" || event.type === "dropReject") handleRoutedDrop(event.path || "");
  }
  window.MAWLauncher = { backend: "pending", onBackendEvent: handleBackendEvent, onBackendEvents(events) { events.forEach(handleBackendEvent); } };

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
  ["apiKey", "workspaceId", "qwenAudioContext", "qwenAudioHotwords", "qwenAudioHotwordsFile", "qwenAudioHotwordWeight", "serverMediaPath", "port", "ffmpegPath", "stickerDir"].forEach((field) => { const el = $(field); el?.addEventListener("input", () => { setError(field, ""); if (field === "qwenAudioContext") renderPromptCharacterCount(); if (field === "qwenAudioHotwords") renderHotwordWarnings(); if (field === "qwenAudioHotwordWeight") renderHotwordWarnings(); if (field === "serverMediaPath") syncFlvHints(); if (field === "port") { state.detectedServerUrl = ""; renderServerButton(); } }); el?.addEventListener("change", () => { setError(field, ""); if (field === "qwenAudioHotwordWeight") renderHotwordWarnings(); if (field === "serverMediaPath") syncFlvHints(); if (field === "port") void checkExistingServer(); }); });
  $("refreshServerStatus").addEventListener("click", async () => { $("refreshServerStatus").disabled = true; try { await checkExistingServer(); } finally { $("refreshServerStatus").disabled = false; } });
  $("openKeyUrl").addEventListener("click", () => bridge("open_url", { url: provider().keyUrl }));
  $("pickLocalModelPath").addEventListener("click", async () => { const result = await bridge("choose_folder", { kind: "model" }); if (result.ok) { $("localModelPath").value = result.path; state.localModelPaths[selectedModel().id] = result.path; setError("localModelPath", ""); await refreshLocalModels(); } });
  $("pickLocalModelCachePath").addEventListener("click", async () => { const result = await bridge("choose_folder", { kind: "model-cache" }); if (result.ok) { $("localModelCachePath").value = result.path; await saveLocalModelCache(result.path); } });
  $("localModelCachePath").addEventListener("input", () => setError("localModelCachePath", ""));
  $("localModelCachePath").addEventListener("change", async () => { await saveLocalModelCache($("localModelCachePath").value); });
  $("localModelPath").addEventListener("input", () => { setError("localModelPath", ""); if (isLocalProvider()) { state.localModelPaths[selectedModel().id] = $("localModelPath").value.trim(); void refreshLocalModels(); } });
  $("refreshLocalRuntime").addEventListener("click", async () => { $("refreshLocalRuntime").disabled = true; try { await refreshLocalRuntime(); await refreshLocalModels(); } finally { $("refreshLocalRuntime").disabled = false; } });
  $("installLocalRuntime").addEventListener("click", async () => { if (!isLocalProvider()) return; if (state.localRuntimeInstalling) { await bridge("cancel_local_runtime"); return; } state.localRuntimeInstalling = true; state.localRuntimeProgress = 0; state.localRuntimeProgressMessage = t("local_runtime_installing"); renderLocalRuntime(); appendLog(t("local_runtime_installing")); const result = await bridge("install_local_runtime", { repair: state.config.localRuntime?.status === "ready" }); if (!result.ok) { state.localRuntimeInstalling = false; state.localRuntimeProgressMessage = ""; applyErrorResult(result); renderLocalRuntime(); } });
  $("refreshLocalModels").addEventListener("click", async () => { $("refreshLocalModels").disabled = true; try { await refreshLocalModels(); } finally { $("refreshLocalModels").disabled = false; } });
  $("prepareLocalModel").addEventListener("click", async () => { if (!isLocalProvider()) return; if (state.localPreparing) { state.localProgressMessage = t("local_prepare_cancelling"); renderLocalModelStatus(); appendLog(t("local_prepare_cancelling")); const result = await bridge("cancel_local_model"); if (!result.ok) { state.localProgressMessage = t("local_prepare_running"); applyErrorResult(result); renderLocalModelStatus(); } return; } state.localPreparing = true; state.localProgressMessage = t("local_prepare_running"); state.localProgress = null; renderLocalModelStatus(); appendLog(t("local_prepare_running")); const result = await bridge("prepare_local_model", { modelId: $("model").value, modelPath: $("localModelPath").value.trim(), device: $("localDevice").value }); if (!result.ok) { state.localPreparing = false; state.localProgressMessage = ""; state.localProgress = null; applyErrorResult(result); renderLocalModelStatus(); } else if (result.alreadyInstalled) { state.localPreparing = false; state.localProgressMessage = ""; state.localProgress = null; renderLocalModelStatus(); setStatus(t("local_installed")); } });
  $("ffmpegHelp").addEventListener("click", () => bridge("open_url", { url: "https://ffmpeg.org/download.html" }));
  $("settingsButton").addEventListener("click", openSettings); $("settingsClose").addEventListener("click", closeSettings); $("settingsBackdrop").addEventListener("click", closeSettings); document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSettings(); });
  $("changeFfmpeg").addEventListener("click", () => $("ffmpegPathBox").classList.remove("hidden"));
  $("saveFfmpeg").addEventListener("click", async () => { const result = await bridge("save_ffmpeg_path", { path: $("ffmpegPath").value.trim() }); if (!result.ok) { const message = ffmpegSaveError(result); setError("ffmpegPath", message); setStatus(message); return; } setError("ffmpegPath", ""); await refreshFfmpeg(); setStatus(t("saved")); });
  $("pickStickerDir").addEventListener("click", async () => { const result = await bridge("choose_folder"); if (result.ok) await saveStickerDirectory(result.path); });
  $("stickerDir").addEventListener("change", async () => { const path = $("stickerDir").value.trim(); if (path) await saveStickerDirectory(path); });
  $("showRareLangs").addEventListener("change", async () => { state.config.showRareLangs = $("showRareLangs").checked; applyProviderLanguages(provider(), selectedModel()); const result = await bridge("save_prefs", { showRareLangs: state.config.showRareLangs }); if (result.ok) setStatus(t("saved")); else applyErrorResult(result); });
  $("languageReset").addEventListener("click", () => { const el = $("language"); Array.from(el.options).forEach((o) => { o.selected = false; }); savePrefsDebounced({ language: "" }); });
  $("saveSettings").addEventListener("click", async () => { const result = await bridge("save_settings", formPayload()); if (result.ok) { const current = provider(); current.apiKey = $("apiKey").value.trim(); current.maskedApiKey = result.maskedApiKey; state.config.apiKey = current.apiKey; state.config.maskedApiKey = result.maskedApiKey; renderKeyStatus(); setStatus(t("saved")); } else applyErrorResult(result); });
  $("start").addEventListener("click", async () => { if (!validateLocal()) return; $("log").textContent = ""; state.lastLogMessage = ""; const latest = $("logLatest"); latest.textContent = ""; latest.classList.add("hidden"); setRunning(true); $("logTitle").scrollIntoView({ behavior: "smooth", block: "start" }); const result = await bridge("start_transcription", formPayload()); if (!result.ok) { setRunning(false); applyErrorResult(result, false); } else if (result.outputPath) { $("srtPath").value = result.outputPath; if (result.outputRenamed) setOutputNotice(t("output_collision")); } });
  $("openMawe").addEventListener("click", openServerEditor); $("stopServer").addEventListener("click", stopEditorServer); $("openFolder").addEventListener("click", () => bridge("open_output_folder"));
  $("openMenu").addEventListener("click", () => $("htmlMenu").classList.toggle("hidden")); $("openHtml").addEventListener("click", () => { $("htmlMenu").classList.add("hidden"); bridge("open_html"); }); $("openBlankHtml").addEventListener("click", () => { $("htmlMenu").classList.add("hidden"); bridge("open_blank_html"); }); document.addEventListener("click", (event) => { if (!event.target.closest(".split-wrap")) $("htmlMenu").classList.add("hidden"); });
  $("mediaCard").addEventListener("dragenter", onDragEnter); $("mediaCard").addEventListener("dragleave", onDragLeave);
  bindDropField("qwenAudioHotwordsTextField", "text", "qwenAudioHotwords"); bindDropField("qwenAudioHotwordsFileField", "file", "qwenAudioHotwordsFile"); bindDropField("jsonPath", "json");
  document.addEventListener("dragover", (event) => { if (hasFileDrag(event)) event.preventDefault(); });
  document.addEventListener("dragend", clearDropState);
  document.addEventListener("dragleave", (event) => { if (!event.relatedTarget && event.target === document.documentElement) clearDropState(); });
  // 真实后端模式下 drop 由 Python 侧异步回传事件，不能在这里清理 dropTarget，否则 handleRoutedDrop 读不到目标。
  document.addEventListener("drop", (event) => { event.preventDefault(); if (window.MAWLauncher.backend === "real") return; const file = event.dataTransfer?.files?.[0]; handleRoutedDrop(file?.path || file?.name || ""); });
  setupScrollbarFlash();
  document.addEventListener("DOMContentLoaded", init);
})();
