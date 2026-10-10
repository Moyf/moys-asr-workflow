// 「标记与区段」工具窗接线：面板控制器由 editor-markers-panel.js 在装载时
// 通过 createFloatingPanel 创建（已绑定工具栏按钮与 Esc）；这里只补关闭按钮。
MaweDom.markersCloseButton?.addEventListener('click', () => MaweMarkersPanel.closePanel());

// 标记编辑总开关（默认关闭）：🔖 按钮点亮后显示「标记与区段」入口、
// 渲染标记轨道并允许编辑；关闭时隐藏入口与轨道，工程数据保留。
// 快捷键 M；项目设置 → 字幕轨道提供镜像开关。
function applyMarkerEditingEnabled() {
  const enabled = MaweSettings.EDITOR_SETTINGS.markerEditingEnabled === true;
  const quick = document.getElementById('markers-quick-toggle');
  if (quick) {
    quick.classList.toggle('active', enabled);
    quick.setAttribute('aria-pressed', String(enabled));
  }
  if (MaweDom.markersManageButton) MaweDom.markersManageButton.hidden = !enabled;
  const mirror = document.getElementById('project-marker-track-toggle');
  if (mirror) mirror.checked = enabled;
  MaweCoreState.waveformEditor?.refreshMarkerOverlay();
}
function toggleMarkerEditing() {
  MaweSettings.updateEditorSettings({ markerEditingEnabled: !(MaweSettings.EDITOR_SETTINGS.markerEditingEnabled === true) });
  applyMarkerEditingEnabled();
}
document.getElementById('markers-quick-toggle')?.addEventListener('click', toggleMarkerEditing);
document.getElementById('project-marker-track-toggle')?.addEventListener('change', (event) => {
  MaweSettings.updateEditorSettings({ markerEditingEnabled: event.target.checked });
  applyMarkerEditingEnabled();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'm' && event.key !== 'M') return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) return;
  if (MaweInlineEdit.editingState) return;
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT' || target.isContentEditable)) return;
  const modalShows = (dom) => dom?.classList.contains('show');
  if (modalShows(MaweDom.replaceModal) || modalShows(MaweDom.stickerModal)
    || modalShows(MaweDom.stickerPreviewModal) || modalShows(MaweDom.projectMediaModal)
    || modalShows(MaweDom.multiSubtitleImportModal) || MaweDom.ctxmenu.classList.contains('show')) return;
  event.preventDefault();
  toggleMarkerEditing();
});
applyMarkerEditingEnabled();
