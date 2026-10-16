// Main-cue ASS positioning and per-cue scaling.
(function initAssCuePosition(global) {
  'use strict';
  const panel = document.getElementById('ass-cue-position');
  const scaleControls = document.getElementById('ass-cue-scale-controls');
  const positionControls = document.getElementById('ass-cue-coordinate-controls');
  const scaleInput = document.getElementById('ass-cue-scale');
  const xInput = document.getElementById('ass-cue-x');
  const yInput = document.getElementById('ass-cue-y');
  const boxes = new Map();
  const handles = new Map();
  const idleAnchors = new WeakMap();
  let drag = null;
  let scaleDrag = null;
  let scaleWheel = null;
  const target = () => {
    const current = global.MaweCuePanel.getCurrentCuePanelTarget();
    return current?.kind === 'main' ? current : null;
  };
  const enabled = () => global.MaweSettings.EDITOR_SETTINGS.assMode === true;
  const roundPosition = value => Math.floor(Number(value) + 0.5);
  const roundScale = value => Number(Number(value).toFixed(2));
  const clampScale = value => Math.min(5, Math.max(0.1, value));
  const currentScale = segment => segment.assOverride?.scale || 1;
  const translated = value => global.MAWE_I18N?.translateText?.(value) || value;
  function singleSelected(id) {
    const selected = global.MaweState.selection.indices('main');
    return selected.size === 1 && target()?.segment.id === id;
  }
  function recordFor(segment) {
    return global.MaweAssCanvas.lastRender?.tracks.find(item => item.role === 'main' && item.cueId === segment.id && !item.skipped);
  }
  function anchorFor(segment) {
    if (segment.assOverride?.pos) return { ...segment.assOverride.pos };
    const record = recordFor(segment);
    if (record) return { ...(record.positionAnchor || record.anchor) };
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
  function writeScale(segment, value) {
    const override = { ...segment.assOverride };
    delete override.scale;
    const scale = roundScale(clampScale(value));
    if (scale !== 1) override.scale = scale;
    write(segment, override);
  }
  function finishScaleWheel(cancel = false) {
    if (!scaleWheel) return;
    const previous = scaleWheel;
    scaleWheel = null;
    global.clearTimeout(previous.timer);
    if (cancel) previous.command.cancel();
    else previous.command.commit({ preview: 'refresh' });
    global.MawePlaybackLoop.refreshSubtitlePreview();
    sync();
  }
  function edit(label, mutate) {
    const current = target();
    if (!enabled() || !current || drag || scaleDrag) return;
    if (scaleWheel) finishScaleWheel();
    global.MaweCuePanel.commitCuePanelEdit();
    global.MaweCommands.run(label, () => mutate(current.segment), { invalidate: { preview: 'refresh' } });
    sync();
  }
  function nudge(dx, dy, element) {
    edit('微调 ASS 字幕位置', segment => {
      const anchor = anchorFor(segment);
      if (element === xInput && Number.isFinite(xInput.valueAsNumber)) anchor.x = roundPosition(xInput.valueAsNumber);
      if (element === yInput && Number.isFinite(yInput.valueAsNumber)) anchor.y = roundPosition(yInput.valueAsNumber);
      const pos = { x: roundPosition(anchor.x + dx), y: roundPosition(anchor.y + dy) };
      write(segment, { ...segment.assOverride, pos });
      xInput.value = String(pos.x); yInput.value = String(pos.y);
    });
  }
  function point(event, rect = null) {
    const bounds = rect || drag?.rect || scaleDrag?.rect || global.MaweDom.overlayEl.getBoundingClientRect();
    const frame = global.MaweAssCanvas.lastRender;
    return { x: (event.clientX - bounds.left) * frame.playResX / bounds.width,
      y: (event.clientY - bounds.top) * frame.playResY / bounds.height };
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
  function finishScaleDrag(cancel = false) {
    if (!scaleDrag) return;
    const previous = scaleDrag;
    scaleDrag = null;
    previous.handle.classList.remove('dragging');
    if (previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
    if (cancel) previous.command?.cancel();
    else previous.command?.commit({ preview: 'refresh' });
    global.MawePlaybackLoop.refreshSubtitlePreview();
    sync();
  }
  function start(event, id, box) {
    if (!enabled() || event.button !== 0 || drag || scaleDrag) return;
    if (scaleWheel) finishScaleWheel();
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
      rect: global.MaweDom.overlayEl.getBoundingClientRect(), command: null };
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
      if (!drag.command) drag.command = global.MaweCommands.begin('拖动 ASS 字幕位置');
      drag.box.classList.add('dragging');
      write(drag.segment, { ...drag.original, pos: { x: roundPosition(drag.anchor.x + dx), y: roundPosition(drag.anchor.y + dy) } });
    }
    global.MawePlaybackLoop.refreshSubtitlePreview();
    event.preventDefault(); event.stopPropagation();
  }
  function startScale(event, id, handle) {
    if (!enabled() || event.button !== 0 || drag || scaleDrag || !singleSelected(id)) return;
    if (scaleWheel) finishScaleWheel();
    const segment = global.MaweBoot.DATA.segments.find(item => item.id === id);
    const record = segment && recordFor(segment);
    if (!segment || !record?.bounds) return;
    global.MaweCuePanel.commitCuePanelEdit();
    global.MaweCoreState.player?.pause();
    event.preventDefault(); event.stopPropagation();
    handle.focus({ preventScroll: true });
    const bounds = record.bounds;
    const start = point(event);
    const initialShake = record.shakeOffset || { x: 0, y: 0 };
    const stableStart = { x: start.x - initialShake.x, y: start.y - initialShake.y };
    const center = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    let dx = stableStart.x - center.x, dy = stableStart.y - center.y;
    let length = Math.hypot(dx, dy);
    if (length < 0.001) {
      const corner = handle.dataset.corner;
      dx = corner.includes('w') ? -1 : 1; dy = corner.includes('n') ? -1 : 1; length = Math.SQRT2;
    }
    scaleDrag = { segment, id, handle, pointerId: event.pointerId, rect: global.MaweDom.overlayEl.getBoundingClientRect(),
      start: stableStart, direction: { x: dx / length, y: dy / length },
      sensitivity: Math.max(24, Math.hypot(bounds.right - bounds.left, bounds.bottom - bounds.top) / 2),
      initialScale: currentScale(segment), original: global.AsrEditorUtils.normalizeAssOverride(segment.assOverride), command: null };
    handle.setPointerCapture(event.pointerId);
  }
  function moveScale(event) {
    if (!scaleDrag || event.pointerId !== scaleDrag.pointerId) return;
    const here = point(event);
    const currentRecord = recordFor(scaleDrag.segment);
    const shake = currentRecord?.shakeOffset || { x: 0, y: 0 };
    const stable = { x: here.x - shake.x, y: here.y - shake.y };
    const delta = (stable.x - scaleDrag.start.x) * scaleDrag.direction.x
      + (stable.y - scaleDrag.start.y) * scaleDrag.direction.y;
    const scale = roundScale(clampScale(scaleDrag.initialScale * (1 + delta / scaleDrag.sensitivity)));
    if (scale !== currentScale(scaleDrag.segment)) {
      if (!scaleDrag.command) scaleDrag.command = global.MaweCommands.begin('调整 ASS 字幕大小');
      scaleDrag.handle.classList.add('dragging');
      writeScale(scaleDrag.segment, scale);
      global.MawePlaybackLoop.refreshSubtitlePreview();
    }
    event.preventDefault(); event.stopPropagation();
  }
  function wheelScale(event) {
    if (!enabled() || drag || scaleDrag || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const current = target();
    if (!current || !singleSelected(current.segment.id)) return;
    const overlay = global.MaweDom.overlayEl;
    const record = recordFor(current.segment);
    if (global.MaweDom.overlayToggle?.checked !== true || overlay.dataset.assMode !== 'true'
        || overlay.classList.contains('hidden') || !record || !(record.opacity > 0)) return;
    const rect = overlay.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return;
    const blocked = event.target?.closest?.('input,textarea,select,button:not(.ass-cue-drag-target):not(.ass-cue-scale-handle),[contenteditable="true"]');
    if (blocked) return;
    const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1);
    if (!Number.isFinite(delta) || delta === 0) return;
    const currentValue = currentScale(current.segment);
    const change = Math.max(0.01, Math.abs(delta) * 0.0005);
    const next = roundScale(clampScale(currentValue + (delta < 0 ? change : -change)));
    if (next === currentValue) return;
    event.preventDefault();
    if (scaleWheel && scaleWheel.segment !== current.segment) finishScaleWheel();
    if (!scaleWheel) scaleWheel = { segment: current.segment, command: global.MaweCommands.begin('滚轮调整 ASS 字幕大小'), timer: null };
    writeScale(current.segment, next);
    global.MawePlaybackLoop.refreshSubtitlePreview();
    global.clearTimeout(scaleWheel.timer);
    scaleWheel.timer = global.setTimeout(() => finishScaleWheel(), 240);
  }
  function sync() {
    const current = target();
    if (scaleWheel && (!enabled() || scaleWheel.segment !== current?.segment)) finishScaleWheel();
    if (drag && (!enabled() || !global.MaweBoot.DATA.segments.includes(drag.segment))) finish(true);
    if (scaleDrag && (!enabled() || !global.MaweBoot.DATA.segments.includes(scaleDrag.segment))) finishScaleDrag(true);
    const override = current?.segment.assOverride;
    panel.hidden = !enabled() || !current || (!override?.pos && !override?.scale);
    positionControls.hidden = !override?.pos;
    scaleControls.hidden = !override?.scale;
    if (!panel.hidden) {
      const anchor = anchorFor(current.segment);
      if (override?.pos) {
        if (document.activeElement !== xInput) xInput.value = String(roundPosition(anchor.x));
        if (document.activeElement !== yInput) yInput.value = String(roundPosition(anchor.y));
      }
      if (override?.scale && document.activeElement !== scaleInput) scaleInput.value = currentScale(current.segment).toFixed(2);
      document.getElementById('ass-cue-reset').disabled = !override?.pos;
      document.getElementById('ass-cue-scale-reset').disabled = !override?.scale;
    }
    const frame = global.MaweAssCanvas.lastRender;
    const visible = new Set();
    if (enabled() && global.MaweDom.overlayToggle.checked) for (const record of frame?.tracks || []) {
      if (record.role !== 'main' || record.skipped || !record.bounds) continue;
      const id = record.cueId;
      visible.add(id);
      let box = boxes.get(id);
      if (!box) {
        box = document.createElement('button'); box.type = 'button'; box.className = 'ass-cue-drag-target';
        box.setAttribute('aria-label', translated('选择主字幕，选中后拖动 ASS 位置'));
        box.addEventListener('pointerdown', event => start(event, id, box));
        box.addEventListener('pointermove', move);
        box.addEventListener('pointerup', event => { if (event.pointerId === drag?.pointerId) { move(event); finish(); } });
        box.addEventListener('pointercancel', () => finish(true));
        box.addEventListener('lostpointercapture', () => { if (drag?.box === box) finish(true); });
        boxes.set(id, box); global.MaweDom.overlayEl.append(box);
      }
      box.hidden = false;
      const selected = current?.segment.id === id;
      box.classList.toggle('selected', selected);
      const bounds = record.bounds;
      Object.assign(box.style, { left: `${bounds.left / frame.playResX * 100}%`, top: `${bounds.top / frame.playResY * 100}%`,
        width: `${(bounds.right - bounds.left) / frame.playResX * 100}%`, height: `${(bounds.bottom - bounds.top) / frame.playResY * 100}%` });
      let cueHandles = handles.get(id);
      if (!cueHandles) {
        cueHandles = ['nw', 'ne', 'sw', 'se'].map(corner => {
          const handle = document.createElement('button');
          handle.type = 'button'; handle.className = `ass-cue-scale-handle ass-cue-scale-handle--${corner}`;
          handle.dataset.corner = corner;
          handle.setAttribute('aria-label', translated(`调整主字幕大小（${{ nw: '左上', ne: '右上', sw: '左下', se: '右下' }[corner]}角）`));
          handle.addEventListener('pointerdown', event => startScale(event, id, handle));
          handle.addEventListener('pointermove', moveScale);
          handle.addEventListener('pointerup', event => { if (event.pointerId === scaleDrag?.pointerId) { moveScale(event); finishScaleDrag(); } });
          handle.addEventListener('pointercancel', () => finishScaleDrag(true));
          handle.addEventListener('lostpointercapture', () => { if (scaleDrag?.handle === handle) finishScaleDrag(true); });
          global.MaweDom.overlayEl.append(handle);
          return handle;
        });
        handles.set(id, cueHandles);
      }
      const canScale = singleSelected(id);
      for (const handle of cueHandles) {
        const corner = handle.dataset.corner;
        handle.hidden = !canScale;
        handle.classList.toggle('dragging', scaleDrag?.handle === handle);
        Object.assign(handle.style, {
          left: `${(corner.includes('w') ? bounds.left : bounds.right) / frame.playResX * 100}%`,
          top: `${(corner.includes('n') ? bounds.top : bounds.bottom) / frame.playResY * 100}%`,
        });
      }
    }
    for (const [id, box] of boxes) if (!visible.has(id) && drag?.box !== box) {
      box.remove(); boxes.delete(id);
      for (const handle of handles.get(id) || []) handle.remove();
      handles.delete(id);
    }
  }
  for (const [input, axis] of [[xInput, 'x'], [yInput, 'y']]) input.addEventListener('change', () => {
    const rawValue = input.valueAsNumber;
    if (!Number.isFinite(rawValue)) { input.setCustomValidity('请输入有限坐标'); input.reportValidity(); return; }
    input.setCustomValidity('');
    const value = roundPosition(rawValue);
    input.value = String(value);
    edit('设置 ASS 字幕位置', segment => write(segment, { ...segment.assOverride, pos: { ...anchorFor(segment), [axis]: value } }));
  });
  scaleInput.addEventListener('change', () => {
    const value = scaleInput.valueAsNumber;
    if (!Number.isFinite(value) || value < 0.1 || value > 5) {
      scaleInput.setCustomValidity('缩放倍率须在 0.10 到 5.00 之间'); scaleInput.reportValidity(); return;
    }
    scaleInput.setCustomValidity('');
    const rounded = roundScale(value);
    scaleInput.value = rounded.toFixed(2);
    edit('设置 ASS 字幕大小', segment => writeScale(segment, rounded));
  });
  document.getElementById('ass-cue-reset').addEventListener('click', () => edit('重置 ASS 字幕定位', segment => {
    const override = { ...segment.assOverride }; delete override.pos; write(segment, override);
  }));
  document.getElementById('ass-cue-scale-reset').addEventListener('click', () => edit('重置 ASS 字幕大小', segment => {
    const override = { ...segment.assOverride }; delete override.scale; write(segment, override);
  }));
  document.addEventListener('wheel', wheelScale, { capture: true, passive: false });
  // One pointer gesture owns one snapshot. Keyboard navigation cannot publish
  // a second edit while the pointer is held; Escape and focus loss cancel it.
  global.addEventListener('keydown', event => {
    const active = drag || scaleDrag;
    if (active) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { if (drag) finish(true); else finishScaleDrag(true); }
      else if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'z') {
          if (event.shiftKey) global.MaweHistory.performRedo();
          else global.MaweHistory.performUndo();
        } else if (key === 'y' && !event.shiftKey) global.MaweHistory.performRedo();
      }
      return;
    }
    if (scaleWheel && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); finishScaleWheel(true); return;
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (!enabled() || event.ctrlKey || event.metaKey || event.altKey || event.target === scaleInput) return;
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
  global.addEventListener('blur', () => {
    finish(true); finishScaleDrag(true); finishScaleWheel();
  });
  global.MaweCommands.onBeforeBegin(() => {
    if (scaleWheel) finishScaleWheel();
  });
  global.MaweAssCuePosition = Object.freeze({ sync,
    get dragging() { return Boolean(drag || scaleDrag || scaleWheel); },
    cancelDrag() {
      if (drag) { finish(true); return true; }
      if (scaleDrag) { finishScaleDrag(true); return true; }
      if (scaleWheel) { finishScaleWheel(true); return true; }
      return false;
    },
    commitDrag() {
      if (drag) { finish(); return true; }
      if (scaleDrag) { finishScaleDrag(); return true; }
      if (scaleWheel) { finishScaleWheel(); return true; }
      return false;
    },
  });
  sync();
})(typeof window !== 'undefined' ? window : globalThis);
