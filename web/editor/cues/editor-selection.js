import { freezeFacade } from '../state/editor-facade-utils.js';
import { syncOverlaySelectionClasses } from "./editor-wiring-cue-panel.js";
import { updateSelectionCountText } from "./editor-selection-count.js";
import { getOverlayTrack } from "./editor-wiring-overlay-transfer.js";

import { MaweCueElements } from "./editor-cue-elements.js";
import { MaweHint } from "../ui/editor-hint.js";
import { MaweCoreState } from "../state/editor-core-state.js";
import { MaweBoot } from "../boot/editor-boot.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweMultiSubtitleCore } from "../state/editor-multi-subtitle-core.js";
import { MaweSettings } from "../state/editor-settings.js";
import { MaweCuePanelState } from "../state/editor-cue-panel-state.js";
import { MaweCuePanel } from "./editor-cue-panel.js";
import { MaweNavPreview } from "./editor-nav-preview.js";
import { MaweStickerOverlay } from "../media/editor-sticker-overlay.js";
import { getMaweState } from '../state/editor-state.js';
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


//   1) sticker.rel + STICKER_ROOT  - 拼出服务器或 file:// URL
//   2) sticker.path  - 兼容老版工程
function stickerUrl(sticker) {
  if (!sticker) return '';
  if (sticker.rel) {
    if (MaweBoot.STICKER_URL_PREFIX) {
      const url = `${MaweBoot.STICKER_URL_PREFIX.replace(/\/$/, '')}/${sticker.rel.split('/').map(encodeURIComponent).join('/')}`;
      return MaweStickerOverlay.stickerAssetRevision ? `${url}?root=${MaweStickerOverlay.stickerAssetRevision}` : url;
    }
    if (!MaweBoot.STICKER_ROOT) return sticker.rel;
    let root = MaweBoot.STICKER_ROOT;
    if (root.startsWith('file://')) return root.replace(/\/+$/, '') + '/' + sticker.rel;
    let prefix = root.startsWith('/') ? 'file://' : 'file:///';
    return prefix + root.replace(/\/+$/, '') + '/' + sticker.rel;
  }
  if (sticker.path) return sticker.path;
  return '';
}

// 合成表情包文件的操作系统绝对路径（用于导出表情包 OTIO）。
function stickerAbsPath(sticker) {
  if (!sticker) return '';
  if (sticker.rel && MaweBoot.STICKER_ROOT) {
    // 去掉可能的 file:// 前缀，保留纯 OS 路径
    let root = MaweBoot.STICKER_ROOT.replace(/^file:\/+/, '');
    // POSIX: 重新加上前导 /
    if (MaweBoot.STICKER_ROOT.startsWith('file:///') && !root.startsWith('/') && !/^[A-Za-z]:/.test(root)) {
      root = '/' + root;
    }
    return root.replace(/\/+$/, '') + '/' + sticker.rel;
  }
  return sticker.path || '';
}

// 选中集 = MaweState 持有的活 Set（indices('main'/'extension')）。
// 经典脚本时代在 phase-2 体内直接初始化；转普通 ESM 后 import 求值早于
// MaweState 可用，改为首次门面读取时惰性绑定（活 Set 身份不变）。
let selectedIdxs = null;
let selectedExtensionIdxs = null;
function ensureSelectionSnapshot() {
  if (!selectedIdxs) selectedIdxs = getMaweState().selection.indices('main');
  if (!selectedExtensionIdxs) selectedExtensionIdxs = getMaweState().selection.indices('extension');
}
// 模块内读取入口：任何消费 selectedIdxs/selectedExtensionIdxs 的函数
// 先调用 ensureSelectionSnapshot()。顶层读点（IIFE 时代同语义）在启动后
// 触发，由门面访问器保证首个读点已完成绑定。


  // 用于 Shift+click 范围选

// “仅看超长”开启时，刚拆出的字幕临时绕过字数过滤；使用稳定 ID，避免 splice 后下标错位。
const temporaryVisibleSplitCueKeys = new Set();

// 右键选择「绑定到主字幕」后的等待状态。使用稳定 ID 而不是数组下标，
// 这样等待期间即使列表重绘，也不会把另一条副字幕误绑定过去。
let pendingExtensionBinding = null;

// 隐藏开关开启时，禁用项视为"不可选"（Shift 范围选 / Ctrl 切换都跳过）
/**
 * @param {number} idx
 * @param {'main'|'extension'|{segments?: any[]}|undefined} [track]
 */
