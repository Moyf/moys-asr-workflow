// 播放循环：活动字幕追踪、预览刷新与统一渲染帧。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MawePlaybackLoop 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMawePlaybackLoop(global) {
  'use strict';



  // === 当前行高亮 + overlay ===
  let lastActive = -1;


  // 列表点击关闭自动滚动时，避免这次 seek 的同步 active 更新再次滚动列表；
  // 播放指针拖动期间也暂时保持列表位置，避免连续 seek 触发滚动布局。
  let suppressCueListAutoScroll = false;


  let waveformPlayheadDragging = false;


  function findActiveSegmentIndex(segments, tMs, skipDisabled = false) {
    if (!Array.isArray(segments) || !segments.length || !Number.isFinite(Number(tMs))) return -1;
    let lo = 0;
    let hi = segments.length;
    const time = Number(tMs);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const start = Number(segments[mid]?.start);
      if (Number.isFinite(start) && start <= time) lo = mid + 1;
      else hi = mid;
    }
    let index = lo - 1;
    if (skipDisabled) {
      while (index >= 0 && segments[index]?.disabled) index -= 1;
    }
    return index;
  }



  function findActive(tMs) {
    // 相邻字幕共用边界时，右侧字幕的 start 优先；处于时间间隙时保留
    // 前一条字幕作为当前项，和原有列表高亮语义一致。
    return findActiveSegmentIndex(MaweBoot.DATA.segments, tMs);
  }



  function isSubtitlePreviewActive(segment, tMs) {
    if (!segment || segment.disabled) return false;
    const start = Number(segment.start);
    const end = Number(segment.end);
    return Number.isFinite(start) && Number.isFinite(end) && tMs >= start && tMs < end;
  }



  function extensionSegmentAtTime(tMs, mainIndex = -1) {
    if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return null;
    const bound = mainIndex >= 0 ? MaweMultiSubtitleCore.extensionForMainIndex(mainIndex) : null;
    if (isSubtitlePreviewActive(bound, tMs)) return bound;
    const segments = MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [];
    const index = findActiveSegmentIndex(segments, tMs, true);
    const segment = index >= 0 ? segments[index] : null;
    return isSubtitlePreviewActive(segment, tMs) ? segment : null;
  }



  function previewGapAt(index, timeMs) {
    const state = MaweGapRemoveData.getGapRemoveData(false);
    const gap = MaweGapRemoveData.getGapRemoveGaps()[index];
    if (!state?.skip_playback || !gap || gap.removed === false
        || timeMs < gap.start || timeMs >= gap.end) {
      MaweCuePanelState.gapPreviewRange = null;
      return;
    }
    MaweCuePanelState.gapPreviewRange = { start: gap.start, end: gap.end };
    MaweHint.flashHint('正在预览此空隙；播放头离开后恢复跳过');
  }



