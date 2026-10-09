// Personal default directory and project override share the existing validated server endpoint.
(function initStickerRoot(global) {
  'use strict';
  const DEFAULT_ROOT_KEY = 'moy.asr.editor.sticker-root.v1';
  const defaultInput = document.getElementById('sticker-root-input');
  const defaultButton = document.getElementById('sticker-root-read');
  const defaultStatus = document.getElementById('sticker-root-status');
  const projectInput = document.getElementById('project-sticker-root-input');
  const projectButton = document.getElementById('project-sticker-root-read');
  const projectStatus = document.getElementById('project-sticker-root-status');
  const overrideToggle = document.getElementById('project-sticker-root-override');
  const serverEnabled = Boolean(MaweBoot.SERVER_CONFIG?.stickerRootUrl);
  let epoch = 0, busy = false, pending = Promise.resolve();
  function normalizeRoot(value) {
    const root = String(value || '').trim().replace(/\\/g, '/');
    return root === '/' || /^[A-Za-z]:\/$/.test(root) ? root : root.replace(/\/+$/, '');
  }
  function getDefaultRoot() {
    try { return normalizeRoot(MaweHost.storage.getItem(DEFAULT_ROOT_KEY)); } catch (_) { return ''; }
  }
  function projectRoot() { return normalizeRoot(MaweBoot.DATA.sticker_root); }
  function syncControls() {
    if (!busy) {
      defaultInput.value = getDefaultRoot(); projectInput.value = projectRoot();
      overrideToggle.checked = Boolean(projectRoot());
    }
    projectInput.disabled = busy || !overrideToggle.checked;
    projectButton.disabled = busy || !overrideToggle.checked;
    defaultInput.disabled = busy; defaultButton.disabled = busy; overrideToggle.disabled = busy;
    if (!serverEnabled) {
      defaultStatus.textContent = '便携编辑器保存目录配置；读取本地图片需要 Server 编辑器。';
      projectStatus.textContent = defaultStatus.textContent;
    }
  }
  async function requestRoot(root, activate) {
    if (!serverEnabled) return null;
    const response = await MaweHost.server.fetch(MaweBoot.SERVER_CONFIG.stickerRootUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, path: root, activate }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || String(response.status));
    return result;
  }
  function publish(root, result) {
    MaweBoot.STICKER_ROOT = root;
    if (result) {
      MaweBoot.STICKERS.splice(0, MaweBoot.STICKERS.length, ...result.stickers);
      MaweBoot.SERVER_CONFIG.initialStickerCount = result.count;
    }
    MaweStickerOverlay.stickerAssetRevision += 1;
    MaweExportTimeline.updateStickerExportButtons(); MaweCuePanel.renderAll();
  }
  function enqueue(action) { pending = pending.catch(() => {}).then(action); return pending; }
  async function applyRoot(scope, value) {
    const root = normalizeRoot(value), generation = ++epoch;
    const status = scope === 'default' ? defaultStatus : projectStatus;
    busy = true; syncControls(); status.textContent = '正在读取并验证表情包目录…';
    try {
      await enqueue(async () => {
        if (generation !== epoch) return;
        const active = scope === 'project' || !projectRoot();
        const effective = scope === 'project' ? root || getDefaultRoot() : root;
        const result = await requestRoot(effective, active);
        if (generation !== epoch) return;
        const checked = result?.root || effective;
        if (scope === 'default') MaweHost.storage.setItem(DEFAULT_ROOT_KEY, root ? checked : '');
        else { MaweBoot.DATA.sticker_root = root ? checked : ''; MaweServerSave.projectImportDirty = true; }
        if (active) publish(checked, result);
        syncControls();
        status.textContent = result ? '目录已应用，读取 ' + result.count + ' 张图片。' : '目录配置已保存。';
        MaweServerSave.scheduleAutoSave();
      });
    } catch (error) {
      if (generation === epoch) status.textContent = '读取失败：' + (error.message || error) + '。当前有效目录和表情包保持不变。';
    } finally { if (generation === epoch) { busy = false; syncControls(); } }
  }
  function activateProjectRoot() {
    const generation = ++epoch, root = projectRoot() || getDefaultRoot();
    busy = false; syncControls();
    return enqueue(async () => {
      if (generation !== epoch) return;
      try {
        const result = await requestRoot(root, true);
        if (generation === epoch) publish(result?.root || root, result);
      } catch (error) {
        if (generation === epoch) projectStatus.textContent = '目录读取失败：' + (error.message || error);
      }
    });
  }
  if (typeof MaweBoot.DATA.sticker_root !== 'string') MaweBoot.DATA.sticker_root = '';
  global.MaweStickerRoot = Object.freeze({
    getDefaultRoot, projectRoot, syncControls, applyRoot, activateProjectRoot,
    defaultInput, defaultButton, projectInput, projectButton, overrideToggle,
  });
})(window);
