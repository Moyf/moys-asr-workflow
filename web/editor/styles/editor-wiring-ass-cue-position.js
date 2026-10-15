// Main-cue ASS positioning: inspector and one transaction per pointer gesture.
(function initAssCuePosition(global) {
  'use strict';
  const panel = document.getElementById('ass-cue-position');
  const xInput = document.getElementById('ass-cue-x');
  const yInput = document.getElementById('ass-cue-y');
  const boxes = new Map();
  const idleAnchors = new WeakMap();
  let drag = null;
  const target = () => {
    const current = global.MaweCuePanel.getCurrentCuePanelTarget();
    return current?.kind === 'main' ? current : null;
  };
  const enabled = () => global.MaweSettings.EDITOR_SETTINGS.assMode === true;
  const round = value => Number(value.toFixed(4));
  function recordFor(segment) {
    return global.MaweAssCanvas.lastRender?.tracks.find(item => item.role === 'main' && item.cueId === segment.id && !item.skipped);
  }
  function anchorFor(segment) {
    if (segment.assOverride?.pos) return { ...segment.assOverride.pos };
    const record = recordFor(segment);
    if (record) return { ...record.anchor };
    // A selected cue need not be on screen. Obtain its automatic anchor from
    // the same export plan, without changing the playback cursor or data.
    let plan = global.MaweAssPreview.stackPlan;
    const cached = idleAnchors.get(segment);
    if (plan && cached?.plan === plan) return { ...cached.anchor };
    if (!plan) global.MaweExportSrt.buildAss({ preview: true, allowAssPlanDiagnostics: true, onAssPlan: value => { plan = value; } });
    const slice = plan?.slices.find(slice => slice.items.some(item => item.segment.id === segment.id));
    const item = slice && global.AsrEditorUtils.assStackFrame(plan, slice.start + Math.min(10, (slice.end - slice.start) / 2)).items
      .find(item => item.segment.id === segment.id);
    const resolution = global.MaweExportSrt.currentAssVideoResolution() || { width: 1920, height: 1080 };
    const style = item?.style || global.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE;
    const anchor = item?.anchor || global.AsrEditorUtils.assCanvasAnchorPoint({
      alignment: style.alignment,
      margins: { left: style.marginL, right: style.marginR, vertical: style.marginV },
      playResX: resolution.width, playResY: resolution.height,
      move: item?.legacy && plan?.profile.animations.move.enabled
        ? (() => { const state = global.AsrEditorUtils.assPreviewAnimationState(plan.profile, slice.start - item.start, item.end - item.start);
          return { x: state.moveX, y: state.moveY }; })() : null,
    });
    idleAnchors.set(segment, { plan, anchor });
    return { ...anchor };
  }
  function write(segment, value) {
    const override = global.AsrEditorUtils.normalizeAssOverride(value);
    if (override) segment.assOverride = override;
    else delete segment.assOverride;
    segment._dirty = true;
  }
  function edit(label, mutate) {
    const current = target();
    if (!enabled() || !current || drag) return;
    global.MaweCuePanel.commitCuePanelEdit();
    global.MaweCommands.run(label, () => mutate(current.segment), { invalidate: { preview: 'refresh' } });
    sync();
  }
  function nudge(dx, dy, element) {
    edit('微调 ASS 字幕位置', segment => {
      const anchor = anchorFor(segment);
      // Finish a typed coordinate before nudging; keep the focused input in
      // sync too, rather than displaying an old draft above the committed value.
      if (element === xInput && Number.isFinite(xInput.valueAsNumber)) anchor.x = xInput.valueAsNumber;
      if (element === yInput && Number.isFinite(yInput.valueAsNumber)) anchor.y = yInput.valueAsNumber;
      const pos = { x: round(anchor.x + dx), y: round(anchor.y + dy) };
      write(segment, { ...segment.assOverride, pos });
      xInput.value = String(pos.x); yInput.value = String(pos.y);
    });
  }
  function point(event) {
    const rect = drag?.rect || global.MaweDom.overlayEl.getBoundingClientRect();
    const frame = global.MaweAssCanvas.lastRender;
    return { x: (event.clientX - rect.left) * frame.playResX / rect.width,
      y: (event.clientY - rect.top) * frame.playResY / rect.height };
  }
  function finish(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    previous.box.classList.remove('dragging');
    if (previous.box.hasPointerCapture(previous.pointerId)) previous.box.releasePointerCapture(previous.pointerId);
    if (cancel) previous.command?.cancel();
    else previous.command?.commit({ preview: 'refresh' });
    global.MawePlaybackLoop.refreshSubtitlePreview();
    sync();
  }
  function start(event, id, box) {
    if (!enabled() || event.button !== 0 || drag) return;
    const index = global.MaweBoot.DATA.segments.findIndex(segment => segment.id === id);
    if (index < 0) return;
    global.MaweCuePanel.commitCuePanelEdit();
    global.MaweCoreState.player?.pause();
    // The first gesture only selects. A second gesture can move the cue.
    if (currentTargetId() !== id) {
      global.MaweSelection.selectOnly(index);
      event.preventDefault(); event.stopPropagation();
      return;
    }
    const segment = global.MaweBoot.DATA.segments[index];
    const record = recordFor(segment);
    if (!record) return;
    event.preventDefault(); event.stopPropagation();
    box.focus({ preventScroll: true });
    drag = { segment, id, box, pointerId: event.pointerId, start: point(event), anchor: { ...(record.positionAnchor || record.anchor) },
      original: global.AsrEditorUtils.normalizeAssOverride(segment.assOverride),
      rect: global.MaweDom.overlayEl.getBoundingClientRect(),
      command: null };
    box.setPointerCapture(event.pointerId);
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const here = point(event);
    const dx = here.x - drag.start.x, dy = here.y - drag.start.y;
    if (Math.abs(dx) < 0.00005 && Math.abs(dy) < 0.00005) {
      if (drag.original) drag.segment.assOverride = global.AsrEditorUtils.normalizeAssOverride(drag.original);
      else delete drag.segment.assOverride;
    } else {
      // Clicks do not write data or capture history. Start only after real movement.
      if (!drag.command) drag.command = global.MaweCommands.begin('拖动 ASS 字幕位置');
      drag.box.classList.add('dragging');
      write(drag.segment, { ...drag.original, pos: { x: round(drag.anchor.x + dx), y: round(drag.anchor.y + dy) } });
    }
    global.MawePlaybackLoop.refreshSubtitlePreview();
    event.preventDefault(); event.stopPropagation();
  }
  function sync() {
    const current = target();
    if (drag && (!enabled() || !global.MaweBoot.DATA.segments.includes(drag.segment))) finish(true);
    panel.hidden = !enabled() || !current?.segment.assOverride?.pos;
    if (!panel.hidden) {
      const override = current.segment.assOverride;
      const anchor = anchorFor(current.segment);
      if (document.activeElement !== xInput) xInput.value = String(round(anchor.x));
      if (document.activeElement !== yInput) yInput.value = String(round(anchor.y));
      document.getElementById('ass-cue-reset').disabled = !override;
    }
    const frame = global.MaweAssCanvas.lastRender;
    const visible = new Set();
    if (enabled() && global.MaweDom.overlayToggle.checked) for (const record of frame?.tracks || []) {
      if (record.role !== 'main' || record.skipped || !record.bounds) continue;
      visible.add(record.cueId);
      let box = boxes.get(record.cueId);
      if (!box) {
        box = document.createElement('button'); box.type = 'button'; box.className = 'ass-cue-drag-target';
        box.setAttribute('aria-label', '选择主字幕，选中后拖动 ASS 位置');
        box.addEventListener('pointerdown', event => start(event, record.cueId, box));
        box.addEventListener('pointermove', move);
        box.addEventListener('pointerup', event => { if (event.pointerId === drag?.pointerId) { move(event); finish(); } });
        box.addEventListener('pointercancel', () => finish(true));
        box.addEventListener('lostpointercapture', () => { if (drag?.box === box) finish(true); });
        boxes.set(record.cueId, box); global.MaweDom.overlayEl.append(box);
      }
      box.hidden = false;
      box.classList.toggle('selected', current?.segment.id === record.cueId);
      const bounds = record.bounds;
      Object.assign(box.style, { left: `${bounds.left / frame.playResX * 100}%`, top: `${bounds.top / frame.playResY * 100}%`,
        width: `${(bounds.right - bounds.left) / frame.playResX * 100}%`, height: `${(bounds.bottom - bounds.top) / frame.playResY * 100}%` });
    }
    for (const [id, box] of boxes) if (!visible.has(id) && drag?.box !== box) { box.remove(); boxes.delete(id); }
  }
  for (const [input, axis] of [[xInput, 'x'], [yInput, 'y']]) input.addEventListener('change', () => {
    const value = input.valueAsNumber;
    if (!Number.isFinite(value)) { input.setCustomValidity('请输入有限坐标'); input.reportValidity(); return; }
    input.setCustomValidity('');
    edit('设置 ASS 字幕位置', segment => write(segment, { ...segment.assOverride, pos: { ...anchorFor(segment), [axis]: value } }));
  });
  document.getElementById('ass-cue-reset').addEventListener('click', () => edit('重置 ASS 字幕定位', segment => { delete segment.assOverride; segment._dirty = true; }));
  // A drag owns a full-project command snapshot. Run before document capture
  // listeners too: no second edit or navigation may publish history inside it.
  global.addEventListener('keydown', event => {
    if (!drag) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') finish(true);
    else if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'z') {
        if (event.shiftKey) global.MaweHistory.performRedo();
        else global.MaweHistory.performUndo();
      } else if (key === 'y' && !event.shiftKey) global.MaweHistory.performRedo();
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (!enabled() || event.ctrlKey || event.metaKey || event.altKey) return;
    const element = event.target;
    if (!element?.closest?.('#ass-cue-position, .ass-cue-drag-target')) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (element.classList.contains('ass-cue-drag-target')) {
      const id = [...boxes].find(([, box]) => box === element)?.[0];
      const index = global.MaweBoot.DATA.segments.findIndex(segment => segment.id === id);
      if (index >= 0 && currentTargetId() !== id) global.MaweSelection.selectOnly(index);
    }
    if (!target()?.segment.assOverride?.pos) return;
    const step = event.shiftKey ? 10 : 1;
    nudge(delta[0] * step, delta[1] * step, element);
  }, true);
  function currentTargetId() { return target()?.segment.id; }
  global.addEventListener('blur', () => finish(true));
  global.MaweAssCuePosition = Object.freeze({ sync,
    get dragging() { return Boolean(drag); },
    cancelDrag() { if (!drag) return false; finish(true); return true; },
    commitDrag() { if (!drag) return false; finish(); return true; },
  });
  sync();
})(typeof window !== 'undefined' ? window : globalThis);
