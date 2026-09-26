// cue-commands: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-cue-commands', function createWaveformModule(dependencies) {
  'use strict';
  const { applyBoundaryStep, applyIndependentEdge, applyMoveStep, clamp, normalizedIndices, planBoundaryStep, planMoveStep, remapItems, resolveTiming, restoreTiming, snapshotTiming } = dependencies;

  class WaveformMethods {


    adjustSelectedByKeyboard(deltaMs, altKey = false, track = 'main') {
      const segments = this.options.getSegments(track);
      const indices = normalizedIndices(segments, this.options.getSelection?.(track));
      if (!indices.length) return false;
      const timing = this.cueTiming();
      const operationOptions = {
        sticky: !this.isAdjacentCueAdjustmentIndependent(altKey),
        timing,
        minDuration: timing.minDuration,
      };
      const plan = planMoveStep(
        segments,
        indices,
        deltaMs,
        this.cueTimingDuration(),
        operationOptions,
      );
      if (!plan.changed) return false;
      this.options.onBeginEdit?.('移动字幕时间');
      const result = applyMoveStep(
        segments,
        indices,
        deltaMs,
        this.cueTimingDuration(),
        operationOptions,
      );
      result.affectedIndices.forEach((idx) => { segments[idx]._dirty = true; });
      this.options.onCommitEdit?.(result.indices, 'move', track);
      this.refreshCueOverlay();
      return true;
    }


    adjustSelectedBoundaryByKeyboard(deltaMs, edge, altKey = false, track = 'main') {
      const segments = this.options.getSegments(track);
      const indices = normalizedIndices(segments, this.options.getSelection?.(track));
      if (!indices.length || (edge !== 'start' && edge !== 'end')) return false;
      const index = edge === 'start' ? indices[0] : indices[indices.length - 1];
      const timing = this.cueTiming();
      const options = {
        sticky: !this.isAdjacentCueAdjustmentIndependent(altKey),
        timing,
        minDuration: timing.minDuration,
      };
      const plan = planBoundaryStep(segments, index, edge, deltaMs, this.cueTimingDuration(), options);
      if (!plan.changed) return false;
      this.options.onBeginEdit?.(`${edge === 'start' ? '调整字幕起点' : '调整字幕终点'}`);
      const result = applyBoundaryStep(
        segments,
        index,
        edge,
        deltaMs,
        this.cueTimingDuration(),
        options,
      );
      result.affectedIndices.forEach((idx) => { segments[idx]._dirty = true; });
      this.options.onCommitEdit?.(
        result.affectedIndices,
        result.linked ? 'resize-boundary' : 'resize-boundary-independent',
        track,
      );
      this.refreshCueOverlay();
      return true;
    }


    // 把单条字幕的一个边界直接定位到波形指针时间。与方向键微调一样，
    // 保留最短时长和同轨不重叠约束，但不联动同轨邻居；跨轨绑定由编辑器
    // 的提交回调处理。targetIndex 用于“当前没有选中字幕但指针命中字幕”的路径。
    setCueBoundaryToTime(timeMs, edge, track = 'main', targetIndex = null) {
      const segments = this.options.getSegments(track);
      const selectedIndices = normalizedIndices(segments, this.options.getSelection?.(track));
      const hasExplicitTarget = targetIndex !== null && targetIndex !== undefined;
      const index = hasExplicitTarget ? Number(targetIndex)
        : selectedIndices.length === 1 ? selectedIndices[0] : -1;
      if (!Number.isInteger(index) || !segments[index]
          || (!hasExplicitTarget && selectedIndices.length !== 1)
          || (edge !== 'start' && edge !== 'end')) return false;

      const segment = segments[index];
      const timing = this.cueTiming();
      const current = edge === 'start' ? timing.getStart(segment) : timing.getEnd(segment);
      const requested = timing.fromMs(timeMs);
      if (!Number.isFinite(current) || !Number.isFinite(requested)) return false;

      const previous = segments[index - 1];
      const next = segments[index + 1];
      let lower;
      let upper;
      if (edge === 'start') {
        lower = previous ? timing.getEnd(previous) : 0;
        upper = timing.getEnd(segment) - timing.minDuration;
      } else {
        lower = timing.getStart(segment) + timing.minDuration;
        upper = next ? timing.getStart(next) : this.cueTimingDuration();
        if (!Number.isFinite(upper) || upper <= 0) upper = Infinity;
      }
      if (!Number.isFinite(lower) || lower > upper) return true;

      const target = clamp(timing.round(requested), lower, upper);
      if (!Number.isFinite(target) || target === current) return true;

      const original = snapshotTiming(segment, timing);
      this.options.onBeginEdit?.(edge === 'start' ? '定位字幕起点' : '定位字幕终点');
      if (edge === 'start') {
        timing.setStart(segment, target);
      } else {
        timing.setEnd(segment, target);
      }
      segment.items = remapItems(
        original.items,
        original.start,
        original.end,
        timing.getStart(segment),
        timing.getEnd(segment),
        timing,
      );
      segment._dirty = true;
      this.options.onCommitEdit?.(
        [index],
        'resize-boundary-pointer',
        track,
        false,
        {
          edge,
          targetIndex: index,
          targetTimeMs: timing.toMs(target),
          original: { ...original, start: original.startMs, end: original.endMs },
        },
      );
      this.refreshCueOverlay();
      return true;
    }


    snapSelectedCueBoundaryByKeyboard(direction, track = 'main') {
      const segments = this.options.getSegments(track);
      const indices = normalizedIndices(segments, this.options.getSelection?.(track));
      if (!indices.length || (direction !== -1 && direction !== 1)) return false;

      const index = direction < 0 ? indices[0] : indices[indices.length - 1];
      const neighborIndex = direction < 0 ? index - 1 : index + 1;
      const segment = segments[index];
      const neighbor = segments[neighborIndex];
      // 与按住字幕块时的 Shift+A/D 一样，边界不存在或无法贴合时也消费按键，
      // 避免 Shift+方向键继续触发浏览器默认行为。
      if (!segment || !neighbor) return true;

      const timing = this.cueTiming();
      const edge = direction < 0 ? 'start' : 'end';
      const current = edge === 'start' ? timing.getStart(segment) : timing.getEnd(segment);
      const target = timing.round(direction < 0 ? timing.getEnd(neighbor) : timing.getStart(neighbor));
      const lower = edge === 'start' ? 0 : timing.getStart(segment) + timing.minDuration;
      const upper = edge === 'start'
        ? timing.getEnd(segment) - timing.minDuration
        : this.cueTimingDuration();
      if (!Number.isFinite(current) || !Number.isFinite(target)
          || target < lower || target > upper || target === current) return true;

      const result = applyBoundaryStep(
        segments,
        index,
        edge,
        target - current,
        this.cueTimingDuration(),
        { sticky: false, timing, minDuration: timing.minDuration },
      );
      if (!result.changed) return true;
      this.options.onBeginEdit?.('贴近字幕边界');
      result.affectedIndices.forEach((idx) => { segments[idx]._dirty = true; });
      this.options.onCommitEdit?.(result.affectedIndices, 'resize-boundary-independent', track);
      this.refreshCueOverlay();
      return true;
    }


    adjustActiveCueDragBy(deltaMs, altKey = false) {
      const drag = this.drag;
      if (!drag) return false;
      const segments = this.options.getSegments(drag.track || 'main');
      const timing = drag.timing || this.cueTiming();
      const durationMs = Number(this.durationMs) > 0 ? timing.fromMs(this.durationMs) : Infinity;
      let plan;
      let apply;
      if (drag.kind === 'move') {
        const options = {
          sticky: !this.isAdjacentCueAdjustmentIndependent(altKey),
          timing,
          minDuration: timing.minDuration,
        };
        plan = planMoveStep(segments, drag.indices, deltaMs, durationMs, options);
        apply = () => applyMoveStep(segments, drag.indices, deltaMs, durationMs, options);
      } else {
        const edge = drag.kind === 'resize-boundary-independent'
          ? drag.edge
          : drag.kind === 'resize-left' ? 'start' : 'end';
        const options = {
          sticky: drag.kind !== 'resize-boundary-independent'
            && !this.isAdjacentCueAdjustmentIndependent(altKey),
          timing,
          minDuration: timing.minDuration,
        };
        plan = planBoundaryStep(segments, drag.index, edge, deltaMs, durationMs, options);
        apply = () => applyBoundaryStep(segments, drag.index, edge, deltaMs, durationMs, options);
      }
      // A held drag consumes A/D even when the current edge is already at a
      // limit, so the key never falls through to subtitle navigation.
      if (!plan.changed) return true;
      if (!drag.started) {
        drag.started = true;
        const label = drag.kind === 'move' ? '移动字幕时间'
          : drag.kind === 'resize-boundary-independent' ? '独立调整字幕边界'
            : '调整字幕边界';
        this.options.onBeginEdit?.(label);
      }
      const result = apply();
      result.affectedIndices.forEach((idx) => drag.commitIndices.add(idx));
      drag.changed = true;
      this.captureCueDragOriginals(drag);
      drag.startClientX = drag.currentClientX;
      drag.startPointerTime = timing.fromMs(this.timeFromPointerUnbounded(
        { clientX: drag.currentClientX },
        drag.row,
        drag.geometry,
      ));
      if (this.isCueBoundaryDrag(drag)) this.refreshBoundaryDragPointerLine();
      this.scheduleRefreshCueBlocks();
      return true;
    }


    handleHeldCueKey(direction, deltaMs, { shiftKey = false, altKey = false, snap = false } = {}) {
      if (!this.drag) return false;
      if (shiftKey) {
        // Shift 是显式的边界贴合命令，不受自动吸附默认值影响；Alt
        // 只反转普通 A/D 微调的自动联动模式。
        if (snap) this.snapActiveCueBoundaryByKeyboard(direction);
        // 按住字幕块时即使吸附不可用也要消费按键，不能穿透成普通导航。
        return true;
      }
      this.adjustActiveCueDragBy(deltaMs, altKey);
      return true;
    }


    snapActiveCueBoundaryByKeyboard(direction) {
      const drag = this.drag;
      if (!drag || drag.kind !== 'move' || (direction !== -1 && direction !== 1)) return false;
      const segments = this.options.getSegments(drag.track || 'main');
      const indices = normalizedIndices(segments, drag.indices);
      if (!indices.length) return true;

      const index = direction < 0 ? indices[0] : indices[indices.length - 1];
      const neighborIndex = direction < 0 ? index - 1 : index + 1;
      const segment = segments[index];
      const neighbor = segments[neighborIndex];
      // 与普通 A/D 一样，按住字幕块时即使已经到达边界也要消费按键，
      // 避免 Shift+A/D 穿透成“选择前后字幕”。
      if (!segment || !neighbor) return true;

      const timing = drag.timing || this.cueTiming();
      const edge = direction < 0 ? 'start' : 'end';
      const current = edge === 'start' ? timing.getStart(segment) : timing.getEnd(segment);
      const target = timing.round(direction < 0 ? timing.getEnd(neighbor) : timing.getStart(neighbor));
      const lower = edge === 'start' ? 0 : timing.getStart(segment) + timing.minDuration;
      const upper = edge === 'start'
        ? timing.getEnd(segment) - timing.minDuration
        : Number.isFinite(this.durationMs) ? timing.fromMs(this.durationMs) : Infinity;
      if (!Number.isFinite(current) || !Number.isFinite(target)
          || target < lower || target > upper || target === current) return true;

      if (!drag.started) {
        drag.started = true;
        this.options.onBeginEdit?.('贴近字幕边界');
      }
      const original = snapshotTiming(segment, timing);
      if (edge === 'start') timing.setStart(segment, target);
      else timing.setEnd(segment, target);
      segment.items = remapItems(
        original.items,
        original.start,
        original.end,
        timing.getStart(segment),
        timing.getEnd(segment),
        timing,
      );
      drag.commitIndices.add(index);
      drag.changed = true;
      this.captureCueDragOriginals(drag);
      drag.startClientX = drag.currentClientX;
      drag.startPointerTime = timing.fromMs(
        this.timeFromPointerUnbounded({ clientX: drag.currentClientX }, drag.row, drag.geometry),
      );
      this.scheduleRefreshCueBlocks();
      return true;
    }


    cancelCueDrag() {
      if (this.createCueDrag?.finish) {
        this.createCueDrag.finish(false);
        this.setStatus('已取消新增字幕');
        return true;
      }
      const drag = this.drag;
      if (!drag) return false;
      const pointerPosition = drag.lastPointerPosition;
      window.removeEventListener('pointermove', this._dragMove);
      window.removeEventListener('pointerup', this._dragEnd);
      window.removeEventListener('pointercancel', this._dragEnd);
      try { drag.captureTarget?.releasePointerCapture?.(drag.pointerId); } catch (_) {}
      const segments = this.options.getSegments(drag.track || 'main');
      drag.cancelOriginals.forEach((original, idx) => {
        const segment = segments[idx];
        if (!segment) return;
        restoreTiming(segment, original, drag.timing || this.cueTiming());
      });
      this.content.querySelectorAll('.waveform-cue-block.dragging, .waveform-cue-boundary.dragging')
        .forEach((block) => block.classList.remove('dragging'));
      this.pane.classList.remove('cue-drag-active');
      this.pane.classList.remove('shared-boundary-drag-active');
      this.drag = null;
      this.refreshCueOverlay();
      if (this.isCueBoundaryDrag(drag)) this.restorePointerLineAfterBoundaryDrag(pointerPosition);
      this.setStatus('已取消字幕调整');
      return true;
    }


    applyIndependentBoundaryDrag(drag, rawDelta) {
      const clock = resolveTiming(drag.timing || this.cueTiming());
      const segments = this.options.getSegments(drag.track);
      const original = drag.originals.get(drag.index);
      if (!original) return;
      const base = drag.edge === 'start' ? original.start : original.end;
      const value = base + rawDelta;
      applyIndependentEdge(segments, drag.dragIndex, drag.edge, value, clock.minDuration, clock);
      const seg = segments[drag.index];
      this.setStatus(`${drag.edge === 'start' ? '起点' : '终点'} ${clock.format(
        drag.edge === 'start' ? clock.getStart(seg) : clock.getEnd(seg),
      )}`);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
