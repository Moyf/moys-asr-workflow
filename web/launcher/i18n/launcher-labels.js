// 文案与标签：翻译入口、诊断/供应商/模型/语言的英文映射与错误文案工具。

const t = (key) => STRINGS[state.lang][key] || key;
const DIAGNOSTIC_LABELS = {
  zh: { processState: "进程状态", pid: "PID", lastProbe: "最后探测", startupLogTail: "启动日志尾部" },
  en: { processState: "Process", pid: "PID", lastProbe: "Last probe", startupLogTail: "Startup log tail" },
};
function diagnosticText(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return redactSensitive(value).trim();
  if (typeof value !== "object") return redactSensitive(String(value));
  return Object.entries(value).map(([key, item]) => {
    if (item === null || item === undefined || item === "") return "";
    const raw = typeof item === "object" ? JSON.stringify(item) : String(item);
    const shown = key === "processState" && item === "running"
      ? (state.lang === "zh" ? "仍在运行" : "running")
      : raw;
    const label = DIAGNOSTIC_LABELS[state.lang]?.[key] || key;
    return label + ": " + redactSensitive(shown);
  }).filter(Boolean).join("\n");
}
function compactDetail(detail) { return String(detail || "").replace(/\s+/g, " ").trim(); }
// 后端 status detail 是中文固定文案（就绪/未安装/需修复等），界面语言下应改用本地化文案；
// 只有非标准状态的动态信息（如安装失败原因）才原样透传。
function runtimeHintText(runtime, readyKey, otherKey) {
  // 后端 detail 是运行环境的具体说明（如「OCR 模型已安装，可以在工具箱中
  // 使用。」），优先展示；缺失时才回退到界面 i18n 文案。
  const fallbackKey = runtime.ready || runtime.status === "ready" ? readyKey : otherKey;
  return runtime.detail || t(fallbackKey);
}
// 供应商 / 模型配置的 label 与 note 由后端（maw/gui_config.py）以中文下发；
// 英文界面按稳定 id 映射为英文，id 未收录时回退后端原文。
const PROVIDER_LABELS_EN = { qwen: "Alibaba Cloud Bailian (recommended / Qwen)", soniox: "Soniox STT (overseas / minority languages)", tencent: "Tencent Cloud recorded-file ASR", openai: "OpenAI-format compatible API", local: "Local models (Beta)", doubao: "Volcano Engine (Doubao)", bcut: "Bcut (unofficial / free / experimental)", deepseek: "DeepSeek (?)" };
const PROVIDER_NOTES_EN = {
  openai: "OpenAI is used by default; OpenRouter automatically gets the openai/ prefix for built-in models. For other relays, choose Custom and enter the exact model name they provide. The API must return segments or words timestamps.",
  tencent: "Requires TENCENT_SECRET_ID and TENCENT_SECRET_KEY; use a COS URL for media larger than 5 MB.",
  bcut: "Unofficial free endpoint: no API key, Chinese only, 2-hour per-file limit. The endpoint may change, break, or rate-limit at any time; avoid high-frequency calls. For important or batch tasks, prefer the official providers above.",
  deepseek: "🐳 The big blue fish cannot transcribe audio — it's a text model! (this note exists because so many people ask) But you can use it for translation in the Subtitle Processing (AI post-process) settings.",
};
const MODEL_LABELS_EN = {
  "qwen-audio-3.1-asr-flash-filetrans": "qwen-audio-3.1-asr (dialect / hotwords / context)",
  "qwen-audio-3.0-asr-flash-filetrans": "qwen-audio-3.0-asr (hotwords / context)",
  "fun-asr": "fun-asr (speaker support)",
  "qwen3-asr-flash-filetrans": "qwen3-asr (higher accuracy)",
  "custom-asr": "Custom",
  "stt-async-v5": "Soniox Async STT (v5, context)",
  "16k_zh_en_2.0": "Tencent Cloud recorded-file ASR (large model 2.0)",
  "whisper-1": "whisper-1",
  "gpt-transcribe": "gpt-transcribe (keyword hints)",
  "gpt-4o-transcribe": "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe": "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe-diarize": "gpt-4o-transcribe-diarize (speaker diarization)",
  "whisper-large-v3-turbo": "Whisper Large V3 Turbo (OpenRouter)",
  "whisper-large-v3": "Whisper Large V3 (OpenRouter)",
  "qwen3-asr-local": "Qwen3-ASR 0.6B (recommended)",
  "qwen3-asr-1.7b-local": "Qwen3-ASR 1.7B",
  "fun-asr-nano-local": "Fun-ASR-Nano 2512 (GPU)",
  "sensevoice-small-local": "SenseVoice Small",
  "firered-asr2-ctc-local": "FireRedASR2",
  "moss-transcribe-diarize-local": "MOSS Transcribe-Diarize 0.9B",
  "whisper-large-v3-local": "Faster-Whisper large-v3 (experimental)",
  "bcut-asr": "Bcut (no key / Chinese only)",
  "deepseek-not-an-asr": "DeepSeek does not offer a transcription model",
};
const MODEL_NOTES_EN = {
  "qwen-audio-3.1-asr-flash-filetrans": "Supports instant hotwords, context, and speaker diarization; optional dialect preservation.",
  "qwen-audio-3.0-asr-flash-filetrans": "Supports instant hotwords, context, and speaker diarization.",
  "fun-asr": "Supports speaker diarization and word-level timestamps.",
  "whisper-1": "Supports Prompt; Whisper prompts are limited to 224 tokens.",
  "gpt-transcribe": "OpenAI's recommended file transcription model; supports Prompt and Keywords.",
  "gpt-4o-transcribe": "Supports Prompt.",
  "gpt-4o-mini-transcribe": "Supports Prompt.",
  "gpt-4o-transcribe-diarize": "OpenAI's speaker-diarization model; returns speaker-labeled segments.",
  "custom-asr": "Fill in your custom ASR model name after selecting this.",
  "stt-async-v5": "Supports prompts, speaker diarization, and word-level timestamps.",
  "16k_zh_en_2.0": "Enter the SecretId here; configure SecretKey in the local .env.",
  "qwen3-asr-local": "Lightweight multilingual recognition with native word/character timestamps; shares the Qwen3-ForcedAligner cache.",
  "qwen3-asr-1.7b-local": "Higher recognition quality with native word/character timestamps; shares the Qwen3-ForcedAligner; higher resource use.",
  "fun-asr-nano-local": "LLM-ASR approach with FSMN-VAD by default; Chinese, English, Japanese, and Chinese dialects; CUDA recommended.",
  "funasr-local": "Runs locally; uses the FunASR upstream model cache.",
  "sensevoice-small-local": "Multilingual recognition with FSMN-VAD by default; runs on CPU or GPU; an aligner can add word/character timestamps.",
  "firered-asr2-ctc-local": "Chinese, English, and dialect recognition; CPU-capable with word/character timestamps; ct-punc is optional for punctuation and segmentation.",
  "moss-transcribe-diarize-local": "Speaker diarization with segment timestamps only; an aligner can add word/character timestamps; GPU recommended.",
  "whisper-large-v3-local": "Multilingual recognition with native word timestamps; runs on CPU or GPU, with better speed on GPU; no speaker diarization.",
  "bcut-asr": "Millisecond per-character timestamps; no API key required.",
};
const MODEL_PRICING_NOTES_EN = {
  "qwen-audio-3.1-asr-flash-filetrans": "Alibaba Cloud Bailian reference price: token-based, CNY 0.8 / 1M input tokens and CNY 2.7 / 1M output tokens",
  "qwen-audio-3.0-asr-flash-filetrans": "Alibaba Cloud Bailian reference price: CNY 0.00022/second (about CNY 0.792/hour)",
  "fun-asr": "Alibaba Cloud Bailian reference price: CNY 0.00022/second (about CNY 0.792/hour)",
  "qwen3-asr-flash-filetrans": "Alibaba Cloud Bailian reference price: CNY 0.00022/second (about CNY 0.792/hour)",
  "stt-async-v5": "Soniox reference price: about $0.10/hour for async file transcription; token-based pricing with $1.50 / 1M audio input tokens and $3.50 / 1M input-text tokens.",
  "16k_zh_en_2.0": "Tencent Cloud reference price: CNY 0.8/hour for recorded-file ASR large model 2.0 on pay-as-you-go; a 60-hour prepaid pack is CNY 48.",
  "whisper-1": "OpenAI official reference price: $0.006/minute (about $0.36/hour)",
  "gpt-transcribe": "OpenAI official reference price: $0.0045/minute (about $0.27/hour)",
  "gpt-4o-transcribe": "OpenAI official reference price: $2.50 / 1M audio input tokens and $10 / 1M audio output tokens",
  "gpt-4o-mini-transcribe": "OpenAI official reference price: $1.25 / 1M audio input tokens and $5 / 1M audio output tokens",
  "gpt-4o-transcribe-diarize": "OpenAI official reference price: $2.50 / 1M audio input tokens and $10 / 1M audio output tokens.",
};
const MODEL_OPENROUTER_NOTES_EN = {
  "whisper-1": "OpenRouter reference price: $0.006/minute.",
  "gpt-transcribe": "OpenRouter reference price: $0.0045/minute; supports Prompt, Keywords, and languages[].",
  "gpt-4o-transcribe": "OpenRouter reference price: $2.50 / 1M input tokens and $10 / 1M output tokens",
  "gpt-4o-mini-transcribe": "OpenRouter reference price: $1.25 / 1M input tokens and $5 / 1M output tokens",
  "whisper-large-v3-turbo": "OpenRouter reference price: $0.04/hour",
  "whisper-large-v3": "OpenRouter reference price: $0.0015/minute",
  "gpt-4o-transcribe-diarize": "OpenRouter does not support diarize; switch to the official OpenAI Base URL.",
};
const REGION_LABELS_EN = { beijing: "Beijing (China North 2, default)", singapore: "Singapore (Workspace ID required)" };
const LANGUAGE_LABELS_EN = { "": "Auto detect", zh: "Chinese", yue: "Cantonese", en: "English", ja: "Japanese", de: "German", ko: "Korean", ru: "Russian", fr: "French", pt: "Portuguese", ar: "Arabic", it: "Italian", es: "Spanish", hi: "Hindi", id: "Indonesian", th: "Thai", tr: "Turkish", uk: "Ukrainian", vi: "Vietnamese", cs: "Czech", da: "Danish", fil: "Filipino", fi: "Finnish", is: "Icelandic", ms: "Malay", no: "Norwegian", pl: "Polish", sv: "Swedish", nl: "Dutch", el: "Greek", hu: "Hungarian", ro: "Romanian", bg: "Bulgarian", hr: "Croatian", sk: "Slovak", sl: "Slovenian", sw: "Swahili", tl: "Tagalog", ta: "Tamil", te: "Telugu", ur: "Urdu", cy: "Welsh", af: "Afrikaans", sq: "Albanian", az: "Azerbaijani", eu: "Basque", be: "Belarusian", bn: "Bengali", bs: "Bosnian", ca: "Catalan", et: "Estonian", gl: "Galician", gu: "Gujarati", he: "Hebrew", kn: "Kannada", kk: "Kazakh", lv: "Latvian", lt: "Lithuanian", mk: "Macedonian", ml: "Malayalam", mr: "Marathi", fa: "Persian", pa: "Punjabi", sr: "Serbian" };
function localizedSelectLabel(selectId, item) {
  if (state.lang !== "en") return item.label;
  const map = { provider: PROVIDER_LABELS_EN, model: MODEL_LABELS_EN, region: REGION_LABELS_EN, language: LANGUAGE_LABELS_EN }[selectId];
  return map?.[item.id] || item.label;
}
function providerNoteText(providerItem) { return state.lang === "en" ? (PROVIDER_NOTES_EN[providerItem.id] || providerItem.note) : providerItem.note; }
function appendNoteText(parent, text) { if (text) parent.append(document.createTextNode(text)); }
function renderProviderNote(providerItem) {
  // DeepSeek 彩蛋：第二行的「AI处理」是可点击入口，直接打开工具箱的 AI 处理标签页。
  const noteElement = $("providerNote");
  if (!noteElement) return;
  noteElement.textContent = "";
  if (providerItem?.id === "deepseek") {
    const en = state.lang === "en";
    appendNoteText(noteElement, en ? "🐳 The big blue fish cannot transcribe audio — it's a text model!" : "🐳 蓝色大肥鱼不支持语音转写，它是个文本模型！");
    noteElement.append(document.createElement("br"));
    appendNoteText(noteElement, en ? " But you can use it for translation in " : " 不过你可以在 ");
    const link = document.createElement("button");
    link.type = "button";
    link.id = "providerNoteLlmLink";
    link.className = "inline-link";
    link.dataset.i18n = "toolbox_llm";
    link.textContent = t("toolbox_llm");
    link.addEventListener("click", () => { window.MAWLauncher?.openToolboxAiProcessing?.(); });
    noteElement.append(link);
    appendNoteText(noteElement, en ? " of the toolbox." : " 中使用它来翻译啥的。");
    noteElement.classList.remove("hidden");
    return;
  }
  noteElement.textContent = providerNoteText(providerItem);
  noteElement.classList.toggle("hidden", !providerItem?.note);
}
function isOpenRouterBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`);
    return ["openrouter.ai", "www.openrouter.ai"].includes(url.hostname.toLowerCase().replace(/^www\./u, ""));
  } catch (_error) {
    return false;
  }
}
function isOpenAiOfficialBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./u, "") === "api.openai.com";
  } catch (_error) {
    return false;
  }
}
// 价格文案统一加 🪙 前缀；非价格的备注（如 diarize 的 OpenRouter 提示）不加。
function withPricePrefix(text) {
  const value = String(text || "");
  return /参考价|reference price/iu.test(value) ? `🪙 ${value}` : value;
}
function modelNoteParts(modelItem) {
  const openRouterNote = modelItem.openrouterNote || "";
  const baseUrl = $("openaiBaseUrl")?.value || state.config?.openaiBaseUrl;
  const isOpenai = isOpenAiProvider();
  const isOpenRouter = isOpenai && isOpenRouterBaseUrl(baseUrl);
  if (isOpenRouter && openRouterNote) return { note: "", price: withPricePrefix(state.lang === "en" ? (MODEL_OPENROUTER_NOTES_EN[modelItem.id] || openRouterNote) : openRouterNote) };
  const note = state.lang === "en" ? (MODEL_NOTES_EN[modelItem.id] || modelItem.note) : modelItem.note;
  if (isOpenai && !isOpenAiOfficialBaseUrl(baseUrl)) return { note, price: "" };
  const priceNote = state.lang === "en" ? (MODEL_PRICING_NOTES_EN[modelItem.id] || modelItem.priceNote) : modelItem.priceNote;
  return { note, price: withPricePrefix(priceNote) };
}
function modelNoteText(modelItem) { const parts = modelNoteParts(modelItem); return [parts.note, parts.price].filter(Boolean).join("\n"); }
function renderModelNote() {
  const el = $("modelNote");
  if (!el) return;
  const parts = modelNoteParts(selectedModel());
  el.replaceChildren();
  if (parts.note) {
    const noteElement = document.createElement("span");
    noteElement.className = "model-note-text";
    noteElement.textContent = parts.note;
    el.append(noteElement);
  }
  if (parts.price) {
    const priceElement = document.createElement("span");
    priceElement.className = "price-note";
    priceElement.textContent = parts.price;
    el.append(priceElement);
  }
}
// custom / custom2 / custom3 是三个并列的「自定义接口」槽位，共用同一套显示与存储行为。
function isCustomSlotId(providerId) { return ["custom", "custom2", "custom3"].includes(String(providerId || "")); }
function customSlotLabelKey(providerId) {
  const suffix = String(providerId || "").replace("custom", "");
  return suffix ? `llm_custom_provider_${suffix}` : "llm_custom_provider";
}
function llmProviderLabel(providerId) {
  const id = String(providerId || "").trim();
  const item = state.config?.postprocessProviders?.find((candidate) => candidate.id === id);
  if (isCustomSlotId(id) && item?.displayName) return item.displayName;
  if (isCustomSlotId(id)) return t(customSlotLabelKey(id)) || item?.label || t("llm_custom_provider");
  const labels = state.lang === "en"
    ? { deepseek: "DeepSeek", zhipu: "Zhipu Coding Plan", qwen: "Alibaba Qwen" }
    : { deepseek: "DeepSeek", zhipu: "智谱 Coding Plan", qwen: "阿里云 Qwen" };
  return labels[id] || item?.label || t("llm_provider_unknown");
}
function llmBuiltInProviderKeyGuidance(context = {}) {
  const providerId = String(context?.providerId || "").trim();
  if (!["deepseek", "zhipu", "qwen"].includes(providerId)) return "";
  return t("llm_builtin_provider_key_guidance")
    .replaceAll("{provider}", llmProviderLabel(providerId));
}
function llmHttpErrorText(status, context = {}) {
  const numericStatus = Number(status);
  const providerId = String(context?.providerId || "").trim();
  const keys = { 401: "llm_http_unauthorized", 403: "llm_http_forbidden", 404: "llm_http_not_found", 429: "llm_http_rate_limited" };
  const key = numericStatus === 401 && ["deepseek", "zhipu", "qwen"].includes(providerId)
    ? "llm_http_unauthorized_builtin"
    : (numericStatus === 401 && isCustomSlotId(providerId) ? "llm_http_unauthorized_custom" : keys[numericStatus]);
  if (!key) return "";
  const isModelList = String(context?.operation || "").toLowerCase().includes("model");
  const operation = t(isModelList ? "llm_http_model_list_operation" : "llm_http_connection_operation");
  return t(key)
    .replaceAll("{provider}", llmProviderLabel(context?.providerId))
    .replaceAll("{operation}", operation);
}
function errText(code, detail, context = {}) {
  const compact = compactDetail(detail);
  if (["postprocess_failed", "transcription_failed"].includes(code)) {
    const intermediate = String(detail || "").includes("中间文件创建或写入失败");
    const tooLong = /\[WinError 206\]|\[Errno 36\]|\bENAMETOOLONG\b|file(?:name| name) too long/iu.test(String(detail || ""));
    if (tooLong) code = intermediate ? "intermediate_path_too_long" : "file_path_too_long";
    else if (intermediate) code = "intermediate_file_failed";
    else if (String(detail || "").includes("文件创建或写入失败")) code = "file_write_failed";
  }
  const builtInGuidance = ["postprocess_connection_failed", "postprocess_models_failed"].includes(code) && !Number.isInteger(Number(context?.httpStatus))
    ? llmBuiltInProviderKeyGuidance(context)
    : "";
  const modelGuidance = code === "transcription_failed"
    && $("provider")?.value === "openai"
    && /(model|response[_ ]?format|verbose_json|timestamp)/iu.test(compact)
    && !/(自定义（Custom）|choose Custom|exact model name)/iu.test(compact)
    ? t("transcription_model_hint")
    : "";
  if (["postprocess_connection_failed", "postprocess_models_failed"].includes(code)) {
    const guidance = llmHttpErrorText(context?.httpStatus, context);
    if (guidance) return [guidance, builtInGuidance].filter(Boolean).join(" ");
  }
  const entry = ERROR_TEXT[state.lang][code];
  const message = typeof entry === "function" ? entry(compact, context) : (entry || compact || t("failed"));
  return [message, modelGuidance, builtInGuidance].filter(Boolean).join(" ");
}
