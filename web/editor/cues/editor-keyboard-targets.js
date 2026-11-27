import { MaweBoot } from '../boot/editor-boot.js';
import { MaweCoreState } from '../state/editor-core-state.js';
import { MaweMultiSubtitleCore } from '../state/editor-multi-subtitle-core.js';
import { MaweSelection } from './editor-selection.js';
import { interruptCueListFollowing, scrollCueIntoViewIfNeeded } from './editor-cue-list-anchor.js';
let MaweKeyboardTargets;
import { getCurrentCuePanelTarget } from './editor-cue-panel.js';
import { isHiddenDisabled, selectOnly, selectOnlyExtension } from './editor-selection.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';

// 键盘目标判定：输入焦点守卫、播放目标与字幕重叠查找。
export function initMaweKeyboardTargets() {
  function isSpaceKey(e) {
    return e.key === ' ' || e.code === 'Space';
  }

  const TEXT_INPUT_TYPES = new Set([
    'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  ]);

  function isPlayerKeyboardTarget(event) {
    return event.target === MaweCoreState.player
      || document.activeElement === MaweCoreState.player
      || event.composedPath?.().includes(MaweCoreState.player);
  }

  function isTextEditingTarget(event) {
    const target = event.target;
    const active = /** @type {HTMLElement} */ (document.activeElement);
    if (target?.isContentEditable || active?.isContentEditable) return true;
    if (target instanceof HTMLTextAreaElement || active instanceof HTMLTextAreaElement) return true;

    const input = target instanceof HTMLInputElement
      ? target
      : active instanceof HTMLInputElement ? active : null;
    if (!input) return false;
    return TEXT_INPUT_TYPES.has(input.type);
  }

  function isPlaybackKeyboardTarget(event) {
    const target = event.target;
    if (target instanceof Element && target.closest('#audio-processing-panel')) return false;
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
    const active = /** @type {HTMLElement} */ (document.activeElement);
    if (surface?.contains(active) || trigger?.contains(active)) active?.blur?.();
  }

  function subtitleTemporalOverlap(left, right) {
    if (!left || !right) return 0;
    return Math.max(0, Math.min(Number(left.end), Number(right.end))
      - Math.max(Number(left.start), Number(right.start)));
  }

  function nearestSubtitleIndex(segments, source, track = 'main') {
    const candidates = (segments || [])
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment, index }) => segment && !isHiddenDisabled(index, track));
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
    const current = getCurrentCuePanelTarget();
    if (!current) return false;
    const wantMain = direction < 0;
    if ((wantMain && current.kind === 'main') || (!wantMain && current.kind === 'extension')) return false;

    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    let nextIndex = -1;
    if (wantMain) {
      const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(current.index, current.track);
      nextIndex = boundSegmentIndex(binding, (binding?.source?.segment_id ? [binding.source.segment_id] : []), AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments);
      if (nextIndex < 0) nextIndex = nearestSubtitleIndex(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, current.segment, 'main');
    } else {
      const binding = MaweMultiSubtitleCore.bindingForMainIndex(current.index);
      const bindingTrack = binding ? MaweMultiSubtitleCore.getExtensionTrack(binding.target?.track_id) : null;
      if (bindingTrack?.id === extensionTrack?.id) {
        nextIndex = boundSegmentIndex(binding, (binding?.target?.segment_id ? [binding.target.segment_id] : []), extensionTrack.segments);
      }
      if (nextIndex < 0) {
        nextIndex = nearestSubtitleIndex(extensionTrack?.segments, current.segment, 'extension');
      }
    }
if (nextIndex < 0) return false;

interruptCueListFollowing();
if (wantMain) {
selectOnly(nextIndex);
MaweSelection.lastClickedIdx = nextIndex;
    } else {
      selectOnlyExtension(nextIndex, extensionTrack);
      MaweSelection.lastClickedExtensionIdx = nextIndex;
    }
    const cue = MaweCoreState.container.querySelector(
      wantMain
        ? `.cue[data-idx="${nextIndex}"], .multi-dual-cue[data-main-idx="${nextIndex}"]`
        : `.multi-dual-cue[data-ext-idx="${nextIndex}"], .multi-extension-cue[data-ext-idx="${nextIndex}"]`,
    );
    if (cue) scrollCueIntoViewIfNeeded(cue);
    return true;
  }

  MaweKeyboardTargets = Object.freeze({
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
}

export function isSpaceKey(...args) { return MaweKeyboardTargets.isSpaceKey(...args); }
export function isPlayerKeyboardTarget(...args) { return MaweKeyboardTargets.isPlayerKeyboardTarget(...args); }
export function isTextEditingTarget(...args) { return MaweKeyboardTargets.isTextEditingTarget(...args); }
export function isPlaybackKeyboardTarget(...args) { return MaweKeyboardTargets.isPlaybackKeyboardTarget(...args); }
export function isNativeKeyboardControl(...args) { return MaweKeyboardTargets.isNativeKeyboardControl(...args); }
export function releaseClosedUiFocus(...args) { return MaweKeyboardTargets.releaseClosedUiFocus(...args); }
export function subtitleTemporalOverlap(...args) { return MaweKeyboardTargets.subtitleTemporalOverlap(...args); }
export function nearestSubtitleIndex(...args) { return MaweKeyboardTargets.nearestSubtitleIndex(...args); }
export function boundSegmentIndex(...args) { return MaweKeyboardTargets.boundSegmentIndex(...args); }
export function switchMultiSubtitleTrack(...args) { return MaweKeyboardTargets.switchMultiSubtitleTrack(...args); }
