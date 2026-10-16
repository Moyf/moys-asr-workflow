import { freezeFacade } from '../state/editor-facade-utils.js';
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


// === 打开工程 ===
const openProjectFileInput = document.getElementById('open-project-file');

const loadMediaFileInput = document.getElementById('load-media-file');

const loadSrtFileInput = document.getElementById('load-srt-file');

const loadLrcFileInput = document.getElementById('load-lrc-file');

let currentMediaBlobUrl = null;

  // 跟踪 blob URL，便于切换时 revoke 防泄漏
let pendingProjectMediaSelection = null;


import { MaweDom } from "../ui/editor-dom.js";function closeProjectMediaModal(clearPending = false) {
  MaweDom.projectMediaModal.classList.remove('show');
  if (clearPending) pendingProjectMediaSelection = null;
  setTimeout(() => window.MAWE_ONBOARDING?.scheduleStart(), 0);
}

function showProjectMediaModal() {
  MaweDom.projectMediaModal.classList.add('show');
  MaweDom.projectMediaSelectButton.focus();
}

window.MaweProjectMediaInputs = Object.freeze({
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

export const MaweProjectMediaInputs = freezeFacade({
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
  }, ["currentMediaBlobUrl", "pendingProjectMediaSelection"]);
window.MaweProjectMediaInputs = MaweProjectMediaInputs;

// 供已迁移消费者经 import 写待选媒体（语义与 facade set pendingProjectMediaSelection 一致）。
export function setPendingProjectMediaSelection(value) { pendingProjectMediaSelection = value; }
