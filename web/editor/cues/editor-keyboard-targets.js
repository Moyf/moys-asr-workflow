// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';



import { MaweCoreState } from "../state/editor-core-state.js";
import { MaweBoot } from "../boot/editor-boot.js";
import { MaweMultiSubtitleCore } from "../state/editor-multi-subtitle-core.js";
import { MaweSelection } from "./editor-selection.js";
import { MaweCueListAnchor } from "./editor-cue-list-anchor.js";
import { MaweCuePanel } from "./editor-cue-panel.js";
import { isTextEditingTarget, TEXT_INPUT_TYPES } from "./editor-input-targets.js";
function isSpaceKey(e) {
  return e.key === ' ' || e.code === 'Space';
}

function isPlayerKeyboardTarget(event) {
  return event.target === MaweCoreState.player
    || document.activeElement === MaweCoreState.player
    || event.composedPath?.().includes(MaweCoreState.player);
}

function isPlaybackKeyboardTarget(event) {
  const target = event.target;
  return isPlayerKeyboardTarget(event)
    || (target instanceof Element && Boolean(target.closest('#media-controls, .player-stage')));
}

function isNativeKeyboardControl(event) {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  return Boolean(target?.closest?.('button, input, select, textarea, a'));
}

// Closing a tool must not leave focus in hidden controls or on its trigger:
// Space belongs to playback again. Do not steal focus from another open UI.
function releaseClosedUiFocus(surface, trigger = null) {
  const active = document.activeElement;
  if (surface?.contains(active) || trigger?.contains(active)) active?.blur?.();
}

function subtitleTemporalOverlap(left, right) {
  if (!left || !right) return 0;
  return Math.max(0, Math.min(Number(left.end), Number(right.end))
    - Math.max(Number(left.start), Number(right.start)));
}

/** @param {any[]} segments @param {any} source @param {'main'|'extension'} [track] */
function nearestSubtitleIndex(segments, source, track = 'main') {
  const candidates = (segments || [])
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment, index }) => segment && !MaweSelection.isHiddenDisabled(index, track));
  candidates.sort((left, right) => {
    const leftOverlap = subtitleTemporalOverlap(left.segment, source);
    const rightOverlap = subtitleTemporalOverlap(right.segment, source);
    const leftHasOverlap = leftOverlap > 0 ? 0 : 1;
    const rightHasOverlap = rightOverlap > 0 ? 0 : 1;
    if (leftHasOverlap !== rightHasOverlap) return leftHasOverlap - rightHasOverlap;
    if (leftOverlap !== rightOverlap) return rightOverlap - leftOverlap;
    const leftDistance = Math.abs(Number(left.segment.start) - Number(source.start));
    const rightDistance = Math.abs(Number(right.segment.start) - Number(source.start));
    return leftDistance - rightDistance || left.index - right.index;
  });
  return candidates[0]?.index ?? -1;
}

function boundSegmentIndex(binding, ids, segments) {
  for (const id of ids || []) {
    const index = (segments || []).findIndex((segment) => segment?.id === id);
    if (index >= 0) return index;
  }
  return -1;
}

function switchMultiSubtitleTrack(direction) {
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return false;
  const current = MaweCuePanel.getCurrentCuePanelTarget();
  if (!current) return false;
  const wantMain = direction < 0;
  if ((wantMain && current.kind === 'main') || (!wantMain && current.kind === 'extension')) return false;

  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  let nextIndex = -1;
  if (wantMain) {
    const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(current.index, current.track);
    nextIndex = boundSegmentIndex(binding, binding?.main_segment_ids, MaweBoot.DATA.segments);
    if (nextIndex < 0) nextIndex = nearestSubtitleIndex(MaweBoot.DATA.segments, current.segment, 'main');
  } else {
    const binding = MaweMultiSubtitleCore.bindingForMainIndex(current.index);
    const bindingTrack = binding ? MaweMultiSubtitleCore.getExtensionTrack(binding.track_id) : null;
    if (bindingTrack?.id === extensionTrack?.id) {
      nextIndex = boundSegmentIndex(binding, binding?.extension_segment_ids, extensionTrack.segments);
    }
    if (nextIndex < 0) {
      nextIndex = nearestSubtitleIndex(extensionTrack?.segments, current.segment, 'extension');
    }
  }
if (nextIndex < 0) return false;

MaweCueListAnchor.interruptCueListFollowing();
if (wantMain) {
MaweSelection.selectOnly(nextIndex);
MaweSelection.lastClickedIdx = nextIndex;
  } else {
    MaweSelection.selectOnlyExtension(nextIndex, extensionTrack);
    MaweSelection.lastClickedExtensionIdx = nextIndex;
  }
  const cue = MaweCoreState.container.querySelector(
    wantMain
      ? `.cue[data-idx="${nextIndex}"], .multi-dual-cue[data-main-idx="${nextIndex}"]`
      : `.multi-dual-cue[data-ext-idx="${nextIndex}"], .multi-extension-cue[data-ext-idx="${nextIndex}"]`,
  );
  if (cue) MaweCueListAnchor.scrollCueIntoViewIfNeeded(cue);
  return true;
}

window.MaweKeyboardTargets = Object.freeze({
  isSpaceKey,
  TEXT_INPUT_TYPES,
  isPlayerKeyboardTarget,
  isTextEditingTarget,
  isPlaybackKeyboardTarget,
  isNativeKeyboardControl,
  releaseClosedUiFocus,
  subtitleTemporalOverlap,
  nearestSubtitleIndex,
  boundSegmentIndex,
  switchMultiSubtitleTrack
});

export const MaweKeyboardTargets = Object.freeze({
    isSpaceKey,
    TEXT_INPUT_TYPES,
    isPlayerKeyboardTarget,
    isTextEditingTarget,
    isPlaybackKeyboardTarget,
    isNativeKeyboardControl,
    releaseClosedUiFocus,
    subtitleTemporalOverlap,
    nearestSubtitleIndex,
    boundSegmentIndex,
    switchMultiSubtitleTrack
  });
window.MaweKeyboardTargets = MaweKeyboardTargets;
