// workspace: waveform class methods with explicit dependencies.
window.MAWE.register('waveform-workspace', function createWaveformModule(dependencies) {
  'use strict';
  const { BUILTIN_WORKSPACES, DEFAULT_RIGHT_LAYOUT_TREE, DEFAULT_SETTINGS, MODULE_LABELS, ROW_HEIGHT_PRESETS, WORKSPACE_SCHEMA, clamp, cloneLayoutTree, directionLabel, insertLayoutModuleAtEdge, insertLayoutModuleAtRootEdge, isCompleteLayoutTree, layoutDropIntent, layoutDropPreviewRect, layoutRootDropIntent, normalizeLayoutData, normalizeLayoutRows, saveSettings, swapLayoutTreeModules } = dependencies;

  class WaveformMethods {


    bindDivider() {
      const bind = (divider, axis) => {
        if (!divider) return;
        let dividerDrag = null;
        divider.addEventListener('pointerdown', (event) => {
          if (!this.isMultiMode() || this.settings.layout !== 'classic') return;
          event.preventDefault();
          dividerDrag = { pointerId: event.pointerId, snapshot: this.getLayoutHistorySnapshot(), changed: false };
          divider.classList.add('dragging');
          divider.setPointerCapture(event.pointerId);
          this.layoutDragging = true;
        });
        divider.addEventListener('pointermove', (event) => {
          if (!dividerDrag || dividerDrag.pointerId !== event.pointerId) return;
          const rect = this.workspace.getBoundingClientRect();
          const percent = axis === 'x'
            ? ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100
            : ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
          const nextSplitPercent = clamp(
            this.settings.side === 'right' ? 100 - percent : percent,
            35,
            75,
          );
          if (nextSplitPercent === this.settings.splitPercent) return;
          if (!dividerDrag.changed) {
            this.recordLayoutUndo('调整波形与字幕区域尺寸', dividerDrag.snapshot);
            dividerDrag.changed = true;
          }
          this.settings.splitPercent = nextSplitPercent;
          this.workspace.style.setProperty('--waveform-split', `${this.settings.splitPercent}%`);
          this.scheduleRender();
        });
        const finish = (event) => {
          if (!dividerDrag || dividerDrag.pointerId !== event.pointerId) return;
          const changed = dividerDrag.changed;
          dividerDrag = null;
          divider.classList.remove('dragging');
          try { divider.releasePointerCapture(event.pointerId); } catch (_) {}
          this.layoutDragging = false;
          // 松手后按最终尺寸做一次清晰重绘
          if (changed) this.scheduleRender();
          saveSettings(this.settings);
        };
        divider.addEventListener('pointerup', finish);
        divider.addEventListener('pointercancel', finish);
      };
      bind(this.divider, 'x');
    }


    bindLayoutResizers() {
      Object.entries(this.layoutResizers).forEach(([kind, resizer]) => {
        if (!resizer) return;
        let drag = null;
        resizer.addEventListener('pointerdown', (event) => {
          if (!this.isPresetResizableLayout()) return;
          event.preventDefault();
          drag = { pointerId: event.pointerId, snapshot: this.getLayoutHistorySnapshot(), changed: false };
          resizer.classList.add('dragging');
          resizer.setPointerCapture?.(event.pointerId);
          this.layoutDragging = true;
        });
        resizer.addEventListener('pointermove', (event) => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          const rect = this.workspace.getBoundingClientRect();
          const previousColumn = this.settings.layoutColumnPercent;
          const previousRows = [...this.settings.layoutRows];
          if (kind === 'column') {
            this.settings.layoutColumnPercent = clamp(
              ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100,
              30,
              75,
            );
          } else {
            const percent = ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
            const rows = [...this.settings.layoutRows];
            if (kind === 'rowTop') {
              rows[0] = clamp(percent, 12, 76);
              rows[1] = Math.min(rows[1], 88 - rows[0]);
            } else {
              rows[1] = clamp(percent - rows[0], 6, 82);
            }
            this.settings.layoutRows = normalizeLayoutRows(rows);
          }
          const hasChanged = previousColumn !== this.settings.layoutColumnPercent
            || previousRows.some((value, index) => value !== this.settings.layoutRows[index]);
          if (!hasChanged) return;
          if (!drag.changed) {
            this.recordLayoutUndo('调整布局区域尺寸', drag.snapshot);
            drag.changed = true;
          }
          this.applyLayoutVariables();
          this.scheduleRender();
        });
        const finish = (event) => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          const changed = drag.changed;
          drag = null;
          resizer.classList.remove('dragging');
          try { resizer.releasePointerCapture?.(event.pointerId); } catch (_) {}
          this.layoutDragging = false;
          // 松手后按最终尺寸做一次清晰重绘
          if (changed) this.scheduleRender();
          saveSettings(this.settings);
        };
        resizer.addEventListener('pointerup', finish);
        resizer.addEventListener('pointercancel', finish);
      });
    }


    applyLayoutVariables() {
      const [top, middle, bottom] = normalizeLayoutRows(this.settings.layoutRows);
      this.settings.layoutRows = [top, middle, bottom];
      this.workspace.style.setProperty('--waveform-split', `${this.settings.splitPercent}%`);
      this.workspace.style.setProperty('--layout-column', `${this.settings.layoutColumnPercent}%`);
      this.workspace.style.setProperty('--layout-row-top', `${top}%`);
      this.workspace.style.setProperty('--layout-row-middle', `${middle}%`);
      this.workspace.style.setProperty('--layout-row-bottom', `${bottom}%`);
    }


    applyLayout() {
      this.workspace.classList.remove(
        'waveform-basic', 'waveform-multi',
        'layout-classic', 'layout-wave-right', 'layout-custom',
        'waveform-right', 'layout-editing',
      );
      this.workspace.classList.add(`waveform-${this.settings.mode}`);
      this.workspace.classList.add(`layout-${this.settings.layout}`);
      if (this.settings.layout === 'classic' && this.settings.side === 'right') {
        this.workspace.classList.add('waveform-right');
      }
      if (this.settings.layoutEditing) this.workspace.classList.add('layout-editing');
      this.applyLayoutVariables();
      this.applyCustomLayoutTree();
      document.querySelectorAll('[data-waveform-mode]').forEach((button) => {
        button.classList.toggle('active', button.dataset.waveformMode === this.settings.mode);
      });
      this.windowLabel.textContent = `${this.settings.visibleSeconds} 秒`;
      if (this.waveformScaleLabel) this.renderWaveformScaleLabel();
      this.secondsPerRowSelect.value = String(this.settings.secondsPerRow);
      if (this.rowHeightSelect) this.rowHeightSelect.value = String(this.settings.rowHeight);
      if (this.sideSelect) this.sideSelect.value = this.settings.side;
      if (this.disabledDisplaySelect) this.disabledDisplaySelect.value = this.settings.disabledDisplay;
      if (this.showGroupBadgesToggle) this.showGroupBadgesToggle.checked = this.settings.showGroupBadges !== false;
      if (this.dragPlayheadToggle) this.dragPlayheadToggle.checked = this.settings.dragPlayhead === true;
      if (this.layoutEditToggle) {
        this.layoutEditToggle.textContent = this.settings.layoutEditing ? '完成布局' : '编辑布局';
        this.layoutEditToggle.classList.toggle('active', !!this.settings.layoutEditing);
      }
      if (this.layoutResetButton) this.layoutResetButton.hidden = !this.settings.layoutEditing;
      this.updateAdvancedSettingsAvailability();
    }


    updateAdvancedSettingsAvailability() {
      const basicMode = this.settings.mode === 'basic';
      const multiMode = this.settings.mode === 'multi';
      document.getElementById('waveform-zoom-in').disabled = !basicMode;
      document.getElementById('waveform-zoom-out').disabled = !basicMode;
      this.secondsPerRowSelect.disabled = !multiMode;
      if (this.rowHeightSelect) this.rowHeightSelect.disabled = !multiMode;
      // 「显示窗口」仅基础模式有意义；「每行长度」「每行高度」仅多行模式有意义。
      const windowSetting = document.getElementById('waveform-window-setting');
      const secondsPerRowSetting = document.getElementById('waveform-seconds-per-row-setting');
      const rowHeightSetting = document.getElementById('waveform-row-height-setting');
      if (windowSetting) windowSetting.hidden = !basicMode;
      if (secondsPerRowSetting) secondsPerRowSetting.hidden = !multiMode;
      if (rowHeightSetting) rowHeightSetting.hidden = !multiMode;
    }


    setMode(mode) {
      if (!['basic', 'multi'].includes(mode) || mode === this.settings.mode) return;
      this.settings.mode = mode;
      this.multiFollowRowIndex = -1;
      this.multiFollowCheckPending = true;
      saveSettings(this.settings);
      this.applyLayout();
      if (mode === 'basic') this.centerBasicOnCurrentTime();
      if (this.isMultiMode()) this.multiRange = [-1, -1];
      this.render();
    }


    // 工具切换：'select' 为默认选择工具，保留全部 Ctrl/Shift/分组多选与
    // 拖动行为；'razor' 让左键点击字幕块在指针位置安全拆分。切回 select
    // 不会清除已有选中，便于拆分后立即继续操作。
    setTool(tool) {
      if (tool !== 'select' && tool !== 'razor') return;
      if (this.tool === tool) return;
      this.tool = tool;
      this.pane?.classList.toggle('tool-razor', tool === 'razor');
      this.pane?.classList.toggle('tool-select', tool === 'select');
      document.querySelectorAll('[data-waveform-tool]').forEach((button) => {
        button.classList.toggle('active', button.dataset.waveformTool === tool);
      });
      this.setStatus(tool === 'razor' ? '分割工具：点击字幕块在指针位置拆分' : '选择工具');
    }


    getTool() {
      return this.tool;
    }


    // 切换到内置工作区：应用其渲染器、波形模式与完整布局树。
    setLayout(workspaceId) {
      const builtin = BUILTIN_WORKSPACES[workspaceId];
      if (!builtin) return;
      const normalized = normalizeLayoutData(builtin);
      this.settings.layout = normalized.preset;
      if (normalized.waveformMode) this.settings.mode = normalized.waveformMode;
      if (normalized.waveformSettings) Object.assign(this.settings, normalized.waveformSettings);
      this.settings.splitPercent = normalized.splitPercent;
      this.settings.layoutColumnPercent = normalized.columnPercent;
      this.settings.layoutRows = normalized.rows;
      this.settings.layoutTree = normalized.tree;
      this.settings.layoutEditing = false;
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
    }


    toggleLayoutEditMode() {
      if (this.settings.layout !== 'custom') {
        this.settings.layout = 'custom';
        this.settings.layoutEditing = true;
      } else {
        this.settings.layoutEditing = !this.settings.layoutEditing;
      }
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
    }


    isMultiMode() {
      return this.settings.mode === 'multi';
    }


    getRowHeight() {
      return this.settings.rowHeight;
    }


    getMaxRowHeight() {
      return ROW_HEIGHT_PRESETS[ROW_HEIGHT_PRESETS.length - 1];
    }


    setRowHeight(value) {
      const next = Number(value);
      if (this.rowHeightDebounceTimer) {
        window.clearTimeout(this.rowHeightDebounceTimer);
        this.rowHeightDebounceTimer = 0;
        this.pendingRowHeightDirection = 0;
      }
      if (!ROW_HEIGHT_PRESETS.includes(next)) return false;
      if (this.settings.rowHeight === next) return true;
      this.settings.rowHeight = next;
      if (this.rowHeightSelect) this.rowHeightSelect.value = String(next);
      saveSettings(this.settings);
      // 自动标尺按行高算（可用上半高随行高变），换行高要重拟合；手动模式不动。
      // render:false：只算标尺和标签，重绘交给下面正常的行高布局路径。
      if (this.settings.waveformScaleAuto !== false && this.loudnessStats) {
        this.setLoudnessStats(this.loudnessStats, { render: false });
      }
      // 与「每行长度」一样走完整重渲染：字幕块的 lane 布局和「行高不足时
      // 覆盖主字幕」的 cover-mode 回退都在 createRow 按当时行高定死，若只调
      // 行几何并复用旧行，叠加块不会随新行高刷新布局。
      this.render();
      return true;
    }


    isCustomLayout() {
      return this.settings.layout === 'custom' && this.settings.layoutEditing;
    }


    isPresetResizableLayout() {
      return this.settings.layout === 'wave-right';
    }


    bindDockHandles() {
      const modules = [
        ['player', this.playerWrap],
        ['panel', this.panel],
        ['cues', this.cues],
        ['wave', this.pane],
      ];
      modules.forEach(([id, element]) => {
        if (!element) return;
        element.dataset.dockModule = id;
        let handle = element.querySelector(':scope > .dock-handle');
        if (!handle) {
          handle = document.createElement('div');
          handle.className = 'dock-handle';
          handle.textContent = `⋮⋮ ${MODULE_LABELS[id]}`;
          element.prepend(handle);
        }
        handle.draggable = true;
        handle.addEventListener('dragstart', (event) => {
          if (!this.isCustomLayout()) {
            event.preventDefault();
            this.setStatus('请先进入「编辑布局」模式', 'busy');
            return;
          }
          event.dataTransfer?.setData('text/plain', id);
          event.dataTransfer?.setDragImage(handle, 16, 10);
          this.layoutDragSource = id;
          this.workspace.classList.add('layout-dragging');
          element.classList.add('layout-drag-source');
        });
        handle.addEventListener('dragend', () => {
          this.layoutDragSource = null;
          element.classList.remove('layout-drag-source');
          this.clearLayoutDropPreview();
          this.workspace.classList.remove('layout-dragging');
        });
        element.addEventListener('dragover', (event) => {
          if (!this.isCustomLayout() || !this.layoutDragSource) return;
          if (layoutRootDropIntent(this.workspace.getBoundingClientRect(), event.clientX, event.clientY)) return;
          if (this.layoutDragSource === id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const intent = layoutDropIntent(element.getBoundingClientRect(), event.clientX, event.clientY);
          this.layoutDropIntent = { ...intent, targetId: id, sourceId: this.layoutDragSource };
          this.showLayoutDropPreview(element, id, this.layoutDragSource, intent);
        });
        element.addEventListener('drop', (event) => {
          if (!this.isCustomLayout()) return;
          const source = this.layoutDragSource || event.dataTransfer?.getData('text/plain');
          if (layoutRootDropIntent(this.workspace.getBoundingClientRect(), event.clientX, event.clientY)) return;
          event.preventDefault();
          if (!source || source === id) return;
          const intent = this.layoutDropIntent?.targetId === id
            ? this.layoutDropIntent
            : { ...layoutDropIntent(element.getBoundingClientRect(), event.clientX, event.clientY), targetId: id, sourceId: source };
          this.applyLayoutDrop(source, id, intent);
          this.clearLayoutDropPreview();
        });
      });
      this.bindWorkspaceDockTarget();
    }


    bindWorkspaceDockTarget() {
      this.workspace.addEventListener('dragover', (event) => {
        if (!this.isCustomLayout() || !this.layoutDragSource || event.defaultPrevented) return;
        const intent = layoutRootDropIntent(this.workspace.getBoundingClientRect(), event.clientX, event.clientY);
        if (!intent) {
          this.clearLayoutDropPreview();
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        this.layoutDropIntent = { ...intent, sourceId: this.layoutDragSource };
        this.showLayoutDropPreview(this.workspace, null, this.layoutDragSource, intent);
      });
      this.workspace.addEventListener('drop', (event) => {
        if (!this.isCustomLayout() || event.defaultPrevented) return;
        const source = this.layoutDragSource || event.dataTransfer?.getData('text/plain');
        if (!source) return;
        const storedIntent = this.layoutDropIntent?.mode === 'root-insert'
          && this.layoutDropIntent.sourceId === source
          ? this.layoutDropIntent : null;
        const intent = storedIntent
          || layoutRootDropIntent(this.workspace.getBoundingClientRect(), event.clientX, event.clientY);
        if (!intent) return;
        event.preventDefault();
        this.applyLayoutDrop(source, null, intent);
        this.clearLayoutDropPreview();
      });
    }


    applyLayoutDrop(sourceId, targetId, intent) {
      const tree = isCompleteLayoutTree(this.settings.layoutTree)
        ? this.settings.layoutTree
        : cloneLayoutTree(DEFAULT_RIGHT_LAYOUT_TREE);
      const nextTree = intent.mode === 'root-insert'
        ? insertLayoutModuleAtRootEdge(tree, sourceId, intent.direction)
        : intent.mode === 'insert'
          ? insertLayoutModuleAtEdge(tree, sourceId, targetId, intent.direction)
          : swapLayoutTreeModules(tree, sourceId, targetId);
      if (!isCompleteLayoutTree(nextTree)) return;
      this.recordLayoutUndo(
        intent.mode === 'root-insert'
          ? '停靠到窗口边缘'
          : intent.mode === 'insert' ? '插入布局模块' : '交换布局模块',
        this.getLayoutHistorySnapshot(),
      );
      this.settings.layoutTree = nextTree;
      saveSettings(this.settings);
      this.applyLayout();
      if (intent.mode === 'root-insert') {
        this.setStatus(`已将「${MODULE_LABELS[sourceId]}」停靠到窗口${directionLabel(intent.direction)}`);
      } else if (intent.mode === 'insert') {
        this.setStatus(`已将「${MODULE_LABELS[sourceId]}」插入到「${MODULE_LABELS[targetId]}」${directionLabel(intent.direction)}`);
      } else {
        this.setStatus(`已交换「${MODULE_LABELS[sourceId]}」与「${MODULE_LABELS[targetId]}」`);
      }
    }


    showLayoutDropPreview(element, id, sourceId, intent) {
      if (!this.layoutPreview || !element) return;
      const workspaceRect = this.workspace.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const previewRect = layoutDropPreviewRect(rect, intent);
      this.layoutPreview.style.left = `${previewRect.left - workspaceRect.left}px`;
      this.layoutPreview.style.top = `${previewRect.top - workspaceRect.top}px`;
      this.layoutPreview.style.width = `${previewRect.width}px`;
      this.layoutPreview.style.height = `${previewRect.height}px`;
      this.layoutPreview.classList.toggle(
        'layout-insert-preview',
        intent.mode === 'insert' || intent.mode === 'root-insert',
      );
      this.layoutPreview.classList.toggle('layout-root-insert-preview', intent.mode === 'root-insert');
      this.layoutPreview.textContent = intent.mode === 'root-insert'
        ? `窗口${directionLabel(intent.direction)}：${MODULE_LABELS[sourceId]}`
        : intent.mode === 'insert'
          ? `新位置：${MODULE_LABELS[sourceId]} ${directionLabel(intent.direction)}`
          : `新位置：与${MODULE_LABELS[id]}对换`;
      this.layoutPreview.classList.add('show');
      this.workspace.querySelectorAll('.layout-drop-target').forEach((target) => {
        target.classList.remove('layout-drop-target');
      });
      if (intent.mode !== 'root-insert') element.classList.add('layout-drop-target');
    }


    clearLayoutDropPreview() {
      this.layoutPreview?.classList.remove('show');
      this.layoutPreview?.classList.remove('layout-insert-preview');
      this.layoutPreview?.classList.remove('layout-root-insert-preview');
      this.layoutDropIntent = null;
      this.workspace?.querySelectorAll('.layout-drop-target').forEach((target) => {
        target.classList.remove('layout-drop-target');
      });
    }


    ensureCustomLayoutRoot() {
      if (this.customLayoutRoot?.isConnected) return this.customLayoutRoot;
      this.customLayoutRoot = document.createElement('div');
      this.customLayoutRoot.className = 'free-layout-root';
      this.workspace.insertBefore(this.customLayoutRoot, this.layoutPreview || null);
      return this.customLayoutRoot;
    }


    restoreDirectLayoutModules() {
      const elements = {
        player: this.playerWrap,
        panel: this.panel,
        cues: this.cues,
        wave: this.pane,
      };
      if (!this.customLayoutRoot?.isConnected) return;
      Object.values(elements).forEach((element) => {
        if (element) {
          element.style.gridArea = '';
          this.workspace.insertBefore(element, this.customLayoutRoot);
        }
      });
      this.customLayoutRoot.remove();
      this.customLayoutRoot = null;
      this.renderedCustomLayoutTree = null;
    }


    createCustomLayoutNode(node) {
      const elements = {
        player: this.playerWrap,
        panel: this.panel,
        cues: this.cues,
        wave: this.pane,
      };
      if (node.type === 'module') {
        const slot = document.createElement('div');
        slot.className = 'layout-child layout-module-slot';
        slot.dataset.layoutModule = node.id;
        if (elements[node.id]) slot.appendChild(elements[node.id]);
        return slot;
      }
      const split = document.createElement('div');
      split.className = `layout-split layout-split-${node.direction}`;
      split.dataset.layoutDirection = node.direction;
      const first = document.createElement('div');
      first.className = 'layout-child';
      const second = document.createElement('div');
      second.className = 'layout-child';
      const divider = document.createElement('div');
      divider.className = `layout-split-divider layout-split-divider-${node.direction}`;
      divider.title = node.direction === 'row' ? '拖动调整左右区域比例' : '拖动调整上下区域比例';
      first.appendChild(this.createCustomLayoutNode(node.children[0]));
      second.appendChild(this.createCustomLayoutNode(node.children[1]));
      split.append(first, divider, second);
      this.applyCustomSplitRatio(first, node.ratio);
      this.bindCustomLayoutDivider(divider, split, first, node);
      return split;
    }


    applyCustomSplitRatio(first, ratio) {
      first.style.flex = `0 0 calc(${clamp(Number(ratio) || 50, 20, 80)}% - 3.5px)`;
    }


    bindCustomLayoutDivider(divider, split, first, node) {
      let drag = null;
      divider.addEventListener('pointerdown', (event) => {
        if (this.settings.layout !== 'custom') return;
        event.preventDefault();
        drag = { pointerId: event.pointerId, snapshot: this.getLayoutHistorySnapshot(), changed: false };
        divider.classList.add('dragging');
        divider.setPointerCapture?.(event.pointerId);
      });
      divider.addEventListener('pointermove', (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const rect = split.getBoundingClientRect();
        const position = node.direction === 'row'
          ? ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100
          : ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
        const nextRatio = clamp(position, 20, 80);
        if (nextRatio === node.ratio) return;
        if (!drag.changed) {
          this.recordLayoutUndo('调整自定义布局尺寸', drag.snapshot);
          drag.changed = true;
        }
        node.ratio = nextRatio;
        this.applyCustomSplitRatio(first, node.ratio);
      });
      const finish = (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag = null;
        divider.classList.remove('dragging');
        try { divider.releasePointerCapture?.(event.pointerId); } catch (_) {}
        saveSettings(this.settings);
      };
      divider.addEventListener('pointerup', finish);
      divider.addEventListener('pointercancel', finish);
    }


    applyCustomLayoutTree() {
      if (this.settings.layout !== 'custom') {
        this.restoreDirectLayoutModules();
        return;
      }
      const root = this.ensureCustomLayoutRoot();
      const tree = isCompleteLayoutTree(this.settings.layoutTree)
        ? this.settings.layoutTree
        : cloneLayoutTree(DEFAULT_RIGHT_LAYOUT_TREE);
      this.settings.layoutTree = tree;
      if (this.renderedCustomLayoutTree === tree && root.childElementCount) return;
      root.replaceChildren();
      root.appendChild(this.createCustomLayoutNode(tree));
      this.renderedCustomLayoutTree = tree;
    }


    getLayoutData() {
      return {
        schema: WORKSPACE_SCHEMA,
        preset: this.settings.layout,
        waveformMode: this.settings.mode,
        waveformSettings: {
          visibleSeconds: this.settings.visibleSeconds,
          secondsPerRow: this.settings.secondsPerRow,
          rowHeight: this.settings.rowHeight,
          waveformScale: this.settings.waveformScale,
          waveformScaleAuto: this.settings.waveformScaleAuto !== false,
          side: this.settings.side,
          disabledDisplay: this.settings.disabledDisplay,
          showGroupBadges: this.settings.showGroupBadges !== false,
          dragPlayhead: this.settings.dragPlayhead === true,
        },
        splitPercent: this.settings.splitPercent,
        columnPercent: this.settings.layoutColumnPercent,
        rows: [...this.settings.layoutRows],
        tree: cloneLayoutTree(this.settings.layoutTree),
      };
    }


    getLayoutHistorySnapshot() {
      return {
        layout: this.getLayoutData(),
        layoutEditing: !!this.settings.layoutEditing,
      };
    }


    recordLayoutUndo(label, snapshot = this.getLayoutHistorySnapshot()) {
      this.options.onLayoutUndo?.(label, snapshot);
    }


    restoreLayoutHistorySnapshot(snapshot) {
      if (!snapshot || !snapshot.layout) return false;
      const layout = normalizeLayoutData(snapshot.layout);
      this.settings.layout = layout.preset;
      if (layout.waveformMode) this.settings.mode = layout.waveformMode;
      // 兜底给出 waveformScaleAuto：工程完全没有 waveformSettings 时，必须显式
      // 回到「未决定」，否则 Object.assign 不写这个键会让上一个工程的 false 残留。
      Object.assign(this.settings, layout.waveformSettings || { waveformScaleAuto: true });
      this.settings.splitPercent = layout.splitPercent;
      this.settings.layoutColumnPercent = layout.columnPercent;
      this.settings.layoutRows = layout.rows;
      this.settings.layoutTree = layout.tree;
      this.settings.layoutEditing = layout.preset === 'custom' && !!snapshot.layoutEditing;
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
      return true;
    }


    resetLayout() {
      this.recordLayoutUndo('重置工作区');
      this.setLayout(DEFAULT_SETTINGS.layout);
      this.setStatus('已恢复默认工作区');
    }


    setLayoutData(value, { render = true } = {}) {
      const layout = normalizeLayoutData(value);
      this.settings.layout = layout.preset;
      if (layout.waveformMode) this.settings.mode = layout.waveformMode;
      // 兜底给出 waveformScaleAuto：工程完全没有 waveformSettings 时，必须显式
      // 回到「未决定」，否则 Object.assign 不写这个键会让上一个工程的 false 残留。
      Object.assign(this.settings, layout.waveformSettings || { waveformScaleAuto: true });
      this.settings.splitPercent = layout.splitPercent;
      this.settings.layoutColumnPercent = layout.columnPercent;
      this.settings.layoutRows = layout.rows;
      this.settings.layoutTree = layout.tree;
      this.settings.layoutEditing = false;
      saveSettings(this.settings);
      this.applyLayout();
      if (render) this.render();
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return descriptors;
});
