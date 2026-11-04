// 工程与媒体文件输入：input 元素、Blob URL 与媒体选择弹窗。
// ESM init 模块：initMaweProjectMediaInputs 在原清单位次执行原 IIFE 体（挂
// window.MaweProjectMediaInputs 冻结门面——classic 侧出接口）；底部具名导出经门面
// 在调用时转发，兄弟模块可静态 import。
export function initMaweProjectMediaInputs() {
(function initMaweProjectMediaInputs(global) {
  'use strict';



  // === 打开工程 ===
  const openProjectFileInput = document.getElementById('open-project-file');


  const loadMediaFileInput = document.getElementById('load-media-file');


  const loadSrtFileInput = document.getElementById('load-srt-file');


  const loadLrcFileInput = document.getElementById('load-lrc-file');


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
    loadLrcFileInput,
    get currentMediaBlobUrl() { return currentMediaBlobUrl; },
    set currentMediaBlobUrl(v) { currentMediaBlobUrl = v; },
    get pendingProjectMediaSelection() { return pendingProjectMediaSelection; },
    set pendingProjectMediaSelection(v) { pendingProjectMediaSelection = v; },
    closeProjectMediaModal,
    showProjectMediaModal
  });
})(typeof window !== 'undefined' ? window : globalThis);
}

export function loadSrtFileInput(...args) { return window.MaweProjectMediaInputs.loadSrtFileInput(...args); }
export function loadMediaFileInput(...args) { return window.MaweProjectMediaInputs.loadMediaFileInput(...args); }
export function openProjectFileInput(...args) { return window.MaweProjectMediaInputs.openProjectFileInput(...args); }
export function loadLrcFileInput(...args) { return window.MaweProjectMediaInputs.loadLrcFileInput(...args); }
export function closeProjectMediaModal(...args) { return window.MaweProjectMediaInputs.closeProjectMediaModal(...args); }
export function showProjectMediaModal(...args) { return window.MaweProjectMediaInputs.showProjectMediaModal(...args); }
