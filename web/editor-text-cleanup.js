// 文本清理与 seek：标点规整、分组时间同步、媒体 seek 助手。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweTextCleanup 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweTextCleanup(global) {
  'use strict';



  // === cleanPunctuation ===
  function cleanPunctuation() {
    const PUNCT_REPL = '  ';
    const REPLACE_INSIDE = /[，。]/g;
    for (const seg of MaweBoot.DATA.segments) {
      if (!seg.text) continue;
      let t = seg.text;
      while (t.length && (t.endsWith('，') || t.endsWith('。'))) t = t.slice(0, -1);
      seg.text = t.replace(REPLACE_INSIDE, PUNCT_REPL).replace(/[ \t]+$/, '');
      if (seg.items) {
        const total = seg.items.length;
        for (let i = 0; i < total; i++) {
          let it = seg.items[i].text;
          if (i === total - 1) {
            while (it.length && (it.endsWith('，') || it.endsWith('。'))) it = it.slice(0, -1);
          }
          it = it.replace(REPLACE_INSIDE, PUNCT_REPL);
          seg.items[i].text = it;
        }
      }
    }
  }



  function syncTimelineGroupRanges() {
    function sync(headField, refField) {
      MaweBoot.DATA.segments.forEach((segment, headIdx) => {
        const head = segment[headField];
        if (!head) return;
        let end = segment.end;
        MaweBoot.DATA.segments.forEach((candidate) => {
          if (candidate[refField]?.headIdx === headIdx) end = Math.max(end, candidate.end);
        });
        head.start = segment.start;
        head.end = end;
      });
    }
    sync('sticker', 'sticker_ref');
    sync('color', 'color_ref');
  }



  function seekFromWaveform(timeSec, { dragPreview = false } = {}) {
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
    cleanPunctuation,
    syncTimelineGroupRanges,
    seekFromWaveform,
    notifyAutoLoadedMediaReady,
    flushPendingMediaSeek
  });
})(typeof window !== 'undefined' ? window : globalThis);
