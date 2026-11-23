import { isPlaybackActive } from '../media/editor-media-playback.js';
import { showOverlayContextMenu } from '../ui/editor-context-menus.js';
import { getOverlayTrack } from './overlay-track.js';
import { selectOverlayCueRow, selectOverlayRange, toggleOverlaySelection } from './editor-overlay-cue-selection.js';

export function buildOverlayCueEl(seg, index) {
  const el = MaweCueElements.buildCueEl(seg, index, { overlayTrack: true });
  el.classList.add('overlay-track-cue');
  el.dataset.overlayIdx = String(index);
  el.removeAttribute('data-idx');
  el.classList.toggle('selected', MaweState.selection.indices('overlay').has(index));
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.shiftKey && MaweState.selection.overlayAnchor >= 0) {
      selectOverlayRange(MaweState.selection.overlayAnchor, index);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      toggleOverlaySelection(index);
      return;
    }
    selectOverlayCueRow(index);
    const segment = getOverlayTrack()?.segments?.[index];
    if (!segment) return;
    const previousSuppress = MawePlaybackLoop.suppressCueListAutoScroll;
    // 与副字幕一致：点击后的 seek 会同步刷新主字幕 active 状态；这次刷新不能把
    // 列表从刚点击的叠加字幕行再次滚到对应的主字幕行。
    const wasPlaying = isPlaybackActive();
    MawePlaybackLoop.suppressCueListAutoScroll = true;
    try {
      MaweCoreState.waveformEditor?.revealTime(segment.start, true);
      if (MaweSettings.EDITOR_SETTINGS.clickBehavior !== 'select-only') {
        MaweTextCleanup.seekFromWaveform(segment.start / 1000, { mouseClick: true });
      }
    } finally {
      MawePlaybackLoop.suppressCueListAutoScroll = previousSuppress;
    }
    if (MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-and-play' && MaweCoreState.player.paused && !wasPlaying) MaweMediaPlayback.togglePlayback();
    if (MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick) {
      const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`);
      if (row) MaweCueListAnchor.scrollCueToCenter(row);
    }
  });
  el.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectOverlayCueRow(index, { focusEditor: true });
  });
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showOverlayContextMenu(event.clientX, event.clientY, index);
  });
  return el;
}
