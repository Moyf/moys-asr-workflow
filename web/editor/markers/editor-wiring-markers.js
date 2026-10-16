

// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。
'use strict';
import { MaweMarkerEditing } from "./editor-marker-editing.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweInlineEdit } from "../cues/editor-inline-edit.js";
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
