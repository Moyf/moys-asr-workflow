// cue-drag: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-cue-drag', function createWaveformModule(dependencies) {
  'use strict';
  const { isAttached, resolveTiming, snapshotTiming } = dependencies;

  class WaveformMethods {


    beginCueDrag(event, index, row, track = 'main') {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      // 字幕块会阻止 pointerdown 冒泡到 pane；主动接管焦点，确保按住
      // 字幕块/边界后，左手 A/D 不会仍被设置输入框等控件拦截。
      this.focusWaveform();
      // Ctrl(Cmd)+点击字幕仍保留多选；真正移动形成拖动时视为
      // “在已有字幕上创建”：叠加轨启用时主轨字幕改为转入叠加轨创建，
      // 其余情况直接拒绝，不启动普通字幕拖动或创建预览。
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        return this.beginBlockedCueCreateDrag(event, index, track, row);
      }
      // 剃刀工具：无修饰键左键点击字幕块（非手柄）时，在指针位置安全拆分。
      // 主轨与叠加轨均可拆分；叠加轨走编辑器的叠加拆分弹窗。
      // 修饰键（Alt/Ctrl(Cmd)/Shift）仍走原行为，便于拆分后立即多选/禁用。
      const targetHandle = event.target.closest('.waveform-cue-handle');
      const adjacentCueAdjustmentIndependent = this.isAdjacentCueAdjustmentIndependent(event.altKey);
      if ((track === 'main' || track === 'overlay') && this.tool === 'razor' && !targetHandle
          && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const timeMs = this.timeFromPointer(event, row);
        const timing = this.cueTiming();
        const cutMs = timing.toMs(timing.fromMs(timeMs));
        if (track === 'overlay') this.options.splitOverlayCueAtTime?.(index, cutMs);
        else this.options.splitCueAtTime?.(index, cutMs);
        return;
      }
      // 相接字幕边界手柄：dual（中缝联动）模式下始终拆开为单侧拖动；
      // classic 模式按“自动吸附调整相邻字幕”开关决定，Alt 临时反转。
      const sharedBoundaryHandleIndependent = this.isSharedBoundaryHandleIndependent(event.altKey);
      if (sharedBoundaryHandleIndependent && targetHandle) {
        const sharedLeft = targetHandle.classList.contains('left')
          && index > 0 && this.isSharedBoundary(event, index - 1, index, row, track);
        const sharedRight = targetHandle.classList.contains('right')
          && index + 1 < this.options.getSegments(track).length
          && this.isSharedBoundary(event, index, index + 1, row, track);
        if (sharedLeft || sharedRight) {
          return this.beginIndependentEdgeDrag(event, index, row, targetHandle, track);
        }
      }
      // Ctrl(Cmd)+click toggles selection without starting a drag
      if (event.ctrlKey || event.metaKey) {
        if (track === 'extension') this.options.toggleExtensionSelection?.(index);
        else if (track === 'overlay') this.options.toggleOverlaySelection?.(index);
        else this.options.toggleCueSelection?.(index);
        return;
      }
      let boundaryIndex = index;
      const kind = targetHandle?.classList.contains('left')
        ? (index > 0 && this.isSharedBoundary(event, index - 1, index, row, track)
          ? (boundaryIndex = index - 1, 'resize-boundary') : 'resize-left')
        : targetHandle?.classList.contains('right')
          ? (index + 1 < this.options.getSegments(track).length && this.isSharedBoundary(event, index, index + 1, row, track)
            ? 'resize-boundary' : 'resize-right')
          : 'move';
      // Shift+click selects a range from lastClickedIdx to index
      if (event.shiftKey) {
        if (track === 'extension') {
          this.options.selectExtensionRange?.(index);
          return;
        }
        if (kind !== 'move') {
          if (track === 'main') this.options.selectCueRange?.(index);
          else if (track === 'overlay') this.options.selectOverlayRange?.(index);
          return;
        }
        // 主轨/叠加轨的 Shift+拖动：拖动期间不改动选择状态（避免把后面的
        // 主字幕一起选进来），邻居挡路时由 applyMoveDrag 动态换轨；
        // 叠加轨字幕拖到与主轨无重叠的位置会自动放回主轨。
        // 主轨无位移松开时 endCueDrag 补做范围选择，保持 Shift+click 语义。
      }
      // 选中字幕会更新列表、面板以及波形块状态；其中任一步都可能触发
      // 虚拟行重建。先保存按下瞬间的几何数据，避免 pointerup 使用已脱离
      // DOM 的旧行并把比例钳到该行末尾（也就是下一行开头）。
      const geometry = this.captureRowGeometry(row);
      const shiftOverlayMove = kind === 'move' && Boolean(event.shiftKey)
        && (track === 'main' || track === 'overlay');
      const selected = this.options.getSelection(track);
      if (!shiftOverlayMove) {
        if (!selected.has(index)) {
          if (track === 'extension') this.options.selectExtensionCue?.(index);
          else if (track === 'overlay') this.options.selectOverlayCue?.(index);
          else this.options.selectCue(index);
        } else if (track === 'extension') {
          this.options.activateExtensionCue?.(index);
        } else if (track === 'overlay') {
          this.options.activateOverlayCue?.(index);
        } else {
          this.options.activateCue?.(index);
        }
      }
      const liveSelection = this.options.getSelection(track);
      const indices = kind === 'move' && !shiftOverlayMove && liveSelection.has(index)
        ? [...liveSelection].sort((a, b) => a - b) : [index];
      const segments = this.options.getSegments(track);
      const timing = this.cueTiming();
      const dragIndices = kind === 'resize-boundary' ? [boundaryIndex, boundaryIndex + 1] : indices;
      const originals = new Map(dragIndices.map((idx) => [idx, snapshotTiming(segments[idx], timing)]));
      const cancelIndices = new Set(dragIndices);
      if (kind === 'move') {
        dragIndices.forEach((idx) => {
          if (segments[idx - 1] && isAttached(segments[idx - 1], segments[idx], timing)) cancelIndices.add(idx - 1);
          if (segments[idx + 1] && isAttached(segments[idx], segments[idx + 1], timing)) cancelIndices.add(idx + 1);
        });
      }
      const allOriginals = kind === 'move'
        ? new Map(segments.map((segment, idx) => [idx, snapshotTiming(segment, timing)]))
        : null;
      const cancelOriginals = new Map([...cancelIndices].map((idx) => [idx, snapshotTiming(segments[idx], timing)]));
      if (allOriginals) {
        allOriginals.forEach((original, idx) => cancelOriginals.set(idx, original));
      }
      this.drag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        currentClientX: event.clientX,
        lastPointerPosition: { clientX: event.clientX, clientY: event.clientY },
        rangeMs: geometry.endMs - geometry.startMs,
        rowWidth: geometry.width,
        geometry,
        kind,
        track,
        index: kind === 'resize-boundary' ? boundaryIndex : index,
        indices: dragIndices,
        row,
        originals,
        cancelOriginals,
        timing,
        startPointerTime: timing.fromMs(this.timeFromPointerUnbounded(event, row, geometry)),
        commitIndices: new Set(dragIndices),
        started: false,
        changed: false,
        // Alt+副字幕拖动临时解除主副联动；Alt+主字幕拖动仍带着绑定的
        // 副字幕一起走，但允许先挤压主轨相邻字幕。
        independent: Boolean(event.altKey && track === 'extension'),
        allowSqueeze: false,
        squeezeOriginals: allOriginals,
        // Shift+拖动：只拖被抓住的一条；邻居挡路时转入叠加轨继续移动。
        shiftOverlay: shiftOverlayMove,
        shiftRangeSelect: (track === 'main' || track === 'overlay') && Boolean(event.shiftKey),
        convertedToOverlay: false,
        altToggleDisabledOnClick: Boolean(
          event.altKey && !targetHandle
            && !event.shiftKey && !event.ctrlKey && !event.metaKey,
        ),
        seekedOnPointerDown: false,
        captureTarget: event.currentTarget,
      };
      if (this.isCueBoundaryDrag()) {
        this.cancelHoverSeekPreview();
        this.refreshBoundaryDragPointerLine(true);
      }
      event.currentTarget.classList.add('dragging');
      this.pane.classList.add('cue-drag-active');
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch (_) {}
      window.addEventListener('pointermove', this._dragMove = (moveEvent) => this.moveCueDrag(moveEvent));
      window.addEventListener('pointerup', this._dragEnd = (upEvent) => this.endCueDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._dragEnd, { once: true });

      // 普通字幕块点击的跳转与波形空白区保持一致：在按下时立即移动播放头。
      // 只有普通 move 点击进入此路径；修饰键和边界手柄仍只执行选择/拖动操作。
      const clickBehavior = this.options.getClickBehavior?.();
      if (kind === 'move' && clickBehavior !== 'select-only' && !event.altKey && !shiftOverlayMove) {
        this.seekFromCue(event, row, index, clickBehavior === 'select-and-play', geometry, track);
        this.drag.seekedOnPointerDown = true;
      }
    }


    isSharedBoundary(event, leftIndex, rightIndex, row, track = 'main') {
      const segments = this.options.getSegments(track);
      const left = segments[leftIndex];
      const right = segments[rightIndex];
      const timing = this.cueTiming();
      const leftEnd = timing.getEnd(left);
      const rightStart = timing.getStart(right);
      if (!left || !right || Math.abs(leftEnd - rightStart) > timing.snapThreshold) return false;
      const pointerMs = this.timeFromPointer(event, row);
      const pointerTime = timing.fromMs(pointerMs);
      return Math.abs(pointerTime - leftEnd) <= timing.snapThreshold
        || Math.abs(pointerTime - rightStart) <= timing.snapThreshold;
    }


    // Alt-drag 命中共享边界手柄：只拖动被命中一侧，邻居的相反边保持不动。
    // 默认（非 Alt）拖动共享边界会把两侧一起联动；本方法是该联动的独立拆开版本。
    beginIndependentEdgeDrag(event, index, row, targetHandle, track = 'main') {
      const segments = this.options.getSegments(track);
      const isLeftHandle = targetHandle.classList.contains('left');
      // left 手柄命中 index-1|index 共享边界 → 移动 index 段的 start；
      // right 手柄命中 index|index+1 共享边界 → 移动 index 段的 end。
      const movedIndex = isLeftHandle ? index : index;
      const edge = isLeftHandle ? 'start' : 'end';
      const dragIndex = isLeftHandle ? index - 1 : index; // 左侧段索引，用于 applyIndependentEdge
      const geometry = this.captureRowGeometry(row);
      const timing = this.cueTiming();
      const originals = new Map([[movedIndex, snapshotTiming(segments[movedIndex], timing)]]);
      this.drag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        currentClientX: event.clientX,
        lastPointerPosition: { clientX: event.clientX, clientY: event.clientY },
        rangeMs: geometry.endMs - geometry.startMs,
        rowWidth: geometry.width,
        geometry,
        kind: 'resize-boundary-independent',
        track,
        index: movedIndex,
        edge,
        dragIndex,
        indices: [movedIndex],
        row,
        originals,
        cancelOriginals: new Map([[movedIndex, snapshotTiming(segments[movedIndex], timing)]]),
        timing,
        startPointerTime: timing.fromMs(this.timeFromPointerUnbounded(event, row, geometry)),
        commitIndices: new Set([movedIndex]),
        started: false,
        changed: false,
        independent: true,
        captureTarget: event.currentTarget,
      };
      this.cancelHoverSeekPreview();
      this.refreshBoundaryDragPointerLine(true);
      event.currentTarget.classList.add('dragging');
      this.pane.classList.add('cue-drag-active');
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch (_) {}
      window.addEventListener('pointermove', this._dragMove = (moveEvent) => this.moveCueDrag(moveEvent));
      window.addEventListener('pointerup', this._dragEnd = (upEvent) => this.endCueDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._dragEnd, { once: true });
    }


    // 中缝拖动区（dual 模式）：按下即开始共享边界联动拖动，两侧边界
    // 一起移动；plain 点击（未拖动）按点击行为跳转，等价于点击右侧字幕块。
    beginSharedBoundaryZoneDrag(event, leftIndex, row, track = 'main') {
      if (event.button !== 0) return;
      if (this.tool === 'razor') return;
      event.preventDefault();
      event.stopPropagation();
      this.focusWaveform();
      const segments = this.options.getSegments(track);
      const rightIndex = leftIndex + 1;
      if (!segments[leftIndex] || !segments[rightIndex]) return;
      // Ctrl(Cmd)/Shift 的选择语义与点击右侧字幕块的边界手柄一致。
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        if (track === 'extension') this.options.toggleExtensionSelection?.(rightIndex);
        else this.options.toggleCueSelection?.(rightIndex);
        return;
      }
      if (event.shiftKey) {
        if (track === 'extension') this.options.selectExtensionRange?.(rightIndex);
        else this.options.selectCueRange?.(rightIndex);
        return;
      }
      // 选择可能触发行重建，先保存按下瞬间的几何数据（与 beginCueDrag 相同）。
      const geometry = this.captureRowGeometry(row);
      // 普通中缝点击替换为相邻两句的选区；Ctrl/Cmd 与 Shift 已在上面保留
      // 原本的切换和范围选择语义。面板聚焦右侧字幕。
      if (track === 'extension') {
        this.options.selectExtensionCue?.(leftIndex);
        this.options.addExtensionSelection?.([rightIndex]);
        this.options.activateExtensionCue?.(rightIndex);
      } else {
        this.options.selectCue(leftIndex);
        this.options.addCueSelection?.([rightIndex]);
        this.options.activateCue?.(rightIndex);
      }
      const timing = this.cueTiming();
      const originals = new Map(
        [leftIndex, rightIndex].map((idx) => [idx, snapshotTiming(segments[idx], timing)]),
      );
      this.drag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        currentClientX: event.clientX,
        lastPointerPosition: { clientX: event.clientX, clientY: event.clientY },
        rangeMs: geometry.endMs - geometry.startMs,
        rowWidth: geometry.width,
        geometry,
        kind: 'resize-boundary',
        track,
        index: leftIndex,
        indices: [leftIndex, rightIndex],
        row,
        originals,
        cancelOriginals: new Map(originals),
        timing,
        startPointerTime: timing.fromMs(this.timeFromPointerUnbounded(event, row, geometry)),
        commitIndices: new Set([leftIndex, rightIndex]),
        started: false,
        changed: false,
        independent: false,
        allowSqueeze: false,
        squeezeOriginals: null,
        altToggleDisabledOnClick: false,
        seekedOnPointerDown: false,
        sharedBoundaryZone: true,
        previewRowIndex: Number(row.dataset.rowIndex),
        captureTarget: this.pane,
      };
      this.cancelHoverSeekPreview();
      this.refreshBoundaryDragPointerLine(true);
      event.currentTarget.classList.add('dragging');
      this.pane.classList.add('cue-drag-active');
      this.pane.classList.add('shared-boundary-drag-active');
      try { this.pane.setPointerCapture?.(event.pointerId); } catch (_) {}
      window.addEventListener('pointermove', this._dragMove = (moveEvent) => this.moveCueDrag(moveEvent));
      window.addEventListener('pointerup', this._dragEnd = (upEvent) => this.endCueDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._dragEnd, { once: true });
    }


    cueDragDurationMs() {
      return Number(this.durationMs) > 0 ? Number(this.durationMs) : Infinity;
    }


    cueTiming() {
      return resolveTiming(this.options.getCueTiming?.());
    }


    cueTimingDuration() {
      const clock = this.cueTiming();
      const durationMs = this.cueDragDurationMs();
      return Number.isFinite(durationMs) ? clock.fromMs(durationMs) : Infinity;
    }


    cueTimingValueFromMs(valueMs, timing = null) {
      const clock = resolveTiming(timing || this.options.getCueTiming?.());
      return clock.fromMs(valueMs);
    }


    cueTimingValueToMs(value, timing = null) {
      const clock = resolveTiming(timing || this.options.getCueTiming?.());
      return clock.toMs(value);
    }


    formatCueTiming(value, timing = null) {
      const clock = resolveTiming(timing || this.options.getCueTiming?.());
      return clock.format(value);
    }


    captureCueDragOriginals(drag) {
      const segments = this.options.getSegments(drag.track || 'main');
      drag.originals = new Map(drag.indices.map((idx) => [
        idx,
        snapshotTiming(segments[idx], drag.timing || this.cueTiming()),
      ]));
    }


    // Shift+拖动换轨后重建拖动状态：快照取段的当前实际位置为新基准，
    // 并把指针基准平移 rawDelta，使后续帧 position = 基准 +（指针 - 新基准）
    // 连续无跳变；整层重建字幕块并让新块继承拖动视觉（旧元素被移除，
    // 指针监听挂在 window 上，不受元素替换影响）。
    rebaseCueDragToTrack(drag, track, index, clock, deltaShift = 0) {
      drag.track = track;
      drag.index = index;
      drag.indices = [index];
      drag.commitIndices = new Set([index]);
      drag.squeezeOriginals = null;
      drag.allowSqueeze = false;
      drag.convertedToOverlay = track === 'overlay';
      const original = snapshotTiming(this.options.getSegments(track)[index], clock);
      drag.originals = new Map([[index, original]]);
      drag.cancelOriginals = new Map([[index, original]]);
      if (Number.isFinite(deltaShift) && deltaShift) drag.startPointerTime += deltaShift;
      this.refreshCueOverlay();
      this.content.querySelectorAll(`.waveform-cue-block[data-track="${track}"][${track === 'overlay' ? 'data-overlay-idx' : 'data-idx'}="${index}"]`)
        .forEach((block) => block.classList.add('dragging'));
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
