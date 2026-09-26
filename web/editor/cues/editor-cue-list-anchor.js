// 列表滚动锚点：可视区bounds、锚点捕获与恢复补偿。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweCueListAnchor 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweCueListAnchor(global) {
  'use strict';



  // === 滚动 ===
  function cueListVisibleBounds() {
    const containerRect = MaweCoreState.container.getBoundingClientRect();
    const toolbar = MaweCoreState.container.querySelector(':scope > .cue-list-toolbar');
    const toolbarRect = toolbar?.getBoundingClientRect();
    const top = toolbarRect
      ? Math.min(containerRect.bottom, Math.max(containerRect.top, toolbarRect.bottom))
      : containerRect.top;
    return { containerRect, top, bottom: containerRect.bottom };
  }



  function invalidateCueListVisualAnchorRestore({ preserveLayoutAnchor = false } = {}) {
    const previousAnchor = cueListScroll.layoutAnchor;
    cueListScroll.generation += 1;
    cancelAnimationFrame(cueListScroll.frame);
    cueListScroll.frame = 0;
    cueListScroll.owner = null;
    cueListScroll.mutationAnchor = null;
    if (!preserveLayoutAnchor) cueListScroll.layoutAnchor = null;
    else queueMicrotask(() => {
      // 同一个输入事件里的新编辑可以承接尚未稳定的阅读位置；单纯点击、
      // 输入等没有启动新布局操作时，不留下可在以后重新夺权的旧锚点。
      if (!cueListScroll.owner && cueListScroll.layoutAnchor === previousAnchor) cueListScroll.layoutAnchor = null;
    });
    // 同时停止浏览器尚未完成的原生滚动动画。
    MaweCoreState.container.scrollTo({ top: MaweCoreState.container.scrollTop, behavior: 'instant' });
  }



  function captureCueListVisualAnchor(cueEl) {
    if (!cueEl?.isConnected || cueEl.classList.contains('hidden')) return null;
    const { containerRect, top, bottom } = cueListVisibleBounds();
    const rect = cueEl.getBoundingClientRect();
    if (!Number.isFinite(rect.top)) return null;
    const pending = cueListScroll.layoutAnchor;
    const pendingRow = pending && (findCueListRenderAnchor(pending)
      || findCueListRenderAnchor(pending, { replacement: true }));
    // 快速连续编辑时，下一次事务承接上一轮的目标视口，而不是把懒布局
    // 尚未补偿的中间位置当作新的基准。用户导航/滚动已在输入入口清除此值。
    const correction = pendingRow
      ? pending.top - (pendingRow.getBoundingClientRect().top - containerRect.top) : 0;
    const anchor = {
      ...cueListIdentity(cueEl), top: rect.top - containerRect.top + correction,
      scrollTop: MaweCoreState.container.scrollTop,
    };
    // 锚点被删除时，优先保持附近存活字幕自己的屏幕位置。
    anchor.neighbors = [...MaweCoreState.container.querySelectorAll(':scope > .cue:not(.hidden)')]
      .filter(element => element !== cueEl)
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(entry => entry.rect.height > 0 && entry.rect.bottom > top && entry.rect.top < bottom)
      .sort((a, b) => Math.abs(a.rect.top - rect.top) - Math.abs(b.rect.top - rect.top))
      .map(entry => ({ ...cueListIdentity(entry.element), top: entry.rect.top - containerRect.top + correction }));
    return anchor;
  }



  function captureVisibleCueListVisualAnchor(cueEl) {
    if (!cueEl?.isConnected || cueEl.classList.contains('hidden')) return null;
    const rect = cueEl.getBoundingClientRect();
    const { top, bottom } = cueListVisibleBounds();
    if (rect.bottom <= top || rect.top >= bottom) return null;
    return captureCueListVisualAnchor(cueEl);
  }



  function captureCueListRenderAnchor() {
    if (!MaweCoreState.container?.isConnected) return null;
    const pending = cueListScroll.layoutAnchor;
    const pendingRow = pending && (findCueListRenderAnchor(pending)
      || findCueListRenderAnchor(pending, { replacement: true }));
    if (pendingRow) return captureCueListVisualAnchor(pendingRow);
    const { top, bottom } = cueListVisibleBounds();
    const candidates = [...MaweCoreState.container.querySelectorAll(':scope > .cue:not(.hidden)')];
    const visible = candidates.filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > top && rect.top < bottom;
    });
    // 使用旧 DOM 的选区而不是可能已改变身份的面板下标。
    const cue = visible.find(element => element.matches('.selected, .selected-extension')
      || element.querySelector('.selected')) || visible.find(element => element.getBoundingClientRect().top >= top)
      || visible[0];
    return captureCueListVisualAnchor(cue) || { scrollTop: MaweCoreState.container.scrollTop };
  }



  function findCueListRenderAnchor(anchor, { replacement = false } = {}) {
    if (!anchor?.segmentId) return null;
    return [...MaweCoreState.container.querySelectorAll(':scope > .cue:not(.hidden)')].find(element => {
      const identity = cueListIdentity(element, anchor.kind);
      return identity.kind === anchor.kind && identity.trackId === anchor.trackId
        && (identity.segmentId === anchor.segmentId
          || (replacement && identity.start === anchor.start));
    }) || null;
  }



  function restoreCueListRenderAnchor(anchor) {
    if (!anchor) return;
    // B 的左段和 C 的首段承接原起点；撤销时同样按这一语义回到源句。
    let cue = findCueListRenderAnchor(anchor) || findCueListRenderAnchor(anchor, { replacement: true });
    let target = anchor;
    if (!cue) {
      for (const neighbor of anchor.neighbors || []) {
        cue = findCueListRenderAnchor(neighbor)
          || findCueListRenderAnchor(neighbor, { replacement: true });
        if (cue) { target = { ...anchor, ...neighbor }; break; }
      }
    }
    restoreCueListVisualAnchor(cue, target);
  }



  function restoreCueListVisualAnchor(cueEl, anchor, owner = 'restore') {
    invalidateCueListVisualAnchorRestore();
    cueListScroll.playbackKey = playbackCueListKey();
    const generation = cueListScroll.generation;
    cueListScroll.owner = owner;
    cueListScroll.layoutAnchor = owner === 'restore' ? anchor : null;
    const maxFrames = 12;
    let frameCount = 0;
    const restore = () => {
      if (generation !== cueListScroll.generation) return;
      if (cueEl?.isConnected && !cueEl.classList.contains('hidden') && Number.isFinite(anchor?.top)) {
        const { containerRect, top, bottom } = cueListVisibleBounds();
        const rect = cueEl.getBoundingClientRect();
        // 文字不得被 sticky 工具栏盖住；行顶部留白可以在工具栏下，避免
        // 把本来可读的边缘行无谓推移几个像素。内容不足时交给浏览器最小限幅。
        const paddingTop = Math.max(0, Number.parseFloat(getComputedStyle(cueEl).paddingTop) || 0);
        const targetTop = Math.max(top - containerRect.top - paddingTop,
          Math.min(anchor.top, bottom - containerRect.top - 1));
        const delta = rect.top - containerRect.top - targetTop;
        if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
          MaweCoreState.container.scrollTo({ top: MaweCoreState.container.scrollTop + delta, behavior: 'instant' });
        }
      } else if (Number.isFinite(anchor?.scrollTop)) {
        MaweCoreState.container.scrollTo({ top: anchor.scrollTop, behavior: 'instant' });
      }
      // 即使当前帧被边界限幅，也继续这个有界布局窗口。后续行高回填后
      // 滚动范围可能恢复；用户输入通过 generation 取消，而非猜测 scrollTop。
      if (cueEl?.isConnected && ++frameCount < maxFrames) cueListScroll.frame = requestAnimationFrame(restore);
      else { cueListScroll.frame = 0; cueListScroll.owner = null; cueListScroll.layoutAnchor = null; }
    };
    restore();
  }



  function scrollCueToCenter(cueEl, { owner = 'navigate' } = {}) {
    if (!cueEl || cueEl.classList.contains('hidden')) return;
    invalidateCueListVisualAnchorRestore();
    const { containerRect, top, bottom } = cueListVisibleBounds();
    const rect = cueEl.getBoundingClientRect();
    const inset = Math.min(120, Math.max(48, (bottom - top) * 0.2));
    if (rect.top >= top + inset && rect.bottom <= bottom - inset) return;
    restoreCueListVisualAnchor(cueEl, {
      top: top - containerRect.top + Math.max(0, (bottom - top - rect.height) / 2),
    }, owner);
  }


  function scrollCueIntoViewIfNeeded(cueEl, options) {
    if (!cueEl || cueEl.classList.contains('hidden')) return;
    const { top, bottom } = cueListVisibleBounds();
    const rect = cueEl.getBoundingClientRect();
    if (rect.top < top || rect.bottom > bottom) scrollCueToCenter(cueEl, options);
  }



  // 三种滚动共用一个可取消的操作：布局恢复、主动导航、播放跟随。
  // scroll 事件本身不表示用户输入，懒布局和浏览器边界限制也会触发它。
  const cueListScroll = { generation: 0, frame: 0, owner: null, following: true, playbackKey: null, mutationAnchor: null, layoutAnchor: null };


  const cueListFollowButton = document.getElementById('cue-list-follow');



  function setCueListFollowing(enabled) {
    cueListScroll.following = enabled;
    cueListFollowButton?.setAttribute('aria-pressed', String(enabled));
  }



  function interruptCueListFollowing() {
    MaweCueListAnchor.invalidateCueListVisualAnchorRestore();
    setCueListFollowing(false);
  }



  function setCueListIdentity(element, segment, track = null) {
    // 身份写在渲染时的 DOM 上；splice / history 后不能再拿旧下标读新数据。
    const prefix = track ? 'ext' : 'main';
    element.dataset[`${prefix}Id`] = segment.id;
    element.dataset[`${prefix}Start`] = String(segment.start);
    if (track) element.dataset.trackId = track.id;
  }



  function cueListIdentity(element, kind = MaweCuePanelState.currentCuePanelKind) {
    const extension = (kind === 'extension' && element.dataset.extId) || !element.dataset.mainId;
    return {
      kind: extension ? 'extension' : 'main',
      segmentId: extension ? element.dataset.extId : element.dataset.mainId,
      trackId: extension ? element.dataset.trackId : null,
      start: Number(extension ? element.dataset.extStart : element.dataset.mainStart),
    };
  }



  function rememberCueListMutation() {
    const anchor = MaweCueListAnchor.captureCueListRenderAnchor();
    cueListScroll.mutationAnchor = anchor;
    // 只交给同一个同步编辑事务，未重绘的原地改字不会留下过时视口。
    queueMicrotask(() => {
      if (cueListScroll.mutationAnchor === anchor) cueListScroll.mutationAnchor = null;
    });
  }



  function playbackCueListElement() {
    if (MaweMultiSubtitleCore.multiSubtitleVisible() && MaweMultiSubtitleCore.getMultiSubtitleState().display_mode === 'extension') {
      const segment = MawePlaybackLoop.extensionSegmentAtTime(MaweCoreState.player.currentTime * 1000);
      return segment ? MaweCueListAnchor.findCueListRenderAnchor({ kind: 'extension', segmentId: segment.id,
        trackId: MaweMultiSubtitleCore.getActiveExtensionTrack()?.id }) : null;
    }
    const index = MawePlaybackLoop.findActive(MaweCoreState.player.currentTime * 1000);
    return index >= 0 ? MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`) : null;
  }



  function playbackCueListKey() {
    const element = playbackCueListElement();
    if (!element) return null;
    const identity = cueListIdentity(element,
      MaweMultiSubtitleCore.getMultiSubtitleState().display_mode === 'extension' ? 'extension' : 'main');
    return `${identity.kind}:${identity.trackId || ''}:${identity.segmentId}`;
  }



  function resumeCueListFollowing() {
    MaweCueListAnchor.invalidateCueListVisualAnchorRestore();
    setCueListFollowing(true);
    MaweCueListAnchor.scrollCueIntoViewIfNeeded(playbackCueListElement(), { owner: 'navigate' });
  }



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
        && !MaweSelection.isHiddenDisabled(index, track)
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
    const target = MaweCuePanel.getCurrentCuePanelTarget();
    if (!target) return false;
    const boundary = renderedCueBoundaryTarget(target, key === 'Home' ? 'first' : 'last');
    if (!boundary) return false;
    interruptCueListFollowing();
    if (target.kind === 'extension') {
      MaweSelection.selectOnlyExtension(boundary.index, target.track);
      MaweSelection.lastClickedExtensionIdx = boundary.index;
    } else {
      MaweSelection.selectOnly(boundary.index);
      MaweSelection.lastClickedIdx = boundary.index;
    }
    MaweCueListAnchor.scrollCueToCenter(boundary.cue);
    return true;
  }

  global.MaweCueListAnchor = Object.freeze({
    cueListScroll,
    cueListFollowButton,
    setCueListFollowing,
    interruptCueListFollowing,
    setCueListIdentity,
    cueListIdentity,
    rememberCueListMutation,
    playbackCueListElement,
    playbackCueListKey,
    resumeCueListFollowing,
    renderedCueBoundaryTarget,
    navigateCueListBoundary,
    cueListVisibleBounds,
    invalidateCueListVisualAnchorRestore,
    captureCueListVisualAnchor,
    captureVisibleCueListVisualAnchor,
    captureCueListRenderAnchor,
    findCueListRenderAnchor,
    restoreCueListRenderAnchor,
    restoreCueListVisualAnchor,
    scrollCueToCenter,
    scrollCueIntoViewIfNeeded
  });
})(typeof window !== 'undefined' ? window : globalThis);
