// 无 pywebview 后端时的 mock API（浏览器直接打开页面用）。

function mockApi() {
  let saved = { apiKey: "", region: "beijing", language: "", workspaceId: "", guiLang: "", customDisplayName: "", openaiBaseUrl: "https://api.openai.com/v1", openaiModel: "whisper-1", postprocessApiKeys: {}, theme: null, outputSubfolder: true, perVideoSubfolder: false, attachModelName: false, notifyOnComplete: false };
  const chainedPath = (path, operation, fallback) => path
    ? path.replace(/(\.[^.\\/]+)$/u, `.${operation}$1`)
    : fallback;
  let modelPrepareTimer = 0;
  let alignmentPrepareTimer = 0;
  let alignmentModels = [
    { id: "qwen3-forced-aligner-0.6b", modelId: "qwen3-forced-aligner-0.6b", engine: "qwen", modelRef: "Qwen/Qwen3-ForcedAligner-0.6B", label: "Qwen3-ForcedAligner 0.6B", note: "文本 + 音频输入，输出字词级时间码；复用 Qwen Local Hugging Face 缓存", estimatedSize: "1.7G+", deviceSupport: "gpu_preferred", resourceLevel: "medium", supportsWordTimestamps: true, installed: false, status: "missing", runtimeAvailable: false, detail: "" },
    { id: "firered-asr2-ctc", modelId: "firered-asr2-ctc", engine: "firered", modelRef: "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25", label: "FireRedASR2-CTC", note: "已知稿对齐；中英及多方言；CPU 可运行；字词时间码", estimatedSize: "0.9G", deviceSupport: "cpu", resourceLevel: "low", supportsWordTimestamps: true, installed: false, status: "missing", runtimeAvailable: false, detail: "" },
  ];
  return {
    get_config: async () => {
      const config = {
      platform: /^Mac/u.test(navigator.platform) ? "darwin" : "win32",
      apiKey: saved.apiKey,
      maskedApiKey: saved.apiKey ? "sk-…demo" : "",
      providerId: "qwen",
      modelId: "qwen-audio-3.0-asr-flash-filetrans",
      lastModel: localStorage.getItem(LAST_MODEL_KEY),
      localModelPaths: saved.localModelPaths || {},
       lastLanguage: localStorage.getItem(LAST_LANGUAGE_KEY),
       zoomPercent: Number(localStorage.getItem(ZOOM_PERCENT_KEY)) || ZOOM_DEFAULT,
      region: saved.region,
      language: saved.language,
      workspaceId: saved.workspaceId,
       guiLang: saved.guiLang,
       theme: saved.theme,
      moseAvailable: false,
      moseBundled: false,
      initialProjectPath: "",
      update: { ok: true, currentVersion: "1.8.0-beta.1", latestVersion: "1.8.0-beta.1", latestTag: "v1.8.0-beta.1", available: false, assetAvailable: false, capability: "none", channel: "stable", autoCheck: true, installation: { kind: "source", platform: "windows", arch: "x64", canApply: false } },
      openaiBaseUrl: saved.openaiBaseUrl,
      openaiModel: saved.openaiModel,
      showRareLangs: saved.showRareLangs || false,
      outputSubfolder: saved.outputSubfolder,
      perVideoSubfolder: saved.perVideoSubfolder,
      attachModelName: saved.attachModelName,
      notifyOnComplete: saved.notifyOnComplete === true,
      appVersion: "1.8.0-beta.1",
      asrPresetRoot: saved.asrPresetRoot || "D:\\Models\\MAW\\asr-presets",
      asrPresetRootConfigured: Boolean(saved.asrPresetRoot),
      serverPort: null,
      stickerDir: saved.stickerDir || "",
      postprocessProviders: [
        { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: true, hasModel: true, selected: true },
        { id: "zhipu", label: "智谱 Coding Plan", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.2", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: true, hasModel: true, selected: false },
        { id: "qwen", label: "阿里云 Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: true, hasModel: true, selected: false },
        { id: "custom", label: saved.customDisplayName || "Custom API (or local model)", defaultLabel: "Custom API (or local model)", displayName: saved.customDisplayName || "", baseUrl: "", model: "", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: false, hasModel: false, selected: false },
        { id: "custom2", label: "Custom API #2", defaultLabel: "Custom API #2", displayName: "", baseUrl: "", model: "", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: false, hasModel: false, selected: false },
        { id: "custom3", label: "Custom API #3", defaultLabel: "Custom API #3", displayName: "", baseUrl: "", model: "", reasoningMode: "off", maskedApiKey: "", verified: false, hasApiKey: false, hasBaseUrl: false, hasModel: false, selected: false },
      ],
      postprocessAutoPlan: saved.postprocessAutoPlan || { version: 1, enabled: false, retainIntermediate: true, steps: [] },
      modelCacheRoot: saved.modelCacheRoot || "D:\\Models\\MAW",
      localRuntime: { status: "missing", ready: false, path: "", pythonPath: "", modelCachePath: saved.modelCacheRoot || "D:\\Models\\MAW", detail: "" },
      ocrRuntime: { status: "missing", ready: false, path: "D:\\Users\\Demo\\AppData\\Local\\MAW\\ocr-runtime", pythonPath: "", modelId: "pp-ocrv6-tiny", modelLabel: "PP-OCRv6 tiny（CPU）", detail: "" },
      ocrModels: [
        { id: "pp-ocrv6-tiny", label: "PP-OCRv6 tiny（CPU）", installed: false, status: "missing", detail: "" },
        { id: "pp-ocrv6-small", label: "PP-OCRv6 small（CPU）", installed: false, status: "missing", detail: "" }
      ],
       ocrModelId: "pp-ocrv6-tiny",
       alignmentModels: alignmentModels.map((model) => ({ ...model, runtimeAvailable: Boolean(state.config?.localRuntime?.ready) })),
      providers: [
        {
          id: "qwen",
          label: "阿里云百炼（千问）",
          keyButtonLabel: "千问AI平台",
          keyUrl: "https://platform.qianwenai.com/home/",
          apiKey: saved.apiKey,
          maskedApiKey: saved.apiKey ? "sk-…demo" : "",
          supportsSpeaker: true,
          multiLanguage: false,
          commonLanguages: ["", "zh", "yue", "en"],
          models: [
            { id: "qwen-audio-3.0-asr-flash-filetrans", label: "qwen-audio-3.0-asr（热词 / 上下文）", envKey: "DASHSCOPE_API_KEY", note: "支持即时热词、上下文与说话人分离。", priceNote: "阿里云百炼参考价：¥0.00022 / 秒（约 ¥0.792 / 小时）", supportsSpeaker: true, supportsContext: true, supportsHotwords: true, supportsVocabulary: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "yue", label: "粤语 / Cantonese" }, { id: "en", label: "英语 / English" }] },
            { id: "qwen-audio-3.1-asr-flash-filetrans", label: "qwen-audio-3.1-asr（方言 / 热词 / 上下文）", envKey: "DASHSCOPE_API_KEY", note: "支持即时热词、上下文与说话人分离；可选保留方言表达。", priceNote: "阿里云百炼参考价：按 Token 计费，输入 ¥0.8 / 百万 Token、输出 ¥2.7 / 百万 Token", supportsSpeaker: true, supportsContext: true, supportsHotwords: true, supportsVocabulary: true, supportsKeepDialect: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "yue", label: "粤语 / Cantonese" }, { id: "en", label: "英语 / English" }] },
            { id: "fun-asr", label: "fun-asr（支持说话人）", envKey: "DASHSCOPE_API_KEY", note: "支持说话人分离与词级时间戳。", priceNote: "阿里云百炼参考价：¥0.00022 / 秒（约 ¥0.792 / 小时）", supportsSpeaker: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] },
            { id: "qwen3-asr-flash-filetrans", label: "qwen3-asr（准确率更高）", envKey: "DASHSCOPE_API_KEY", note: "", priceNote: "阿里云百炼参考价：¥0.00022 / 秒（约 ¥0.792 / 小时）", supportsSpeaker: false, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] }
          ],
          regions: [{ id: "beijing", label: "北京（华北 2，默认）" }, { id: "singapore", label: "新加坡（需要 Workspace ID）" }],
          languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "da", label: "丹麦语 / Danish" }]
        },
        {
          id: "openai",
          label: "OpenAI 格式通用接口",
          keyUrl: "https://platform.openai.com/api-keys",
          secondaryKeyUrl: "https://openrouter.ai/keys",
          apiKey: saved.apiKey,
          maskedApiKey: saved.apiKey ? "sk-…demo" : "",
          supportsSpeaker: false,
          multiLanguage: false,
          note: "默认连接 OpenAI 官方服务；OpenRouter 会自动适配预设模型 ID。其他中转站请选择“自定义（Custom）”并填写服务商提供的完整模型名；接口必须返回 segments 或 words 时间戳。",
          commonLanguages: ["", "zh", "en"],
          models: [
            { id: "whisper-1", label: "whisper-1", envKey: "MAW_OPENAI_ASR_API_KEY", note: "支持 Prompt 提示词；Whisper 提示词最多 224 tokens。", openrouterNote: "OpenRouter 参考价：$0.006 / 分钟。", priceNote: "OpenAI 官方参考价：$0.006 / 分钟（约 $0.36 / 小时）", supportsSpeaker: false, supportsPrompt: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] },
            { id: "gpt-4o-transcribe", label: "gpt-4o-transcribe", envKey: "MAW_OPENAI_ASR_API_KEY", note: "支持 Prompt 提示词。", openrouterNote: "OpenRouter 参考价：输入 $2.50 / 1M tokens，输出 $10 / 1M tokens", priceNote: "OpenAI 官方参考价：输入 $2.50 / 1M audio tokens，输出 $10 / 1M audio tokens", supportsSpeaker: false, supportsPrompt: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] },
            { id: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe", envKey: "MAW_OPENAI_ASR_API_KEY", note: "支持 Prompt 提示词。", openrouterNote: "OpenRouter 参考价：输入 $1.25 / 1M tokens，输出 $5 / 1M tokens", priceNote: "OpenAI 官方参考价：输入 $1.25 / 1M audio tokens，输出 $5 / 1M audio tokens", supportsSpeaker: false, supportsPrompt: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] },
            { id: "gpt-transcribe", label: "gpt-transcribe（支持关键词）", envKey: "MAW_OPENAI_ASR_API_KEY", note: "OpenAI 官方推荐的文件转写模型；支持 Prompt 提示词和 Keywords。", openrouterNote: "OpenRouter 参考价：$0.0045 / 分钟；支持 Prompt、Keywords 和 languages[]。", priceNote: "OpenAI 官方参考价：$0.0045 / 分钟（约 $0.27 / 小时）", supportsSpeaker: false, supportsPrompt: true, supportsKeywords: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] },
            { id: "gpt-4o-transcribe-diarize", label: "gpt-4o-transcribe-diarize（说话人分离）", envKey: "MAW_OPENAI_ASR_API_KEY", note: "OpenAI 官方说话人分离模型；返回段级 speaker 与时间戳。", openrouterNote: "OpenRouter 不支持 diarize；请改用 OpenAI 官方 Base URL。", priceNote: "OpenAI 官方参考价：输入 $2.50 / 1M audio tokens，输出 $10 / 1M audio tokens", supportsSpeaker: true, supportsDiarization: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] },
            { id: "whisper-large-v3-turbo", label: "whisper-large-v3-turbo（OpenRouter）", envKey: "MAW_OPENAI_ASR_API_KEY", note: "", openrouterNote: "OpenRouter 参考价：$0.04 / 小时", supportsSpeaker: false, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] },
            { id: "whisper-large-v3", label: "whisper-large-v3（OpenRouter）", envKey: "MAW_OPENAI_ASR_API_KEY", note: "", openrouterNote: "OpenRouter 参考价：$0.0015 / 分钟（约 $0.09 / 小时）", supportsSpeaker: false, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] },
            { id: OPENAI_ASR_CUSTOM_MODEL_ID, label: "自定义（Custom）", envKey: "MAW_OPENAI_ASR_API_KEY", note: "选择后填写自定义 ASR 模型名。", supportsSpeaker: false, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }] }
          ],
          regions: [],
          languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }]
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
            { id: "qwen3-asr-local", label: "Qwen3-ASR 0.6B（推荐）", envKey: "", note: "轻量多语种识别；原生字词级时间码；可复用 Qwen3-ForcedAligner", supportsSpeaker: false, supportsWordTimestamps: true, deviceSupport: "cpu_gpu", resourceLevel: "medium", estimatedSize: "1.7G+", kind: "local", engine: "qwen-asr", modelRef: "Qwen/Qwen3-ASR-0.6B", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
            { id: "qwen3-asr-1.7b-local", label: "Qwen3-ASR 1.7B", envKey: "", note: "更高识别质量；原生字词级时间码；可复用 Qwen3-ForcedAligner；资源占用更高", supportsSpeaker: false, supportsWordTimestamps: true, deviceSupport: "gpu_preferred", resourceLevel: "high", estimatedSize: "4G+", kind: "local", engine: "qwen-asr", modelRef: "Qwen/Qwen3-ASR-1.7B", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
            { id: "fun-asr-nano-local", label: "Fun-ASR-Nano 2512（GPU）", envKey: "", note: "LLM-ASR 路线；中英日及中文方言，建议使用 CUDA", supportsSpeaker: false, hidden: true, kind: "local", engine: "funasr", modelRef: "FunAudioLLM/Fun-ASR-Nano-2512", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "yue", label: "粤语 / Cantonese" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
            { id: "funasr-local", label: "FunASR paraformer-zh", envKey: "", note: "中文向 FunASR 路线；保留作为兼容选项", supportsSpeaker: false, hidden: true, kind: "local", engine: "funasr", modelRef: "paraformer-zh", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "en", label: "英语 / English" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
            { id: "sensevoice-small-local", label: "SenseVoice Small", envKey: "", note: "多语种识别；默认配合 FSMN-VAD；CPU/GPU 均可运行；可用对齐模型补齐字词时间码", supportsSpeaker: false, supportsWordTimestamps: false, deviceSupport: "cpu_gpu", resourceLevel: "low", estimatedSize: "1G+", kind: "local", engine: "funasr", modelRef: "iic/SenseVoiceSmall", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "yue", label: "粤语 / Cantonese" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }, { id: "ko", label: "韩语 / Korean" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
            { id: "moss-transcribe-diarize-local", label: "MOSS Transcribe-Diarize 0.9B", envKey: "", note: "多人转写与说话人分离；仅段级时间码，可用对齐模型补齐字词时间码；建议 GPU", supportsSpeaker: true, supportsWordTimestamps: false, deviceSupport: "gpu_preferred", resourceLevel: "high", estimatedSize: "1.7G+", kind: "local", engine: "moss", modelRef: "OpenMOSS-Team/MOSS-Transcribe-Diarize", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "en", label: "英语 / English" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
    { id: "firered-asr2-ctc-local", label: "FireRedASR2", envKey: "", note: "中英及多方言；CPU 可运行；字词时间码；可用 ct-punc 改善标点和断句", supportsSpeaker: false, supportsWordTimestamps: true, deviceSupport: "cpu", resourceLevel: "low", estimatedSize: "2G+", kind: "local", engine: "firered", modelRef: "firered-asr2-ctc", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "en", label: "英语 / English" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } },
            { id: "whisper-large-v3-local", label: "Faster-Whisper large-v3（实验）", envKey: "", note: "多语种识别；原生词级时间码；CPU/GPU 均可运行；GPU 速度更佳；无说话人分离", supportsSpeaker: false, supportsWordTimestamps: true, deviceSupport: "cpu_gpu", resourceLevel: "high", estimatedSize: "3G+", kind: "local", engine: "whisper", modelRef: "Systran/faster-whisper-large-v3", languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Chinese" }, { id: "en", label: "英语 / English" }], localStatus: { status: "missing", runtimeAvailable: true, installed: false, path: "", detail: "", canPrepare: true } }
          ],
          regions: [],
          languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }]
        },
        {
          id: "doubao",
          label: "火山引擎（豆包）",
          keyUrl: "https://console.volcengine.com/speech/new/setting/apikeys",
          apiKey: "",
          maskedApiKey: "",
          supportsSpeaker: true,
          multiLanguage: false,
          dividerBefore: true,
          note: "媒体会直接上传到火山引擎；base64 直传单文件 ≤25MB 且 ≤120 分钟，MAW 会先提取为低码率单声道音频再提交。",
          commonLanguages: ["", "zh", "yue", "en", "ja", "ko"],
          models: [{ id: "volc.seedasr.auc", label: "豆包录音文件识别 2.0（Seed-ASR）", envKey: "VOLC_API_KEY", note: "支持说话人分离与即时热词；2.0 准确率更高。", supportsSpeaker: true, languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }, { id: "ko", label: "韩语 / Korean" }] }],
          regions: [],
          languages: [{ id: "", label: "自动识别" }, { id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }, { id: "ko", label: "韩语 / Korean" }]
        },
        {
          id: "soniox",
          label: "Soniox STT（海外 / 小语种）",
          keyUrl: "https://console.soniox.com",
          apiKey: "",
          maskedApiKey: "",
          supportsSpeaker: true,
          multiLanguage: true,
          commonLanguages: ["zh", "en", "ja", "ko"],
          models: [{ id: "stt-async-v5", label: "Soniox Async STT（v5，上下文）", envKey: "SONIOX_API_KEY", note: "支持提示词、说话人与字词时间码。", priceNote: "Soniox 参考价：异步文件转写约 $0.10 / 小时；按 token 计费，音频输入 $1.50 / 1M，输入文本 $3.50 / 1M。", supportsSpeaker: true, supportsContext: true, languages: [{ id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }, { id: "ko", label: "韩语 / Korean" }, { id: "fr", label: "法语 / French" }, { id: "de", label: "德语 / German" }] }],
          regions: [],
          languages: [{ id: "zh", label: "中文 / Mandarin" }, { id: "en", label: "英语 / English" }, { id: "ja", label: "日语 / Japanese" }, { id: "ko", label: "韩语 / Korean" }, { id: "fr", label: "法语 / French" }, { id: "de", label: "德语 / German" }]
        },
        {
          id: "bcut",
          label: "必剪（非官方 / 免费 / 实验性）",
          keyUrl: "https://github.com/SocialSisterYi/bcut-asr",
          apiKey: "",
          maskedApiKey: "",
          supportsSpeaker: false,
          multiLanguage: false,
          requiresApiKey: false,
          supportsLanguage: false,
          note: "非官方免费接口：无需 API Key，仅支持中文，单文件上限 2 小时；接口可能随时变更、失效或触发限流，请勿高频调用。重要或批量任务建议使用上方正式供应商。",
          commonLanguages: [],
          models: [{ id: "bcut-asr", label: "必剪（免 Key / 仅中文）", envKey: "", note: "逐字毫秒时间戳；无需 API Key。", supportsSpeaker: false, languages: [{ id: "", label: "中文（自动识别）" }] }],
          regions: [],
          languages: [{ id: "", label: "中文（自动识别）" }]
        },
        {
          id: "deepseek", label: "DeepSeek（？）", keyUrl: "", apiKey: "", maskedApiKey: "",
          supportsSpeaker: false, multiLanguage: false, requiresApiKey: false, supportsLanguage: false,
          note: "DeepSeek 是文本模型，请在工具箱的 AI 处理里使用。", commonLanguages: [], regions: [], languages: [],
          models: [{ id: "deepseek-not-an-asr", label: "DeepSeek 不是转写模型", envKey: "", languages: [] }],
        }
      ]
      };
      const provider = config.providers.find(item => item.id === config.providerId);
      return { ...config, models: provider.models, regions: provider.regions, languages: provider.languages };
    },
    default_output: async ({ mediaPath, providerId, modelId, testRun }) => {
      let path = "";
      if (mediaPath) {
        const sep = mediaPath.includes("\\") ? "\\" : "/";
        const dirIndex = Math.max(mediaPath.lastIndexOf("/"), mediaPath.lastIndexOf("\\"));
        const dir = dirIndex >= 0 ? mediaPath.slice(0, dirIndex + 1) : "";
        const stem = mediaPath.slice(dirIndex + 1).replace(/\.[^.\\/]+$/, "");
        const tag = saved.attachModelName === false ? "" : (providerId === "openai" ? ".custom-asr" : (providerId === "soniox" ? ".soniox" : (providerId === "bcut" ? ".bcut" : (providerId === "local" ? (modelId.includes("sensevoice") ? ".sensevoice-local" : (modelId.includes("firered") ? ".firered-local" : (modelId.includes("moss") ? ".moss-local" : ((modelId.includes("funasr") || modelId.includes("fun-asr")) ? ".funasr-local" : (modelId.includes("1.7b") ? ".qwen3-asr-1.7b-local" : ".qwen-asr-local"))))) : (modelId === "fun-asr" ? ".fun-asr" : ((modelId === "qwen-audio-3.0-asr-flash-filetrans" || modelId === "qwen-audio-3.1-asr-flash-filetrans") ? ".qwen-audio" : ".qwen3-asr-api"))))));
        let outputDir = dir;
        if (saved.outputSubfolder) {
          const root = saved.perVideoSubfolder ? `${stem}_maw` : "_maw";
          outputDir = dir ? `${dir}${root}${sep}` : `${root}${sep}`;
        }
        path = `${outputDir}${stem}${tag}${testRun ? "-test" : ""}.srt`;
      }
      return { ok: true, path };
    },
    get_audio_tracks: async ({ mediaPath = "" } = {}) => VIDEO_EXTS.has(ext(mediaPath)) ? ({ ok: true, tracks: [
      { audioIndex: 0, streamIndex: 1, title: "Mix", channels: 2, sampleRate: 48000, default: true },
      { audioIndex: 1, streamIndex: 2, title: "Voice", channels: 2, sampleRate: 48000, default: false },
      { audioIndex: 2, streamIndex: 3, title: "OriginSound", channels: 2, sampleRate: 48000, default: false },
    ] }) : ({ ok: true, tracks: [] }),
    choose_file: async ({ kind }) => ({ ok: true, path: kind === "json" ? "D:\\Demo\\project.json" : (kind === "subtitle" ? "D:\\Demo\\project.mosp" : (kind === "subtitle-burn" ? "D:\\Demo\\clip.srt" : (kind === "video" ? "D:\\Demo\\clip.mp4" : (kind === "ffconcat" ? "D:\\Demo\\clip.ffconcat" : (kind === "script" ? "D:\\Demo\\script.txt" : (kind === "hotwords" ? "D:\\Demo\\hotwords.txt" : "D:\\Demo\\clip.mp4")))))) }),
    read_script_preview: async () => ({ ok: true, path: "D:\\Demo\\script.txt", preview: "第一行\n第二行", truncated: false }),
    read_hotword_file: async () => ({ ok: true, path: "D:\\Demo\\hotwords.txt", text: "张三\n阿里云百炼\n专业术语\n" }),
    save_settings: async (payload) => { saved = { ...saved, ...payload }; if (Object.prototype.hasOwnProperty.call(payload, "modelCacheRoot")) { state.config.modelCacheRoot = payload.modelCacheRoot || ""; state.config.localRuntime = { ...(state.config.localRuntime || {}), modelCachePath: payload.modelCacheRoot || "D:\\Models\\MAW" }; } return { ok: true, maskedApiKey: payload.apiKey ? "sk-…mock" : "", modelCacheRoot: Object.prototype.hasOwnProperty.call(payload, "modelCacheRoot") ? (payload.modelCacheRoot || "") : (state.config?.modelCacheRoot || ""), message: "mock saved" }; },
    get_local_runtime: async () => ({ ok: true, ...(state.config?.localRuntime || { status: "missing", ready: false }) }),
    get_local_runtime_inventory: async () => {
      const runtime = state.config?.localRuntime || { status: "missing", ready: false };
      const installed = Boolean(runtime.ready);
      const components = ["faster_whisper", "funasr", "qwen_asr", "jieba", "torch", "torchaudio", "quapeaks", "sherpa_onnx", "soundfile"].map((name) => ({ name, required: true, installed }));
      return { ok: true, ...runtime, inventory: { status: runtime.status || "missing", ready: installed, runtimeVersionExpected: "7", runtimeVersionInstalled: installed ? (runtime.runtimeVersion || "7") : "", pythonVersionExpected: "3.11", pythonVersionInstalled: installed ? "3.11" : "", manifestStatus: installed ? "ready" : "", installedAt: installed ? Math.floor(Date.now() / 1000) : 0, components } };
    },
    install_local_runtime: async () => { state.config.localRuntime = { status: "ready", ready: true, path: "D:\\Users\\Demo\\AppData\\Local\\MAW\\local-runtime", detail: "本地运行环境已就绪。" }; setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "localRuntimeReady", runtime: state.config.localRuntime }), 400); return { ok: true, installing: true }; },
     cancel_local_runtime: async () => ({ ok: true }),
     get_alignment_models: async () => ({ ok: true, runtime: state.config?.localRuntime || {}, modelCacheRoot: state.config?.modelCacheRoot || "D:\\Models\\MAW", models: alignmentModels.map((model) => ({ ...model, runtimeAvailable: Boolean(state.config?.localRuntime?.ready) })) }),
     prepare_alignment_model: async ({ modelId }) => { clearTimeout(alignmentPrepareTimer); alignmentPrepareTimer = setTimeout(() => { const model = alignmentModels.find((item) => item.id === modelId); if (model) { model.status = "installed"; model.installed = true; model.runtimeAvailable = true; model.detail = "已检测到对齐模型。"; } window.MAWLauncher.onBackendEvent({ type: "alignmentModelPrepared", modelId, status: "installed" }); }, 400); return { ok: true, preparing: true, modelId }; },
     cancel_alignment_model: async () => { clearTimeout(alignmentPrepareTimer); setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "alignmentPrepareCancelled" }), 80); return { ok: true, cancelling: true }; },
    get_ocr_runtime: async () => ({ ok: true, ...(state.config?.ocrRuntime || { status: "missing", ready: false }), models: state.config?.ocrModels || [] }),
    save_ocr_settings: async ({ runtimePath }) => { state.config.ocrRuntime = { ...(state.config.ocrRuntime || {}), path: runtimePath || "D:\\Users\\Demo\\AppData\\Local\\MAW\\ocr-runtime" }; return { ok: true, runtimePath: state.config.ocrRuntime.path, runtime: state.config.ocrRuntime }; },
