import { getOverlayTrack } from './overlay-track.js';

export function initMaweTextCleanup() {
'use strict';

// 文本清理与 seek：分组时间同步、媒体 seek 助手。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweTextCleanup 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweTextCleanup(global) {
  'use strict';

  // Explicit normalization remains available to callers; opening a project
  // keeps the original text and does not invoke this operation.
  function cleanPunctuation() {
    const main = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    if (main.preserve_punctuation === true) return;
    const PUNCT_REPL = '  ';
    const REPLACE_INSIDE = /[，。]/g;
    for (const seg of main.segments) {
      if (!seg.text) continue;
      const aiRanges = MaweBoot.DATA.gap_remove?.provenance?.sources?.ai_cleanup;
      const validScopes = (Array.isArray(aiRanges) ? aiRanges : [])
        .filter((range) => window.AsrGapRemoveCore.getCleanupScopeItems(seg, range).length);
      let text = seg.text;
      while (text.length && (text.endsWith('，') || text.endsWith('。'))) text = text.slice(0, -1);
      seg.text = text.replace(REPLACE_INSIDE, PUNCT_REPL).replace(/[ \t]+$/, '');
      if (seg.items) {
        const total = seg.items.length;
        for (let index = 0; index < total; index++) {
          let itemText = seg.items[index].text;
          if (index === total - 1) {
            while (itemText.length && (itemText.endsWith('，') || itemText.endsWith('。'))) itemText = itemText.slice(0, -1);
          }
          seg.items[index].text = itemText.replace(REPLACE_INSIDE, PUNCT_REPL);
        }
      }
      for (const range of validScopes) {
        const scope = range.cleanup_scope;
        scope.text = seg.items.slice(scope.item_start, scope.item_end).map((item) => item.text).join('');
      }
    }
  }



  function syncTimelineGroupRanges() {
    window.AsrEditorUtils.refreshSubtitleGroupViews(MaweBoot.DATA);
  }

  function seekFromWaveform(timeSec, { dragPreview = false, mouseClick = false } = {}) {
  const seekableEnd = MaweCoreState.player.seekable.length ? MaweCoreState.player.seekable.end(MaweCoreState.player.seekable.length - 1) : 0;
  if (seekableEnd <= 0 && !MaweNavPreview.seekWarned) {
    if (MaweCoreState.player.readyState < 1 || MaweCoreState.player.networkState === HTMLMediaElement.NETWORK_LOADING) {
      MaweNavPreview.pendingMediaSeekTimeSec = timeSec;
      return;
    }
    MaweNavPreview.seekWarned = true;
    MaweHint.flashHint('媒体尚不可 seek；请等待加载完成或用 file:// 直接打开 HTML', 'warning');
  }
  try {
    MaweCoreState.player.currentTime = Math.max(0, timeSec);
    if (mouseClick) window.MaweKeyboardGuards.pausePlaybackAfterMouseClick();
    if (!dragPreview) {
      MawePlaybackLoop.update();
      // currentTime 的 seeked/timeupdate 事件是异步触发的；先同步刷新波形，
      // 避免字幕已选中但红色播放头要等下一拍才移动。
      MaweCoreState.waveformEditor?.updatePlayback();
    }
  } catch (error) {
    MaweHint.flashHint(`跳转失败：${error.message}`, 'warning');
  }
}



  function notifyAutoLoadedMediaReady(mediaElement) {
    if (mediaElement !== MaweCoreState.player || MaweNavPreview.autoLoadedMediaReadyNotified || !MaweBoot.SERVER_CONFIG?.autoLoadedMediaName) return;
    MaweNavPreview.autoLoadedMediaReadyNotified = true;
    MaweHint.flashHint(MaweProjectSave.translatedEditorText(`已加载媒体：${MaweBoot.SERVER_CONFIG.autoLoadedMediaName}`), 'success');
  }



  function flushPendingMediaSeek(mediaElement) {
    if (mediaElement !== MaweCoreState.player || MaweNavPreview.pendingMediaSeekTimeSec === null) return;
    const timeSec = MaweNavPreview.pendingMediaSeekTimeSec;
    MaweNavPreview.pendingMediaSeekTimeSec = null;
    seekFromWaveform(timeSec);
  }

  global.MaweTextCleanup = Object.freeze({
    syncTimelineGroupRanges,
    seekFromWaveform,
    notifyAutoLoadedMediaReady,
    flushPendingMediaSeek
  });
})(typeof window !== 'undefined' ? window : globalThis);
}
