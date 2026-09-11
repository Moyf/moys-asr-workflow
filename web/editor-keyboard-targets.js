// 键盘目标判定：输入焦点守卫、播放目标与字幕重叠查找。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweKeyboardTargets 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweKeyboardTargets(global) {
  'use strict';



  function renderedCueBoundaryTarget(target, boundary) {
    const selector = target?.kind === 'extension'
      ? '.multi-dual-cue[data-ext-idx], .multi-extension-cue[data-ext-idx]'
      : '.cue[data-idx], .multi-dual-cue[data-main-idx]';
    const track = target?.kind === 'extension' ? target.track : 'main';
    const indexes = [...MaweCoreState.container.querySelectorAll(selector)]
      .filter((cue) => !cue.classList.contains('hidden'))
      .map((cue) => Number(target?.kind === 'extension'
        ? cue.dataset.extIdx
        : cue.dataset.idx ?? cue.dataset.mainIdx))
      .filter((index, position, values) => (
        Number.isInteger(index)
        && !isHiddenDisabled(index, track)
        && values.indexOf(index) === position
      ));
    const index = boundary === 'first' ? indexes[0] : indexes[indexes.length - 1];
    if (!Number.isInteger(index)) return null;
    const cue = MaweCoreState.container.querySelector(
      target?.kind === 'extension'
        ? `.multi-dual-cue[data-ext-idx="${index}"], .multi-extension-cue[data-ext-idx="${index}"]`
        : `.cue[data-idx="${index}"], .multi-dual-cue[data-main-idx="${index}"]`,
    );
    return cue ? { cue, index } : null;
  }



  function navigateCueListBoundary(key) {
    const target = getCurrentCuePanelTarget();
    if (!target) return false;
    const boundary = renderedCueBoundaryTarget(target, key === 'Home' ? 'first' : 'last');
    if (!boundary) return false;
    if (target.kind === 'extension') {
      selectOnlyExtension(boundary.index, target.track);
      lastClickedExtensionIdx = boundary.index;
    } else {
      selectOnly(boundary.index);
      lastClickedIdx = boundary.index;
    }
    scrollCueToCenter(boundary.cue);
    return true;
  }



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
    const active = document.activeElement;
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
    return isPlayerKeyboardTarget(event)
      || (target instanceof Element && Boolean(target.closest('#media-controls, .player-stage')));
  }



  function isNativeKeyboardControl(event) {
    const target = event.target instanceof Element ? event.target : document.activeElement;
    return Boolean(target?.closest?.('button, input, select, textarea, a'));
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
      nextIndex = boundSegmentIndex(binding, binding?.main_segment_ids, DATA.segments);
      if (nextIndex < 0) nextIndex = nearestSubtitleIndex(DATA.segments, current.segment, 'main');
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

    if (wantMain) {
      selectOnly(nextIndex);
      lastClickedIdx = nextIndex;
    } else {
      selectOnlyExtension(nextIndex, extensionTrack);
      lastClickedExtensionIdx = nextIndex;
    }
    const cue = MaweCoreState.container.querySelector(
      wantMain
        ? `.cue[data-idx="${nextIndex}"], .multi-dual-cue[data-main-idx="${nextIndex}"]`
        : `.multi-dual-cue[data-ext-idx="${nextIndex}"], .multi-extension-cue[data-ext-idx="${nextIndex}"]`,
    );
    if (cue) scrollCueIntoViewIfNeeded(cue);
    return true;
  }

  global.MaweKeyboardTargets = Object.freeze({
    renderedCueBoundaryTarget,
    navigateCueListBoundary,
    isSpaceKey,
    TEXT_INPUT_TYPES,
    isPlayerKeyboardTarget,
    isTextEditingTarget,
    isPlaybackKeyboardTarget,
    isNativeKeyboardControl,
    subtitleTemporalOverlap,
    nearestSubtitleIndex,
    boundSegmentIndex,
    switchMultiSubtitleTrack
  });
})(typeof window !== 'undefined' ? window : globalThis);
