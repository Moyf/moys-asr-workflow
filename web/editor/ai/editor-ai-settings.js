// AI 设置：编辑器侧供应商/模型/密钥面板与 /api/ai/settings 读写。
// 后端（maw.editor_ai）与 Launcher 工具箱共享同一份 .env 配置，改一处两边
// 同步；api_key 只保存、只以掩码回显，本模块不持有密钥原文。file:// 打开
// 时无 requestToken，AI 服务端能力整体不可用，这里提供统一可用性判断。
(function initMaweAiSettings(global) {
  'use strict';



  const AI_SETTINGS_URL = '/api/ai/settings';
  const AI_MODELS_URL = '/api/ai/models';



  // 最近一次 GET/POST /api/ai/settings 返回的设置视图（含 providers 列表）。
  let serverSettings = null;
  let loadPromise = null;



  function aiEnabled() {
    return MaweSettings.EDITOR_SETTINGS.aiEnabled === true;
  }


  function serverAvailable() {
    return Boolean(MaweBoot.SERVER_CONFIG?.requestToken);
  }


  function ensureServerAvailable() {
    if (serverAvailable()) return;
    throw new Error('AI 功能仅在本地服务器版编辑器可用（当前通过 file:// 打开）');
  }


  async function fetchSettings({ force = false } = {}) {
    if (!serverAvailable()) return null;
    if (serverSettings && !force) return serverSettings;
    if (loadPromise) return loadPromise;
    loadPromise = MaweHost.server.fetch(AI_SETTINGS_URL, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body?.ok) throw new Error(body?.error || `读取 AI 设置失败（HTTP ${response.status}）`);
        return body;
      })
      .then((body) => {
        serverSettings = body;
        return body;
      })
      .finally(() => { loadPromise = null; });
    return loadPromise;
  }


  // 保存设置；payload 缺省字段不覆盖服务端现值（apiKey=null 表示保留密钥）。
  async function saveSettings(payload = {}) {
    ensureServerAvailable();
    const response = await MaweHost.server.fetch(AI_SETTINGS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, ...payload }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error || `保存 AI 设置失败（HTTP ${response.status}）`);
    }
    serverSettings = body;
    return body;
  }


  // 拉取供应商的可用模型列表（OpenAI 兼容 /models）；失败抛可读错误。
  async function fetchModels(providerId = null) {
    ensureServerAvailable();
    const response = await MaweHost.server.fetch(AI_MODELS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, providerId }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error || `拉取模型列表失败（HTTP ${response.status}）`);
    }
    return Array.isArray(body.models) ? body.models : [];
  }



  const element = (id) => document.getElementById(id);


  function apiKeyStatusText(entry) {
    if (!entry) return '';
    if (entry.hasApiKey) return `已保存：${entry.maskedApiKey}`;
    if (entry.apiKeyRequired) return '未配置密钥';
    return '该供应商可免密钥访问';
  }


  // 按供应商切换时展示该槽位的配置；只改表单，点「保存设置」才写入。
  function applyProviderSelection(providerId) {
    const data = serverSettings;
    if (!data) return;
    const entry = (data.providers || []).find((provider) => provider.id === providerId) || null;
    const baseUrlInput = element('ai-base-url-input');
    const modelInput = element('ai-model-input');
    const reasoningSelect = element('ai-reasoning-select');
    if (baseUrlInput) baseUrlInput.value = entry?.baseUrl || '';
    if (modelInput) modelInput.value = entry?.model || '';
    if (reasoningSelect && entry?.reasoningMode) reasoningSelect.value = entry.reasoningMode;
    const keyStatus = element('ai-api-key-status');
    if (keyStatus) keyStatus.textContent = apiKeyStatusText(entry);
  }


  // 用服务端当前值填充整个面板（供应商下拉 + 各输入框 + 密钥状态）。
  function fillSettingsPanel() {
    const data = serverSettings;
    if (!data) return;
    const select = element('ai-provider-select');
    if (select) {
      select.innerHTML = '';
      for (const provider of data.providers || []) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.label;
        option.selected = provider.id === data.providerId;
        select.appendChild(option);
      }
    }
    applyProviderSelection(data.providerId);
  }


  // 读取面板当前表单值；空 API Key 转成 null 表示「保持现值不变」。
  function readFormValues() {
    const apiKey = String(element('ai-api-key-input')?.value || '').trim();
    return {
      providerId: String(element('ai-provider-select')?.value || '').trim(),
      baseUrl: String(element('ai-base-url-input')?.value || '').trim(),
      model: String(element('ai-model-input')?.value || '').trim(),
      reasoningMode: String(element('ai-reasoning-select')?.value || '').trim(),
      apiKey: apiKey || null,
    };
  }


  function clearApiKeyInput() {
    const input = element('ai-api-key-input');
    if (input) input.value = '';
  }


  // 把模型列表写入 datalist；去重并跳过非法值。
  function fillModelDatalist(models) {
    const datalist = element('ai-model-datalist');
    if (!datalist) return;
    datalist.innerHTML = '';
    for (const model of models) {
      if (typeof model !== 'string' || !model.trim()) continue;
      const option = document.createElement('option');
      option.value = model.trim();
      datalist.appendChild(option);
    }
  }


  global.MaweAiSettings = Object.freeze({
    aiEnabled,
    serverAvailable,
    ensureServerAvailable,
    fetchSettings,
    saveSettings,
    fetchModels,
    fillSettingsPanel,
    applyProviderSelection,
    readFormValues,
    clearApiKeyInput,
    fillModelDatalist,
    get serverSettings() { return serverSettings; },
  });
})(typeof window !== 'undefined' ? window : globalThis);
