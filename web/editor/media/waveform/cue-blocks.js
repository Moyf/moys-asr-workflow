// cue-blocks: waveform class methods with explicit dependencies.
export function createWaveformModule(dependencies) {
  'use strict';
  const { colorForSegment, cueBlockContinuationEdges, findActiveCueIndex, firstCueIndexOverlapping, formatCompact, gapOperationAllowsBoundary, gapOperationAllowsMiddle, gapRemoveDisplayLabel, hasSubtitleColor, isActiveCueVisualHit, localizedWaveformMessage } = dependencies;

  class WaveformMethods {


    /** @this {import('./waveform-types.js').WaveformInstance} */
    createRow(startMs, endMs, rowIndex, basic, groupBadges = null) {
      const row = /** @type {import('./waveform-types.js').WaveformRow} */ (document.createElement('div'));
      row.className = 'waveform-row';
      const multiLane = this.options.multiSubtitleVisible?.() === true;
      if (multiLane) {
        row.classList.add('multi-subtitle-row');
        if (this.options.showTrackBadges?.() === true) row.classList.add('show-track-badges');
      }
      row.dataset.startMs = String(startMs);
      row.dataset.endMs = String(endMs);
      row.dataset.rowIndex = String(rowIndex);
      if (basic) row.dataset.basic = 'true';

      const canvas = document.createElement('canvas');
      canvas.className = 'waveform-canvas';
      row.appendChild(canvas);

      const time = document.createElement('div');
      time.className = 'waveform-row-time';
      time.textContent = `${formatCompact(startMs)} → ${formatCompact(endMs)}`;
      row.appendChild(time);

      const playhead = document.createElement('div');
      playhead.className = 'waveform-playhead';
      playhead.hidden = true;
      row.appendChild(playhead);
      row._waveformPlayhead = playhead;

      const pointerLine = document.createElement('div');
      pointerLine.className = 'waveform-pointer-line';
      pointerLine.hidden = true;
      pointerLine.setAttribute('aria-hidden', 'true');
      row.appendChild(pointerLine);

      const splitFlash = document.createElement('div');
      splitFlash.className = 'waveform-split-flash';
      splitFlash.hidden = true;
      row.appendChild(splitFlash);

      this.appendGapBlocks(row, startMs, endMs);
      this.appendCueBlocks(row, startMs, endMs, groupBadges || this.computeGroupBadgesCached(this.options.getSegments('main')));
      // 通用 Marker / Region 轨道：遵守标记编辑开关，启用时空轨也可添加标记。
      this.appendMarkerTrack(row, startMs, endMs);

      row.addEventListener('pointerdown', (event) => {
        // 每次按下时读取最新模式；设置切换会重绘空隙块，但不会重建仍在
        // 可视区内的行，不能使用 createRow 时捕获的旧值。
        if (event.button === 1 && gapOperationAllowsMiddle(this.options.getGapOperationMode?.())) {
          this.beginGapRangeDrag(event, row);
          return;
        }
        // Alt+左键拖动空白处：用与中键增加静音相同的范围操作，
        // 这样不需要切换到“中键拖动”模式也能快速新增空隙。
        if (
          event.button === 0 &&
          event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          !(/** @type {Element | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.waveform-cue-block, .waveform-gap-block')))
        ) {
          this.beginGapRangeDrag(event, row, { removed: true });
          return;
        }
        // Ctrl(Cmd)+左键拖动空白处：按拖动范围创建一条指定时长字幕。
        // 命中字幕块或静音空隙时保留各自已有的选择/边界操作。
        // 叠加轨启用时，主轨被占用的位置不再直接拒绝：改为把创建拖动转入
        // 叠加轨（叠加字幕允许与主字幕时间重叠）；叠加轨同轨仍不重叠。
        if (
          event.button === 0 &&
          (event.ctrlKey || event.metaKey) &&
          !event.shiftKey &&
          !event.altKey &&
          !(/** @type {Element | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.waveform-cue-block, .waveform-gap-block')))
        ) {
          let track = this.trackAtPoint(event.clientX, event.clientY, row);
          const pointerMs = this.pointerTimeMs(event, row);
          if (this.isCueTimeOccupied(pointerMs, track)) {
            if (
              track === 'main' &&
              this.options.getOverlayCreateEnabled?.() === true &&
              !this.isCueTimeOccupied(pointerMs, 'overlay')
            ) {
              track = 'overlay';
            } else {
              event.preventDefault();
              event.stopPropagation();
              this.options.onCueCreateRejected?.('occupied');
              return;
            }
          }
          event.preventDefault();
          event.stopPropagation();
          this.beginCreateCueDrag(event, row, track);
          return;
        }
        // Shift+左键在空白处拖动：框选字幕块（追加进现有多选），
        // 不进入下方的清除选中/seek/播放头拖拽路径
        if (
          event.button === 0 &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !(/** @type {Element | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.waveform-cue-block, .waveform-gap-block'))) &&
          !this.isCustomLayout()
        ) {
          event.preventDefault();
          this.beginMarqueeDrag(event);
          return;
        }
        if (event.button !== 0 || (/** @type {Element | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.waveform-cue-block, .waveform-gap-block')))) return;
        event.preventDefault();
        // 清除选中会提交当前字幕面板编辑，而提交可能同步重建虚拟行。
        // 在调用外部回调前保存坐标，后续 seek 不依赖可能已脱离 DOM 的 row。
        const geometry = this.captureRowGeometry(row);
        // 普通左键点击空白波形：清除字幕选中并跳转播放头
        this.options.clearSelection?.();
        // 「允许拖动指针」开启时，继续按住左键拖动则指针跟随鼠标位置
        if (this.settings.dragPlayhead) this.beginPlayheadDrag(event, row, geometry);
        this.seekFromPointer(event, row, false, geometry);
      });
      row.addEventListener('pointerenter', (event) => {
        if (this.pointerLineOverrideActive) return;
        this.pointerLineEvent = { clientX: event.clientX };
        this.pointerLineRow = row;
        this.pointerLineMarker = pointerLine;
        this.showPointerLine(event, row, pointerLine);
      });
      row.addEventListener('pointermove', (event) => {
        if (this.pointerLineOverrideActive) return;
        this.pointerLineEvent = { clientX: event.clientX };
        this.pointerLineRow = row;
        this.pointerLineMarker = pointerLine;
        this.showPointerLine(event, row, pointerLine);
        this.scheduleHoverSeekPreview(event, row);
      });
      row.addEventListener('pointerleave', () => {
        if (this.pointerLineOverrideActive) return;
        this.hidePointerLine(pointerLine);
        if (this.pointerLineMarker === pointerLine) {
          this.pointerLineEvent = null;
          this.pointerLineRow = null;
          this.pointerLineMarker = null;
        }
        this.cancelHoverSeekPreview();
      });
      row.addEventListener('auxclick', (event) => {
        if (event.button === 1 && gapOperationAllowsMiddle(this.options.getGapOperationMode?.())) {
          event.preventDefault();
        }
      });
      row.addEventListener('dblclick', (event) => {
        if ((/** @type {Element | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.waveform-cue-block, .waveform-gap-block')))) return;
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        this.options.togglePlayback();
      });
      row.addEventListener('contextmenu', (event) => {
        if ((/** @type {Element | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.waveform-cue-block, .waveform-gap-block')))) return;
        event.preventDefault();
        event.stopPropagation();
        const time = this.pointerTimeMs(event, row);
        const track = this.trackAtPoint(event.clientX, event.clientY, row);
        this.options.showBlankWaveformMenu?.(time, event.clientX, event.clientY, track);
      });
      return row;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    appendGapBlocks(row, startMs, endMs) {
      // Editor/Align 提供的 getter 已经返回共享的最终显示投影；这里不要
      // 对每一行再次做投影，避免多行波形重复扫描同一组 Gap。
      const gaps = this.options.getGapRemoveGaps?.() || [];
      const gapOperationMode = this.options.getGapOperationMode?.() || 'boundary_drag';
      const boundaryEnabled = gapOperationAllowsBoundary(gapOperationMode);
      const middleEnabled = gapOperationAllowsMiddle(gapOperationMode);
      const firstGapIndex = firstCueIndexOverlapping(gaps, startMs);
      for (let index = firstGapIndex; index < gaps.length; index += 1) {
        const gap = gaps[index];
        if (!gap) continue;
        if (gap.start >= endMs) break;
        if (gap.end <= startMs) continue;
        const block = document.createElement('div');
        block.className = 'waveform-gap-block';
        block.dataset.gapIndex = String(index);
        block.classList.toggle('restored', gap.removed === false);
        if (gap.removed !== false) {
          block.classList.toggle(
            'protected',
            window.AsrGapRemoveCore.isGapRemoveDisplayProtected(gap),
          );
        }
        block.classList.toggle('boundary-editable', boundaryEnabled);
        block.title = gapRemoveDisplayLabel(gap);
        block.setAttribute('aria-label', block.title);
        const label = document.createElement('span');
        label.className = 'waveform-gap-label';
        label.textContent = gap.removed === false ? '空隙（未激活）' : '空隙';
        block.appendChild(label);
        if (boundaryEnabled) {
          if (gap.start >= startMs) {
            const leftHandle = document.createElement('span');
            leftHandle.className = 'waveform-gap-handle left';
            block.appendChild(leftHandle);
          }
          if (gap.end <= endMs) {
            const rightHandle = document.createElement('span');
            rightHandle.className = 'waveform-gap-handle right';
            block.appendChild(rightHandle);
          }
        }
        this.layoutGapBlock(block, gap, startMs, endMs);
        block.addEventListener('pointerdown', (event) => {
          const handle = (/** @type {Element | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.waveform-gap-handle')));
          if (event.button === 0 && !handle) {
            this.beginGapMoveDrag(
              event,
              index,
              row,
              event.ctrlKey || event.metaKey ? 'copy' : 'move',
            );
            return;
          }
          if (!handle || event.altKey || event.ctrlKey || event.metaKey) return;
          this.beginGapBoundaryDrag(
            event,
            index,
            row,
            handle.classList.contains('left') ? 'start' : 'end',
          );
        });
        block.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (Date.now() < this.suppressGapClickUntil) return;
          if (event.altKey) {
            this.options.toggleGapRemoved?.(index);
            return;
          }
          const timeMs = this.timeFromPointer(event, row);
          this.options.previewGapAt?.(index, timeMs);
          this.options.seek(timeMs / 1000, { mouseClick: true });
          this.updatePlayback();
        });
        block.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        block.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.options.showGapContextMenu?.(event.clientX, event.clientY, index);
        });
        row.appendChild(block);
      }
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    appendCueBlocks(row, startMs, endMs, groupBadges = null) {
      // 传统模式沿用旧版系统光标（ew-resize）；原创边界光标只在
      const multiLane = this.options.multiSubtitleVisible?.() === true;
      // 非双语行：单行波形或行高 ≥96 的多行波形上下等高分层，整句保留
      // 拖动与边界操作；低行高或双语行沿用紧凑叠加布局。
      const wordTimingFullLane = this.options.wordTiming?.enabled
        && !multiLane && (this.settings.mode === 'basic'
          || (this.settings.mode === 'multi' && (Number(this.settings.rowHeight) || 0) >= 96));
      const segments = this.options.getSegments('main');
      const selected = this.options.getSelection('main');
      const bindingMarkerTargets = this.options.getBindingMarkerTargets?.() || {};
      const mainBindingMarkers = bindingMarkerTargets.main;
      const now = this.currentTimeMs();
      const activeMainIndex = findActiveCueIndex(segments, now);
      const badgesByIndex = groupBadges || this.computeGroupBadgesCached(segments);
      const firstMainIndex = firstCueIndexOverlapping(segments, startMs);
      for (let index = firstMainIndex; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.start >= endMs) break;
        if (segment.end <= startMs) continue;
        if (segment.disabled && (this.options.getHideDisabled?.() || this.settings.disabledDisplay === 'hidden')) continue;
        const block = document.createElement('div');
        block.className = 'waveform-cue-block';
        block.dataset.idx = String(index);
        block.dataset.start = String(segment.start);
        block.dataset.end = String(segment.end);
        block.style.setProperty('--cue-color', colorForSegment(segment));
        if (hasSubtitleColor(segment)) block.classList.add('has-subtitle-color');
        if (selected.has(index)) block.classList.add('selected');
        if (segment.disabled) block.classList.add('disabled');
        // 空隙中沿用的当前字幕不点亮 active 轮廓（仅视觉；逻辑语义不变）。
        if (index === activeMainIndex && isActiveCueVisualHit(segments, index, now)) block.classList.add('active');

        const label = document.createElement('span');
        label.className = 'waveform-cue-label';
        label.textContent = segment.text.replace(/\s+/g, ' ');
        block.appendChild(label);
        this.setBindingMarker(block, mainBindingMarkers?.has?.(index) === true);
        // 短块内文字会被截断，悬浮 title 给出完整字幕文本
        block.title = label.textContent;
        const badges = this.settings.showGroupBadges !== false ? badgesByIndex.get(index) : null;
        if (badges?.length) {
          // 徽章挂在行上、块上方（不遮挡块内文字）；短字幕也保留最小显示空间，
          // 让分组提示可以正常出现。
          const badgeDuration = Math.max(1, endMs - startMs);
          const badgeVisibleStart = Math.max(startMs, segment.start);
          const badgeVisibleEnd = Math.min(endMs, segment.end);
          // 行创建时还未挂载（clientWidth=0），用容器宽度估算块像素宽（行宽=容器宽）
          const blockWidthPx = ((badgeVisibleEnd - badgeVisibleStart) / badgeDuration)
            * (row._waveformCanvasWidth || this.content.clientWidth);
          if (blockWidthPx >= 24) badges.forEach((badge, badgeIndex) => {
            const badgeEl = document.createElement('span');
            badgeEl.className = `waveform-cue-badge ${badge.type}${wordTimingFullLane ? ' word-timing-full' : ''}`;
            badgeEl.textContent = badge.type === 'sticker' && badge.total === 1
              ? '🦊'
              : `${badge.type === 'color' ? '🎨' : '🦊'} ${badge.ordinal}/${badge.total}`;
            badgeEl.style.left = `${((badgeVisibleStart - startMs) / badgeDuration) * 100}%`;
            badgeEl.style.setProperty('--badge-stack-index', String(badgeIndex));
            badgeEl.dataset.segId = segment.id;
            row.appendChild(badgeEl);
          });
        }
        // 字词时间码模式下整句块退为背景，但选中句仍保留两端手柄，
        // 让用户能在这个模式下拖动整句边界；未选中句不显示，避免与字词块抢指针。
        // 等高分层（full）时字幕块保持全功能：手柄常显、拖动行为与常规一致。
        const sentenceHandles = !this.options.wordTiming?.enabled || wordTimingFullLane || selected.has(index);
        if (sentenceHandles && segment.start >= startMs) {
          this.appendCueHandle(block, index, row, 'left');
        }
        if (sentenceHandles && segment.end <= endMs) {
          this.appendCueHandle(block, index, row, 'right');
        }
        this.layoutBlock(block, segment, startMs, endMs, row);
        block.dataset.track = 'main';
        if (this.options.wordTiming?.enabled) {
          // 等高分层的字幕块不降级为背景（保持高亮样式与拖动）；叠加模式才垫底变暗。
          block.classList.add(wordTimingFullLane ? 'word-timing-full' : 'word-timing-background');
          if (!wordTimingFullLane) block.classList.add('word-timing-compact');
        }
        block.addEventListener('pointerdown', (event) => {
          // 账本 #24：字词码模式下整句块（含紧凑垫底）与常规模式一致允许
          // 拖动；Ctrl/Shift 多选与 Shift 范围选择由 beginCueDrag 内置处理，
          // 提交层的 items 重映射（cue-drag-update 的 move 平移 / boundary
          // 比例重映射）保证字词跟随整句边界。字词块是独立元素，不受影响。
          return this.beginCueDrag(event, index, row, 'main');
        });
        block.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const timeMs = this.pointerTimeMs(event, row);
          // 与字幕列表右键一致：Shift = 渐进拆分，Ctrl/Cmd+Shift = 复制拆分。
          const splitTextMode = event.shiftKey
            ? ((event.ctrlKey || event.metaKey) ? 'duplicate' : 'progressive')
            : null;
          this.options.showContextMenu?.(event.clientX, event.clientY, index, timeMs, { splitTextMode });
        });
        block.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.ctrlKey || event.metaKey) return;
          // 字词时间码显示时，主字幕文本与字词绑定：波形字幕块双击不再直接
          // 进入编辑，提示先退出字词码模式（字幕列表的行内编辑不受影响）。
          if (this.options.wordTiming?.enabled) {
            this.options.onMainCueDoubleClickBlocked?.();
            return;
          }
          if (this.options.enterCueEditor) this.options.enterCueEditor(index);
          else this.options.activateCue?.(index);
        });
        row.appendChild(block);
        this.appendWordBlocks(row, index, startMs, endMs);
      }
      // 字词模式下同样创建中缝拖动区：等高分层时中缝区落在整句块层、
      // 与字词条带不同层互不遮挡；紧凑叠加时贴缝词块手柄向中缝区让出
      // 中央 8px（appendSharedBoundaryZones 内加宽贴缝手柄保留独立命中）。
      this.appendSharedBoundaryZones(row, startMs, endMs, 'main');

      // 独立叠加轨：与主/副字幕互不绑定，绘制在主字幕块上方（bottom 50% 独立一层）。
      // 交互为点击选中、双击编辑、拖动移动、右键菜单；badge 与主块同款，挂在叠加块上方。
      const overlaySegments = this.options.getSegments('overlay') || [];
      if (overlaySegments.length) {
        const overlaySelected = this.options.getOverlaySelection?.() || new Set();
        const overlayBadges = this.settings.showGroupBadges !== false
          ? this.computeGroupBadgesCached(overlaySegments) : null;
        // 行高不足（50% 线放不下 35px 叠加块 + 7px 底边距）时叠加块直接盖在
        // 主字幕块上方，此时不渲染叠加徽章，避免与下半区徽章混叠。
        // 多行模式的行高真源是 settings.rowHeight：createMultiRow 在
        // createRow 返回后才写 row.style.height，这里读内联样式恒为空，
        // cover-mode 会永远不生效。
        // 双语行叠加块放在主字幕格上方（CSS 同步），需要高度 = 上下 inset
        // (14) + 两格 lane + 块 35 + 间隙 1；放不下时同样回退 cover。
        const rowHeightPx = this.settings.mode === 'multi'
          ? Number(this.settings.rowHeight) || 0
          : Number.parseFloat(row.style.height) || 0;
        const laneHeight = multiLane
          ? Math.min(this.settings.mode === 'basic' ? 54 : this.options.wordTiming?.enabled ? 44 : 35, (rowHeightPx - 14) / 2)
          : 0;
        const overlayCoverMode = rowHeightPx > 0
          && rowHeightPx < (multiLane ? 50 + laneHeight * 2 : 84);
        const activeOverlayIndex = findActiveCueIndex(overlaySegments, now);
        const firstOverlayIndex = firstCueIndexOverlapping(overlaySegments, startMs);
        for (let index = firstOverlayIndex; index < overlaySegments.length; index += 1) {
          const segment = overlaySegments[index];
          if (segment.start >= endMs) break;
          if (segment.end <= startMs) continue;
          if (segment.disabled && (this.options.getHideDisabled?.() || this.settings.disabledDisplay === 'hidden')) continue;
          const block = document.createElement('div');
          block.className = 'waveform-cue-block waveform-overlay-block';
          block.dataset.track = 'overlay';
          block.dataset.overlayIdx = String(index);
          block.dataset.start = String(segment.start);
          block.dataset.end = String(segment.end);
          // 外观与主字幕块一致：沿用字幕自身的颜色快照，不做轨道特殊配色。
          block.style.setProperty('--cue-color', colorForSegment(segment));
          if (overlayCoverMode) block.classList.add('overlay-cover-mode');
          if (overlaySelected.has(index)) block.classList.add('selected');
          if (segment.disabled) block.classList.add('disabled');
          if (index === activeOverlayIndex && isActiveCueVisualHit(overlaySegments, index, now)) block.classList.add('active');
          const label = document.createElement('span');
          label.className = 'waveform-cue-label';
          label.textContent = String(segment.text || '').replace(/\s+/g, ' ');
          block.title = label.textContent;
          block.appendChild(label);
          if (segment.start >= startMs) {
            const leftHandle = document.createElement('span');
            leftHandle.className = 'waveform-cue-handle left';
            block.appendChild(leftHandle);
          }
          if (segment.end <= endMs) {
            const rightHandle = document.createElement('span');
            rightHandle.className = 'waveform-cue-handle right';
            block.appendChild(rightHandle);
          }
          this.layoutBlock(block, segment, startMs, endMs, row);
          // cover 模式（行高不足）下叠加块盖住主块与徽章区，不渲染叠加徽章。
          const overlayBadgesForIndex = !overlayCoverMode && this.settings.showGroupBadges !== false
            ? overlayBadges?.get(index) : null;
          if (overlayBadgesForIndex?.length) {
            const badgeDuration = Math.max(1, endMs - startMs);
            const badgeVisibleStart = Math.max(startMs, segment.start);
            const badgeVisibleEnd = Math.min(endMs, segment.end);
            const blockWidthPx = ((badgeVisibleEnd - badgeVisibleStart) / badgeDuration) * this.content.clientWidth;
            if (blockWidthPx >= 24) overlayBadgesForIndex.forEach((badge, badgeIndex) => {
              const badgeEl = document.createElement('span');
              badgeEl.className = 'waveform-cue-badge waveform-overlay-cue-badge';
              badgeEl.textContent = badge.type === 'sticker' && badge.total === 1
                ? '🦊'
                : `${badge.type === 'color' ? '🎨' : '🦊'} ${badge.ordinal}/${badge.total}`;
              badgeEl.style.left = `${((badgeVisibleStart - startMs) / badgeDuration) * 100}%`;
              badgeEl.style.setProperty('--badge-stack-index', String(badgeIndex));
              badgeEl.dataset.segId = segment.id;
              row.appendChild(badgeEl);
            });
          }
          block.addEventListener('pointerdown', (event) => this.beginCueDrag(event, index, row, 'overlay'));
          block.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.options.showOverlayContextMenu?.(event.clientX, event.clientY, index);
          });
          block.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (this.options.enterOverlayCueEditor) this.options.enterOverlayCueEditor(index);
          });
          row.appendChild(block);
        }
      }

      if (!multiLane) return;
      const extensionSegments = this.options.getExtensionSegments?.() || [];
      const extensionSelected = this.options.getExtensionSelection?.() || new Set();
      const extensionBindingMarkers = bindingMarkerTargets.extension;
      const activeExtensionIndex = findActiveCueIndex(extensionSegments, now);
      const firstExtensionIndex = firstCueIndexOverlapping(extensionSegments, startMs);
      for (let index = firstExtensionIndex; index < extensionSegments.length; index += 1) {
        const segment = extensionSegments[index];
        if (segment.start >= endMs) break;
        if (segment.end <= startMs) continue;
        if (segment.disabled && (this.options.getHideDisabled?.() || this.settings.disabledDisplay === 'hidden')) continue;
        const block = document.createElement('div');
          block.className = 'waveform-cue-block';
          block.dataset.track = 'extension';
          block.dataset.extIdx = String(index);
          block.dataset.start = String(segment.start);
          block.dataset.end = String(segment.end);
          block.style.setProperty('--cue-color', '#7a9fc5');
        if (extensionSelected.has(index)) block.classList.add('selected');
        if (segment.disabled) block.classList.add('disabled');
        // 空隙中沿用的当前字幕不点亮 active 轮廓（仅视觉；逻辑语义不变）。
        if (index === activeExtensionIndex && isActiveCueVisualHit(extensionSegments, index, now)) block.classList.add('active');
        const label = document.createElement('span');
        label.className = 'waveform-cue-label';
        label.textContent = String(segment.text || '').replace(/\s+/g, ' ');
        block.title = label.textContent;
        block.appendChild(label);
        this.setBindingMarker(block, extensionBindingMarkers?.has?.(index) === true);
        if (segment.start >= startMs) this.appendExtensionHandle(block, 'left');
        if (segment.end <= endMs) this.appendExtensionHandle(block, 'right');
        this.layoutBlock(block, segment, startMs, endMs, row);
        block.addEventListener('pointerdown', (event) => this.beginCueDrag(event, index, row, 'extension'));
        block.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const timeMs = this.pointerTimeMs(event, row);
          this.options.showExtensionContextMenu?.(event.clientX, event.clientY, index, timeMs);
        });
        block.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.ctrlKey || event.metaKey) return;
          if (this.options.enterExtensionCueEditor) this.options.enterExtensionCueEditor(index);
          else this.options.activateExtensionCue?.(index);
        });
        row.appendChild(block);
      }
      this.appendSharedBoundaryZones(row, startMs, endMs, 'extension');
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    isSegmentHiddenForDisplay(segment) {
      return Boolean(
        segment?.disabled
        && (this.options.getHideDisabled?.() || this.settings.disabledDisplay === 'hidden'),
      );
    }


    // 新模式（中缝联动）下，为相接的字幕对在中缝处渲染一个可拖动区：
    // 拖动中缝 = 两侧边界一起联动；相接侧手柄加宽后仍可单侧独立调整。
    // classic 模式不渲染中缝区，行为与旧版完全一致。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    appendSharedBoundaryZones(row, startMs, endMs, track = 'main') {
      if (this.options.getAdjacentBoundaryMode?.() !== 'dual') return;
      const segments = this.options.getSegments(track);
      if (!Array.isArray(segments) || segments.length < 2) return;
      // 与 appendCueBlocks/appendWordBlocks 的分层判定一致：字词条带在独立
      // 一层（full）时中缝区与其不重叠，词块手柄无需让位。
      const wordTimingFullLane = this.options.multiSubtitleVisible?.() !== true
        && (this.settings.mode === 'basic'
          || (this.settings.mode === 'multi' && (Number(this.settings.rowHeight) || 0) >= 96));
      const clock = this.cueTiming();
      const duration = Math.max(1, endMs - startMs);
      const firstIndex = Math.max(0, firstCueIndexOverlapping(segments, startMs) - 1);
      for (let index = firstIndex; index + 1 < segments.length; index += 1) {
        const left = segments[index];
        const right = segments[index + 1];
        if (!left || !right) continue;
        const leftEnd = clock.getEnd(left);
        const rightStart = clock.getStart(right);
        if (!Number.isFinite(leftEnd) || !Number.isFinite(rightStart)) continue;
        const leftEndMs = clock.toMs(leftEnd);
        const rightStartMs = clock.toMs(rightStart);
        if (leftEndMs > endMs && rightStartMs > endMs) break;
        if (leftEnd !== rightStart) continue;
        // 帧模式下 getEnd/getStart 返回帧数，行边界是毫秒；定位前统一换算。
        const seamMs = leftEndMs;
        // 每条中缝只由其左侧所在行持有。行末中缝仍要渲染，否则整齐落在
        // 行边界的相接字幕会失去双侧联动拖动区。
        if (seamMs <= startMs || seamMs > endMs) continue;
        if (this.isSegmentHiddenForDisplay(left) || this.isSegmentHiddenForDisplay(right)) continue;
        const zone = document.createElement('span');
        zone.className = 'waveform-cue-boundary';
        zone.dataset.track = track;
        zone.dataset.leftIdx = String(index);
        zone.style.left = `${((seamMs - startMs) / duration) * 100}%`;
        zone.classList.toggle('at-row-end', seamMs === endMs);
        zone.title = '拖动调整贴合边界（两侧一起移动）';
        zone.addEventListener('pointerdown', (event) => this.beginSharedBoundaryZoneDrag(event, index, row, track));
        row.appendChild(zone);
        // 加宽相接侧手柄：中缝区只占中间 8px，加宽后两侧手柄保留约 7px
        // 独立命中区域，三个区域都有稳定的视觉与命中宽度。
        const leftBlock = row.querySelector(
          track === 'extension'
            ? `.waveform-cue-block[data-track="extension"][data-ext-idx="${index}"]`
            : `.waveform-cue-block[data-track="main"][data-idx="${index}"]`,
        );
        const rightBlock = row.querySelector(
          track === 'extension'
            ? `.waveform-cue-block[data-track="extension"][data-ext-idx="${index + 1}"]`
            : `.waveform-cue-block[data-track="main"][data-idx="${index + 1}"]`,
        );
        leftBlock?.classList.add('has-shared-boundary-right');
        rightBlock?.classList.add('has-shared-boundary-left');
        if (seamMs === endMs) leftBlock?.classList.add('shared-boundary-at-row-end-right');
        // 字词紧凑叠加布局下，贴缝词块手柄的内半段与中缝区（中央 8px）重叠；
        // 与句块手柄同款加宽到 11px，保持「手柄—中缝—手柄」各约 7px 的稳定
        // 命中。只在词块边界与句边界真正重合时处理；full 分层不重叠则跳过。
        if (track === 'main' && this.options.wordTiming?.enabled && !wordTimingFullLane) {
          const timing = this.cueTiming();
          const leftEntries = window.AsrEditorUtils?.getWordTimingEntries(left, timing);
          const rightEntries = window.AsrEditorUtils?.getWordTimingEntries(right, timing);
          if (leftEntries?.length && leftEntries[leftEntries.length - 1].end === leftEnd) {
            const leftWords = row.querySelectorAll(`.waveform-word-block[data-segment-idx="${index}"]`);
            leftWords[leftWords.length - 1]?.classList.add('has-shared-boundary-right');
          }
          if (rightEntries?.length && rightEntries[0].start === rightStart) {
            const rightWords = row.querySelector(`.waveform-word-block[data-segment-idx="${index + 1}"]`);
            rightWords?.classList.add('has-shared-boundary-left');
          }
        }
      }
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    setBindingMarker(block, visible) {
      block.classList.toggle('has-binding-marker', visible);
      const marker = (/** @type {HTMLElement} */ (block.querySelector('.waveform-binding-marker')));
      if (!visible) {
        marker?.remove();
        return;
      }
      if (marker) return;
      const next = document.createElement('span');
      next.className = 'waveform-binding-marker';
      next.textContent = '🔗';
      next.title = '已绑定字幕';
      next.setAttribute('aria-label', '已绑定字幕');
      block.appendChild(next);
    }


    // 字词时间码模式下，选中句的两端手柄直接进入整句边界拖动；
    // 阻断冒泡，避免落到句块的「仅选中」pointerdown 处理上。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    bindWordModeSentenceHandle(handle, index, row) {
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.focusWaveform();
        this.beginCueDrag(event, index, row, 'main');
      });
    }

    /** @this {import('./waveform-types.js').WaveformInstance} */
    layoutBlock(block, segment, startMs, endMs, ownerRow = null) {
      const duration = Math.max(1, endMs - startMs);
      const visibleStart = Math.max(startMs, segment.start);
      const visibleEnd = Math.min(endMs, segment.end);
      const left = ((visibleStart - startMs) / duration) * 100;
      const width = Math.max(0.25, ((visibleEnd - visibleStart) / duration) * 100);
      block.style.left = `${left}%`;
      block.style.width = `${width}%`;
      block.hidden = visibleEnd <= visibleStart;
      const row = ownerRow || (/** @type {import('./waveform-types.js').WaveformRow} */ (block.closest('.waveform-row')));
      // 时间上的多行模式与“多重字幕”双轨不是同一个概念；普通多行波形也
      // 必须在行边界清除相接侧圆角。基础模式的单行窗口则保留完整圆角。
      const isMultiRow = Boolean(row && row.dataset.basic !== 'true');
      const continuation = cueBlockContinuationEdges(segment, startMs, endMs);
      block.classList.toggle('continues-from-previous-row', isMultiRow && continuation.fromPreviousRow);
      block.classList.toggle('continues-to-next-row', isMultiRow && continuation.toNextRow);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    layoutGapBlock(block, gap, startMs, endMs) {
      const duration = Math.max(1, endMs - startMs);
      const visibleStart = Math.max(startMs, gap.start);
      const visibleEnd = Math.min(endMs, gap.end);
      const left = ((visibleStart - startMs) / duration) * 100;
      const width = Math.max(0.25, ((visibleEnd - visibleStart) / duration) * 100);
      block.style.left = `${left}%`;
      block.style.width = `${width}%`;
      block.hidden = visibleEnd <= visibleStart;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    refreshGapOverlay() {
      if (!this.payload) return;
      (/** @type {NodeListOf<import('./waveform-types.js').WaveformRow>} */ (this.content.querySelectorAll('.waveform-row'))).forEach((row) => {
        (/** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-gap-block'))).forEach((element) => element.remove());
        this.appendGapBlocks(row, Number(row.dataset.startMs), Number(row.dataset.endMs));
      });
      this.positionPlayheads();
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    appendCueHandle(block, index, row, side) {
      const handle = document.createElement('span');
      handle.className = `waveform-cue-handle ${side}`;
      handle.title = side === 'left'
        ? localizedWaveformMessage('调节字幕的左边界（开始时间）', 'Adjust subtitle left boundary (start time)')
        : localizedWaveformMessage('调节字幕的右边界（结束时间）', 'Adjust subtitle right boundary (end time)');
      if (this.options.wordTiming?.enabled) this.bindWordModeSentenceHandle(handle, index, row);
      block.appendChild(handle);
      return handle;
    }


    // 副字幕块手柄：与主块手柄同结构，但无字词模式绑定（副轨句柄直接
    // 走块级 beginCueDrag('extension')，无选中句联动语义）。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    appendExtensionHandle(block, side) {
      const handle = document.createElement('span');
      handle.className = `waveform-cue-handle ${side}`;
      handle.title = side === 'left'
        ? localizedWaveformMessage('调节字幕的左边界（开始时间）', 'Adjust subtitle left boundary (start time)')
        : localizedWaveformMessage('调节字幕的右边界（结束时间）', 'Adjust subtitle right boundary (end time)');
      block.appendChild(handle);
      return handle;
    }


    // 平移期轻量重排（账本 #22 批次 2）：句块与徽章按新窗口原位重算
    // left/width/hidden，不重建 DOM。返回 false 表示存在无法原位表达的
    // 结构差异（新窗口出现无 DOM 块的字幕、segment 丢失、句块手柄存在性
    // 需要变化），由调用方回退 renderBasic 全量重建。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    relayoutCueBlocksInRow(row, startMs, endMs) {
      const segments = this.options.getSegments('main');
      const duration = Math.max(1, endMs - startMs);
      const blocks = [.../** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-cue-block[data-track="main"]'))];
      const wordTimingEnabled = Boolean(this.options.wordTiming?.enabled);
      const multiLane = this.options.multiSubtitleVisible?.() === true;
      // 句块手柄存在性（与 appendCueBlocks 创建条件一致）：非字词模式按
      // 窗口边界；字词 full lane 常显；紧凑模式仅选中句。平移不改选区。
      const fullLane = wordTimingEnabled && !multiLane && (this.settings.mode === 'basic'
        || (this.settings.mode === 'multi' && (Number(this.settings.rowHeight) || 0) >= 96));
      const selected = this.options.getSelection('main');
      for (const block of blocks) {
        const index = Number(block.dataset.idx);
        const segment = segments[index];
        if (!segment) return false;
        const wantLeft = segment.start >= startMs;
        const wantRight = segment.end <= endMs;
        const sentenceHandles = !wordTimingEnabled || fullLane || selected.has(index);
        const expectLeft = sentenceHandles && wantLeft;
        const expectRight = sentenceHandles && wantRight;
        const hasLeft = Boolean(block.querySelector('.waveform-cue-handle.left'));
        const hasRight = Boolean(block.querySelector('.waveform-cue-handle.right'));
        // 句块手柄是可原位增删的 span（命中经 closest 解析，创建走
        // appendCueHandle 与整层重建同一结构）；segment 跨越窗口边界时
        // 原位增删，避免每次跨边都回退全量重建。
        if (expectLeft && !hasLeft) this.appendCueHandle(block, index, row, 'left');
        if (expectRight && !hasRight) this.appendCueHandle(block, index, row, 'right');
        if (!expectLeft && hasLeft) block.querySelector('.waveform-cue-handle.left')?.remove();
        if (!expectRight && hasRight) block.querySelector('.waveform-cue-handle.right')?.remove();
        this.layoutBlock(block, segment, startMs, endMs, row);
        // 完全滑出窗口的句块直接移除，维持「DOM 块只覆盖窗口内字幕」的
        // 不变量（与 appendCueBlocks 的创建条件一致）；重新进入窗口走
        // 缺块检测回退全量重建。
        if (block.hidden) block.remove();
      }
      // 新窗口内每条可见字幕都必须已有 DOM 块；缺失 → 结构变化。
      const hideDisabled = this.options.getHideDisabled?.() || this.settings.disabledDisplay === 'hidden';
      for (let index = firstCueIndexOverlapping(segments, startMs); index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.start >= endMs) break;
        if (segment.end <= startMs) continue;
        if (segment.disabled && hideDisabled) continue;
        let present = false;
        for (const block of blocks) {
          if (Number(block.dataset.idx) === index) { present = true; break; }
        }
        if (!present) return false;
      }
      // 徽章位置随句块平移（badge 挂在同一 row 上，按 seg-id 找回）。
      const badges = [.../** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-cue-badge[data-seg-id]'))];
      if (badges.length) {
        const indexById = new Map();
        segments.forEach((segment, index) => { if (segment.id) indexById.set(segment.id, index); });
        for (const badge of badges) {
          const segment = segments[indexById.get(badge.dataset.segId) ?? -1];
          if (!segment) return false;
          const visibleStart = Math.max(startMs, segment.start);
          badge.style.left = `${((visibleStart - startMs) / duration) * 100}%`;
        }
      }
      // 双语行的叠加轨块同样原位重排（缺失块等整行精绘时补齐，短暂滞后可接受）。
      const overlaySegments = this.options.getSegments('overlay') || [];
      if (overlaySegments.length) {
        const overlayBlocks = [.../** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-cue-block[data-track="overlay"]'))];
        for (const block of overlayBlocks) {
          const segment = overlaySegments[Number(block.dataset.overlayIdx)];
          if (!segment) return false;
          this.layoutBlock(block, segment, startMs, endMs, row);
          if (block.hidden) block.remove();
        }
      }
      // 双语行的副字幕（extension）块与主块同构（窗口边界手柄、无字词绑定），
      // 同样原位重排；完全滑出即移除，重新进入走缺块检测回退全量重建。
      if (this.options.multiSubtitleVisible?.() === true) {
        const extensionSegments = this.options.getExtensionSegments?.() || [];
        const extensionBlocks = [.../** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-cue-block[data-track="extension"]'))];
        for (const block of extensionBlocks) {
          const index = Number(block.dataset.extIdx);
          const segment = extensionSegments[index];
          if (!segment) return false;
          const expectLeft = segment.start >= startMs;
          const expectRight = segment.end <= endMs;
          const hasLeft = Boolean(block.querySelector('.waveform-cue-handle.left'));
          const hasRight = Boolean(block.querySelector('.waveform-cue-handle.right'));
          if (expectLeft && !hasLeft) this.appendExtensionHandle(block, 'left');
          if (expectRight && !hasRight) this.appendExtensionHandle(block, 'right');
          if (!expectLeft && hasLeft) block.querySelector('.waveform-cue-handle.left')?.remove();
          if (!expectRight && hasRight) block.querySelector('.waveform-cue-handle.right')?.remove();
          this.layoutBlock(block, segment, startMs, endMs, row);
          if (block.hidden) block.remove();
        }
      }
      return true;
    }


    // 空隙块原位重排；gap 增减（块数不匹配）、索引失效或手柄存在性变化
    // 时返回 false（调用方回退 refreshGapOverlay 整层重建，空隙块数量少）。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    relayoutGapBlocksInRow(row, startMs, endMs) {
      const gaps = this.options.getGapRemoveGaps?.() || [];
      const blocks = [.../** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-gap-block'))];
      const expected = [];
      for (let index = firstCueIndexOverlapping(gaps, startMs); index < gaps.length; index += 1) {
        const gap = gaps[index];
        if (!gap) continue;
        if (gap.start >= endMs) break;
        if (gap.end <= startMs) continue;
        expected.push({ gap, index });
      }
      if (blocks.length !== expected.length) return false;
      const boundaryEnabled = gapOperationAllowsBoundary(this.options.getGapOperationMode?.() || 'boundary_drag');
      for (const block of blocks) {
        const entry = expected.find(candidate => candidate.index === Number(block.dataset.gapIndex));
        if (!entry) return false;
        if (boundaryEnabled) {
          // 空隙手柄同样是可原位增删的纯 span（无独立监听器）。
          if (entry.gap.start >= startMs && !block.querySelector('.waveform-gap-handle.left')) {
            const handle = document.createElement('span');
            handle.className = 'waveform-gap-handle left';
            block.appendChild(handle);
          }
          if (entry.gap.end <= endMs && !block.querySelector('.waveform-gap-handle.right')) {
            const handle = document.createElement('span');
            handle.className = 'waveform-gap-handle right';
            block.appendChild(handle);
          }
          if (entry.gap.start < startMs) block.querySelector('.waveform-gap-handle.left')?.remove();
          if (entry.gap.end > endMs) block.querySelector('.waveform-gap-handle.right')?.remove();
        }
        this.layoutGapBlock(block, entry.gap, startMs, endMs);
      }
      return true;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    refreshCueOverlay() {
      if (!this.payload) return;
      // 覆盖层重建的入口都可能伴随分组字段变化（颜色/表情包/拆分合并/
      // 撤销重做）：徽章缓存纪元在此推进，后续读取按新纪元重算。
      this.invalidateGroupBadges();
      const rows = [...(/** @type {NodeListOf<import('./waveform-types.js').WaveformRow>} */ (this.content.querySelectorAll('.waveform-row')))];
      if (!rows.length) return;
      const groupBadges = this.computeGroupBadgesCached(this.options.getSegments('main'));
      rows.forEach((row) => {
        // 绑定、解绑和字幕时间变化只影响覆盖层；保留已有行与 Canvas，
        // 避免重新采样/绘制波形导致操作出现一帧卡顿。
        (/** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll('.waveform-cue-block, .waveform-cue-badge, .waveform-cue-boundary, .waveform-word-block, .waveform-word-boundary')))
          .forEach((element) => element.remove());
        this.appendCueBlocks(
          row,
          Number(row.dataset.startMs),
          Number(row.dataset.endMs),
          groupBadges,
        );
      });
      const drag = this.drag;
      if (drag?.started) {
        for (const move of drag.moveTracks || [drag]) {
          const indices = new Set(move.indices);
          rows.forEach((row) => row.querySelectorAll(`.waveform-cue-block[data-track="${move.track}"]`)
            .forEach((element) => {
              const block = /** @type {HTMLElement} */ (element);
              const index = Number(block.dataset.overlayIdx ?? block.dataset.extIdx ?? block.dataset.idx);
              if (indices.has(index)) block.classList.add('dragging');
            }));
        }
      }
      this.updatePlayback(false);
      // 字块几何/文本可能随整层重建变化：同步重绘全文预览气泡层
      //（仅基础模式 + 字词码生效，内部自带模式守卫）。
      this.refreshWordChips();
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    refreshCueBlocks() {
      const activeSeamDrag = this.drag?.sharedBoundaryZone && this.drag.started ? this.drag : null;
      if (activeSeamDrag) {
        const boundaryMs = this.cueBoundaryDragTimeMs(activeSeamDrag);
        const ownerRow = this.findVisibleWaveformRowForTime(boundaryMs);
        const ownerRowIndex = ownerRow ? Number(ownerRow.dataset.rowIndex) : NaN;
        if (Number.isFinite(ownerRowIndex) && ownerRowIndex !== activeSeamDrag.previewRowIndex) {
          // 中缝换行时只重建字幕覆盖层，保留已绘制的波形 Canvas 与指针捕获。
          activeSeamDrag.previewRowIndex = ownerRowIndex;
          this.refreshCueOverlay();
        }
      }
      const activeCueDrag = this.drag && this.drag.started && !this.drag.sharedBoundaryZone
        ? this.drag : null;
      if (activeCueDrag && (activeCueDrag.moveTracks || [activeCueDrag]).some((move) => this.cueDragOverlayOccupancyChanged(move))) {
        // 轻量块重排只能更新已有 DOM；当字幕跨行后，必须在目标行创建新片段、
        // 并移除源行旧片段。指针捕获在稳定 pane 上，覆盖层重建不会中断拖动。
        this.refreshCueOverlay();
      }
      const segments = this.options.getSegments('main');
      const extensionSegments = this.options.getExtensionSegments?.() || [];
      const overlaySegments = this.options.getSegments('overlay') || [];
      const overlaySelected = this.options.getOverlaySelection?.() || new Set();
      // 共享边界拖动会同时修改两侧字幕：中缝拖动的真实选区已包含前后
      // 两句；传统模式的手柄联动只选中点击侧，拖动期间两侧块也按选中态
      // 显示，松开后由真实选区恢复原状。
      const boundaryDrag = this.drag?.kind === 'resize-boundary' ? this.drag : null;
      const boundaryDragTrack = boundaryDrag?.track || 'main';
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll('.waveform-cue-block'))).forEach((block) => {
        const trackKind = block.dataset.track;
        const isExtension = trackKind === 'extension';
        const isOverlay = trackKind === 'overlay';
        const index = isExtension
          ? Number(block.dataset.extIdx)
          : isOverlay
            ? Number(block.dataset.overlayIdx)
            : Number(block.dataset.idx);
        const segment = isExtension
          ? extensionSegments[index]
          : isOverlay
            ? overlaySegments[index]
            : segments[index];
        const row = (/** @type {import('./waveform-types.js').WaveformRow} */ (block.closest('.waveform-row')));
        if (!segment || !row) return;
        this.layoutBlock(block, segment, Number(row.dataset.startMs), Number(row.dataset.endMs));
        // badge 位置跟随块移动（同一 segment 的 badge 挂在同一 row 上）
        (/** @type {NodeListOf<HTMLElement>} */ (row.querySelectorAll(`.waveform-cue-badge[data-seg-id="${segment.id}"]`))).forEach((badge) => {
          const badgeRowStart = Number(row.dataset.startMs);
          const badgeRowDur = Math.max(1, Number(row.dataset.endMs) - badgeRowStart);
          const visibleStart = Math.max(badgeRowStart, segment.start);
          badge.style.left = `${((visibleStart - badgeRowStart) / badgeRowDur) * 100}%`;
        });
        const linkedToBoundaryDrag = Boolean(
          boundaryDrag
          && (isExtension ? 'extension' : 'main') === boundaryDragTrack
          && (index === boundaryDrag.index || index === boundaryDrag.index + 1),
        );
        block.classList.toggle('selected', linkedToBoundaryDrag || (isExtension
          ? this.options.getExtensionSelection?.().has(index)
          : isOverlay
            ? overlaySelected.has(index)
            : this.options.getSelection('main').has(index)));
        if (isOverlay) return;
        const bindingMarkerTargets = this.options.getBindingMarkerTargets?.() || {};
        this.setBindingMarker(block, isExtension
          ? bindingMarkerTargets.extension?.has?.(index) === true
          : bindingMarkerTargets.main?.has?.(index) === true);
      });
      this.refreshBoundaryZones();
      if (activeSeamDrag) {
        (/** @type {HTMLElement} */ (this.content.querySelector(
          `.waveform-cue-boundary[data-track="${activeSeamDrag.track}"][data-left-idx="${activeSeamDrag.index}"]`,
        )))?.classList.add('dragging');
      }
      this.positionPlayheads();
      this.refreshBoundaryDragPointerLine();
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    cueDragOverlayOccupancyChanged(drag) {
      const rows = [...(/** @type {NodeListOf<import('./waveform-types.js').WaveformRow>} */ (
        this.content.querySelectorAll('.waveform-row')
      ))];
      if (!rows.length) return false;
      const segments = drag.track === 'extension'
        ? (this.options.getExtensionSegments?.() || [])
        : (this.options.getSegments(drag.track) || []);
      const occupancy = rows.map((row) => ({
        startMs: Number(row.dataset.startMs), endMs: Number(row.dataset.endMs),
        indices: new Set([...row.querySelectorAll(`.waveform-cue-block[data-track="${drag.track}"]`)]
          .map((element) => {
            const block = /** @type {HTMLElement} */ (element);
            return Number(block.dataset.overlayIdx ?? block.dataset.extIdx ?? block.dataset.idx);
          })),
      }));
      return drag.indices.some((index) => {
        const segment = segments[index];
        if (!segment) return false;
        const hiddenDisabled = segment.disabled
          && (this.options.getHideDisabled?.() || this.settings.disabledDisplay === 'hidden');
        return occupancy.some(({ startMs, endMs, indices }) => {
          const shouldExist = !hiddenDisabled
            && Number(segment.start) < endMs && Number(segment.end) > startMs;
          const exists = indices.has(index);
          return shouldExist !== exists;
        });
      });
    }


    // 轻量刷新（拖动中）只重建字幕块，不重建中缝区；这里按当前时间
    // 重新定位已有中缝区，保证拖动过程中中缝始终跟随贴合边界。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    refreshBoundaryZones() {
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll('.waveform-cue-boundary'))).forEach((zone) => {
        const row = (/** @type {import('./waveform-types.js').WaveformRow} */ (zone.closest('.waveform-row')));
        if (!row) return;
        const track = zone.dataset.track === 'extension' ? 'extension' : 'main';
        const index = Number(zone.dataset.leftIdx);
        const left = this.options.getSegments(track)[index];
        const right = this.options.getSegments(track)[index + 1];
        const clock = this.cueTiming();
        // 独立拖动让两侧脱离贴合后，中缝区立即移除；重新贴合会在下一次
        // 完整重建（refreshCueOverlay）时恢复。
        if (!left || !right || clock.getEnd(left) !== clock.getStart(right)) {
          zone.remove();
          return;
        }
        const startMs = Number(row.dataset.startMs);
        const endMs = Number(row.dataset.endMs);
        const duration = Math.max(1, endMs - startMs);
        const seamMs = clock.toMs(clock.getEnd(left));
        zone.style.left = `${((seamMs - startMs) / duration) * 100}%`;
        zone.classList.toggle('at-row-end', seamMs === endMs);
      });
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    refreshCueLabel(index) {
      const segment = this.options.getSegments('main')[index];
      if (!segment) return;
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll(`.waveform-cue-block[data-track="main"][data-idx="${index}"] .waveform-cue-label`)))
        .forEach((label) => { label.textContent = segment.text.replace(/\s+/g, ' '); });
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    refreshExtensionCueLabel(index, trackId = null) {
      const segment = this.options.getExtensionSegments?.(trackId)?.[index];
      if (!segment) return;
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll(`.waveform-cue-block[data-track="extension"][data-ext-idx="${index}"] .waveform-cue-label`)))
        .forEach((label) => { label.textContent = String(segment.text || '').replace(/\s+/g, ' '); });
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    updateSelection() {
      // 字词时间码模式下选中句才有整句手柄；选中集变化需要整层重建，
      // 轻量 class 切换无法增删手柄。
      if (this.options.wordTiming?.enabled) {
        this.refreshCueOverlay();
        return;
      }
      const selected = this.options.getSelection('main');
      const extensionSelected = this.options.getExtensionSelection?.() || new Set();
      const overlaySelected = this.options.getOverlaySelection?.() || new Set();
      const bindingMarkerTargets = this.options.getBindingMarkerTargets?.() || {};
      (/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll('.waveform-cue-block'))).forEach((block) => {
        const trackKind = block.dataset.track;
        const index = Number(trackKind === 'extension' ? block.dataset.extIdx
          : trackKind === 'overlay' ? block.dataset.overlayIdx : block.dataset.idx);
        block.classList.toggle('selected', trackKind === 'extension'
          ? extensionSelected.has(index)
          : trackKind === 'overlay'
            ? overlaySelected.has(index)
            : selected.has(index));
        if (trackKind === 'overlay') return;
        this.setBindingMarker(block, trackKind === 'extension'
          ? bindingMarkerTargets.extension?.has?.(index) === true
          : bindingMarkerTargets.main?.has?.(index) === true);
      });
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
}
