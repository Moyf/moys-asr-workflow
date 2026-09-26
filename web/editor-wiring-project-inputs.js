// === 打开工程 ===



  // 跟踪 blob URL，便于切换时 revoke 防泄漏






MaweDom.projectMediaSelectButton.addEventListener('click', () => {
  MaweProjectMediaInputs.closeProjectMediaModal(false);
  MaweProjectMediaInputs.loadMediaFileInput.value = '';
  MaweProjectMediaInputs.loadMediaFileInput.click();
});

MaweDom.projectMediaLaterButton.addEventListener('click', () => {
  MaweProjectMediaInputs.closeProjectMediaModal(true);
  MaweHint.flashHint('可稍后点击“加载媒体”选择关联媒体', 'invalid');
});

MaweDom.projectMediaModal.addEventListener('click', (event) => {
  if (event.target === MaweDom.projectMediaModal) MaweDom.projectMediaLaterButton.click();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.projectMediaModal.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDom.projectMediaLaterButton.click();
}, true);











// 新建工程：浏览器原生保存对话框选择位置，页面持有句柄持续写回。
// 不再经过服务器 helper；服务器绑定的旧工程在创建成功后解除保存，避免串写。


// 浏览器自行管理的工程（句柄或下载创建）不能再写回服务器绑定的旧工程文件，
// 便携表情包 OTIO 也随之退回引用原始素材（服务器已不跟踪当前工程）。
















































document.getElementById('new-project')?.addEventListener('click', async () => {
  if (MaweServerSave.hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定新建工程？将丢失未保存内容。')) return;
  await MaweProjectLoad.createProjectCheckpoint(MaweProjectLoad.buildBlankProject(), MaweProjectLoad.suggestedProjectName());
});

document.getElementById('open-project')?.addEventListener('click', () => {
  if (MaweServerSave.hasUnsavedProjectChanges()) {
    if (!confirm('当前有未保存的改动，是否确定打开新工程？将丢失未保存内容。')) return;
  }
  MaweProjectMediaInputs.openProjectFileInput.value = '';
  MaweProjectMediaInputs.openProjectFileInput.click();
});

MaweProjectMediaInputs.openProjectFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !MaweDragDrop.isJsonFile(file)) {
    MaweHint.flashHint('请选择一个 .mosp 或 .json 工程文件。', 'invalid');
    return;
  }
  await MaweMultiImport.openProjectFile(file);
});

