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
