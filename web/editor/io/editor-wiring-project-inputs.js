
// === 打开工程 ===



  // 跟踪 blob URL，便于切换时 revoke 防泄漏






MaweDom.projectMediaLaterButton.addEventListener('click', () => {
  MaweProjectMediaInputs.closeProjectMediaModal(true);
  MaweHint.flashHint('可稍后点击“导入媒体”选择关联媒体', 'invalid');
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
















































// Keep the picker synchronous for user activation. Only a palette invocation
// waits for the choice and for the existing change handler to finish.
function bindFileInputAction(input, handleChange) {
  let pending = null;
  input.addEventListener('change', async event => {
    if (!pending || pending.processing) {
      await handleChange(event);
      return;
    }
    const request = pending;
    request.processing = true;
    try {
      request.resolve(await handleChange(event) === true);
    } catch (error) {
      request.reject(error);
    } finally {
      pending = null;
    }
  });
  function cancelPendingChoice() {
    if (!pending || pending.processing) return;
    const { resolve } = pending;
    pending = null;
    resolve(false);
  }
  input.addEventListener('cancel', cancelPendingChoice);

  return (waitForResult, prepare) => {
    if ((waitForResult && pending?.processing) || prepare?.() === false) return false;
    if (waitForResult && navigator.userActivation?.isActive === false) return false;
    // A new explicit choice supersedes an unanswered one; older browsers can
    // silently ignore click() without firing cancel.
    cancelPendingChoice();
    input.value = '';
    if (!waitForResult) {
      input.click();
      return;
    }
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, processing: false };
      try {
        if (typeof input.showPicker === 'function') input.showPicker();
        else input.click();
      } catch (error) {
        pending = null;
        reject(error);
      }
    });
  };
}

async function newProjectAction() {
  if (MaweServerSave.hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定新建工程？将丢失未保存内容。')) return false;
  return MaweProjectLoad.createProjectCheckpoint(MaweProjectLoad.buildBlankProject(), MaweProjectLoad.suggestedProjectName());
}

const pickProjectFile = bindFileInputAction(MaweProjectMediaInputs.openProjectFileInput, e => {
  const file = e.target.files?.[0];
  if (!file || !MaweDragDrop.isJsonFile(file)) {
    MaweHint.flashHint('请选择一个 .mosp 或 .json 工程文件。', 'invalid');
    return false;
  }
  return MaweMultiImport.openProjectFile(file);
});

function openProjectAction(waitForResult) {
  if (launcherSessionConnection && !launcherSessionRejected) {
    return MaweServerSave.openNativeProject(launcherSessionConnection);
  }
  return pickProjectFile(waitForResult, () => !MaweServerSave.hasUnsavedProjectChanges()
    || confirm('当前有未保存的改动，是否确定打开新工程？将丢失未保存内容。'));
}

document.getElementById('new-project')?.addEventListener('click', newProjectAction);
document.getElementById('open-project')?.addEventListener('click', () => { void openProjectAction(false); });
window.MaweProjectFileActions = Object.freeze({
  newProject: newProjectAction,
  openProject: () => openProjectAction(true),
});
