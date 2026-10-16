import { freezeFacade } from '../state/editor-facade-utils.js';
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


import { MaweCueElements } from "./editor-cue-elements.js";
import { MaweCoreState } from "../state/editor-core-state.js";
import { MaweBoot } from "../boot/editor-boot.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweMultiSubtitleCore } from "../state/editor-multi-subtitle-core.js";
import { MaweSelection } from "./editor-selection.js";
import { MaweSettings } from "../state/editor-settings.js";
import { MaweCuePanel } from "./editor-cue-panel.js";
import { MaweCommands } from "../state/editor-commands.js";
import { MaweViewUpdates } from "../state/editor-view-updates.js";
import { MaweTextCleanup } from "./editor-text-cleanup.js";
import { MaweStickerPicker } from "./editor-sticker-picker.js";
import { MaweCueListAnchor } from "./editor-cue-list-anchor.js";
import { MaweNavPreview } from "./editor-nav-preview.js";
import { MaweContextMenus } from "../ui/editor-context-menus.js";
import { MaweWordTiming } from "./editor-word-timing.js";
import { MawePlaybackLoop } from "../media/editor-playback-loop.js";
import { getMaweState } from '../state/editor-state.js';
function deferCaretPlacement(textEl, applyCaret) {
  // A new user action owns the caret, even if the native double-click repair
  // timer has not run yet. Observe capture phase before keyboard guards.
  const root = textEl.ownerDocument;
  const events = ['beforeinput', 'keydown', 'pointerdown'];
  let untouched = true;
  const cancel = () => { untouched = false; };
  events.forEach(type => root.addEventListener(type, cancel, { once: true, capture: true }));
  setTimeout(() => {
    events.forEach(type => root.removeEventListener(type, cancel, true));
    if (untouched) applyCaret();
  }, 0);
}

// === 编辑 ===

function startExtensionEdit(
  el,
  index,
  track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
  clickX,
  clickY,
  { deferCaret = false } = {},
) {
  if (!el || !track?.segments?.[index]) return;
  MaweNavPreview.hideCueSplitPreview();
  if (getMaweState().editing.editingState) finishEdit(true);
  if (getMaweState().editing.extensionEditingState) finishExtensionEdit(true);
  MaweCuePanel.setCurrentCuePanelExtensionIndex(index, track);
  const textEl = el.querySelector('.text') || el;
  const segment = track.segments[index];
  let caretCharOffset = null;
  if (typeof clickX === 'number' && typeof clickY === 'number') {
    caretCharOffset = caretCharFromPoint(textEl, clickX, clickY);
  }
  const session = {
    el, index, trackId: track.id, textEl, original: segment.text || '', caretCharOffset,
  };
  getMaweState().editing.extensionEditingState = session;
  el.classList.add('editing');
  textEl.setAttribute('contenteditable', 'plaintext-only');
  textEl.innerText = segment.text || '';
  textEl.focus();
  const applyCaret = () => {
    if (getMaweState().editing.extensionEditingState !== session) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (caretCharOffset !== null && textEl.firstChild) {
      const range = document.createRange();
      const node = textEl.firstChild;
      const pos = Math.max(0, Math.min(caretCharOffset, node.textContent.length));
      range.setStart(node, pos);
      range.setEnd(node, pos);
      selection.addRange(range);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(textEl);
    selection.addRange(range);
  };
  applyCaret();
  if (deferCaret) deferCaretPlacement(textEl, applyCaret);
}

function syncCuePanelAfterInlineEdit(kind, index, trackId = null) {
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  if (!target || target.kind !== kind || target.index !== index) return;
  if (kind === 'extension' && target.trackId !== trackId) return;
  if (MaweDom.cuePanelText && document.activeElement !== MaweDom.cuePanelText) {
    MaweDom.cuePanelText.value = target.segment?.text || '';
  }
}

function finishExtensionEdit(save) {
  if (!getMaweState().editing.extensionEditingState) return;
  const { el, index, trackId, textEl, original } = getMaweState().editing.extensionEditingState;
  const track = MaweMultiSubtitleCore.getExtensionTrack(trackId);
  const segment = track?.segments?.[index];
  textEl.removeAttribute('contenteditable');
  el.classList.remove('editing');
  if (segment && save) {
    const nextText = textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
    if (nextText !== original) {
      MaweCommands.run('编辑副字幕', () => {
        segment.text = nextText;
        segment._dirty = true;
        MaweMultiSubtitleCore.markMultiSubtitleDirty();

      });
    }
  }
  if (segment) {
    MaweCueElements.setTextHtml(textEl, segment.text || '', MaweDom.searchEl.value);
    MaweCueElements.applyCharCount(
      el.querySelector('.charcount'),
      segment.text || '',
      MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, segment),
    );
  }
  MaweCoreState.waveformEditor?.refreshExtensionCueLabel(index, trackId);
  syncCuePanelAfterInlineEdit('extension', index, trackId);
  getMaweState().editing.extensionEditingState = null;
  MaweViewUpdates.invalidate({ preview: 'refresh' });
}