save_local_settings: async ({ runtimePath }) => { state.config.localRuntime = { ...(state.config.localRuntime || {}), path: runtimePath || "D:\\Users\\Demo\\AppData\\Local\\MAW\\local-runtime" }; return { ok: true, runtimePath: state.config.localRuntime.path, runtime: state.config.localRuntime }; },
    install_ocr_runtime: async () => { state.config.ocrRuntime = { ...(state.config.ocrRuntime || {}), status: "ready", ready: true, modelInstalled: true, detail: "OCR 模型已安装，可以在工具箱中使用。" }; state.config.ocrModels = (state.config.ocrModels || []).map((model) => ({ ...model, installed: true, status: "installed", detail: state.config.ocrRuntime.detail })); setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "ocrRuntimeReady", runtime: state.config.ocrRuntime, models: state.config.ocrModels }), 400); return { ok: true, installing: true }; },
    cancel_ocr_runtime: async () => ({ ok: true }),
    get_local_models: async ({ modelId, modelPath, modelPaths = {} }) => ({ ok: true, runtime: state.config?.localRuntime || {}, models: (state.config?.providers.find((item) => item.id === "local")?.models || []).map((model) => { const path = model.id === modelId ? modelPath : modelPaths[model.id]; return { ...model, localStatus: { ...(model.localStatus || {}), ...(path ? { status: "installed", installed: true, path, detail: "已使用指定的模型目录。" } : {}) } }; }) }),
    prepare_local_model: async ({ modelId }) => { clearTimeout(modelPrepareTimer); modelPrepareTimer = setTimeout(() => { state.config?.providers.find((item) => item.id === "local")?.models.forEach((model) => { if (model.id === modelId) model.localStatus = { ...(model.localStatus || {}), status: "installed", installed: true, runtimeAvailable: true, canPrepare: false, detail: "已检测到本地模型。" }; }); window.MAWLauncher.onBackendEvent({ type: "modelPrepared", modelId }); }, 400); return { ok: true, preparing: true, modelId }; },
    cancel_local_model: async () => { clearTimeout(modelPrepareTimer); setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "localPrepareCancelled" }), 80); return { ok: true, cancelling: true }; },
     save_prefs: async (payload) => { if (Object.prototype.hasOwnProperty.call(payload, "modelId")) localStorage.setItem(LAST_MODEL_KEY, payload.modelId || ""); if (Object.prototype.hasOwnProperty.call(payload, "localModelPaths")) saved.localModelPaths = payload.localModelPaths; if (Object.prototype.hasOwnProperty.call(payload, "language")) localStorage.setItem(LAST_LANGUAGE_KEY, payload.language || ""); if (Object.prototype.hasOwnProperty.call(payload, "showRareLangs")) saved.showRareLangs = Boolean(payload.showRareLangs); for (const key of ["outputSubfolder", "perVideoSubfolder", "attachModelName", "notifyOnComplete"]) { if (Object.prototype.hasOwnProperty.call(payload, key)) saved[key] = Boolean(payload[key]); } if (Object.prototype.hasOwnProperty.call(payload, "theme")) saved.theme = payload.theme || "system"; if (Object.prototype.hasOwnProperty.call(payload, "zoomPercent")) localStorage.setItem(ZOOM_PERCENT_KEY, String(payload.zoomPercent)); return { ok: true, zoomPercent: Number(localStorage.getItem(ZOOM_PERCENT_KEY)) || ZOOM_DEFAULT }; },
    open_url: async ({ url }) => { window.open(url, "_blank"); return { ok: true }; },
    open_runtime_folder: async (payload) => { window.__openedRuntimeFolder = payload; return { ok: true }; },
    open_blank_html: async () => ({ ok: true }),
    check_ffmpeg: async () => ({ ok: true, found: true, directory: "D:\\FFmpeg\\bin", ffmpeg: "D:\\FFmpeg\\bin\\ffmpeg.exe", ffprobe: "D:\\FFmpeg\\bin\\ffprobe.exe" }),
    check_update: async () => ({ ...(state.config?.update || {}), ok: true, checking: false }),
    start_update: async () => ({ ok: true, started: true }),
    cancel_update: async () => ({ ok: true, cancelled: true }),
    apply_update: async () => ({ ok: false, code: "update_manual_only", error: "portable" }),
    set_update_preferences: async ({ autoCheck }) => { if (state.config?.update) state.config.update.autoCheck = Boolean(autoCheck); return { ok: true, autoCheck: Boolean(autoCheck) }; },
    save_ffmpeg_path: async ({ path }) => ({ ok: Boolean(path), found: Boolean(path), directory: path || "", ffmpeg: path || "", ffprobe: path || "" }),
    choose_folder: async ({ kind } = {}) => ({ ok: true, path: kind === "model-cache" ? "D:\\Models\\MAW" : (kind === "ocr-runtime" ? "D:\\Models\\MAW\\ocr-runtime" : (kind === "runtime" ? "D:\\Users\\Demo\\AppData\\Local\\MAW\\local-runtime" : "D:\\Stickers")) }),
    save_sticker_dir: async ({ path }) => { saved.stickerDir = path || ""; return { ok: Boolean(path), stickerDir: saved.stickerDir, field: path ? "" : "stickerDir", error: path ? "" : "missing" }; },
    open_sticker_folder: async () => { if (!saved.stickerDir) return { ok: false, code: "sticker_dir_invalid" }; window.__openedStickerFolder = saved.stickerDir; return { ok: true }; },
    get_postprocess_settings: async ({ providerId }) => { const apiKey = saved.postprocessApiKeys[providerId] || ""; return { ok: true, providerId, apiKey, maskedApiKey: apiKey ? "sk-…mock" : "" }; },
    save_postprocess_settings: async ({ providerId, apiKey, displayName, reasoningMode }) => { if (isCustomSlotId(providerId)) saved.customDisplayName = displayName || ""; if (apiKey) saved.postprocessApiKeys[providerId] = apiKey; return { ok: true, providerId, label: isCustomSlotId(providerId) ? (displayName || "Custom API (or local model)") : (providerId === "deepseek" ? "DeepSeek" : (providerId === "zhipu" ? "智谱 Coding Plan" : "阿里云 Qwen")), displayName: isCustomSlotId(providerId) ? (displayName || "") : "", maskedApiKey: saved.postprocessApiKeys[providerId] ? "sk-…mock" : "", reasoningMode: reasoningMode || "off", verified: false }; },
    test_postprocess_connection: async ({ providerId, apiKey, save }) => { if (save && apiKey) saved.postprocessApiKeys[providerId] = apiKey; return { ok: true, providerId, verified: true, saved: Boolean(save), maskedApiKey: saved.postprocessApiKeys[providerId] ? "sk-…mock" : "" }; },
    save_postprocess_plan: async ({ plan }) => { saved.postprocessAutoPlan = plan; return { ok: true, plan }; },
    validate_postprocess_plan: async ({ plan }) => ({ ok: true, plan, errors: [] }),
    get_postprocess_models: async ({ providerId }) => ({ ok: true, providerId, models: providerId === "qwen" ? ["qwen-plus", "qwen3-max"] : (providerId === "zhipu" ? ["glm-5.2", "glm-4.5"] : (providerId === "custom" ? ["local-model"] : ["deepseek-flash", "deepseek-v4-pro"])) }),
    open_file: async ({ path }) => ({ ok: Boolean(path) }),
    open_containing_folder: async ({ path }) => ({ ok: Boolean(path) }),
    retry_postprocess: async () => ({ ok: false, error: "No failed automatic post-processing run." }),
    run_script_match: async ({ projectPath, srtPath, outputMode }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "match", "D:\\Demo\\clip.match.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "match", "D:\\Demo\\clip.match.srt"), warnings: [] }),
     run_ocr_dedup: async ({ projectPath, srtPath, outputMode, report }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "ocr-dedup", "D:\\Demo\\clip.ocr-dedup.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "ocr-dedup", "D:\\Demo\\clip.ocr-dedup.srt"), reportPath: report ? "D:\\Demo\\clip.ocr-dedup.csv" : "", warnings: ["OCR 字幕去重完成：新增禁用 1 条，已有禁用 0 条，实际 OCR 1 条，跳过 0 条。"] }),
     run_timestamp_alignment: async ({ projectPath, srtPath, outputMode }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "timestamps", "D:\\Demo\\clip.timestamps.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "timestamps", "D:\\Demo\\clip.timestamps.srt"), warnings: [] }),
    run_llm_postprocess: async ({ projectPath, srtPath, outputMode }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "llm", "D:\\Demo\\clip.llm.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "llm", "D:\\Demo\\clip.llm.srt"), warnings: [] }),
    run_fixed_process: async ({ projectPath, srtPath, outputMode }) => ({ ok: true, projectPath: outputMode === "srt" ? "" : chainedPath(projectPath, "fixed", "D:\\Demo\\clip.fixed.mosp"), srtPath: outputMode === "json" ? "" : chainedPath(srtPath, "fixed", "D:\\Demo\\clip.fixed.srt"), warnings: [] }),
    send_notification: async ({ title, message } = {}) => { window.__mockNotifications = [...(window.__mockNotifications || []), { title: String(title || ""), message: String(message || "") }]; return { ok: true, sent: false }; },
    run_fixed_replacement: async (payload) => window.MAWLauncher.callBackend("run_fixed_process", payload),
     run_ffconcat_rebuild: async () => ({ ok: true, mediaPath: "D:\\Demo\\clip.gap-removed.mp4" }),
     probe_audio_tracks: async () => ({ ok: true, tracks: [{ audioIndex: 0, streamIndex: 1, codec: "aac", channels: 2, sampleRate: 48000, language: "zh", title: "中文", default: true }, { audioIndex: 1, streamIndex: 2, codec: "aac", channels: 2, sampleRate: 48000, language: "en", title: "English", default: false }] }),
     run_burn_subtitles: async () => ({ ok: true, mediaPath: "D:\\Demo\\clip.subtitled.mp4" }),
     get_burn_subtitle_settings: async () => ({ ok: true, crf: "", preset: "", audioBitrate: "" }),
     save_burn_subtitle_settings: async () => ({ ok: true, message: "saved" }),
     run_extract_audio: async () => ({ ok: true, mediaPath: "D:\\Demo\\clip.audio.m4a", audioTrack: { audioIndex: 0 } }),
     cancel_media_tool: async () => ({ ok: true, cancelling: true }),
     generate_waveform_project: async ({ mediaPath }) => ({ ok: true, mediaPath, projectPath: "D:\\Demo\\clip.waveform.mosp", warnings: [], reapeaksPath: "" }),
     start_alignment_server: async ({ projectPath, scriptPath, mediaPath, gapRemove, guiLang }) => ({ ok: true, url: `http://127.0.0.1:8260/?lang=${guiLang || "zh"}`, projectPath, scriptPath, mediaPath: mediaPath || "D:\\Demo\\clip.mp4", gapRemove }),
     stop_alignment_server: async () => ({ ok: true, stopped: true }),
     check_server_media: async ({ jsonPath }) => ({ ok: Boolean(jsonPath), hasMedia: Boolean(jsonPath), mediaPath: "D:\\Demo\\clip.mp4", mediaExists: Boolean(jsonPath) }),
    start_server: async () => { setTimeout(() => window.MAWLauncher.onBackendEvent({ type: "log", message: "[mock] would open http://127.0.0.1:8250/ after server responds" }), 120); return { ok: true, url: "http://127.0.0.1:8250/" }; },
    open_preferred_editor: async (payload) => state.config?.moseAvailable
      ? { ok: true, usedMose: true, path: "D:\\Demo\\MOSE\\MOSE.exe" }
      : { ...(await bridge("start_server", payload)), usedMose: false },
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
    open_log_folder: async () => ({ ok: true }),
    open_html: async () => ({ ok: true }),
    open_faq: async () => ({ ok: true }),
    get_emoji_font_path: async () => ({ ok: true, path: "" })
  };
}

// 文案与标签：翻译入口、诊断/供应商/模型/语言的英文映射与错误文案工具。
