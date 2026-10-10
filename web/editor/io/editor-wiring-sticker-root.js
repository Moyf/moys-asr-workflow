MaweStickerRoot.syncControls();
MaweStickerRoot.defaultButton.addEventListener('click', () =>
  MaweStickerRoot.applyRoot('default', MaweStickerRoot.defaultInput.value));
MaweStickerRoot.projectButton.addEventListener('click', () =>
  MaweStickerRoot.applyRoot('project', MaweStickerRoot.projectInput.value));
MaweStickerRoot.overrideToggle.addEventListener('change', () => {
  if (!MaweStickerRoot.overrideToggle.checked) { MaweStickerRoot.applyRoot('project', ''); return; }
  MaweStickerRoot.projectInput.disabled = false;
  MaweStickerRoot.projectButton.disabled = false;
  MaweStickerRoot.projectInput.value = MaweBoot.STICKER_ROOT || MaweStickerRoot.getDefaultRoot();
  MaweStickerRoot.projectInput.focus();
});
if (!MaweStickerRoot.projectRoot() && MaweStickerRoot.getDefaultRoot()) MaweStickerRoot.activateProjectRoot();

for (const [scope, id] of [['default', 'sticker-root-choose'], ['project', 'project-sticker-root-choose']]) {
  const button = document.getElementById(id);
  if (!button) continue;
  button.hidden = !MaweHost.desktop.available();
  button.addEventListener('click', async () => {
    const result = await MaweHost.desktop.chooseDirectory(window.MAWE_I18N?.language);
    if (result.status === 'cancelled') return;
    if (result.status !== 'ok') {
      MaweHint.flashHint(result.error?.message || '选择文件夹失败', 'warning');
      return;
    }
    await MaweStickerRoot.applyRoot(scope, result.path);
  });
}
