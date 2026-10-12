// 表单基础：provider/model 选择器访问器与 OpenAI 自定义模型字段。

const ext = (path) => (path.match(/\.[^.\\/]+$/)?.[0] || "").toLowerCase();
const provider = () => state.config.providers.find((item) => item.id === $("provider").value) || state.config.providers[0];
const selectedModel = () => provider().models.find((item) => item.id === $("model").value) || provider().models[0];
const isOpenAiProvider = () => provider()?.id === "openai";
const isCustomOpenAiModel = () => isOpenAiProvider() && selectedModel()?.id === OPENAI_ASR_CUSTOM_MODEL_ID;
function customOpenAiModelDraft() {
  if (state.config && state.config.openaiCustomModel !== undefined) return String(state.config.openaiCustomModel || "").trim();
  const saved = String(state.config?.openaiModel || "").trim();
  return OPENAI_ASR_OFFICIAL_MODEL_IDS.has(saved) ? "" : saved;
}
function apiKeyFormatInvalid(value) {
  const key = String(value || "").trim();
  return Boolean(key && (!/^[\x21-\x7e]+$/u.test(key) || /["']/u.test(key)
    || /^https?:\/\//iu.test(key) || /^(?:[\w-]*api[-_]?key|key|authorization)\s*[:=]/iu.test(key)));
}
function validateApiKey() {
  const current = provider();
  if (current.requiresApiKey === false || isLocalProvider()) return true;
  const key = String($("apiKey").value || "").trim() || String(current.apiKey || "").trim();
  const code = !key ? "api_key_missing" : (apiKeyFormatInvalid(key) ? "api_key_invalid_format" : "");
  return code ? fail("apiKey", errText(code, "")) : true;
}
function syncOpenAiFields() {
  const openai = isOpenAiProvider();
  const custom = isCustomOpenAiModel();
  $("customAsrFields").classList.toggle("hidden", !openai);
  $("openaiModelField").classList.toggle("hidden", !custom);
  if (custom) {
    const current = $("openaiModel").value.trim();
    const saved = customOpenAiModelDraft();
    const draft = current && !OPENAI_ASR_OFFICIAL_MODEL_IDS.has(current) ? current : saved;
    $("openaiModel").value = draft;
    state.config.openaiCustomModel = draft;
  }
}
