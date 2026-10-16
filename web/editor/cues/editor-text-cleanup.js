import { getOverlayTrack } from "./editor-wiring-overlay-transfer.js";
import { pausePlaybackAfterMouseClick } from "../media/editor-wiring-keyboard-guards.js";

import { MawePlaybackLoop } from "../media/editor-playback-loop.js";
import { MaweHint } from "../ui/editor-hint.js";
import { MaweCoreState } from "../state/editor-core-state.js";
import { MaweBoot } from "../boot/editor-boot.js";
import { MaweProjectSave } from "../io/editor-project-save.js";
import { MaweNavPreview } from "./editor-nav-preview.js";
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


// === cleanPunctuation ===
function cleanPunctuation() {
  if (MaweBoot.DATA.preserve_punctuation === true) return;
  const PUNCT_REPL = '  ';
  const REPLACE_INSIDE = /[，。]/g;
  for (const seg of MaweBoot.DATA.segments) {
    if (!seg.text) continue;
    // This built-in normalization changes source text/items together. Migrate
    // only previously exact local scopes; ordinary user edits remain invalid.
    const aiRanges = MaweBoot.DATA.gap_remove?.provenance?.sources?.ai_cleanup;
    const validScopes = (Array.isArray(aiRanges) ? aiRanges : [])
      .filter((range) => window.AsrGapRemoveCore.getCleanupScopeItems(seg, range).length);
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
    for (const range of validScopes) {
      const scope = range.cleanup_scope;
      scope.text = seg.items.slice(scope.item_start, scope.item_end).map((item) => item.text).join('');
    }
  }
}

function syncTimelineGroupRanges() {
function sync(segments, headField, refField) {
  segments.forEach((segment, headIdx) => {
    const head = segment[headField];
    if (!head) return;
    let end = segment.end;
    segments.forEach((candidate) => {
      if (candidate[refField]?.headIdx === headIdx) end = Math.max(end, candidate.end);
    });
    head.start = segment.start;
    head.end = end;
  });
}
sync(MaweBoot.DATA.segments, 'sticker', 'sticker_ref');
sync(MaweBoot.DATA.segments, 'color', 'color_ref');
// 叠加轨自持 head 的范围随段拖动自动归位：换轨瞬间物化的颜色快照
// 记录的是当时的位置，以 onCommitEdit 的这次同步为准。
const overlay = getOverlayTrack();
if (overlay?.segments?.length) {
  sync(overlay.segments, 'sticker', 'sticker_ref');
  sync(overlay.segments, 'color', 'color_ref');
}
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
  if (mouseClick) pausePlaybackAfterMouseClick();
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

window.MaweTextCleanup = Object.freeze({
  cleanPunctuation,
  syncTimelineGroupRanges,
  seekFromWaveform,
  notifyAutoLoadedMediaReady,
  flushPendingMediaSeek
});

export const MaweTextCleanup = Object.freeze({
    cleanPunctuation,
    syncTimelineGroupRanges,
    seekFromWaveform,
    notifyAutoLoadedMediaReady,
    flushPendingMediaSeek
  });
window.MaweTextCleanup = MaweTextCleanup;
