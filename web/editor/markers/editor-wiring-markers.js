// 「标记与区段」工具窗接线：面板控制器由 editor-markers-panel.js 在装载时
// 通过 createFloatingPanel 创建（这里只补关闭按钮）；开关的启用/禁用逻辑
// 在 editor-marker-editing.js（applyMarkerEditingEnabled），本文件只绑事件。
MaweDom.markersCloseButton?.addEventListener('click', () => MaweMarkersPanel.closePanel());

function toggleMarkerEditing() {
  MaweMarkerEditing.setEditingEnabled(!MaweMarkerEditing.isEditingEnabled());
}
document.getElementById('markers-quick-toggle')?.addEventListener('click', toggleMarkerEditing);
document.getElementById('project-marker-track-toggle')?.addEventListener('change', (event) => {
  MaweMarkerEditing.setEditingEnabled(event.target.checked);
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
MaweMarkerEditing.applyMarkerEditingEnabled();