function bindExtensionCueEvents(el, index, track = MaweMultiSubtitleCore.getActiveExtensionTrack(), dualRow = null) {
if (!el || !track?.segments?.[index]) return;
let pointerDown = null;
el.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || (getMaweState().editing.extensionEditingState?.el === el)) return;
  event.stopPropagation();
  if (event.altKey) {
    event.preventDefault();
    MaweStickerPicker.toggleDisabled([index], track);
    pointerDown = null;
    return;
  }
  pointerDown = { x: event.clientX, y: event.clientY };
  if (event.shiftKey && MaweSelection.lastClickedExtensionIdx >= 0) MaweSelection.selectExtensionRange(MaweSelection.lastClickedExtensionIdx, index);
  else if (event.ctrlKey || event.metaKey) MaweSelection.toggleExtensionSelection(index);
  else MaweSelection.selectOnlyExtension(index);
  MaweSelection.lastClickedExtensionIdx = index;
});
el.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!pointerDown) return;
  pointerDown = null;
  const segment = track.segments[index];
  const previousSuppress = MawePlaybackLoop.suppressCueListAutoScroll;
  // 副字幕点击后 seek 会同步刷新主字幕 active 状态；这次刷新不能把
  // 列表从刚点击的副字幕行再次滚到对应的主字幕行。
  MawePlaybackLoop.suppressCueListAutoScroll = true;
  try {
    MaweCoreState.waveformEditor?.revealTime(segment.start, true);
    if (MaweSettings.EDITOR_SETTINGS.clickBehavior !== 'select-only') {
      MaweTextCleanup.seekFromWaveform(segment.start / 1000, { mouseClick: true });
    }
  } finally {
    MawePlaybackLoop.suppressCueListAutoScroll = previousSuppress;
  }
  if (MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick) {
    const currentRow = MaweCoreState.container.querySelector(
      `.multi-dual-cue[data-ext-idx="${index}"], .multi-extension-cue[data-ext-idx="${index}"]`,
    );
    MaweCueListAnchor.scrollCueToCenter(currentRow || dualRow || el);
  }
});
el.addEventListener('pointermove', (event) => {
  event.stopPropagation();
  if (getMaweState().editing.extensionEditingState?.el === el) {
    MaweNavPreview.hideCueSplitPreview();
    return;
  }
  MaweNavPreview.cueListPointer = {
    kind: 'extension',
    idx: index,
    trackId: track.id,
    x: event.clientX,
    y: event.clientY,
  };
  MaweNavPreview.scheduleCueSplitPreview(index, event.clientX, event.clientY, 'extension', track.id);
});
el.addEventListener('pointerleave', () => {
  if (MaweNavPreview.cueListPointer?.kind === 'extension'
      && MaweNavPreview.cueListPointer.idx === index
      && MaweNavPreview.cueListPointer.trackId === track.id) {
    MaweNavPreview.cueListPointer = null;
    MaweNavPreview.hideCueSplitPreview();
  }
});
el.addEventListener('dblclick', (event) => {
  event.preventDefault();
  event.stopPropagation();
  startExtensionEdit(el, index, track, event.clientX, event.clientY, { deferCaret: true });
});
el.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  event.stopPropagation();
  MaweContextMenus.showExtensionContextMenu(event.clientX, event.clientY, index, null, track);
});
}

