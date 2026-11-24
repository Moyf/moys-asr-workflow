export function initStickerRootModule() {
// Personal default directory and project override share the existing validated server endpoint.
(function initStickerRoot(global) {
  'use strict';
  const DEFAULT_ROOT_KEY = 'moy.asr.editor.sticker-root.v1';
  const defaultInput = document.getElementById('sticker-root-input');
  const defaultButton = document.getElementById('sticker-root-read');
  const defaultBrowse = document.getElementById('sticker-root-browse');
  const defaultStatus = document.getElementById('sticker-root-status');
  const projectInput = document.getElementById('project-sticker-root-input');
  const projectButton = document.getElementById('project-sticker-root-read');
  const projectBrowse = document.getElementById('project-sticker-root-browse');
  const projectStatus = document.getElementById('project-sticker-root-status');
  const overrideToggle = document.getElementById('project-sticker-root-override');
  const serverEnabled = Boolean(MaweBoot.SERVER_CONFIG?.stickerRootUrl);
  let epoch = 0, busy = false, pending = Promise.resolve();
  let picking = false;
  const nativePaths = new WeakMap();
  function normalizeRoot(value) {
    const root = String(value || '').trim().replace(/\\/g, '/');
    return root === '/' || /^[A-Za-z]:\/$/.test(root) ? root : root.replace(/\/+$/, '');
  }
  function getDefaultRoot() {
    try { return MaweHost.storage.getItem(DEFAULT_ROOT_KEY) || ''; } catch (_) { return ''; }
  }
  function projectRoot() { return MaweBoot.DATA.sticker_root || ''; }
  function syncBrowseControls() {
    defaultBrowse.disabled = busy || picking;
    projectBrowse.disabled = busy || picking || !overrideToggle.checked;
  }
  function syncControls(refreshValues = true) {
    if (!busy && refreshValues) {
      defaultInput.value = getDefaultRoot(); projectInput.value = projectRoot();
      overrideToggle.checked = Boolean(projectRoot());
    }
    projectInput.disabled = busy || !overrideToggle.checked;
    projectButton.disabled = busy || !overrideToggle.checked;
    defaultInput.disabled = busy; defaultButton.disabled = busy; overrideToggle.disabled = busy;
    syncBrowseControls();
    if (!serverEnabled) {
      defaultStatus.textContent = '便携编辑器保存目录配置；读取本地图片需要 Server 编辑器。';
      projectStatus.textContent = defaultStatus.textContent;
    }
  }
  function connectNativePicker(nativeSession) {
    if (!serverEnabled || !nativeSession) return;
    defaultBrowse.hidden = projectBrowse.hidden = false;
    for (const [button, input] of [[defaultBrowse, defaultInput], [projectBrowse, projectInput]]) {
      button.addEventListener('click', async () => {
        if (picking || busy || input.disabled) return;
        const generation = MaweState.projectLoadGeneration, initialValue = input.value, rootEpoch = epoch;
        const current = () => generation === MaweState.projectLoadGeneration && rootEpoch === epoch
          && !input.disabled && input.value === initialValue;
        picking = true;
        syncBrowseControls();
        try {
          const { response, result } = await MaweHint.withLauncherPickerHint(
            '请在 Launcher 的文件夹选择器中选择表情包目录。',
            async () => {
              const response = await MaweHost.server.fetch('/api/stickers/native-pick-root', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, nativeSession }),
              });
              return { response, result: await response.json() };
            },
          );
          if (!current()) return;
          if (!response.ok || !result.ok) throw new Error(result.error || String(response.status));
          if (!result.cancelled && typeof result.root === 'string') {
            input.value = result.root;
            nativePaths.set(input, input.value);
          }
        } catch (error) {
          if (current()) MaweHint.flashHint(`选择表情包目录失败：${error.message || error}`, 'warning', { error });
        } finally {
          picking = false;
          syncBrowseControls();
        }
      });
    }
  }
  async function requestRoot(root, activate) {
    if (!serverEnabled) return null;
    const { stickerRootUrl, requestToken } = MaweBoot.SERVER_CONFIG;
    const response = await MaweHost.server.fetch(stickerRootUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken, path: root, activate, ...MaweServerSave.currentServerBinding }),
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
    global.MaweAssFrame?.syncWindowStickers?.();
    MaweExportTimeline.updateStickerExportButtons(); MaweCuePanel.renderAll();
  }
  function enqueue(action) { pending = pending.catch(() => {}).then(action); return pending; }
  function applyInputRoot(scope) {
    const input = scope === 'default' ? defaultInput : projectInput;
    const saved = scope === 'default' ? getDefaultRoot() : projectRoot();
    return applyRoot(scope, input.value, { exact: nativePaths.get(input) === input.value || saved === input.value });
  }
  function hasStickerReferences() {
    const project = MaweBoot.DATA;
    const tracks = [project, project.overlay_track, ...(project.multi_subtitle?.tracks || [])];
    return tracks.some(track => track?.segments?.some(segment => segment.sticker || segment.sticker_ref));
  }
  async function applyRoot(scope, value, { exact = false } = {}) {
    const root = exact ? value : normalizeRoot(value), generation = ++epoch;
    const status = scope === 'default' ? defaultStatus : projectStatus;
    let declined = false;
    busy = true; syncControls();
    try {
      await enqueue(async () => {
        if (generation !== epoch) return;
        const active = scope === 'project' || !projectRoot();
        const effective = scope === 'project' ? root || getDefaultRoot() : root;
        if (active && effective !== (MaweBoot.STICKER_ROOT || '') && hasStickerReferences()) {
          const message = '当前工程已有表情包。更换目录可能导致部分表情包无法显示或导出；原有引用不会删除。确定更换吗？';
          if (!global.confirm(global.MAWE_I18N?.translateText?.(message) || message)) {
            declined = true;
            if (scope === 'project' && !root) overrideToggle.checked = Boolean(projectRoot());
            return;
          }
        }
        status.textContent = '正在读取并验证表情包目录…';
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
    } finally { if (generation === epoch) { busy = false; syncControls(!declined); } }
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
    getDefaultRoot, projectRoot, syncControls, applyRoot, applyInputRoot, activateProjectRoot, connectNativePicker,
    waitForPending: () => pending.catch(() => {}),
    defaultInput, defaultButton, projectInput, projectButton, overrideToggle,
  });
})(window);
}
