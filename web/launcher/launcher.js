(function () {
  "use strict";

  const STRINGS = {
    zh: { media_output: "1️⃣ 媒体与输出", recognition: "2️⃣ 识别设置", server: "4️⃣ 字幕编辑器设置", logs: "3️⃣ 日志", provider: "语音 API 供应商", test_run: "测试运行", test_run_title: "仅截取前2分钟内容，用于测试功能和 API", test_run_override: "测试运行已限定前 2 分钟", debug_raw: "调试运行（保存完整返回数据）", debug_raw_title: "额外保存 ASR 服务端返回的原始 JSON，便于排查断句、标点和时间码问题", hero_desc: "本地媒体 ➜ AI 转写 ➜ 可编辑字幕工程", project_home: "项目官网", media: "媒体文件", srt_output: "SRT 输出", choose: "选择", model: "模型", region: "地域", workspace: "工作空间 ID", language: "语言", length_limit: "时长上限", language_reset: "重置（自动识别）", language_multi_hint: "可多选；不选即自动识别（仅偏向，不限制）。", language_filter_hint: "默认仅显示常用语言，其余可在「配置」中开启。", settings_language: "语言", show_rare_langs: "显示相对小众的语言", show_rare_langs_hint: "开启后，「语言」列表显示供应商支持的全部语种；关闭时只显示 8 种常用语言。", key: "API Key", save_key: "存入本地环境", key_hint_prefix: "在", key_hint_suffix: "获取 API Key ↗", json_project: "工程文件", json_placeholder: "生成工程后会自动填入，也可以手动选择之前的工程", server_media: "服务器媒体（可选）", server_media_missing: "工程未记录媒体，或文件已移动，请手动选择。", flv_media_hint: "flv 无法预览，将会自动转换成 mp4 格式", port: "端口", advanced: "高级选项", open_mawe: "🎬 启动字幕编辑器", server_stop: "⏹️ 停止服务器", start: "✨ 生成字幕和工程", open_folder: "📁 打开输出文件夹", open_html: "打开 html 编辑器", open_blank_html: "打开 html 空模板", demo_mode: "演示模式", settings_title: "配置", settings_ffmpeg: "FFmpeg", settings_stickers: "默认表情包路径", stickers_explain: "表情包根目录供 HTML 编辑器使用；支持嵌套子目录（如 大狗/、Nox/ 等）。", current_value: "当前", unset: "未设置", sticker_dir: "表情包根目录", choose_folder: "选择文件夹", change: "更改", ffmpeg_found: "成功定位到 ffmpeg", ffmpeg_path: "FFmpeg 路径", ffmpeg_placeholder: "ffmpeg.exe / ffprobe.exe 所在 bin 目录，或 ffmpeg.exe", ffmpeg_help: "如何安装 FFmpeg ↗", ffmpeg_missing: "未找到 ffmpeg / ffprobe", ffmpeg_need: "需要依赖 ffmpeg 先将视频转成音频后才能发送给服务器转录", sticker_missing: "请选择一个存在的文件夹。", ready: "就绪", running: "转写中…", saved: "设置已保存", failed: "失败", done: "完成", key_empty: "未配置密钥", key_loaded: "已加载密钥 {key}", workspace_hint: "北京地域选填（推荐），新加坡地域必填。", other_language: "English", drop_hint: "拖入音频/视频文件，或点击选择。", drop_reject: "只支持音频、视频或工程文件。", media_required: "请选择存在的媒体文件。", output_required: "请填写 SRT 输出路径。", key_required: "请填写 API Key，或先保存到 .env。", workspace_required: "新加坡地域需要 Workspace ID。", json_required: "请选择工程文件后再打开 MAWE。", server_media_required: "工程没有可用媒体，请手动选择媒体文件。", speaker_colors: "给不同说话人分配字幕颜色", speaker_colors_hint: "最多 5 种颜色；说话人超过 5 个时颜色循环复用。", speaker_colors_title: "转写时按说话人自动着色（生成后仍可在编辑器修改）" },
    en: { media_output: "1️⃣ Media & Output", recognition: "2️⃣ Recognition Settings", server: "4️⃣ Subtitle Editor Settings", logs: "3️⃣ Logs", provider: "Speech API Provider", test_run: "Test run", test_run_title: "Trim to the first 2 minutes to test the workflow and API", test_run_override: "Test run is limited to the first 2 minutes", debug_raw: "Debug run (save full response)", debug_raw_title: "Also save the raw ASR service response as JSON for investigating segmentation, punctuation, and timestamps.", hero_desc: "Local media ➜ AI transcription ➜ Editable subtitle projects", project_home: "Project", media: "Media file", srt_output: "SRT output", choose: "Choose", model: "Model", region: "Region", workspace: "Workspace ID", language: "Language", length_limit: "Length limit", language_reset: "Reset (auto-detect)", language_multi_hint: "Multi-select; empty = auto (bias only).", language_filter_hint: "Only common languages are shown by default. Enable the rest in Settings.", settings_language: "Language", show_rare_langs: "Show less common languages", show_rare_langs_hint: "When enabled, the language list shows every supported language; otherwise it shows 8 common languages.", key: "API Key", save_key: "Save locally", key_hint_prefix: "Get an API Key from", key_hint_suffix: "↗", json_project: "Project file", json_placeholder: "Auto-filled after generation, or choose an earlier project", server_media: "Server media (optional)", server_media_missing: "The project has no media, or the file moved. Choose it again.", flv_media_hint: "flv cannot be previewed and will be converted to mp4 automatically", port: "Port", advanced: "Advanced options", open_mawe: "🎬 Launch Subtitle Editor", server_stop: "⏹️ Stop server", start: "✨ Generate subtitles & project", open_folder: "📁 Open output folder", open_html: "Open HTML editor", open_blank_html: "Open blank HTML template", demo_mode: "Demo mode", settings_title: "Settings", settings_ffmpeg: "FFmpeg", settings_stickers: "Default sticker path", stickers_explain: "Sticker root directory for the HTML editor; nested folders are supported.", current_value: "Current", unset: "Not set", sticker_dir: "Sticker root", choose_folder: "Choose folder", change: "Change", ffmpeg_found: "Located ffmpeg successfully", ffmpeg_path: "FFmpeg path", ffmpeg_placeholder: "bin directory containing ffmpeg/ffprobe, or ffmpeg executable", ffmpeg_help: "How to install FFmpeg ↗", ffmpeg_missing: "ffmpeg / ffprobe not found", ffmpeg_need: "ffmpeg is required to convert video to audio before sending it to the transcription server", sticker_missing: "Choose an existing folder.", ready: "Ready", running: "Running…", saved: "Settings saved", failed: "Failed", done: "Done", key_empty: "No key configured", key_loaded: "Loaded key {key}", workspace_hint: "Optional (recommended) for Beijing; required for Singapore.", other_language: "中文", drop_hint: "Drop an audio/video file here, or choose one.", drop_reject: "Only audio, video, or project files are supported.", media_required: "Choose an existing media file.", output_required: "Enter an SRT output path.", key_required: "Enter an API key, or save one to .env first.", workspace_required: "Workspace ID is required for Singapore.", json_required: "Choose a project file before opening MAWE.", server_media_required: "The project has no usable media. Choose media manually.", speaker_colors: "Assign subtitle colors to speakers", speaker_colors_hint: "Up to 5 colors; colors cycle when there are more than 5 speakers.", speaker_colors_title: "Color subtitles by speaker during transcription (editable afterwards)" }
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
    server_address: "当前服务器地址：",
    server_start_hint: "请点击「启动字幕服务器」",
    server_no_response_hint: "编辑器服务器没有响应，请检查端口或下方状态。",
    server_start_failed_hint: "编辑器服务器启动失败，请查看下方状态和日志。",
    open_editor: "🚀 打开字幕编辑器",
    server_refresh: "刷新"
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
    server_refresh: "Refresh"
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
  Object.assign(STRINGS.zh, {
    toolbox_open: "打开后处理工具箱", toolbox_title: "后处理工具箱（Beta）", toolbox_chain_hint: "每次生成新文件，并自动作为下一步输入。", toolbox_beta_notice: "该功能正在开发中，可能不太稳定，仅供尝鲜，遇到问题实属正常，可前往 ", toolbox_beta_notice_tail: " 提反馈。", toolbox_no_media: "未选择媒体",
    toolbox_input: "处理文件", toolbox_input_placeholder: "跟随工程文件自动填入，也可拖入 .mosp / .json / .srt", toolbox_input_hint: "默认跟随「工程文件」并在每次处理后更新；手动选择或拖入其他文件后，以这里的文件为准。", toolbox_drop_reject: "这里只接受 .mosp / .json / .srt 字幕或工程文件。",
    toolbox_llm: "LLM 处理", toolbox_replace: "固定替换", toolbox_ffconcat: "媒体重组", toolbox_provider: "供应商", toolbox_operation: "任务", toolbox_proofread: "校对", toolbox_resegment: "重新断句", toolbox_translate_en: "翻译为英文", toolbox_translate_zh: "翻译为中文", toolbox_custom: "自定义",
    toolbox_prompt: "附加提示词", toolbox_prompt_placeholder: "例如：保留专有名词，不要使用书面腔。", toolbox_time_hint: "模型只处理带 ID 的文字；本地时间槽始终是时间真源。", toolbox_output: "输出", toolbox_output_both: "工程 + SRT", toolbox_output_project: "仅工程", toolbox_output_srt: "仅 SRT", toolbox_run: "运行处理",
    toolbox_replace_rules: "替换规则", toolbox_replace_placeholder: "错别字 => 正确文字\n旧名称 => 新名称", toolbox_replace_hint: "每行一条：原文 => 新文。修改文本后会移除失真的逐词时间。", toolbox_replace_safe: "分段起止时间保持不变。", toolbox_run_replace: "执行替换",
    toolbox_ffconcat_warning: "只允许引用当前媒体。重组会生成新媒体，但不会改写字幕时间轴。", toolbox_run_media: "生成新媒体", toolbox_ready: "选择工具后运行；源文件不会被覆盖。", toolbox_running: "处理中……", toolbox_saved: "LLM 设置已保存。", toolbox_key_empty: "未保存此供应商的密钥", toolbox_key_loaded: "已保存密钥 {key}",
    toolbox_need_source: "请先选择工程或 SRT。", toolbox_need_rules: "请至少填写一条有效替换规则。", toolbox_need_ffconcat: "请选择 .ffconcat 文件。", toolbox_need_media: "请先选择当前媒体。", toolbox_done: "处理完成，已切换到新产物：", toolbox_media_done: "媒体重组完成，已切换到新媒体："
  });
  Object.assign(STRINGS.en, {
    toolbox_open: "Open post-processing toolbox", toolbox_title: "Post-processing toolbox (Beta)", toolbox_chain_hint: "Each run creates a new file and uses it as the next input.", toolbox_beta_notice: "This feature is still in development and may be unstable — issues are expected. Please report them on ", toolbox_beta_notice_tail: ".", toolbox_no_media: "No media selected",
    toolbox_input: "File to process", toolbox_input_placeholder: "Follows the project file, or drop a .mosp / .json / .srt", toolbox_input_hint: "Follows the project file and updates after each run; choosing or dropping another file overrides it.", toolbox_drop_reject: "Only .mosp / .json / .srt subtitle or project files can be dropped here.",
    toolbox_llm: "LLM", toolbox_replace: "Fixed replace", toolbox_ffconcat: "Media rebuild", toolbox_provider: "Provider", toolbox_operation: "Task", toolbox_proofread: "Proofread", toolbox_resegment: "Resegment", toolbox_translate_en: "Translate to English", toolbox_translate_zh: "Translate to Chinese", toolbox_custom: "Custom",
    toolbox_prompt: "Additional prompt", toolbox_prompt_placeholder: "Example: preserve product names and use conversational language.", toolbox_time_hint: "The model edits ID-tagged text only; local time slots remain authoritative.", toolbox_output: "Output", toolbox_output_both: "Project + SRT", toolbox_output_project: "Project only", toolbox_output_srt: "SRT only", toolbox_run: "Run",
    toolbox_replace_rules: "Replacement rules", toolbox_replace_placeholder: "old text => new text", toolbox_replace_hint: "One per line: source => target. Stale word timings are removed when text changes.", toolbox_replace_safe: "Segment start and end times stay unchanged.", toolbox_run_replace: "Replace",
    toolbox_ffconcat_warning: "Only the current media may be referenced. A new media file is created without changing subtitle timing.", toolbox_run_media: "Build media", toolbox_ready: "Choose a tool and run it; source files are never overwritten.", toolbox_running: "Processing…", toolbox_saved: "LLM settings saved.", toolbox_key_empty: "No saved key for this provider", toolbox_key_loaded: "Saved key {key}",
    toolbox_need_source: "Choose a project or SRT first.", toolbox_need_rules: "Enter at least one valid replacement rule.", toolbox_need_ffconcat: "Choose an .ffconcat file.", toolbox_need_media: "Choose the current media first.", toolbox_done: "Done. Chained to the new artifact:", toolbox_media_done: "Media rebuilt. Chained to the new media:"
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
  const state = { lang: "zh", serverRunning: false, serverStarting: false, serverProjectPath: "", moseStarting: false, running: false, result: null, config: null, srtAuto: true, testSuffixAdded: false, serverMediaOk: false, detectedServerUrl: "", dropTarget: "", theme: "system", toolboxBusy: false, toolboxOpen: false };
  const dragState = { depth: 0 };
  let api = null;
  let prefsTimer = 0;

  function mockApi() {
    let saved = { apiKey: "", region: "beijing", language: "", workspaceId: "", guiLang: "zh" };
    const chainedPath = (path, operation, fallback) => path
      ? path.replace(/(\.[^.\\/]+)$/u, `.${operation}$1`)
      : fallback;
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
        appVersion: "1.3.2",
        stickerDir: saved.stickerDir || "",
        postprocessProviders: [
          { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", maskedApiKey: "", selected: true },
          { id: "zhipu", label: "智谱 Coding Plan", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.2", maskedApiKey: "", selected: false },
          { id: "qwen", label: "阿里云 Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", maskedApiKey: "", selected: false },
          { id: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", model: "", maskedApiKey: "", selected: false }
        ],
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
          }
        ]
      }),
      default_output: async ({ mediaPath, providerId, modelId, testRun }) => ({ ok: true, path: mediaPath ? mediaPath.replace(/\.[^.\\/]+$/, `${providerId === "soniox" ? ".soniox" : (modelId === "fun-asr" ? ".fun-asr" : (modelId === "qwen-audio-3.0-asr-flash-filetrans" ? ".qwen-audio" : ".qwen3-asr-api"))}${testRun ? "-test" : ""}.srt`) : "" }),
      choose_file: async ({ kind }) => ({ ok: true, path: kind === "json" ? "D:\\Demo\\project.json" : (kind === "subtitle" ? "D:\\Demo\\project.mosp" : (kind === "ffconcat" ? "D:\\Demo\\clip.ffconcat" : (kind === "hotwords" ? "D:\\Demo\\hotwords.txt" : "D:\\Demo\\clip.mp4"))) }),
      read_hotword_file: async () => ({ ok: true, path: "D:\\Demo\\hotwords.txt", text: "张三\n阿里云百炼\n专业术语\n" }),
      save_settings: async (payload) => { saved = { ...saved, ...payload }; return { ok: true, maskedApiKey: payload.apiKey ? "sk-…mock" : "", message: "mock saved" }; },
      save_prefs: async (payload) => { if (Object.prototype.hasOwnProperty.call(payload, "modelId")) localStorage.setItem(LAST_MODEL_KEY, payload.modelId || ""); if (Object.prototype.hasOwnProperty.call(payload, "language")) localStorage.setItem(LAST_LANGUAGE_KEY, payload.language || ""); if (Object.prototype.hasOwnProperty.call(payload, "showRareLangs")) saved.showRareLangs = Boolean(payload.showRareLangs); return { ok: true }; },
      open_url: async ({ url }) => { window.open(url, "_blank"); return { ok: true }; },
      open_blank_html: async () => ({ ok: true }),
      check_ffmpeg: async () => ({ ok: true, found: true, directory: "D:\\FFmpeg\\bin", ffmpeg: "D:\\FFmpeg\\bin\\ffmpeg.exe", ffprobe: "D:\\FFmpeg\\bin\\ffprobe.exe" }),
      save_ffmpeg_path: async ({ path }) => ({ ok: Boolean(path), found: Boolean(path), directory: path || "", ffmpeg: path || "", ffprobe: path || "" }),
      choose_folder: async () => ({ ok: true, path: "D:\\Stickers" }),
      save_sticker_dir: async ({ path }) => { saved.stickerDir = path || ""; return { ok: Boolean(path), stickerDir: saved.stickerDir, field: path ? "" : "stickerDir", error: path ? "" : "missing" }; },
      save_postprocess_settings: async ({ providerId, apiKey }) => ({ ok: true, providerId, maskedApiKey: apiKey ? "sk-…mock" : "" }),
      run_llm_postprocess: async ({ projectPath, srtPath, outputMode }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "llm", "D:\\Demo\\clip.llm.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "llm", "D:\\Demo\\clip.llm.srt"), warnings: [] }),
      run_fixed_replacement: async ({ projectPath, srtPath, outputMode }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "replace", "D:\\Demo\\clip.replace.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "replace", "D:\\Demo\\clip.replace.srt"), warnings: [] }),
      run_ffconcat_rebuild: async () => ({ ok: true, mediaPath: "D:\\Demo\\clip.gap-removed.mp4" }),
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
  const appendLog = (text) => { const log = $("log"); log.textContent += `${text}\n`; log.scrollTop = log.scrollHeight; };

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
  function clearErrors() { ["mediaPath", "srtPath", "apiKey", "workspaceId", "qwenAudioContext", "qwenAudioHotwords", "qwenAudioHotwordsFile", "jsonPath", "serverMediaPath", "port", "ffmpegPath", "stickerDir"].forEach((field) => setError(field, "")); }
  function formPayload() { return { providerId: $("provider").value, modelId: $("model").value, mediaPath: $("mediaPath").value.trim(), srtPath: $("srtPath").value.trim(), apiKey: $("apiKey").value.trim(), region: $("region").value, workspaceId: $("workspaceId").value.trim(), language: languageValue(), lengthLimit: $("lengthLimit").value.trim(), qwenAudioContext: $("qwenAudioContext").value.trim(), qwenAudioHotwordsMode: $("qwenAudioHotwordsMode").value, qwenAudioHotwords: $("qwenAudioHotwords").value.trim(), qwenAudioHotwordsFile: $("qwenAudioHotwordsFile").value.trim(), qwenAudioHotwordWeight: $("qwenAudioHotwordWeight").value, testRun: $("testRun").checked, debugRaw: $("debugRaw").checked, speakerColors: $("speakerColors").checked, generateHtml: $("generateHtml").checked, guiLang: state.lang }; }
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
  function renderKeyStatus() { const masked = state.config ? provider().maskedApiKey : ""; $("keyStatus").textContent = masked ? t("key_loaded").replace("{key}", masked) : t("key_empty"); }
  function applyProvider(persistReset = false) { const current = provider(); const preferred = state.config.lastModel; const fallback = state.config.modelId || current.models[0]?.id; const modelValue = current.models.some((item) => item.id === preferred) ? preferred : (current.models.some((item) => item.id === fallback) ? fallback : current.models[0]?.id); fillSelect("model", current.models, modelValue); fillSelect("region", current.regions, state.config.region || "beijing"); applySelectedModel(persistReset); $("openKeyUrl").textContent = current.label; $("regionField").classList.toggle("hidden", !SHOW_REGIONAL_FIELDS || current.regions.length === 0); $("apiKey").value = current.apiKey || ""; renderKeyStatus(); syncWorkspace(); }
  function applySelectedModel(persistReset = false) { const current = provider(); const model = selectedModel(); applyProviderLanguages(current, model, persistReset); $("speakerColorsField").classList.toggle("hidden", !model.supportsSpeaker); syncQwenAudioOptions(model); syncDefaultOutput(); if (persistReset) savePrefsDebounced({ modelId: model.id, language: languageValue() }); }
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
  function renderLanguage() { document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en"; document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); }); document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); }); document.querySelectorAll("[data-i18n-title]").forEach((node) => { node.title = t(node.dataset.i18nTitle); }); $("langToggle").textContent = t("other_language"); $("demoBadge").textContent = t("demo_mode"); renderKeyStatus(); renderStickerCurrent(); renderPromptCharacterCount(); renderHotwordWarnings(); renderServerButton(); }
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
  function validateLocal() { clearErrors(); const data = formPayload(); if (!data.mediaPath) return fail("mediaPath", errText("media_not_found", "")); if (!data.srtPath) return fail("srtPath", errText("output_missing", "")); if (!data.apiKey && !provider().apiKey) return fail("apiKey", errText("api_key_missing", "")); if (provider().regions.length > 0 && data.region === "singapore" && !data.workspaceId) return fail("workspaceId", errText("workspace_missing", "")); if (selectedModel().supportsContext && Array.from(data.qwenAudioContext).length > 400) return fail("qwenAudioContext", errText("context_too_long", "")); if (selectedModel().supportsHotwords && data.qwenAudioHotwordsMode === "file" && ext(data.qwenAudioHotwordsFile) !== ".txt") return fail("qwenAudioHotwordsFile", errText("hotwords_file_missing", "")); return true; }
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
  function handleRoutedDrop(path) { const target = state.dropTarget; clearDropState(); const suffix = ext(path || ""); if (target === "toolboxInput") { if (PROJECT_EXTS.has(suffix) || suffix === ".srt") { $("toolboxInputPath").value = path; $("toolboxInputPath").dispatchEvent(new Event("input", { bubbles: true })); setError("toolboxInputPath", ""); } else setError("toolboxInputPath", t("toolbox_drop_reject")); return; } if (target === "json") { if (PROJECT_EXTS.has(suffix)) { setJsonPath(path); setStatus(t("json_project")); } else setError("jsonPath", t("drop_reject_json")); return; } if (target === "text" || target === "file") { if (suffix === ".txt") { void loadHotwordFile(path, target === "text"); } else setError(target === "text" ? "qwenAudioHotwords" : "qwenAudioHotwordsFile", t("drop_reject_txt")); return; } if (PROJECT_EXTS.has(suffix)) { setJsonPath(path); setStatus(t("json_project")); return; } if (suffix === ".txt") { void loadHotwordFile(path, false); return; } if (MEDIA_EXTS.has(suffix)) { setMedia(path); setStatus(t("media")); return; } setError("mediaPath", mediaDropError()); }
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
    window.MAWLauncher.config = state.config;
    state.lang = state.config.guiLang || "zh";
    fillSelect("provider", state.config.providers, state.config.providerId || "qwen");
    applyProvider(false);
    $("workspaceId").value = state.config.workspaceId || "";
    syncWorkspace(); syncTestRun(); renderChevron("advancedCard"); renderChevron("serverCard"); renderLanguage(); refreshFfmpeg();
    appendLog(window.MAWLauncher.backend === "real" ? "MAW launcher ready." : "[mock] Static browser demo mode enabled."); setStatus(t("ready")); await checkExistingServer(); window.dispatchEvent(new CustomEvent("mawlauncherready"));
  }

  function handleBackendEvent(event) { if (event.type === "log") appendLog(event.message); if (event.type === "error") { setRunning(false); const detail = event.detail || event.message || ""; const message = event.code ? errText(event.code, detail) : detail || t("failed"); setStatus(message); appendLog(`[error] ${message}`); if (detail && detail !== message) appendLog(`[detail] ${detail}`); } if (event.type === "done") { state.result = event.result; setRunning(false); setJsonPath(event.result?.jsonPath || ""); $("openMawe").classList.add("attention"); $("openFolder").classList.remove("hidden"); syncHtmlMenu(); appendLog(t("done")); void checkExistingServer(t("done")); } if (event.type === "dropMedia" || event.type === "dropJson" || event.type === "dropSubtitle" || event.type === "dropHotwordFile" || event.type === "dropReject") handleRoutedDrop(event.path || ""); }
  window.MAWLauncher = { backend: "pending", config: null, callBackend: bridge, translate: t, onBackendEvent: handleBackendEvent, onBackendEvents(events) { events.forEach(handleBackendEvent); } };

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
  $("ffmpegHelp").addEventListener("click", () => bridge("open_url", { url: "https://ffmpeg.org/download.html" }));
  $("settingsButton").addEventListener("click", openSettings); $("settingsClose").addEventListener("click", closeSettings); $("settingsBackdrop").addEventListener("click", closeSettings); document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSettings(); });
  $("changeFfmpeg").addEventListener("click", () => $("ffmpegPathBox").classList.remove("hidden"));
  $("saveFfmpeg").addEventListener("click", async () => { const result = await bridge("save_ffmpeg_path", { path: $("ffmpegPath").value.trim() }); if (!result.ok) { const message = ffmpegSaveError(result); setError("ffmpegPath", message); setStatus(message); return; } setError("ffmpegPath", ""); await refreshFfmpeg(); setStatus(t("saved")); });
  $("pickStickerDir").addEventListener("click", async () => { const result = await bridge("choose_folder"); if (result.ok) await saveStickerDirectory(result.path); });
  $("stickerDir").addEventListener("change", async () => { const path = $("stickerDir").value.trim(); if (path) await saveStickerDirectory(path); });
  $("showRareLangs").addEventListener("change", async () => { state.config.showRareLangs = $("showRareLangs").checked; applyProviderLanguages(provider(), selectedModel()); const result = await bridge("save_prefs", { showRareLangs: state.config.showRareLangs }); if (result.ok) setStatus(t("saved")); else applyErrorResult(result); });
  $("languageReset").addEventListener("click", () => { const el = $("language"); Array.from(el.options).forEach((o) => { o.selected = false; }); savePrefsDebounced({ language: "" }); });
  $("saveSettings").addEventListener("click", async () => { const result = await bridge("save_settings", formPayload()); if (result.ok) { const current = provider(); current.apiKey = $("apiKey").value.trim(); current.maskedApiKey = result.maskedApiKey; state.config.apiKey = current.apiKey; state.config.maskedApiKey = result.maskedApiKey; renderKeyStatus(); setStatus(t("saved")); } else applyErrorResult(result); });
  $("start").addEventListener("click", async () => { if (!validateLocal()) return; $("log").textContent = ""; setRunning(true); $("logTitle").scrollIntoView({ behavior: "smooth", block: "start" }); const result = await bridge("start_transcription", formPayload()); if (!result.ok) { setRunning(false); applyErrorResult(result, false); } else if (result.outputPath) { $("srtPath").value = result.outputPath; if (result.outputRenamed) setOutputNotice(t("output_collision")); } });
  $("openMawe").addEventListener("click", openServerEditor); $("stopServer").addEventListener("click", stopEditorServer); $("openFolder").addEventListener("click", () => bridge("open_output_folder"));
  $("openMenu").addEventListener("click", () => $("htmlMenu").classList.toggle("hidden")); $("openHtml").addEventListener("click", () => { $("htmlMenu").classList.add("hidden"); bridge("open_html"); }); $("openBlankHtml").addEventListener("click", () => { $("htmlMenu").classList.add("hidden"); bridge("open_blank_html"); }); document.addEventListener("click", (event) => { if (!event.target.closest(".split-wrap")) $("htmlMenu").classList.add("hidden"); });
  $("mediaCard").addEventListener("dragenter", onDragEnter); $("mediaCard").addEventListener("dragleave", onDragLeave);
  bindDropField("qwenAudioHotwordsTextField", "text", "qwenAudioHotwords"); bindDropField("qwenAudioHotwordsFileField", "file", "qwenAudioHotwordsFile"); bindDropField("jsonPath", "json"); bindDropField("toolboxInputPath", "toolboxInput");
  document.addEventListener("dragover", (event) => { if (hasFileDrag(event)) event.preventDefault(); });
  document.addEventListener("dragend", clearDropState);
  document.addEventListener("dragleave", (event) => { if (!event.relatedTarget && event.target === document.documentElement) clearDropState(); });
  // 真实后端模式下 drop 由 Python 侧异步回传事件，不能在这里清理 dropTarget，否则 handleRoutedDrop 读不到目标。
  document.addEventListener("drop", (event) => { event.preventDefault(); if (window.MAWLauncher.backend === "real") return; const file = event.dataTransfer?.files?.[0]; handleRoutedDrop(file?.path || file?.name || ""); });
  setupScrollbarFlash();
  document.addEventListener("DOMContentLoaded", init);
})();
