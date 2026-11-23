MaweStickerRoot.syncControls();
launcherSessionConnection?.then(session => MaweStickerRoot.connectNativePicker(session));
MaweStickerRoot.defaultButton.addEventListener('click', () => MaweStickerRoot.applyInputRoot('default'));
MaweStickerRoot.projectButton.addEventListener('click', () => MaweStickerRoot.applyInputRoot('project'));
MaweStickerRoot.overrideToggle.addEventListener('change', () => {
  if (!MaweStickerRoot.overrideToggle.checked) { MaweStickerRoot.applyRoot('project', ''); return; }
  MaweStickerRoot.syncControls(false);
  MaweStickerRoot.projectInput.value = MaweBoot.STICKER_ROOT || MaweStickerRoot.getDefaultRoot();
  MaweStickerRoot.projectInput.focus();
});
if (!MaweStickerRoot.projectRoot() && MaweStickerRoot.getDefaultRoot()) MaweStickerRoot.activateProjectRoot();
