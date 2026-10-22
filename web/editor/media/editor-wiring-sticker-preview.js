
// === 表情包预览（视频画面内）===
// 层位置/尺寸由 preview.sticker 几何驱动（默认右上角）；点击后可拖动/缩放，与字幕预览同一套交互。

MaweStickerOverlay.stickerOverlayLayer.id = 'sticker-overlay-layer';
MaweStickerOverlay.stickerOverlayLayer.className = 'geo-box';
MaweStickerOverlay.stickerOverlayLayer.tabIndex = 0;
MaweStickerOverlay.stickerOverlayLayer.setAttribute('role', 'group');
MaweStickerOverlay.stickerOverlayLayer.setAttribute('aria-label', '表情包预览位置。可拖动调整；方向键移动，按住 Shift 加速，按住 Alt 配合方向键调整大小，Enter 显示控制点，Esc 退出。');

MaweStickerOverlay.stickerOverlayContent.className = 'sticker-overlay-content';
MaweStickerOverlay.stickerOverlayLayer.appendChild(MaweStickerOverlay.stickerOverlayContent);
['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((h) => {
  const handle = document.createElement('span');
  handle.className = 'overlay-handle';
  handle.dataset.handle = h;
  MaweStickerOverlay.stickerOverlayLayer.appendChild(handle);
});
MaweDom.playerStage.appendChild(MaweStickerOverlay.stickerOverlayLayer);
MawePreviewGeometry.bindPreviewBoxPointerEvents(MaweStickerOverlay.stickerOverlayLayer, 'sticker');
MaweStickerOverlay.stickerOverlayLayer.addEventListener('keydown', (event) => MawePreviewGeometry.handlePreviewBoxKeydown(event, 'sticker'));











let activeStickerHasOverlay = false;







MaweDom.stickerOverlayToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ stickerOverlayEnabled: MaweDom.stickerOverlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  MawePlaybackLoop.update();
  // 实际画面窗口的表情包图层跟随同一开关（与烧录行为同源）。
  window.MaweAssFrame?.syncWindowStickers?.();
});

// 表情包功能总开关：关闭时「预览表情包」不可用（强制关闭并禁用），
// 右键菜单的分配入口由 context-menus 按同一设置隐藏；工程数据不受影响。
function applyStickerFeatureEnabled() {
  const enabled = MaweSettings.EDITOR_SETTINGS.stickersEnabled !== false;
  const featureToggle = document.getElementById('sticker-feature-toggle');
  if (featureToggle) featureToggle.checked = enabled;
  if (MaweDom.stickerOverlayToggle) {
    MaweDom.stickerOverlayToggle.disabled = !enabled;
    if (!enabled && MaweDom.stickerOverlayToggle.checked) {
      MaweDom.stickerOverlayToggle.checked = false;
      MaweSettings.updateEditorSettings({ stickerOverlayEnabled: false });
    }
  }
  MaweStickerOverlay.stickerOverlayLayer.classList.toggle('hidden', !enabled);
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  // 程序化改 checked 不触发 change；实际画面窗口的表情包图层同步跟随。
  window.MaweAssFrame?.syncWindowStickers?.();
  MawePlaybackLoop.update();
}
document.getElementById('sticker-feature-toggle')?.addEventListener('change', (event) => {
  MaweSettings.updateEditorSettings({ stickersEnabled: event.target.checked });
  // 启用功能时自动打开「预览表情包」，省一次到预览页翻开关；只在用户开启
  // 的这一刻补默认值，启动时恢复已保存的「预览关闭」不被强行覆盖。
  if (event.target.checked && MaweDom.stickerOverlayToggle && !MaweDom.stickerOverlayToggle.checked) {
    MaweDom.stickerOverlayToggle.checked = true;
    MaweSettings.updateEditorSettings({ stickerOverlayEnabled: true });
  }
  applyStickerFeatureEnabled();
});
applyStickerFeatureEnabled();

// 初次应用（不弄脏工程）：字幕与表情包预览几何。必须在 stickerOverlayLayer 创建之后执行（TDZ）。
MawePreviewGeometry.setPreviewGeometry(MaweAppearance.getPreviewGeometry(), { markDirty: false });
MawePreviewGeometry.setStickerGeometry(MawePreviewGeometry.getStickerGeometry(), { markDirty: false });
MawePreviewGeometry.refreshPreviewGeometryEditable();

MaweMediaPlayback.bindPlayerEvents(MaweCoreState.player);
MaweDom.overlayToggle.addEventListener('change', () => {
  // change 触发时 checked 已是新值；其它预览样式和副字幕开关仍从当前快照保留。
  const previous = MaweHistory.snapshotPreviewState();
  previous.overlay = !MaweDom.overlayToggle.checked;
  MaweHistory.pushPreviewUndo('切换字幕预览', previous);
  MaweSettings.updateEditorSettings({ overlayEnabled: MaweDom.overlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  if (!MaweDom.overlayToggle.checked) MaweDom.overlayEl.classList.add('hidden');
  else MawePlaybackLoop.update();
});
