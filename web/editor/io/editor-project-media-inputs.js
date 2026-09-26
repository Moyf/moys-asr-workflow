// 工程与媒体文件输入：input 元素、Blob URL 与媒体选择弹窗。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweProjectMediaInputs 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweProjectMediaInputs(global) {
  'use strict';



  // === 打开工程 ===
  const openProjectFileInput = document.getElementById('open-project-file');


  const loadMediaFileInput = document.getElementById('load-media-file');


  const loadSrtFileInput = document.getElementById('load-srt-file');


  let currentMediaBlobUrl = null;

    // 跟踪 blob URL，便于切换时 revoke 防泄漏
  let pendingProjectMediaSelection = null;



  function closeProjectMediaModal(clearPending = false) {
    MaweDom.projectMediaModal.classList.remove('show');
    if (clearPending) pendingProjectMediaSelection = null;
    setTimeout(() => window.MAWE_ONBOARDING?.scheduleStart(), 0);
  }



  function showProjectMediaModal() {
    MaweDom.projectMediaModal.classList.add('show');
    MaweDom.projectMediaSelectButton.focus();
  }

  global.MaweProjectMediaInputs = Object.freeze({
    openProjectFileInput,
    loadMediaFileInput,
    loadSrtFileInput,
    get currentMediaBlobUrl() { return currentMediaBlobUrl; },
    set currentMediaBlobUrl(v) { currentMediaBlobUrl = v; },
    get pendingProjectMediaSelection() { return pendingProjectMediaSelection; },
    set pendingProjectMediaSelection(v) { pendingProjectMediaSelection = v; },
    closeProjectMediaModal,
    showProjectMediaModal
  });
})(typeof window !== 'undefined' ? window : globalThis);