function isHiddenDisabled(idx, track = 'main') {
  const segments = track === 'extension'
    ? (MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [])
    : ((track && typeof track === 'object' && track.segments) || MaweBoot.DATA.segments);
  return MaweDom.hideDisabled && !!(segments[idx] && segments[idx].disabled);
}

function cancelPendingExtensionBinding(message = '已取消绑定副字幕') {
  if (!pendingExtensionBinding) return false;
  pendingExtensionBinding = null;
  MaweHint.flashHint(message);
  return true;
}

// 逐行 querySelector 是 O(选中数 × 列表行数)：全选几千条时主线程会冻结
// 数秒（研究见 docs/logs/unversioned/2026-10-07/PERF_CUE_DRAG_RESEARCH.md）。选中数超过阈值后改为
// 单次扫描列表行并按选中集合判断；小选区仍走逐行查找（常数更小）。
const BULK_SELECTION_CLASS_SCAN_THRESHOLD = 64;

function applyMainSelectionClasses(classFn) {
ensureSelectionSnapshot();
  if (selectedIdxs.size > BULK_SELECTION_CLASS_SCAN_THRESHOLD) {
    MaweCoreState.container.querySelectorAll(':scope > .cue').forEach((el) => {
      const idx = el.dataset.idx != null ? Number(el.dataset.idx) : NaN;
      if (selectedIdxs.has(idx)) classFn(el);
    });
    return;
  }
  selectedIdxs.forEach((i) => {
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
    if (el) classFn(el);
  });
}

function clearSelection({ silent = false, commitCuePanel = true } = {}) {
ensureSelectionSnapshot();
MaweNavPreview.hideCueSplitPreview();
cancelPendingExtensionBinding();
applyMainSelectionClasses((el) => el.classList.remove('selected'));
getMaweState().selection.clear('main');
selectedExtensionIdxs.forEach((index) => {
  MaweCoreState.container.querySelectorAll(`.multi-cue[data-ext-idx="${index}"], .multi-dual-cue[data-ext-idx="${index}"]`)
    .forEach((el) => el.classList.remove('selected'));
});
getMaweState().selection.clear('extension');
getMaweState().selection.indices('overlay').forEach((index) => {
  MaweCoreState.container.querySelectorAll(`.cue[data-overlay-idx="${index}"]`)
    .forEach((el) => el.classList.remove('selected'));
});
getMaweState().selection.clear('overlay');
getMaweState().selection.overlayAnchor = -1;
MaweDom.selCountEl.textContent = '0';
if (silent) {
  // 结构编辑会马上 renderAll() 并重新选中目标；此时不必先刷新旧波形
  // 覆盖层和空面板，避免同一次操作产生两轮视觉更新。
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.resetCuePanelEditState();
  return;
}
if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
if (commitCuePanel) {
  MaweCuePanel.setCurrentCuePanelIndex(-1);
} else {
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState();
  MaweCuePanel.renderCurrentCuePanel();
}
}

function updateMultiSelectionClasses() {
  MaweCoreState.container.querySelectorAll('.multi-cue').forEach((element) => {
    const mainIndex = element.dataset.mainIdx == null ? -1 : Number(element.dataset.mainIdx);
    const extensionIndex = element.dataset.extIdx == null ? -1 : Number(element.dataset.extIdx);
    const selected = (Number.isInteger(mainIndex) && selectedIdxs.has(mainIndex))
      || (Number.isInteger(extensionIndex) && selectedExtensionIdxs.has(extensionIndex));
    element.classList.toggle('selected', selected);
  });
}

