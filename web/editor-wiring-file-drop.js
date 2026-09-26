// === Drag & Drop：拖入视频/音频/JSON/SRT 自动加载 ===




  // dragenter/leave 计数，避免子元素进出导致遮罩闪烁
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  MaweDragDrop.dragCounter++;
  if (MaweDragDrop.dragCounter === 1) MaweDragDrop.dragOverlay.classList.add('show');
});
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer) return;
  MaweDragDrop.dragCounter--;
  if (MaweDragDrop.dragCounter <= 0) { MaweDragDrop.dragCounter = 0; MaweDragDrop.dragOverlay.classList.remove('show'); }
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  MaweDragDrop.dragCounter = 0;
  MaweDragDrop.dragOverlay.classList.remove('show');
  void MaweDragDrop.handleDroppedFiles(Array.from(e.dataTransfer.files));
});
