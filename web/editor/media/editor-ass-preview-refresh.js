const refreshService = {};

export function scheduleAssSubtitlePreviewRefresh() {
  return refreshService.schedule();
}

export function observeAssSubtitlePreviewPlayer(player) {
  return refreshService.observePlayer(player);
}

export function initMaweAssPreviewRefresh() {
  if (refreshService.schedule) return;

  let refreshFrame = 0;
  let refreshTimer = 0;
  function queueRefresh() {
    if (refreshFrame) return;
    const refresh = () => {
      refreshFrame = 0;
      if (MaweSettings.EDITOR_SETTINGS.assMode === true) MawePlaybackLoop.refreshSubtitlePreview();
    };
    if (typeof requestAnimationFrame === 'function') refreshFrame = requestAnimationFrame(refresh);
    else refresh();
  }
  function schedule() {
    if (MaweSettings.EDITOR_SETTINGS.assMode !== true) return;
    // ResizeObserver runs after layout. Draw the overlay and Canvas together on
    // the next frame; repeated events never postpone the bounded follow-up.
    queueRefresh();
    if (!refreshTimer) {
      refreshTimer = window.setTimeout(() => {
        refreshTimer = 0;
        if (MaweSettings.EDITOR_SETTINGS.assMode === true) queueRefresh();
      }, 100);
    }
  }

  let observedPlayer = null;
  const stageObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(schedule) : null;
  function observePlayer(player) {
    if (!stageObserver || observedPlayer === player) return;
    if (observedPlayer) stageObserver.unobserve(observedPlayer);
    observedPlayer = player?.tagName === 'VIDEO' ? player : null;
    if (observedPlayer) stageObserver.observe(observedPlayer);
  }

  if (MaweDom.playerStage) stageObserver?.observe(MaweDom.playerStage);
  observePlayer(MaweCoreState.player);
  window.addEventListener('resize', schedule);
  refreshService.schedule = schedule;
  refreshService.observePlayer = observePlayer;
  window.MaweAssPreviewRefresh = Object.freeze({
    scheduleAssSubtitlePreviewRefresh,
    observeAssSubtitlePreviewPlayer,
  });
}
