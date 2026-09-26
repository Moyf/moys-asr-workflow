// cue-drag-update: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-cue-drag-update', function createWaveformModule(dependencies) {
  'use strict';
  const { clamp, remapItems, resolveTiming, restoreTiming, snapshotTiming } = dependencies;

  class WaveformMethods {


    moveCueDrag(event) {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      drag.currentClientX = event.clientX;
      drag.lastPointerPosition = { clientX: event.clientX, clientY: event.clientY };
      const timing = drag.timing || this.cueTiming();
      if (drag.sharedBoundaryZone) {
        const pointerRow = this.findVisibleWaveformRowAtY(event.clientY);
        // 只有指针落在当前可见波形行内才更新；行间空白和可视区外沿用最后
        // 一个有效位置，不让捕获到 pane 的指针事件把中缝带出时间轴范围。
        if (!pointerRow) return;
        // 纵向进入另一行只改变可操作区域，不改变时间；时间始终按起始行
        // 的横向位移计算；横向越过波形视口边缘也继续移动，不发生整行吸附。
      }
      const pointerMs = this.timeFromPointerUnbounded(event, drag.row, drag.geometry);
      const currentPointerTime = timing.fromMs(pointerMs);
      const deltaTime = currentPointerTime - drag.startPointerTime;
      const hasMeaningfulMovement = timing.unit === 'frames'
        ? deltaTime !== 0 : Math.abs(deltaTime) >= 2;
      if (!drag.started && !hasMeaningfulMovement) return;
      if (!drag.started) {
        drag.started = true;
        const label = drag.kind === 'move' ? '移动字幕时间'
          : drag.kind === 'resize-boundary-independent' ? '独立调整字幕边界'
          : '调整字幕边界';
        this.options.onBeginEdit(label);
      }
      // 一旦在本次拖动中进入相邻字幕独立模式，松开 Alt 也不要把已经
      // 调整过的字幕重新吸回邻居；下一次拖动再按设置决定默认模式。
      const adjacentCueAdjustmentIndependent = this.isAdjacentCueAdjustmentIndependent(event.altKey);
      // Shift+拖动的逃生口是转入叠加轨，不做同轨挤压。
      if (drag.kind === 'move' && adjacentCueAdjustmentIndependent && !drag.shiftOverlay) drag.allowSqueeze = true;
      // 主字幕/副字幕绑定的独立调整仍只由 Alt 临时触发，不受同轨自动吸附开关影响。
      if (drag.track === 'extension' && event.altKey) drag.independent = true;
      // Shift+拖动是精确自由放置（邻居挡路时换轨而不是吸附），全程禁用吸附，
      // 否则刚拖出重叠区就会被吸回邻居边界。
      const disableSnap = drag.independent === true || drag.shiftOverlay === true;
      if (drag.kind === 'move') this.applyMoveDrag(drag, deltaTime, disableSnap, drag.allowSqueeze);
      else if (drag.kind === 'resize-boundary') this.applyBoundaryDrag(drag, deltaTime, drag.independent);
      else if (drag.kind === 'resize-boundary-independent') this.applyIndependentBoundaryDrag(drag, deltaTime);
      else this.applyResizeDrag(drag, deltaTime, drag.independent);
      this.options.syncBoundCueDrag?.(drag);
      drag.changed = true;
      if (this.isCueBoundaryDrag(drag)) this.refreshBoundaryDragPointerLine();
      this.scheduleRefreshCueBlocks();
    }


    applyMoveDrag(drag, rawDelta, disableSnap, allowSqueeze = false) {
      const clock = resolveTiming(drag.timing || this.cueTiming());
      // Shift+拖动的动态换轨（只作用于单条拖动）：
      // 1) 主轨上请求位移被邻居挡住 → 先把段移到指针对应位置，再转入叠加轨；
      // 2) 叠加轨上段的实际位置不再与主轨任何字幕重叠 → 转回主轨。
      // 两次换轨都以“当前实际位置”为新基准，并同步平移 startPointerTime，
      // 保证 position = 换轨位置 +（指针 - 换轨指针）逐帧连续无跳变。
      if (drag.shiftOverlay && drag.indices.length === 1) {
        const mainSegments = this.options.getSegments('main');
        if (drag.track === 'main' && !drag.convertedToOverlay
            && typeof this.options.convertCueToOverlay === 'function') {
          const segment = mainSegments[drag.index];
          const mainOriginal = drag.originals.get(drag.index);
          if (segment && mainOriginal) {
            let neighborMinDelta = -Infinity;
            let neighborMaxDelta = Infinity;
            if (drag.index > 0) {
              neighborMinDelta = clock.getEnd(mainSegments[drag.index - 1]) - mainOriginal.start;
            }
            if (drag.index + 1 < mainSegments.length) {
              neighborMaxDelta = clock.getStart(mainSegments[drag.index + 1]) - mainOriginal.end;
            }
            const requestedDelta = clock.round(rawDelta);
            if (requestedDelta > neighborMaxDelta || requestedDelta < neighborMinDelta) {
              const mediaDuration = Number(this.durationMs) > 0 ? clock.fromMs(this.durationMs) : Infinity;
              const appliedDelta = clamp(requestedDelta, -mainOriginal.start, mediaDuration - mainOriginal.end);
              // 先把段移到指针对应位置（可越过邻居），迁移后快照才与实际一致。
              clock.setStart(segment, mainOriginal.start + appliedDelta);
              clock.setEnd(segment, mainOriginal.end + appliedDelta);
              if (Array.isArray(mainOriginal.items)) {
                segment.items = mainOriginal.items.map((item) => {
                  const copy = { ...item };
                  clock.setItemStart(copy, clock.getItemStart(item) + appliedDelta);
                  clock.setItemEnd(copy, clock.getItemEnd(item) + appliedDelta);
                  return copy;
                });
              }
              const overlayIndex = this.options.convertCueToOverlay(drag.index);
              if (Number.isInteger(overlayIndex) && overlayIndex >= 0) {
                this.rebaseCueDragToTrack(drag, 'overlay', overlayIndex, clock, rawDelta);
                return;
              }
              restoreTiming(segment, mainOriginal, clock);
            }
          }
        } else if (drag.track === 'overlay'
            && typeof this.options.convertOverlayCueToMainDrag === 'function') {
          const segment = this.options.getSegments('overlay')[drag.index];
          if (segment) {
            const currentStart = clock.getStart(segment);
            const currentEnd = clock.getEnd(segment);
            // 用实际位置判定：叠加轨允许压在主轨上，只有真的拖出重叠才回主轨。
            // 起点就在叠加轨的 Shift+拖动同样适用（放回主字幕）。
            const fitsMain = mainSegments.every((other) => (
              currentEnd <= clock.getStart(other) || currentStart >= clock.getEnd(other)
            ));
            if (fitsMain) {
              const mainIndex = this.options.convertOverlayCueToMainDrag(drag.index);
              if (Number.isInteger(mainIndex) && mainIndex >= 0) {
                this.rebaseCueDragToTrack(drag, 'main', mainIndex, clock, rawDelta);
                return;
              }
            }
          }
        }
      }
      const segments = this.options.getSegments(drag.track);
      const moved = new Set(drag.indices);
      const originalFor = (idx) => drag.squeezeOriginals?.get(idx)
        || drag.originals.get(idx) || snapshotTiming(segments[idx], clock);
      const restoreSegment = (idx, original) => {
        const segment = segments[idx];
        if (!segment || !original) return;
        restoreTiming(segment, original, clock);
      };
      if (allowSqueeze && drag.squeezeOriginals) {
        drag.squeezeOriginals.forEach((original, idx) => {
          if (!moved.has(idx)) restoreSegment(idx, original);
        });
      }
      let minDelta = -Infinity;
      let maxDelta = Infinity;
      const duration = Number(this.durationMs) > 0 ? clock.fromMs(this.durationMs) : Infinity;
      for (const idx of drag.indices) {
        const original = drag.originals.get(idx);
        minDelta = Math.max(minDelta, -original.start);
        maxDelta = Math.min(maxDelta, duration - original.end);
        if (allowSqueeze) {
          let previousIndex = idx - 1;
          while (previousIndex >= 0 && moved.has(previousIndex)) previousIndex -= 1;
          if (previousIndex >= 0) {
            const previous = originalFor(previousIndex);
            minDelta = Math.max(minDelta, previous.start + clock.minDuration - original.start);
          }
          let nextIndex = idx + 1;
          while (nextIndex < segments.length && moved.has(nextIndex)) nextIndex += 1;
          if (nextIndex < segments.length) {
            const next = originalFor(nextIndex);
            maxDelta = Math.min(maxDelta, next.end - clock.minDuration - original.end);
          }
        } else {
          if (idx > 0 && !moved.has(idx - 1)) {
            minDelta = Math.max(minDelta, clock.getEnd(segments[idx - 1]) - original.start);
          }
          if (idx + 1 < segments.length && !moved.has(idx + 1)) {
            maxDelta = Math.min(maxDelta, clock.getStart(segments[idx + 1]) - original.end);
          }
        }
      }
      let delta = rawDelta;
      if (!disableSnap) {
        const candidates = [];
        const playhead = clock.fromMs(this.currentTimeMs());
        const crossTrackTargets = (this.options.getCrossTrackSnapTargets?.(drag.track) || [])
          .map((target) => clock.fromMs(target));
        for (const idx of drag.indices) {
          const original = drag.originals.get(idx);
          candidates.push(playhead - original.start, playhead - original.end);
          if (!allowSqueeze) {
            if (idx > 0 && !moved.has(idx - 1)) {
              candidates.push(clock.getEnd(segments[idx - 1]) - original.start);
            }
            if (idx + 1 < segments.length && !moved.has(idx + 1)) {
              candidates.push(clock.getStart(segments[idx + 1]) - original.end);
            }
          }
          crossTrackTargets.forEach((target) => {
            if (Number.isFinite(target)) candidates.push(target - original.start, target - original.end);
          });
        }
        const nearest = candidates.reduce((best, value) => (
          Math.abs(value - delta) < Math.abs(best - delta) ? value : best
        ), Infinity);
        if (Number.isFinite(nearest) && Math.abs(nearest - delta) <= clock.snapThreshold) delta = nearest;
      }
      delta = clamp(clock.round(delta), minDelta, maxDelta);
      for (const idx of drag.indices) {
        const original = drag.originals.get(idx);
        const segment = segments[idx];
        clock.setStart(segment, original.start + delta);
        clock.setEnd(segment, original.end + delta);
        if (Array.isArray(original.items)) {
          segment.items = original.items.map((item) => {
            const copy = { ...item };
            clock.setItemStart(copy, clock.getItemStart(item) + delta);
            clock.setItemEnd(copy, clock.getItemEnd(item) + delta);
            return copy;
          });
        }
      }
      if (allowSqueeze) {
        for (const idx of drag.indices) {
          const segment = segments[idx];
          let previousIndex = idx - 1;
          while (previousIndex >= 0 && moved.has(previousIndex)) previousIndex -= 1;
          if (previousIndex >= 0) {
            const previous = segments[previousIndex];
            const previousOriginal = originalFor(previousIndex);
            if (previous && clock.getEnd(previous) > clock.getStart(segment)) {
              const nextEnd = Math.max(previousOriginal.start + clock.minDuration, clock.getStart(segment));
              if (nextEnd < clock.getEnd(previous)) {
                clock.setEnd(previous, nextEnd);
                previous.items = remapItems(
                  previousOriginal.items,
                  previousOriginal.start,
                  previousOriginal.end,
                  clock.getStart(previous),
                  clock.getEnd(previous),
                  clock,
                );
                drag.commitIndices.add(previousIndex);
              }
            }
          }
          let nextIndex = idx + 1;
          while (nextIndex < segments.length && moved.has(nextIndex)) nextIndex += 1;
          if (nextIndex < segments.length) {
            const next = segments[nextIndex];
            const nextOriginal = originalFor(nextIndex);
            if (next && clock.getEnd(segment) > clock.getStart(next)) {
              const nextStart = Math.min(nextOriginal.end - clock.minDuration, clock.getEnd(segment));
              if (nextStart > clock.getStart(next)) {
                clock.setStart(next, nextStart);
                next.items = remapItems(
                  nextOriginal.items,
                  nextOriginal.start,
                  nextOriginal.end,
                  clock.getStart(next),
                  clock.getEnd(next),
                  clock,
                );
                drag.commitIndices.add(nextIndex);
              }
            }
          }
        }
      }
      const deltaLabel = clock.unit === 'frames' ? `${delta >= 0 ? '+' : ''}${delta}F` : `${delta >= 0 ? '+' : ''}${delta} ms`;
      this.setStatus(`${allowSqueeze ? '挤压移动' : '移动'} ${drag.indices.length} 条 · ${deltaLabel}`);
    }


    applyResizeDrag(drag, rawDelta, disableSnap) {
      const clock = resolveTiming(drag.timing || this.cueTiming());
      const segments = this.options.getSegments(drag.track);
      const segment = segments[drag.index];
      const original = drag.originals.get(drag.index);
      let newStart = original.start;
      let newEnd = original.end;
      if (drag.kind === 'resize-left') {
        const lower = drag.index > 0 ? clock.getEnd(segments[drag.index - 1]) : 0;
        const upper = original.end - clock.minDuration;
        newStart = original.start + rawDelta;
        if (!disableSnap) {
          const targets = [lower, clock.fromMs(this.currentTimeMs()), ...(
            this.options.getCrossTrackSnapTargets?.(drag.track) || []
          ).map((target) => clock.fromMs(target))];
          const nearest = targets.reduce((best, value) => (
            Math.abs(value - newStart) < Math.abs(best - newStart) ? value : best
          ), Infinity);
          if (Number.isFinite(nearest) && Math.abs(nearest - newStart) <= clock.snapThreshold) newStart = nearest;
        }
        newStart = clamp(clock.round(newStart), lower, upper);
      } else {
        const lower = original.start + clock.minDuration;
        const upper = drag.index + 1 < segments.length
          ? clock.getStart(segments[drag.index + 1]) : this.cueTimingDuration();
        newEnd = original.end + rawDelta;
        if (!disableSnap) {
          const targets = [upper, clock.fromMs(this.currentTimeMs()), ...(
            this.options.getCrossTrackSnapTargets?.(drag.track) || []
          ).map((target) => clock.fromMs(target))];
          const nearest = targets.reduce((best, value) => (
            Math.abs(value - newEnd) < Math.abs(best - newEnd) ? value : best
          ), Infinity);
          if (Number.isFinite(nearest) && Math.abs(nearest - newEnd) <= clock.snapThreshold) newEnd = nearest;
        }
        newEnd = clamp(clock.round(newEnd), lower, upper);
      }
      clock.setStart(segment, newStart);
      clock.setEnd(segment, newEnd);
      segment.items = remapItems(original.items, original.start, original.end, newStart, newEnd, clock);
      this.setStatus(`${clock.format(newStart)} → ${clock.format(newEnd)}`);
    }


    applyBoundaryDrag(drag, rawDelta, disableSnap) {
      const clock = resolveTiming(drag.timing || this.cueTiming());
      const segments = this.options.getSegments(drag.track);
      const left = drag.originals.get(drag.index);
      const right = drag.originals.get(drag.index + 1);
      if (!left || !right) return;
      let boundary = left.end + rawDelta;
      const lower = left.start + clock.minDuration;
      const upper = right.end - clock.minDuration;
      if (!disableSnap) {
        const candidates = [clock.fromMs(this.currentTimeMs()), ...(
          this.options.getCrossTrackSnapTargets?.(drag.track) || []
        ).map((target) => clock.fromMs(target))];
        if (drag.index > 0) candidates.push(clock.getEnd(segments[drag.index - 1]));
        if (drag.index + 2 < segments.length) candidates.push(clock.getStart(segments[drag.index + 2]));
        const nearest = candidates.reduce((best, value) => (
          Math.abs(value - boundary) < Math.abs(best - boundary) ? value : best
        ), Infinity);
        if (Number.isFinite(nearest) && Math.abs(nearest - boundary) <= clock.snapThreshold) boundary = nearest;
      }
      boundary = clamp(clock.round(boundary), lower, upper);
      const leftSegment = segments[drag.index];
      const rightSegment = segments[drag.index + 1];
      clock.setEnd(leftSegment, boundary);
      clock.setStart(rightSegment, boundary);
      leftSegment.items = remapItems(left.items, left.start, left.end, left.start, boundary, clock);
      rightSegment.items = remapItems(right.items, right.start, right.end, boundary, right.end, clock);
      this.setStatus(`共享边界 ${clock.format(boundary)} · ${this.adjacentSnapModeStatusHint()}`);
      // 吸附模式提示只挂在「共享边界」状态上：共享边界拖动正是自动吸附
      // 默认联动/独立两种模式的直接体现，Alt 可随时临时反转。
    }


    endCueDrag(event) {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const restorePointerLine = () => {
        if (this.isCueBoundaryDrag(drag)) {
          this.restorePointerLineAfterBoundaryDrag({ clientX: event.clientX, clientY: event.clientY });
        }
      };
      window.removeEventListener('pointermove', this._dragMove);
      window.removeEventListener('pointerup', this._dragEnd);
      window.removeEventListener('pointercancel', this._dragEnd);
      try { drag.captureTarget?.releasePointerCapture?.(drag.pointerId); } catch (_) {}
      this.content.querySelectorAll('.waveform-cue-block.dragging, .waveform-cue-boundary.dragging')
        .forEach((block) => block.classList.remove('dragging'));
      this.pane.classList.remove('cue-drag-active');
      this.pane.classList.remove('shared-boundary-drag-active');
      this.drag = null;
      if (event.type === 'pointercancel') {
        drag.cancelOriginals.forEach((original, idx) => {
          const segment = this.options.getSegments(drag.track || 'main')[idx];
          if (!segment) return;
          restoreTiming(segment, original, drag.timing || this.cueTiming());
        });
        this.options.onCancelEdit?.();
        this.refreshCueOverlay();
        restorePointerLine();
        return;
      }
      if (!drag.changed) {
        if (drag.started) this.options.onCancelEdit?.();
        // Shift+点击（无拖动位移）：按下时未做范围选择，这里补上，
        // 保持既有 Shift+click 范围选语义；不进入跳转/启停逻辑。
        if (drag.shiftRangeSelect) {
          if (drag.track === 'overlay') this.options.selectOverlayRange?.(drag.index);
          else this.options.selectCueRange?.(drag.index);
          restorePointerLine();
          return;
        }
        if (drag.altToggleDisabledOnClick) {
          this.options.toggleDisabled?.([drag.index], drag.track || 'main');
          restorePointerLine();
          return;
        }
        // select-only 只选中；两个跳转模式按设置跳到字幕开头或鼠标位置。
        const clickBehavior = this.options.getClickBehavior?.();
        if (clickBehavior !== 'select-only' && !drag.seekedOnPointerDown) {
          this.seekFromCue(event, drag.row, drag.index, clickBehavior === 'select-and-play', drag.geometry, drag.track);
        }
        restorePointerLine();
        return;
      }
      const commitIndices = [...(drag.commitIndices || drag.indices)];
      const segments = this.options.getSegments(drag.track || 'main');
      commitIndices.forEach((idx) => { if (segments[idx]) segments[idx]._dirty = true; });
      this.options.onCommitEdit(commitIndices, drag.kind, drag.track || 'main', drag.independent === true);
      this.refreshCueOverlay();
      restorePointerLine();
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