function updateActiveCue(idx) {
const changed = idx !== lastActive;
if (changed && lastActive >= 0) {
const prev = MaweCoreState.container.querySelector(`.cue[data-idx="${lastActive}"]`);
if (prev) prev.classList.remove('active');
}
if (changed && idx >= 0) {
const cur = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
if (cur) {
cur.classList.add('active');
}
}
lastActive = idx;
if (!MaweCoreState.player.paused && MaweCueListAnchor.cueListScroll.following && !MaweCueListAnchor.cueListScroll.owner
&& !MaweInlineEdit.editingState && !MaweInlineEdit.extensionEditingState && document.activeElement !== MaweDom.cuePanelText
&& !suppressCueListAutoScroll && !waveformPlayheadDragging) {
const key = MaweCueListAnchor.playbackCueListKey();
if (key !== MaweCueListAnchor.cueListScroll.playbackKey) {
MaweCueListAnchor.cueListScroll.playbackKey = key;
MaweCueListAnchor.scrollCueIntoViewIfNeeded(MaweCueListAnchor.playbackCueListElement(), { owner: 'follow' });
}
}
}



  function updatePlaybackFrame() {
    const tMs = MaweCoreState.player.currentTime * 1000;
    if (MaweCuePanelState.gapPreviewRange && (tMs < MaweCuePanelState.gapPreviewRange.start || tMs >= MaweCuePanelState.gapPreviewRange.end)) {
      MaweCuePanelState.gapPreviewRange = null;
    }
    const gapState = MaweGapRemoveData.getGapRemoveData(false);
    const skippedGap = window.AsrGapRemoveCore.getGapPlaybackSkip(
      MaweGapRemoveData.getRemovedGapRanges(),
      tMs,
      {
        skipPlayback: gapState?.skip_playback === true,
        isPlaying: !MaweCoreState.player.paused,
        previewRange: MaweCuePanelState.gapPreviewRange,
      },
    );
    if (skippedGap) {
      MaweCoreState.player.currentTime = skippedGap.end / 1000;
      return;
    }
    const nowLabel = MaweCueElements.fmtShort(tMs);
    if (MaweDom.nowEl.textContent !== nowLabel) MaweDom.nowEl.textContent = nowLabel;
    const idx = findActive(tMs);
    updateActiveCue(idx);
    refreshSubtitlePreview(tMs, idx);
    MaweCoreState.waveformEditor?.updatePlayback();
  }



  function refreshSubtitlePreview(tMs = MaweCoreState.player.currentTime * 1000, idx = findActive(tMs)) {
    // 编辑字幕文本时只刷新播放器预览，避免每输入一个字都触发字幕列表的自动滚动。
    const seg = idx >= 0 ? MaweBoot.DATA.segments[idx] : null;
    const mainVisible = !!MaweDom.overlayToggle.checked && isSubtitlePreviewActive(seg, tMs);
    const extension = extensionSegmentAtTime(tMs, idx);
    const extensionVisible = !!MaweDom.extensionOverlayToggle?.checked && !!extension;
    // 播放刷新每帧都会经过这里；只在可见状态或文字真的变化时触碰 DOM，
    // 避免连续 textContent/classList 写入触发不必要的样式和绘制工作。
    if (MaweDom.overlayTextEl.classList.contains('hidden') === mainVisible) {
      MaweDom.overlayTextEl.classList.toggle('hidden', !mainVisible);
    }
    if (MaweDom.overlayExtensionTextEl.classList.contains('hidden') === extensionVisible) {
      MaweDom.overlayExtensionTextEl.classList.toggle('hidden', !extensionVisible);
    }
    const subtitleAppearance = MaweAppearance.getSubtitleAppearance();
    const colorPreviewEnabled = subtitleAppearance.color_underline !== false;
    const colorStyle = subtitleAppearance.color_style || MaweSettings.DEFAULT_SUBTITLE_COLOR_STYLE;
    const mainSubtitleColor = subtitleAppearance.color || MaweSettings.DEFAULT_SUBTITLE_COLOR;
    const speakerLabels = MaweSpeakerLabels.getSpeakerLabelSettings();
    const mainColorName = mainVisible && seg
      ? window.AsrEditorUtils.effectiveColorName(seg, MaweBoot.DATA.segments)
      : null;
    const speakerLabel = mainVisible && speakerLabels.mapping_enabled && speakerLabels.enabled
      ? window.AsrEditorUtils.speakerLabelForSegment(
        seg, MaweBoot.DATA.segments, speakerLabels.names,
      )
      : '';
    const speakerLabelVisible = Boolean(speakerLabel && mainColorName && MaweColors.COLOR_BY_NAME[mainColorName]);
    const speakerLabelColor = speakerLabelVisible
      ? colorPreviewEnabled && colorStyle === 'stroke'
        ? mainSubtitleColor
        : MaweColors.COLOR_BY_NAME[mainColorName].value
      : '';
    const speakerLabelText = speakerLabelVisible
      ? `${speakerLabel}${speakerLabels.separator}`
      : '';
    const mainText = mainVisible ? String(seg.text || '') : '';
    const extensionText = extensionVisible ? (extension.text || '') : '';
    if (MaweDom.overlayMainSpeakerLabelEl.classList.contains('hidden') === speakerLabelVisible) {
      MaweDom.overlayMainSpeakerLabelEl.classList.toggle('hidden', !speakerLabelVisible);
    }
    if (MaweDom.overlayMainSpeakerLabelEl.textContent !== speakerLabelText) {
      MaweDom.overlayMainSpeakerLabelEl.textContent = speakerLabelText;
    }
    if (MaweDom.overlayMainSpeakerLabelEl.dataset.color !== speakerLabelColor) {
      MaweDom.overlayMainSpeakerLabelEl.dataset.color = speakerLabelColor;
      MaweDom.overlayMainSpeakerLabelEl.style.color = speakerLabelColor;
    }
    if (MaweDom.overlayMainTextNode.nodeValue !== mainText) MaweDom.overlayMainTextNode.nodeValue = mainText;
    if (extensionVisible && MaweDom.overlayExtensionTextEl.textContent !== extensionText) {
      MaweDom.overlayExtensionTextEl.textContent = extensionText;
    }
    // 预览字幕颜色：读取当前字幕的颜色快照（head/color_ref），按设置应用到
    // 预览文字颜色、下划线或描边。dataset 记录上次应用的结果，避免
    // 播放刷新每帧都写内联样式。
    let previewSegmentColor = '';
    if (mainVisible && colorPreviewEnabled && seg) {
      const colorName = window.AsrEditorUtils.effectiveColorName(seg, MaweBoot.DATA.segments);
      previewSegmentColor = colorName ? MaweColors.COLOR_BY_NAME[colorName]?.value || '' : '';
    }
    const colorUnderline = colorPreviewEnabled
      && colorStyle === 'underline'
      ? previewSegmentColor : '';
    const textColor = colorPreviewEnabled
      && colorStyle === 'text'
      && previewSegmentColor
      ? previewSegmentColor
      : mainSubtitleColor;
    const textStroke = colorPreviewEnabled
      && colorStyle === 'stroke'
      && previewSegmentColor
      ? `.125em ${previewSegmentColor}`
      : '';
    if (MaweDom.overlayTextEl.dataset.colorUnderline !== colorUnderline) {
      MaweDom.overlayTextEl.dataset.colorUnderline = colorUnderline;
      MaweDom.overlayTextEl.style.textDecorationLine = colorUnderline ? 'underline' : '';
      MaweDom.overlayTextEl.style.textDecorationColor = colorUnderline;
      MaweDom.overlayTextEl.style.textUnderlineOffset = colorUnderline ? '0.25em' : '';
    }
    if (MaweDom.overlayTextEl.dataset.colorText !== textColor) {
      MaweDom.overlayTextEl.dataset.colorText = textColor;
      MaweDom.overlayTextEl.style.color = textColor;
    }
    if (MaweDom.overlayTextEl.dataset.colorStroke !== textStroke) {
      MaweDom.overlayTextEl.dataset.colorStroke = textStroke;
      MaweDom.overlayTextEl.style.webkitTextStroke = textStroke;
      MaweDom.overlayTextEl.style.paintOrder = textStroke ? 'stroke fill' : '';
    }
    const overlayHidden = !mainVisible && !extensionVisible;
    if (MaweDom.overlayEl.classList.contains('hidden') !== overlayHidden) {
      MaweDom.overlayEl.classList.toggle('hidden', overlayHidden);
    }
    MaweStickerOverlay.renderStickerOverlay(tMs);
  }



  function update() {
    const tMs = MaweCoreState.player.currentTime * 1000;
    if (MaweCuePanelState.gapPreviewRange && (tMs < MaweCuePanelState.gapPreviewRange.start || tMs >= MaweCuePanelState.gapPreviewRange.end)) {
      MaweCuePanelState.gapPreviewRange = null;
    }
    const gapState = MaweGapRemoveData.getGapRemoveData(false);
    const skippedGap = window.AsrGapRemoveCore.getGapPlaybackSkip(
      MaweGapRemoveData.getRemovedGapRanges(),
      tMs,
      {
        skipPlayback: gapState?.skip_playback === true,
        isPlaying: !MaweCoreState.player.paused,
        previewRange: MaweCuePanelState.gapPreviewRange,
      },
    );
    if (skippedGap) {
      MaweCoreState.player.currentTime = skippedGap.end / 1000;
      return;
    }
    MaweDom.nowEl.textContent = MaweCueElements.fmtShort(tMs);
    const idx = findActive(tMs);
    updateActiveCue(idx);
    refreshSubtitlePreview(tMs, idx);
  }



  // 列表重绘或属性批量变更后的 update() 只刷新时间码与激活态，不触发播放跟随滚动。
  // renderAll 刚重建列表时，content-visibility 让视口外的行仍处于估算占位
  // 高度，updateActiveCue 量到的瞬态几何会把「活动行不在视口」误判成真，
  // 再用被污染的 offsetTop 算出错误目标平滑滚走（页面放大倍率越高、真实
  // 行高与估算差异越大越容易触发）。这些操作是否滚动、滚到哪里都应由
  // 调用方显式决定（例如拆分按来源保持原位或居中新右半段）。
  function updateWithoutCueListAutoScroll() {
    const previousSuppress = suppressCueListAutoScroll;
    suppressCueListAutoScroll = true;
    try {
      update();
    } finally {
      suppressCueListAutoScroll = previousSuppress;
    }
  }

  global.MawePlaybackLoop = Object.freeze({
    get lastActive() { return lastActive; },
    set lastActive(v) { lastActive = v; },
    get suppressCueListAutoScroll() { return suppressCueListAutoScroll; },
    set suppressCueListAutoScroll(v) { suppressCueListAutoScroll = v; },
    get waveformPlayheadDragging() { return waveformPlayheadDragging; },
    set waveformPlayheadDragging(v) { waveformPlayheadDragging = v; },
    findActiveSegmentIndex,
    findActive,
    isSubtitlePreviewActive,
    extensionSegmentAtTime,
    previewGapAt,
    updateActiveCue,
    updatePlaybackFrame,
    refreshSubtitlePreview,
    update,
    updateWithoutCueListAutoScroll
  });
})(typeof window !== 'undefined' ? window : globalThis);
