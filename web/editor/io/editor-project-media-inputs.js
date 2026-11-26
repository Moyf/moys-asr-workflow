import { MaweDom } from '../ui/editor-dom.js';
import { scheduleOnboarding } from '../boot/editor-onboarding.js';
export let MaweProjectMediaInputs;
// 工程与媒体文件输入：input 元素、Blob URL 与媒体选择弹窗。
export function initMaweProjectMediaInputs() {
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
    setTimeout(() => scheduleOnboarding(), 0);
  }



  function showProjectMediaModal() {
    MaweDom.projectMediaModal.classList.add('show');
    MaweDom.projectMediaSelectButton.focus();
  }

  MaweProjectMediaInputs = Object.freeze({
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
}

export function loadSrtFileInput(...args) { return MaweProjectMediaInputs.loadSrtFileInput(...args); }
export function loadMediaFileInput(...args) { return MaweProjectMediaInputs.loadMediaFileInput(...args); }
export function openProjectFileInput(...args) { return MaweProjectMediaInputs.openProjectFileInput(...args); }
export function loadLrcFileInput(...args) { return MaweProjectMediaInputs.loadLrcFileInput(...args); }
export function closeProjectMediaModal(...args) { return MaweProjectMediaInputs.closeProjectMediaModal(...args); }
export function showProjectMediaModal(...args) { return MaweProjectMediaInputs.showProjectMediaModal(...args); }
