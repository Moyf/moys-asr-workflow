// Gap preview playback owns its boundary timer and an independent audio gate.
// The audio clock closes the gate even while the page is busy; the timer seeks
// only after the actual boundary, so retained media is never trimmed early.
(function initMaweGapPlayback(global) {
  'use strict';
  const boundPlayers = new WeakSet();
  let timer = 0, scheduledKey = '', gateScheduled = false, skipping = null, boundPlayer = null, waiting = false;

  function needsAudioGate(player = MaweCoreState.player) {
    return player === MaweCoreState.player
      && MaweGapRemoveData.getGapRemoveData(false)?.skip_playback === true
      && !global.MaweMediaPlayback?.isAuditioning
      && MaweGapRemoveData.getRemovedGapRanges().length > 0;
  }

  function clearTimer() {
    if (timer) global.clearTimeout(timer);
    timer = 0;
    scheduledKey = '';
    gateScheduled = false;
  }

  function reset() {
    clearTimer();
    skipping = null;
    waiting = false;
    global.MaweAudioProcessing?.setGapPlaybackMuted(false);
  }

  function previewed(gap) {
    const preview = MaweCuePanelState.gapPreviewRange;
    return preview && gap.start === preview.start && gap.end === preview.end;
  }

  function currentGap(player, playing = !player.paused) {
    return global.AsrGapRemoveCore.getGapPlaybackSkip(
      MaweGapRemoveData.getRemovedGapRanges(), player.currentTime * 1000,
      { skipPlayback: needsAudioGate(player), isPlaying: playing,
        previewRange: MaweCuePanelState.gapPreviewRange },
    );
  }

  function refresh(player = MaweCoreState.player) {
    return update(player, currentGap(player));
  }

  function seekPastGap(player, gap) {
    const pause = !player.paused;
    skipping = { start: gap.start, end: gap.end, resumePending: true, internalPause: pause || skipping?.internalPause };
    if (pause) player.pause();
    player.currentTime = gap.end / 1000;
  }

  function retargetPendingSeek(player) {
    if (player !== MaweCoreState.player || !player.seeking || !skipping) return;
    // Keep the play intent, but discard the previous gap and drain callback.
    skipping = skipping.resumePending ? { resumePending: true, internalPause: skipping.internalPause } : null;
  }

  function finishSeek(player) {
    const pending = skipping;
    if (player.seeking || !pending?.resumePending || pending.finishing) return;
    pending.finishing = true;
    const resume = () => {
      if (player !== MaweCoreState.player || player.seeking || skipping !== pending || !pending.resumePending) return;
      if (player.ended) {
        reset();
        return;
      }
      const gap = currentGap(player, true);
      if (gap && (gap.start !== pending.start || gap.end !== pending.end)) {
        seekPastGap(player, gap);
        return;
      }
      pending.resumePending = false;
      const promise = player.play();
      promise?.catch(() => { if (skipping === pending) reset(); });
      refresh(player);
    };
    const drained = global.MaweAudioProcessing?.waitForGapPlaybackSilence?.();
    if (drained) drained.then(resume, () => { if (skipping === pending) reset(); });
    else resume();
  }

  function cancelPendingPlayback() {
    if (!skipping?.resumePending) return false;
    reset();
    return true;
  }

  function update(player, gap) {
    if (player !== MaweCoreState.player) return false;
    if (skipping?.resumePending) return true;
    if (player.paused || player.ended || !needsAudioGate(player)) {
      reset();
      return false;
    }
    const rate = Number(player.playbackRate) || 1;
    const now = Number(player.currentTime) * 1000;
    if (gap) {
      clearTimer();
      global.MaweAudioProcessing?.setGapPlaybackMuted(true);
      if (player.seeking) return true;
      const same = skipping && skipping.start === gap.start && skipping.end === gap.end;
      if (!same) {
        seekPastGap(player, gap);
      } else {
        // A quantized seek may land just inside the gap. Let the clock leave it
        // under the closed gate instead of interrupting that seek every frame.
        timer = global.setTimeout(() => refresh(player), Math.max(1, (gap.end - now) / rate));
      }
      return true;
    }
    // During our async seek currentTime already reports its destination.
    if (player.seeking && skipping) return true;
    skipping = null;
    if (waiting) {
      clearTimer();
      global.MaweAudioProcessing?.setGapPlaybackMuted(false);
      return false;
    }
    const next = MaweGapRemoveData.getRemovedGapRanges().find(range => range.start > now && !previewed(range));
    const key = next ? `${next.start}:${next.end}:${rate}` : '';
    if (scheduledKey && scheduledKey === key) {
      if (!gateScheduled) gateScheduled = global.MaweAudioProcessing?.scheduleGapPlaybackMute((next.start - now) / 1000 / rate) === true;
      return false;
    }
    clearTimer();
    global.MaweAudioProcessing?.setGapPlaybackMuted(false);
    if (!next || rate <= 0) return false;
    scheduledKey = key;
    gateScheduled = global.MaweAudioProcessing?.scheduleGapPlaybackMute((next.start - now) / 1000 / rate) === true;
    timer = global.setTimeout(() => {
      timer = 0;
      scheduledKey = '';
      refresh(player);
    }, Math.max(1, (next.start - now) / rate));
    return false;
  }

  function beforePlay(player) {
    if (player !== MaweCoreState.player || !needsAudioGate(player)) return;
    const gap = currentGap(player, true);
    if (!gap || player.seeking) return;
    clearTimer();
    skipping = { start: gap.start, end: gap.end };
    global.MaweAudioProcessing?.setGapPlaybackMuted(true);
    player.currentTime = gap.end / 1000;
  }

  function bindPlayer(player) {
    if (player === MaweCoreState.player && boundPlayer !== player) {
      reset();
      boundPlayer = player;
    }
    if (!player || boundPlayers.has(player)) return;
    boundPlayers.add(player);
    for (const name of ['play', 'playing', 'seeked', 'ratechange']) {
      player.addEventListener(name, () => {
        if (player !== MaweCoreState.player) return;
        if (name === 'playing') waiting = false;
        if (name === 'seeked') finishSeek(player);
        refresh(player);
      });
    }
    player.addEventListener('waiting', () => {
      if (player !== MaweCoreState.player) return;
      waiting = true;
      clearTimer();
      if (!skipping) global.MaweAudioProcessing?.setGapPlaybackMuted(false);
    });
    player.addEventListener('seeking', () => {
      if (player !== MaweCoreState.player) return;
      if (skipping?.finishing) retargetPendingSeek(player);
      clearTimer();
      if (!skipping) global.MaweAudioProcessing?.setGapPlaybackMuted(false);
      refresh(player);
    });
    for (const name of ['pause', 'ended', 'emptied', 'loadstart']) {
      player.addEventListener(name, () => {
        if (player !== MaweCoreState.player) return;
        if (name === 'pause' && skipping?.internalPause) { skipping.internalPause = false; return; }
        reset();
      });
    }
  }

  global.MaweState?.observeProjectLoad(reset);
  global.MaweGapPlayback = Object.freeze({ needsAudioGate, beforePlay, bindPlayer, update, refresh, reset, cancelPendingPlayback, retargetPendingSeek,
    get pendingPlayback() { return skipping?.resumePending === true; } });
})(typeof window !== 'undefined' ? window : globalThis);