function addMainIndexToSelection(index) {
  if (!Number.isInteger(index) || !MaweBoot.DATA.segments[index] || isHiddenDisabled(index)) return;
  getMaweState().selection.add('main', index);
  const el = MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`);
  if (el) el.classList.add('selected');
}

function addExtensionIndexToSelection(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
  getMaweState().selection.add('extension', index);
}

// 联动选中只补充另一轨的选中集合，不切换当前字幕编辑区；编辑区焦点仍由用户最后点击的字幕决定。
function syncBoundSelection(kind, index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
ensureSelectionSnapshot();
  if (!MaweSettings.EDITOR_SETTINGS.selectBoundSubtitlePair || !MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (kind === 'main') {
    const binding = MaweMultiSubtitleCore.bindingForMainIndex(index);
    const activeTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const bindingTrack = binding ? (MaweMultiSubtitleCore.getExtensionTrack(binding.track_id) || activeTrack) : null;
    if (!binding || !activeTrack || bindingTrack?.id !== activeTrack.id) return;
    (binding.extension_segment_ids || []).forEach((id) => {
      const extensionIndex = activeTrack.segments.findIndex((segment) => segment?.id === id);
      if (extensionIndex >= 0) addExtensionIndexToSelection(extensionIndex, activeTrack);
    });
    return;
  }
  const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(index, track);
  if (!binding) return;
  (binding.main_segment_ids || []).forEach((id) => {
    const mainIndex = MaweBoot.DATA.segments.findIndex((segment) => segment?.id === id);
    if (mainIndex >= 0) addMainIndexToSelection(mainIndex);
  });
}

function selectOnlyExtension(
index,
track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
syncPair = true,
preserveMainSelection = false,
) {
ensureSelectionSnapshot();
if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
if (
  pendingExtensionBinding
  && track?.id === pendingExtensionBinding.trackId
  && track.segments?.[index]?.id !== pendingExtensionBinding.extensionId
) {
  cancelPendingExtensionBinding();
}
if (!preserveMainSelection) {
  // 普通点击副字幕后，最后点击的轨道成为当前绑定/编辑对象；
  // 不保留旧主字幕选区，避免 G 被误解为“替换旧主字幕的绑定”。
  MaweCuePanel.commitCuePanelEdit();
  getMaweState().selection.clear('main');
  getMaweState().selection.mainAnchor = -1;
}
getMaweState().selection.clear('extension');
getMaweState().selection.add('extension', index);
if (syncPair) syncBoundSelection('extension', index, track);
updateMultiSelectionClasses();
updateSelectionCountText();
getMaweState().selection.extensionAnchor = index;
MaweCoreState.waveformEditor?.updateSelection();
MaweCuePanel.setCurrentCuePanelExtensionIndex(index, track);
}

function toggleExtensionSelection(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
ensureSelectionSnapshot();
if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
if (selectedExtensionIdxs.has(index)) getMaweState().selection.remove('extension', index);
else {
  getMaweState().selection.add('extension', index);
  syncBoundSelection('extension', index, track);
}
updateMultiSelectionClasses();
updateSelectionCountText();
getMaweState().selection.extensionAnchor = index;
MaweCoreState.waveformEditor?.updateSelection();
MaweCuePanel.setCurrentCuePanelExtensionIndex(index, track);
}

function selectExtensionRange(a, b) {
ensureSelectionSnapshot();
const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
if (!track) return;
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('extension', b, track);
const lo = Math.min(a, b);
const hi = Math.max(a, b);
getMaweState().selection.clear('extension');
let lastSelected = -1;
for (let index = lo; index <= hi; index++) {
  if (!track.segments[index] || isHiddenDisabled(index, track)) continue;
  getMaweState().selection.add('extension', index);
  syncBoundSelection('extension', index, track);
  lastSelected = index;
}
updateMultiSelectionClasses();
updateSelectionCountText();
if (lastSelected < 0) return;
getMaweState().selection.extensionAnchor = lastSelected;
MaweCoreState.waveformEditor?.updateSelection();
MaweCuePanel.setCurrentCuePanelExtensionIndex(lastSelected, track);
}

function toggleSel(idx) {
ensureSelectionSnapshot();
if (isHiddenDisabled(idx)) return;  // 隐藏禁用项不参与选择
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', idx);
MaweNavPreview.hideCueSplitPreview();
const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
if (selectedIdxs.has(idx)) {
  getMaweState().selection.remove('main', idx);
  if (el) el.classList.remove('selected');
} else {
  getMaweState().selection.add('main', idx);
  if (el) el.classList.add('selected');
  syncBoundSelection('main', idx);
}
updateSelectionCountText();
if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
updateMultiSelectionClasses();
MaweCuePanel.setCurrentCuePanelIndex(selectedIdxs.has(idx) ? idx : (selectedIdxs.values().next().value ?? -1));
}

function selectRange(a, b) {
ensureSelectionSnapshot();
MaweNavPreview.hideCueSplitPreview();
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', b);
const lo = Math.min(a, b), hi = Math.max(a, b);
for (let i = lo; i <= hi; i++) {
  if (isHiddenDisabled(i)) continue;  // 跳过隐藏禁用项
  if (!selectedIdxs.has(i)) {
    getMaweState().selection.add('main', i);
  }
  syncBoundSelection('main', i);
}
applyMainSelectionClasses((el) => el.classList.add('selected'));
updateSelectionCountText();
if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
updateMultiSelectionClasses();
MaweCuePanel.setCurrentCuePanelIndex(selectedIdxs.has(b) ? b : (selectedIdxs.values().next().value ?? -1));
}

function selectOnly(idx, syncPair = true) {
ensureSelectionSnapshot();
MaweNavPreview.hideCueSplitPreview();
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', idx);
// 这是键盘导航的热路径：clearSelection() 会先把面板切到空状态，
// 再由下面的 setCurrentCuePanelIndex() 切回目标，导致一次按键触发
// 两次面板刷新和两次波形选区刷新。先提交一次待编辑内容，再批量
// 更新选区与面板，保持行为不变但只做一次视觉刷新。
MaweCuePanel.commitCuePanelEdit();
clearSelection({ silent: true });
getMaweState().selection.extensionAnchor = -1;
getMaweState().selection.add('main', idx);
if (syncPair) syncBoundSelection('main', idx);
const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
if (el) el.classList.add('selected');
updateSelectionCountText();
if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
updateMultiSelectionClasses();
MaweCuePanel.setCurrentCuePanelIndex(idx);
}

function addToSelection(idx) {
if (isHiddenDisabled(idx) || selectedIdxs.has(idx)) return;
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', idx);
MaweNavPreview.hideCueSplitPreview();
getMaweState().selection.add('main', idx);
syncBoundSelection('main', idx);
const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
if (el) el.classList.add('selected');
updateSelectionCountText();
if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
MaweCuePanel.setCurrentCuePanelIndex(idx);
}

function addExtensionToSelection(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
if (!track?.segments?.[index] || isHiddenDisabled(index, track) || selectedExtensionIdxs.has(index)) return;
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
getMaweState().selection.add('extension', index);
syncBoundSelection('extension', index, track);
updateMultiSelectionClasses();
updateSelectionCountText();
MaweCoreState.waveformEditor?.updateSelection();
MaweCuePanel.setCurrentCuePanelExtensionIndex(index, track);
}

// 波形框选/批量追加：语义等同对每个下标调用 addToSelection，但列表类
// 刷新、计数与面板切换只做一次，避免几千条框选时逐条全表扫描。
function addManyToSelection(idxs) {
const added = [];
(Array.isArray(idxs) ? idxs : []).forEach((idx) => {
  if (!Number.isInteger(idx) || !MaweBoot.DATA.segments[idx] || isHiddenDisabled(idx) || selectedIdxs.has(idx)) return;
  getMaweState().selection.add('main', idx);
  added.push(idx);
});
if (!added.length) return;
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', added[added.length - 1]);
MaweNavPreview.hideCueSplitPreview();
added.forEach((idx) => syncBoundSelection('main', idx));
applyMainSelectionClasses((el) => el.classList.add('selected'));
updateSelectionCountText();
if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
MaweCuePanel.setCurrentCuePanelIndex(added[added.length - 1]);
}

function addManyToExtensionSelection(idxs, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
const added = [];
(Array.isArray(idxs) ? idxs : []).forEach((index) => {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track) || selectedExtensionIdxs.has(index)) return;
  getMaweState().selection.add('extension', index);
  added.push(index);
});
if (!added.length) return;
MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('extension', added[added.length - 1], track);
added.forEach((index) => syncBoundSelection('extension', index, track));
updateMultiSelectionClasses();
updateSelectionCountText();
MaweCoreState.waveformEditor?.updateSelection();
MaweCuePanel.setCurrentCuePanelExtensionIndex(added[added.length - 1], track);
}

// 选中全部字幕（跳过「隐藏禁用项」开启时的禁用条目，与其它选择逻辑一致）。
function selectAll() {
ensureSelectionSnapshot();
MaweCuePanel.commitCuePanelEdit();
clearSelection({ silent: true });
MaweBoot.DATA.segments.forEach((_, idx) => {
  if (isHiddenDisabled(idx)) return;
  getMaweState().selection.add('main', idx);
  syncBoundSelection('main', idx);
});
applyMainSelectionClasses((el) => el.classList.add('selected'));
const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
extensionTrack?.segments.forEach((_, idx) => {
  if (isHiddenDisabled(idx, extensionTrack)) return;
  getMaweState().selection.add('extension', idx);
  syncBoundSelection('extension', idx, extensionTrack);
});
(getOverlayTrack()?.segments || []).forEach((_, idx) => {
  if (isHiddenDisabled(idx, getOverlayTrack())) return;
  getMaweState().selection.add('overlay', idx);
});
syncOverlaySelectionClasses();
updateMultiSelectionClasses();
updateSelectionCountText();
if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
const last = MaweBoot.DATA.segments.length - 1;
if (last >= 0 && selectedIdxs.has(last)) {
  MaweCuePanel.setCurrentCuePanelIndex(last);
  return;
}
const firstMain = selectedIdxs.values().next().value;
if (firstMain !== undefined) {
  MaweCuePanel.setCurrentCuePanelIndex(firstMain);
  return;
}
if (!extensionTrack) {
  MaweCuePanel.setCurrentCuePanelIndex(-1);
  return;
}
const lastExtension = extensionTrack.segments.length - 1;
if (lastExtension >= 0 && selectedExtensionIdxs.has(lastExtension)) {
  MaweCuePanel.setCurrentCuePanelExtensionIndex(lastExtension, extensionTrack);
  return;
}
const firstExtension = selectedExtensionIdxs.values().next().value;
MaweCuePanel.setCurrentCuePanelExtensionIndex(firstExtension ?? -1, extensionTrack);
}

window.MaweSelection = Object.freeze({
  stickerUrl,
  stickerAbsPath,
  get selectedIdxs() { ensureSelectionSnapshot(); return selectedIdxs; },
  get selectedExtensionIdxs() { ensureSelectionSnapshot(); return selectedExtensionIdxs; },
  get lastClickedIdx() { return getMaweState().selection.mainAnchor; },
  set lastClickedIdx(v) { getMaweState().selection.mainAnchor = v; },
  get lastClickedExtensionIdx() { return getMaweState().selection.extensionAnchor; },
  set lastClickedExtensionIdx(v) { getMaweState().selection.extensionAnchor = v; },
  temporaryVisibleSplitCueKeys,
  get pendingExtensionBinding() { return pendingExtensionBinding; },
  set pendingExtensionBinding(v) { pendingExtensionBinding = v; },
  isHiddenDisabled,
  cancelPendingExtensionBinding,
  clearSelection,
  updateMultiSelectionClasses,
  addMainIndexToSelection,
  addExtensionIndexToSelection,
  syncBoundSelection,
  selectOnlyExtension,
  toggleExtensionSelection,
  selectExtensionRange,
  toggleSel,
  selectRange,
  selectOnly,
  addToSelection,
  addManyToSelection,
  addExtensionToSelection,
  addManyToExtensionSelection,
  selectAll
});

export const MaweSelection = freezeFacade({
    stickerUrl,
    stickerAbsPath,
    get selectedIdxs() { ensureSelectionSnapshot(); return selectedIdxs; },
    get selectedExtensionIdxs() { ensureSelectionSnapshot(); return selectedExtensionIdxs; },
    get lastClickedIdx() { return getMaweState().selection.mainAnchor; },
    set lastClickedIdx(v) { getMaweState().selection.mainAnchor = v; },
    get lastClickedExtensionIdx() { return getMaweState().selection.extensionAnchor; },
    set lastClickedExtensionIdx(v) { getMaweState().selection.extensionAnchor = v; },
    temporaryVisibleSplitCueKeys,
    get pendingExtensionBinding() { return pendingExtensionBinding; },
    set pendingExtensionBinding(v) { pendingExtensionBinding = v; },
    isHiddenDisabled,
    cancelPendingExtensionBinding,
    clearSelection,
    updateMultiSelectionClasses,
    addMainIndexToSelection,
    addExtensionIndexToSelection,
    syncBoundSelection,
    selectOnlyExtension,
    toggleExtensionSelection,
    selectExtensionRange,
    toggleSel,
    selectRange,
    selectOnly,
    addToSelection,
    addManyToSelection,
    addExtensionToSelection,
    addManyToExtensionSelection,
    selectAll
  }, ["lastClickedIdx", "lastClickedExtensionIdx", "pendingExtensionBinding"]);
window.MaweSelection = MaweSelection;
