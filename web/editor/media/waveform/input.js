// input: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-input', function createWaveformModule(dependencies) {
  'use strict';
  const { PLAYHEAD_DRAG_SEEK_INTERVAL_MS, POINTER_DRAG_THRESHOLD_PX, ROW_HEIGHT_PRESETS, ROW_PRESETS, SPLIT_FLASH_DURATION_MS, clamp, roundMs, saveSettings, wheelScrollDelta } = dependencies;

  class WaveformMethods {


    seekFromPointer(
      event,
      row,
      playAfterSeek = false,
      geometry = null,
      allowCrossRow = false,
      dragPreview = false,
    ) {
      const requestedMs = this.pointerTimeMs(event, row, geometry, allowCrossRow);
      const timeMs = allowCrossRow
        ? clamp(requestedMs, 0, Math.max(0, this.durationMs))
        : requestedMs;
      this.options.seek(timeMs / 1000, { dragPreview, mouseClick: !dragPreview });
      this.updatePlayback();
      if (playAfterSeek && this.player?.paused) this.options.togglePlayback?.();
    }


    seekFromCue(event, row, index, playAfterSeek = false, geometry = null, track = 'main') {
      const segment = this.options.getSegments(track)[index];
      const timeMs = this.options.getClickTarget?.() === 'pointer'
        ? this.pointerTimeMs(event, row, geometry)
        : Number(segment?.start);
      if (!Number.isFinite(timeMs)) return;
      const wasPlaying = this.options.isPlaybackActive?.() ?? !this.player?.paused;
      this.options.seek(timeMs / 1000, { mouseClick: true });
      this.updatePlayback();
      if (playAfterSeek && this.player?.paused && !wasPlaying) this.options.togglePlayback?.();
    }


    // Ctrl(Cmd)+左键拖动空白波形：显示字幕块虚影，松开后交给编辑器
    // 创建字幕。时间映射固定使用按下时的行几何，避免虚拟行重建或拖出行边界
    // 后把终点错误地映射到另一行。
    beginCreateCueDrag(event, row, track = 'main') {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.focusWaveform();
      const geometry = this.captureRowGeometry(row);
      const timing = this.cueTiming();
      const snapToTimeline = (valueMs) => timing.toMs(timing.fromMs(valueMs));
      const startMs = snapToTimeline(this.timeFromPointer(event, row, geometry));
      if (this.isCueTimeOccupied(startMs, track)) {
        this.options.onCueCreateRejected?.('occupied');
        return;
      }
      const drag = {
        pointerId: event.pointerId,
        row,
        geometry,
        startMs,
        currentMs: startMs,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastEvent: event,
        preview: null,
        frame: 0,
        finish: null,
      };
      this.createCueDrag = drag;

      const updatePosition = (nextEvent) => {
        if (!nextEvent) return;
        drag.lastEvent = nextEvent;
        const requestedMs = this.timeFromPointer(nextEvent, row, geometry);
        // 起点在空白时，拖入已有字幕只把终点挡在字幕边界，
        // 保留之前的“边界阻挡后仍可创建”行为。
        drag.currentMs = this.clampCreateCueTime(
          drag.startMs,
          snapToTimeline(requestedMs),
          track,
        );
      };
      const updatePreview = () => {
        drag.frame = 0;
        if (this.createCueDrag !== drag) return;
        const start = Math.min(drag.startMs, drag.currentMs);
        const end = Math.max(drag.startMs, drag.currentMs);
        if (!drag.preview) {
          drag.preview = document.createElement('div');
          drag.preview.className = 'waveform-cue-block waveform-create-preview';
          drag.preview.dataset.track = track;
          if (track === 'extension') drag.preview.style.setProperty('--cue-color', '#7a9fc5');
          if (track === 'overlay') {
            // 叠加字幕创建虚影落在叠加轨 lane（上半区），与正式叠加块同位；
            // 行高不足 84px 时同样切 cover 模式，直接盖在主字幕块上方。
            drag.preview.classList.add('waveform-overlay-block');
            const rowHeightPx = Number.parseFloat(row.style.height) || 0;
            if (rowHeightPx > 0 && rowHeightPx < 84) {
              drag.preview.classList.add('overlay-cover-mode');
            }
          }
          const label = document.createElement('span');
          label.className = 'waveform-cue-label';
          drag.preview.appendChild(label);
          row.appendChild(drag.preview);
        }
        const duration = Math.max(1, geometry.endMs - geometry.startMs);
        drag.preview.style.left = `${clamp(((start - geometry.startMs) / duration) * 100, 0, 100)}%`;
        drag.preview.style.width = `${Math.max(0.25, clamp(((end - start) / duration) * 100, 0, 100))}%`;
        const startTime = timing.fromMs(roundMs(start));
        const endTime = timing.fromMs(roundMs(end));
        const durationTime = timing.fromMs(roundMs(end - start));
        drag.preview.firstElementChild.textContent = `${timing.format(startTime)} → ${timing.format(endTime)} · ${timing.format(durationTime)}`;
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (drag.frame) {
          cancelAnimationFrame(drag.frame);
          drag.frame = 0;
        }
        try { row.releasePointerCapture?.(drag.pointerId); } catch (_) {}
        drag.preview?.remove();
        drag.preview = null;
      };
      const finish = (commit, finalEvent = null) => {
        if (this.createCueDrag !== drag) return;
        if (finalEvent) updatePosition(finalEvent);
        const start = snapToTimeline(roundMs(Math.min(drag.startMs, drag.currentMs)));
        const end = snapToTimeline(roundMs(Math.max(drag.startMs, drag.currentMs)));
        cleanup();
        this.createCueDrag = null;
        if (!commit) return;
        if (end - start < timing.toMs(timing.minDuration)) {
          this.options.onCueCreateRejected?.('too-short', start, end);
          return;
        }
        this.options.addCueRange?.(start, end, drag.startClientX, drag.startClientY, track);
      };
      drag.finish = finish;
      try { row.setPointerCapture?.(drag.pointerId); } catch (_) {}

      const onMove = (moveEvent) => {
        if (this.createCueDrag !== drag) return;
        if (!(moveEvent.buttons & 1)) {
          finish(true, moveEvent);
          return;
        }
        updatePosition(moveEvent);
        if (!drag.frame) drag.frame = requestAnimationFrame(updatePreview);
      };
      const onUp = (upEvent) => finish(true, upEvent);
      const onCancel = () => finish(false);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    }


    captureRowGeometry(row) {
      const rect = row.getBoundingClientRect();
      // 时间映射与覆盖层/指示线统一用 content-box：行有 1px 边框，
      // border-box 会让指针位置与实际生效边界差出边框宽度。
      return {
        left: rect.left + row.clientLeft,
        width: Math.max(1, row.clientWidth),
        startMs: Number(row.dataset.startMs),
        endMs: Number(row.dataset.endMs),
      };
    }


    trackAtPoint(clientX, clientY, row = null) {
      const hit = document.elementFromPoint(clientX, clientY);
      const hitRow = row || hit?.closest?.('.waveform-row');
      if (!hitRow || !this.pane?.contains(hitRow)) return 'main';
      const block = hit?.closest?.('.waveform-cue-block');
      if (block?.dataset.track === 'extension') return 'extension';
      if (!hitRow.classList.contains('multi-subtitle-row')) return 'main';
      const rowRect = hitRow.getBoundingClientRect();
      const rowStyle = getComputedStyle(hitRow);
      const parsePx = (value, fallback) => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      const bottomInset = parsePx(rowStyle.getPropertyValue('--multi-subtitle-bottom-inset'), 7);
      const visibleCue = hitRow.querySelector(
        '.waveform-cue-block[data-track="main"], .waveform-cue-block[data-track="extension"]',
      );
      const visibleCueHeight = visibleCue?.getBoundingClientRect().height || 0;
      const markerStyle = getComputedStyle(hitRow, '::after');
      const markerHeight = parsePx(markerStyle.height, 15);
      const markerBottom = parsePx(markerStyle.bottom, NaN);
      const markerLaneHeight = Number.isFinite(markerBottom)
        ? 2 * (markerBottom - bottomInset) + markerHeight : 0;
      const laneHeight = visibleCueHeight > 0
        ? visibleCueHeight
        : markerLaneHeight > 0
          ? markerLaneHeight
          : Math.min(35, Math.max(0, (rowRect.height - bottomInset * 2) / 2));
      const extensionTop = rowRect.height - bottomInset - laneHeight;
      return clientY - rowRect.top >= extensionTop ? 'extension' : 'main';
    }


    isCueTimeOccupied(timeMs, track = 'main') {
      const time = Number(timeMs);
      if (!Number.isFinite(time)) return false;
      const segments = this.options.getSegments?.(track) || [];
      return segments.some((segment) => {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        return Number.isFinite(start) && Number.isFinite(end)
          && start < time && time < end;
      });
    }


    // 创建字幕的拖动不能跨过已有字幕；沿拖动方向把当前端点夹到遇到的
    // 第一个字幕边界。这样预览和最终提交使用同一组无重叠时间范围。
    clampCreateCueTime(anchorMs, requestedMs, track = 'main') {
      if (!Number.isFinite(anchorMs) || !Number.isFinite(requestedMs) || anchorMs === requestedMs) {
        return requestedMs;
      }
      const segments = this.options.getSegments?.(track) || [];
      if (segments.some((segment) => {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        return Number.isFinite(start) && Number.isFinite(end)
          && start < anchorMs && anchorMs < end;
      })) return anchorMs;
      const movingRight = requestedMs > anchorMs;
      let boundary = movingRight ? Infinity : -Infinity;
      for (const segment of segments) {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        if (movingRight) {
          if (start >= anchorMs && start <= requestedMs) boundary = Math.min(boundary, start);
        } else if (end <= anchorMs && end >= requestedMs) {
          boundary = Math.max(boundary, end);
        }
      }
      return Number.isFinite(boundary) ? boundary : requestedMs;
    }


    beginBlockedCueCreateDrag(event, index, track = 'main', row = null) {
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let finished = false;
      let moved = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        try { target.releasePointerCapture?.(pointerId); } catch (_) {}
      };
      const onMove = (moveEvent) => {
        if (finished || moveEvent.pointerId !== pointerId) return;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (dx * dx + dy * dy < 16) return;
        moved = true;
        cleanup();
        // 叠加轨启用时，在主轨字幕上按住拖动 = 从按下位置在叠加轨创建字幕：
        // 复用空白处的创建拖动（锚点为按下时间），叠加轨同轨占用仍拒绝。
        if (track === 'main' && row && this.options.getOverlayCreateEnabled?.() === true) {
          this.beginCreateCueDrag(event, row, 'overlay');
          return;
        }
        this.options.onCueCreateRejected?.('occupied');
      };
      const onUp = () => {
        if (finished) return;
        cleanup();
        if (!moved) {
          if (track === 'extension') this.options.toggleExtensionSelection?.(index);
          else if (track === 'overlay') this.options.toggleOverlaySelection?.(index);
          else this.options.toggleCueSelection?.(index);
        }
      };
      const onCancel = () => cleanup();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      try { target.setPointerCapture?.(pointerId); } catch (_) {}
    }


    timeFromPointer(event, row, geometry = null) {
      const contentLeft = geometry ? geometry.left : row.getBoundingClientRect().left + row.clientLeft;
      const contentWidth = Math.max(1, geometry ? geometry.width : row.clientWidth);
      const ratio = clamp((event.clientX - contentLeft) / contentWidth, 0, 1);
      const startMs = geometry?.startMs ?? Number(row.dataset.startMs);
      const endMs = geometry?.endMs ?? Number(row.dataset.endMs);
      return startMs + ratio * (endMs - startMs);
    }


    // Gap、字幕块和字幕边界拖动都按起始行的横向位移计算；指针越过行边缘时
    // 继续延伸时间，避免拖动在本行末尾饱和或进入另一行时发生跳变。
    timeFromPointerUnbounded(event, row, geometry = null) {
      const contentLeft = geometry ? geometry.left : row.getBoundingClientRect().left + row.clientLeft;
      const contentWidth = Math.max(1, geometry ? geometry.width : row.clientWidth);
      const ratio = (event.clientX - contentLeft) / contentWidth;
      const startMs = geometry?.startMs ?? Number(row.dataset.startMs);
      const endMs = geometry?.endMs ?? Number(row.dataset.endMs);
      return startMs + ratio * (endMs - startMs);
    }


    // 在波形指针拆分成功后短暂显示黄色定位光条，帮助用户确认实际操作位置。
    // 光条只覆盖波形行，不参与鼠标命中，也不影响红色播放头。
    flashSplitAtTime(timeMs) {
      if (!Number.isFinite(timeMs)) return false;
      const rows = [...this.content.querySelectorAll('.waveform-row')];
      const row = rows.find((candidate) => {
        const startMs = Number(candidate.dataset.startMs);
        const endMs = Number(candidate.dataset.endMs);
        return timeMs >= startMs && timeMs <= endMs;
      });
      if (!row) return false;

      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      const marker = row.querySelector('.waveform-split-flash');
      if (!marker) return false;
      if (marker._hideTimer) window.clearTimeout(marker._hideTimer);
      marker.hidden = false;
      marker.style.left = `${((timeMs - startMs) / Math.max(1, endMs - startMs)) * 100}%`;
      marker.classList.remove('is-active');
      // 强制重新计算布局，让连续两次 B 也能重启动画。
      void marker.offsetWidth;
      marker.classList.add('is-active');
      marker._hideTimer = window.setTimeout(() => {
        marker.classList.remove('is-active');
        marker.hidden = true;
        marker._hideTimer = 0;
      }, SPLIT_FLASH_DURATION_MS);
      return true;
    }


    // 返回波形字幕切点的屏幕坐标，供全屏反馈动画把中心落在实际切分位置。
    getSplitPointAtTime(timeMs, track = 'main') {
      if (!Number.isFinite(timeMs)) return null;
      const rows = [...this.content.querySelectorAll('.waveform-row')];
      const row = rows.find((candidate) => {
        const startMs = Number(candidate.dataset.startMs);
        const endMs = Number(candidate.dataset.endMs);
        return timeMs >= startMs && timeMs <= endMs;
      });
      if (!row) return null;
      const rowStart = Number(row.dataset.startMs);
      const rowEnd = Number(row.dataset.endMs);
      const rowRect = row.getBoundingClientRect();
      const ratio = clamp((timeMs - rowStart) / Math.max(1, rowEnd - rowStart), 0, 1);
      const selector = `.waveform-cue-block[data-track="${track === 'extension' ? 'extension' : track === 'overlay' ? 'overlay' : 'main'}"]`;
      const block = [...row.querySelectorAll(selector)].find((candidate) => {
        const startMs = Number(candidate.dataset.start);
        const endMs = Number(candidate.dataset.end);
        return timeMs >= startMs && timeMs <= endMs;
      });
      const blockRect = block?.getBoundingClientRect?.();
      return {
        clientX: rowRect.left + row.clientLeft + row.clientWidth * ratio,
        clientY: blockRect ? blockRect.top + blockRect.height / 2 : rowRect.top + rowRect.height / 2,
      };
    }


    // 屏幕坐标 -> 波形时间：命中某个波形行时返回该行内的时间（毫秒），否则返回 null。
    // 供键盘快捷键（如 B 按指针音频位置拆分）在不构造指针事件的情况下复用行内映射。
    timeMsAtPoint(clientX, clientY) {
      const hit = document.elementFromPoint(clientX, clientY);
      const row = hit?.closest?.('.waveform-row');
      if (!row || !this.pane?.contains(row)) return null;
      const timeMs = this.pointerTimeMs({ clientX }, row);
      return Number.isFinite(timeMs) ? timeMs : null;
    }


    // 「允许拖动指针」：在波形空白区域按住左键拖动时，播放指针实时跟随鼠标
    // 所在位置。高回报率指针事件用 rAF 合并，并限制连续 seek 的频率，避免
    // 浏览器反复解码和编辑器刷新造成拖动卡顿；松开时以最终位置再 seek 一次
    // 保证落点精确。多行模式下允许拖出当前行边界，并把时间限制在整个媒体范围内。
    beginPlayheadDrag(event, row, geometry = null) {
      geometry = geometry || this.captureRowGeometry(row);
      try { row.setPointerCapture?.(event.pointerId); } catch (_) {}
      let frame = 0;
      let lastEvent = null;
      let lastSeekAt = -Infinity;
      let active = true;
      let dragging = false;
      let moved = false;
      const startX = event.clientX;
      const startY = event.clientY;
      const flush = () => {
        frame = 0;
        if (!lastEvent) return;
        const now = performance.now();
        if (now - lastSeekAt < PLAYHEAD_DRAG_SEEK_INTERVAL_MS) {
          frame = requestAnimationFrame(flush);
          return;
        }
        const eventToSeek = lastEvent;
        lastEvent = null;
        lastSeekAt = now;
        this.seekFromPointer(eventToSeek, row, false, geometry, true, true);
      };
      const cleanup = () => {
        if (!active) return;
        active = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        try { row.releasePointerCapture?.(event.pointerId); } catch (_) {}
        lastEvent = null;
        if (dragging) {
          this.playheadDragActive = false;
          this.cancelHoverSeekPreview();
          this.options.onPlayheadDragStateChange?.(false);
        }
      };
      const onMove = (moveEvent) => {
        if (!(moveEvent.buttons & 1)) { cleanup(); return; }
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >= POINTER_DRAG_THRESHOLD_PX) {
          moved = true;
          if (!dragging) {
            dragging = true;
            this.playheadDragActive = true;
            this.cancelHoverSeekPreview();
            this.options.onPlayheadDragStateChange?.(true);
          }
        }
        lastEvent = moveEvent;
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const onUp = (upEvent) => {
        cleanup();
        if (moved) this.seekFromPointer(upEvent, row, false, geometry, true, false);
      };
      const onCancel = () => cleanup();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
      window.addEventListener('pointercancel', onCancel, { once: true });
    }


    // Shift+左键框选：在波形空白处按下并拖动，画出选框，松开后把与选框相交的
    // 字幕块追加进当前多选（与 Shift 范围选同为追加语义）。选框挂在
    // #waveform-content 内、与行同坐标系，滚动时自动跟随；多行虚拟化重建
    // 会清掉覆盖层与块上的预览类，因此每帧重新挂载、重新命中。位移低于
    // 阈值的 Shift+点击视为空操作，不触发空白区既有的清除选中/seek。
    beginMarqueeDrag(event) {
      const content = this.content;
      const startRect = content.getBoundingClientRect();
      const start = { x: event.clientX - startRect.left, y: event.clientY - startRect.top };
      let lastEvent = event;
      let overlay = null;
      let frame = 0;
      let drawing = false;
      let hits = { main: new Set(), extension: new Set() };

      const clearPreview = () => {
        content.querySelectorAll('.waveform-cue-block.marquee-preview').forEach((block) => {
          block.classList.remove('marquee-preview');
        });
      };
      const removeOverlay = () => {
        if (overlay) overlay.remove();
        overlay = null;
      };
      const update = () => {
        frame = 0;
        const rect = content.getBoundingClientRect();
        const current = { x: lastEvent.clientX - rect.left, y: lastEvent.clientY - rect.top };
        if (!drawing) {
          if (Math.hypot(current.x - start.x, current.y - start.y) < 4) return;
          drawing = true;
        }
        if (!overlay || !overlay.isConnected) {
          overlay = document.createElement('div');
          overlay.className = 'waveform-marquee';
          content.appendChild(overlay);
        }
        const left = Math.min(start.x, current.x);
        const top = Math.min(start.y, current.y);
        overlay.style.left = `${left}px`;
        overlay.style.top = `${top}px`;
        overlay.style.width = `${Math.abs(current.x - start.x)}px`;
        overlay.style.height = `${Math.abs(current.y - start.y)}px`;
        const marqueeRect = overlay.getBoundingClientRect();
        const next = { main: new Set(), extension: new Set() };
        content.querySelectorAll('.waveform-cue-block[data-track="main"], .waveform-cue-block[data-track="extension"]').forEach((block) => {
          const blockRect = block.getBoundingClientRect();
          const hit =
            !block.hidden &&
            blockRect.right > marqueeRect.left &&
            blockRect.left < marqueeRect.right &&
            blockRect.bottom > marqueeRect.top &&
            blockRect.top < marqueeRect.bottom;
          block.classList.toggle('marquee-preview', hit);
          if (!hit) return;
          const track = block.dataset.track === 'extension' ? 'extension' : 'main';
          const rawIndex = track === 'extension' ? block.dataset.extIdx : block.dataset.idx;
          const index = Number(rawIndex);
          if (Number.isInteger(index)) next[track].add(index);
        });
        hits = next;
      };
      const finish = (commit) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        // 以指针最终位置补一次命中计算，避免快速松开时结果落后一帧
        if (commit) update();
        clearPreview();
        removeOverlay();
        if (commit && drawing) {
          if (hits.main.size > 0) {
            this.options.addCueSelection?.([...hits.main].sort((a, b) => a - b));
          }
          if (hits.extension.size > 0) {
            this.options.addExtensionSelection?.([...hits.extension].sort((a, b) => a - b));
          }
        }
      };
      const onMove = (moveEvent) => {
        if (!(moveEvent.buttons & 1)) {
          finish(true);
          return;
        }
        lastEvent = moveEvent;
        if (!frame) frame = requestAnimationFrame(update);
      };
      const onUp = (upEvent) => {
        lastEvent = upEvent;
        finish(true);
      };
      const onCancel = () => finish(false);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    }


    handleWheel(event) {
      const scrollDelta = wheelScrollDelta(event);
      if (!scrollDelta) return;
      this.autoScrolling = false;
      this.autoScrollTarget = null;
      this.multiFollowCheckPending = true;
      if (this.isMultiMode() && (event.ctrlKey || event.metaKey) && event.shiftKey) {
        // Ctrl(Cmd)+Shift+滚轮：仅多行模式下循环调整行高预设，向上滚放大，不改变时间映射
        event.preventDefault();
        const current = ROW_HEIGHT_PRESETS.indexOf(this.settings.rowHeight);
        const next = clamp(current + (scrollDelta > 0 ? -1 : 1), 0, ROW_HEIGHT_PRESETS.length - 1);
        if (next !== current) {
          this.scheduleRowHeightChange(scrollDelta > 0 ? -1 : 1);
        }
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        // 用 rAF 合并高频滚轮：一帧内累加方向，避免每次 wheel 都重渲染导致卡顿
        this.pendingScaleDirection += scrollDelta > 0 ? -1 : 1;
        this.scheduleWheelScaleChange();
        return;
      }
      if (this.settings.mode === 'basic') {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          this.changeZoom(scrollDelta > 0 ? 1 : -1);
          return;
        }
        const windowMs = this.settings.visibleSeconds * 1000;
        const maxStart = Math.max(0, this.durationMs - windowMs);
        const delta = Math.sign(scrollDelta) * windowMs * 0.12;
        this.basicWindowStartMs = clamp(this.basicWindowStartMs + delta, 0, maxStart);
        this.manualFollowUntil = Date.now() + 3000;
        this.scheduleBasicRender();
        return;
      }
      if (this.isMultiMode() && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        const current = ROW_PRESETS.indexOf(this.settings.secondsPerRow);
        const next = clamp(current + (scrollDelta > 0 ? 1 : -1), 0, ROW_PRESETS.length - 1);
        if (next !== current) {
          this.settings.secondsPerRow = ROW_PRESETS[next];
          this.secondsPerRowSelect.value = String(this.settings.secondsPerRow);
          saveSettings(this.settings);
          this.renderMulti();
        }
      }
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