function startEdit(el, idx, clickX, clickY, { deferCaret = false } = {}) {
  if (getMaweState().editing.editingState) finishEdit(true);
  MaweNavPreview.hideCueSplitPreview();
  const textEl = el.querySelector('.text');
  if (!textEl) return;
  const seg = MaweBoot.DATA.segments[idx];
  let caretCharOffset = null;
  if (typeof clickX === 'number' && typeof clickY === 'number') {
    caretCharOffset = caretCharFromPoint(textEl, clickX, clickY);
  }
  const session = { el, idx, textEl, original: seg.text };
  getMaweState().editing.editingState = session;
  el.classList.add('editing');
  textEl.setAttribute('contenteditable', 'plaintext-only');
  textEl.innerText = seg.text;
  textEl.focus();
  const applyCaret = () => {
    if (getMaweState().editing.editingState !== session) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (caretCharOffset !== null && textEl.firstChild) {
      const range = document.createRange();
      const node = textEl.firstChild;
      const pos = Math.max(0, Math.min(caretCharOffset, node.textContent.length));
      range.setStart(node, pos);
      range.setEnd(node, pos);
      sel.addRange(range);
    } else {
      const range = document.createRange();
      range.selectNodeContents(textEl);
      sel.addRange(range);
    }
  };
  // 浏览器可能在 dblclick 处理器返回后执行原生的“双击选词”，覆盖刚设置的光标。
  // 延后一轮事件循环，确保双击编辑最终落在鼠标对应的字符位置。
  // 先同步放置一次光标，让编辑状态立即可见；双击原生选词可能在事件返回后
  // 覆盖它，再用下一轮事件循环恢复到鼠标位置。
  applyCaret();
  if (deferCaret) deferCaretPlacement(textEl, applyCaret);
}

function setEditingCaretOffset(offset) {
  const textEl = getMaweState().editing.editingState?.textEl;
  const node = textEl?.firstChild;
  if (!node || !Number.isFinite(offset)) return false;
  const pos = Math.max(0, Math.min(Math.round(offset), node.textContent.length));
  const range = document.createRange();
  range.setStart(node, pos);
  range.setEnd(node, pos);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function caretOffsetInText(textEl) {
  if (!textEl) return null;
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!textEl.contains(range.startContainer) && range.startContainer !== textEl) return null;
  const preRange = range.cloneRange();
  preRange.selectNodeContents(textEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

function caretInfoFromPoint(root, x, y) {
  if (!root) return null;
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (!range || (!root.contains(range.startContainer) && range.startContainer !== root)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return { offset: pre.toString().length, rect: range.getBoundingClientRect() };
}

function caretCharFromPoint(root, x, y) {
  return caretInfoFromPoint(root, x, y)?.offset ?? null;
}

function finishEdit(save) {
  if (!getMaweState().editing.editingState) return;
  const { el, idx, textEl, original } = getMaweState().editing.editingState;
  textEl.removeAttribute('contenteditable');
  el.classList.remove('editing');
  if (save) {
    const newText = textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
    if (newText !== original) {
      MaweCommands.run('编辑文本', () => {
        const segment = MaweBoot.DATA.segments[idx];
        const previousText = segment.text;
        segment.text = newText;
        segment._dirty = true;
        MaweWordTiming.syncTextChange(segment, previousText);
        el.classList.add('dirty');

      });
    }
  }
  MaweCueElements.setTextHtml(textEl, MaweBoot.DATA.segments[idx].text, MaweDom.searchEl.value);
  const cntEl = el.querySelector('.charcount');
  if (cntEl) MaweCueElements.applyCharCount(
    cntEl, MaweBoot.DATA.segments[idx].text, MaweMultiSubtitleCore.getMainSubtitleSplitMode(MaweBoot.DATA.segments[idx]),
  );
  MaweCoreState.waveformEditor?.refreshCueLabel(idx);
  syncCuePanelAfterInlineEdit('main', idx);
  getMaweState().editing.editingState = null;
  MaweViewUpdates.invalidate({ preview: 'refresh' });
}

window.MaweInlineEdit = Object.freeze({
  get editingState() { return getMaweState().editing.editingState; },
  set editingState(v) { getMaweState().editing.editingState = v; },
  get extensionEditingState() { return getMaweState().editing.extensionEditingState; },
  set extensionEditingState(v) { getMaweState().editing.extensionEditingState = v; },
  startExtensionEdit,
  syncCuePanelAfterInlineEdit,
  finishExtensionEdit,
  bindExtensionCueEvents,
  startEdit,
  setEditingCaretOffset,
  caretOffsetInText,
  caretInfoFromPoint,
  caretCharFromPoint,
  finishEdit
});

export const MaweInlineEdit = freezeFacade({
    get editingState() { return getMaweState().editing.editingState; },
    set editingState(v) { getMaweState().editing.editingState = v; },
    get extensionEditingState() { return getMaweState().editing.extensionEditingState; },
    set extensionEditingState(v) { getMaweState().editing.extensionEditingState = v; },
    startExtensionEdit,
    syncCuePanelAfterInlineEdit,
    finishExtensionEdit,
    bindExtensionCueEvents,
    startEdit,
    setEditingCaretOffset,
    caretOffsetInText,
    caretInfoFromPoint,
    caretCharFromPoint,
    finishEdit
  }, ["editingState", "extensionEditingState"]);
window.MaweInlineEdit = MaweInlineEdit;
