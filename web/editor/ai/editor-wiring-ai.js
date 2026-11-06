// AI 功能接线：设置面板事件、进度浮条取消按钮与 MaweAi 公共门面。
// 门面（aiEnabled / appendContextMenu / begin）供右键菜单与后续任务入口
// 统一调用；各能力分别委托给 MaweAiSettings 与 MaweAiTasks。
(function initMaweAiWiring(global) {
  'use strict';



  const element = (id) => document.getElementById(id);


  function setStatus(message, isError = false) {
    const status = element('ai-settings-status');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('is-error', Boolean(isError));
  }


  function openSettings() {
    MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-ai');
    refreshSettingsPanel();
  }


  // 拉取服务端设置并填充面板；file:// 或失败时在状态行说明原因。
  async function refreshSettingsPanel() {
    if (!MaweAiSettings.serverAvailable()) {
      setStatus('AI 设置仅在本地服务器版编辑器可用（当前通过 file:// 打开）', true);
      return;
    }
    try {
      const settings = await MaweAiSettings.fetchSettings({ force: true });
      if (settings) MaweAiSettings.fillSettingsPanel();
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  }


  // 读表单 → 保存 → 回显掩码；测试连接 / 拉取模型都先走这一步，
  // 确保后端用到的是面板上看到的值。
  async function saveCurrentForm() {
    const form = MaweAiSettings.readFormValues();
    const settings = await MaweAiSettings.saveSettings(form);
    MaweAiSettings.fillSettingsPanel();
    MaweAiSettings.clearApiKeyInput();
    return settings;
  }


  function wireSettingsControls() {
    const toggle = element('ai-feature-toggle');
    if (toggle) {
      toggle.checked = MaweSettings.EDITOR_SETTINGS.aiEnabled === true;
      toggle.addEventListener('change', () => {
        MaweSettings.updateEditorSettings({ aiEnabled: toggle.checked });
        MaweHint.flashHint(toggle.checked ? '已启用 AI 功能' : '已关闭 AI 功能', 'success');
      });
    }

    const providerSelect = element('ai-provider-select');
    providerSelect?.addEventListener('change', () => {
      MaweAiSettings.applyProviderSelection(providerSelect.value);
    });

    element('ai-settings-save')?.addEventListener('click', async () => {
      try {
        await saveCurrentForm();
        setStatus('已保存；编辑器与 Launcher 工具箱共用这份配置。', false);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });

    element('ai-settings-test')?.addEventListener('click', async () => {
      try {
        const settings = await saveCurrentForm();
        setStatus(`正在用 ${settings.model || '当前模型'} 测试连接…`, false);
        const result = await MaweAiTasks.begin('test-connection', {}, '测试 AI 连接');
        setStatus(`连接成功：${result.model || settings.model || '当前模型'}`, false);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });

    element('ai-models-refresh')?.addEventListener('click', async () => {
      try {
        const settings = await saveCurrentForm();
        setStatus('正在拉取模型列表…', false);
        const models = await MaweAiSettings.fetchModels(settings.providerId);
        MaweAiSettings.fillModelDatalist(models);
        setStatus(`已拉取 ${models.length} 个模型，输入模型时可从下拉列表选择。`, false);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });

    element('ai-task-progress-cancel')?.addEventListener('click', () => {
      MaweAiTasks.cancelCurrent();
    });
  }


  wireSettingsControls();
  // 启动即预取一次设置：右键菜单与后续任务入口可用 provider 列表判断状态；
  // file:// 打开时 fetchSettings 返回 null，静默跳过。
  if (MaweAiSettings.serverAvailable()) {
    MaweAiSettings.fetchSettings().then((settings) => {
      if (settings) MaweAiSettings.fillSettingsPanel();
    }).catch(() => { /* 网络暂不可用时留到打开设置页再重试 */ });
  }



  // 公共门面：右键菜单等外部模块只感知 MaweAi，不直接依赖两个子门面。
  global.MaweAi = Object.freeze({
    aiEnabled: () => MaweAiSettings.aiEnabled(),
    serverAvailable: () => MaweAiSettings.serverAvailable(),
    openSettings,
    appendContextMenu: (container, targets) => MaweAiTasks.appendContextMenu(container, targets),
    begin: (kind, payload, label) => MaweAiTasks.begin(kind, payload, label),
  });
})(typeof window !== 'undefined' ? window : globalThis);
