// 右键菜单：字幕/副字幕/空隙/波形空白菜单与定位。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweContextMenus 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweContextMenus(global) {
  'use strict';



  function findWaveformCueAtTime(timeMs, segments = MaweBoot.DATA.segments) {
    const time = Number(timeMs);
    if (!Number.isFinite(time)) return -1;
    const list = Array.isArray(segments) ? segments : MaweBoot.DATA.segments;
    return list.findIndex((segment) => {
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      return Number.isFinite(start) && Number.isFinite(end) && start < time && time < end;
    });
  }



  // 右键波形背景：添加空隙、创建字幕，或按右键对应的音频位置拆分命中的字幕。
  function showWaveformBlankMenu(timeMs, clickX, clickY, track = 'main') {
  MaweDom.ctxmenu.innerHTML = '';
  // 空白波形按鼠标实际落入的 lane 决定创建轨道；但拆分动作按时间点上
  // 实际存在的两条轨道分别展示，避免用户为了拆副字幕必须先点到副轨空白。
  const effectiveTrack = track === 'extension' ? 'extension' : 'main';
  function addItem(label, kbd, fn, disabled = false) {
    const it = document.createElement('div');
    it.className = `item${disabled ? ' disabled' : ''}`;
    const lbl = document.createElement('span'); lbl.textContent = label;
    it.appendChild(lbl);
    const kb = document.createElement('kbd');
    kb.textContent = kbd || '';
    if (!kbd) kb.style.visibility = 'hidden';
    it.appendChild(kb);
    if (!disabled) {
      it.addEventListener('click', () => { MaweDom.ctxmenu.classList.remove('show'); fn(); });
    }
    MaweDom.ctxmenu.appendChild(it);
  }
  function addSep() {
    const sep = document.createElement('div');
    sep.className = 'sep';
    MaweDom.ctxmenu.appendChild(sep);
  }
  const mainIdx = findWaveformCueAtTime(timeMs, MaweBoot.DATA.segments);
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const extensionIdx = findWaveformCueAtTime(timeMs, extensionTrack?.segments);
  if (effectiveTrack === 'extension') {
    addItem(
      '创建副字幕',
      'N',
      () => MaweAddCue.addExtensionAtWaveformTime(timeMs, clickX, clickY, extensionTrack),
      extensionIdx >= 0,
    );
  } else {
    addItem(
      '创建字幕',
      'N',
      () => MaweAddCue.addCueAtWaveformTime(timeMs, clickX, clickY),
      mainIdx >= 0,
    );
    // 叠加轨启用时提供「创建叠加字幕」：主字幕占用的时间点也能创建
    // （落叠加轨），与主字幕共存；同时间点已有叠加字幕时置灰。
    if (getOverlayTrack()?.enabled === true) {
      addItem(
        '创建叠加字幕',
        '',
        () => addOverlayAtWaveformTime(timeMs, clickX, clickY),
        findWaveformCueAtTime(timeMs, getOverlayTrack()?.segments) >= 0,
      );
    }
  }
  if (Array.isArray(MaweBoot.DATA.segments) && MaweBoot.DATA.segments.length) {
    addItem(
      '按音频位置拆分主字幕',
      'B',
      () => MaweSplitContext.splitFromContextMenu(mainIdx, clickX, clickY, timeMs),
      mainIdx < 0,
    );
  }
  // 拆分副字幕是多重字幕编辑动作；关闭多重字幕（副轨数据保留但不再参与编辑）时不提供。
  if (MaweMultiSubtitleCore.multiSubtitleVisible() && Array.isArray(extensionTrack?.segments) && extensionTrack.segments.length) {
    addItem(
      '按音频位置拆分副字幕',
      '',
      () => MaweSplitCore.openExtensionSplitModal(extensionIdx, timeMs, extensionTrack),
      extensionIdx < 0,
    );
  }
  addSep();
  addItem('添加空隙', '', () => MaweGapRemoveUi.addGapAtWaveformTime(timeMs));
  if (MaweGapRemoveData.getGapRemoveGaps().some((gap) => gap.removed !== false)) {
    addItem('填充区间空隙', '', () => MaweGapRemoveUi.fillGapRangeAtWaveformTime(timeMs));
  }

  MaweDom.ctxmenu.classList.add('show');
  const rect = MaweDom.ctxmenu.getBoundingClientRect();
  let nx = clickX, ny = clickY;
  if (clickX + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 4;
  if (clickY + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 4;
  MaweDom.ctxmenu.style.left = nx + 'px';
  MaweDom.ctxmenu.style.top = ny + 'px';
}



  // === 右键菜单 ===
  let ctxLastClickX = 0, ctxLastClickY = 0;

  function createContextSubmenu(label, className = '') {
    const wrapper = document.createElement('div');
    wrapper.className = `ctxmenu-submenu ${className}`.trim();
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'item ctxmenu-submenu-toggle';
    head.setAttribute('aria-haspopup', 'true');
    head.setAttribute('aria-expanded', 'false');
    const text = document.createElement('span');
    text.textContent = label;
    const arrow = document.createElement('span');
    arrow.className = 'ctxmenu-submenu-arrow';
    arrow.textContent = '›';
    arrow.setAttribute('aria-hidden', 'true');
    head.append(text, arrow);
    const list = document.createElement('div');
    list.className = 'ctxmenu-submenu-list';
    list.hidden = true;
    wrapper.append(head, list);
    let closeTimer;
    function setOpen(open) {
      clearTimeout(closeTimer);
      if (open) {
        for (const sibling of wrapper.parentElement.children) {
          if (sibling !== wrapper && sibling.classList.contains('ctxmenu-submenu')) {
            sibling.dispatchEvent(new Event('close-submenu'));
          }
        }
      }
      list.hidden = !open;
      head.setAttribute('aria-expanded', String(open));
      if (!open) {
        list.querySelectorAll('.ctxmenu-submenu').forEach(child => child.dispatchEvent(new Event('close-submenu')));
        return;
      }
      const anchor = head.getBoundingClientRect();
      const rect = list.getBoundingClientRect();
      const left = anchor.right + rect.width <= window.innerWidth - 4
        ? anchor.right : anchor.left - rect.width;
      list.style.left = `${Math.max(4, Math.min(left, window.innerWidth - rect.width - 4))}px`;
      list.style.top = `${Math.max(4, Math.min(anchor.top - 4, window.innerHeight - rect.height - 4))}px`;
      arrow.textContent = left < anchor.left ? '‹' : '›';
    }
    wrapper.addEventListener('close-submenu', () => setOpen(false));
    wrapper.addEventListener('pointerenter', () => setOpen(true));
    wrapper.addEventListener('pointerleave', () => {
      closeTimer = setTimeout(() => setOpen(false), 180);
    });
    head.addEventListener('click', event => {
      event.stopPropagation();
      setOpen(true);
    });
    wrapper.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' && event.target === head) {
        event.preventDefault(); event.stopPropagation();
        setOpen(true);
        list.querySelector('button, [tabindex="0"]')?.focus();
      } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        setOpen(false);
        head.focus();
      }
    });
    return { wrapper, list };
  }


  function showContextMenu(x, y, idx, waveformTimeMs = null, { splitTextMode = null } = {}) {
  ctxLastClickX = x; ctxLastClickY = y;
  MaweDom.ctxmenu.innerHTML = '';
  // 当前条不在选中里 → 立刻选中（但不改变多选）
  const isMulti = MaweSelection.selectedIdxs.size > 1 && MaweSelection.selectedIdxs.has(idx);
  if (!isMulti && (!MaweSelection.selectedIdxs.has(idx) || MaweSelection.selectedIdxs.size !== 1)) {
    MaweSelection.selectOnly(idx);
    MaweSelection.lastClickedIdx = idx;
  }
  const targetIdxs = isMulti ? [...MaweSelection.selectedIdxs] : [idx];
  const { wrapper: advanced, list: advancedList } = createContextSubmenu('高级操作', 'word-timing-advanced');
  advancedList.classList.add('word-timing-advanced-list');
  const convertWords = document.createElement('button');
  convertWords.type = 'button';
  convertWords.className = 'item danger';
  convertWords.textContent = '字词拆成字幕…';
  convertWords.addEventListener('click', () => {
    MaweDom.ctxmenu.classList.remove('show');
    MaweWordTiming.openConversion(targetIdxs);
  });
  const addAdvancedOverlayConvert = (ids) => {
    const convertOverlay = document.createElement('button');
    convertOverlay.type = 'button';
    convertOverlay.className = 'item';
    convertOverlay.textContent = ids.length > 1 ? `转为叠加字幕 ${ids.length} 条` : '转为叠加字幕';
    convertOverlay.addEventListener('click', () => {
      MaweDom.ctxmenu.classList.remove('show');
      convertMainCuesToOverlay(ids);
    });
    advancedList.appendChild(convertOverlay);
  };

  function addItem(label, kbd, fn, opts = {}) {
    const it = document.createElement('div');
    it.className = 'item' + (opts.danger ? ' danger' : '') + (opts.disabled ? ' disabled' : '');
    const lbl = document.createElement('span'); lbl.textContent = label;
    const kb = document.createElement('kbd'); kb.textContent = kbd || '';
    if (!kbd) kb.style.visibility = 'hidden';
    it.appendChild(lbl); it.appendChild(kb);
    if (!opts.disabled) it.addEventListener('click', () => { MaweDom.ctxmenu.classList.remove('show'); fn(); });
    MaweDom.ctxmenu.appendChild(it);
  }
  function addSep() {
    const s = document.createElement('div'); s.className = 'sep'; MaweDom.ctxmenu.appendChild(s);
  }

  // 颜色子菜单：首行「标记颜色 + 1~5 键位提示」，下方一排加大号色块（好辨认也好点击）
  function addColorSubmenu(targets) {
    const row = document.createElement('div');
    row.className = 'item';
    row.style.cssText = 'cursor:default;display:block;';
    row.addEventListener('click', e => e.stopPropagation());
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;';
    const lbl = document.createElement('span');
    lbl.textContent = '标记颜色';
    head.appendChild(lbl);
    const rangeHint = document.createElement('kbd');
    rangeHint.textContent = '1~5';
    rangeHint.style.marginLeft = 'auto';
    head.appendChild(rangeHint);
    row.appendChild(head);
    const swatches = document.createElement('div');
    swatches.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
    MaweColors.COLOR_PALETTE.forEach((c, colorIndex) => {
      const sw = document.createElement('span');
      sw.title = `${c.label}（按 ${colorIndex + 1}）`;
      sw.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c.value};border:1px solid rgba(255,255,255,.25);cursor:pointer;display:inline-block;box-sizing:border-box;flex:0 0 auto;`;
      sw.addEventListener('mouseenter', () => sw.style.transform = 'scale(1.15)');
      sw.addEventListener('mouseleave', () => sw.style.transform = '');
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        MaweDom.ctxmenu.classList.remove('show');
        MaweStickerPicker.assignColor(targets, c.name);
      });
      swatches.appendChild(sw);
    });
    row.appendChild(swatches);
    MaweDom.ctxmenu.appendChild(row);
    // 「清除颜色」项：仅当选中范围内有颜色时显示
    const hasColorInRange = targets.some(i =>
      MaweBoot.DATA.segments[i].color || MaweBoot.DATA.segments[i].color_ref);
    if (hasColorInRange) {
      addItem('清除颜色', '0', () => MaweStickerPicker.clearColorOnTargets(targets), { danger: true });
    }
  }

  // 「左右添加字符」子菜单：数据驱动预设 + 自定义输入。插入一律双符号形式；
  // 「单双符号」设置只影响识别/解析，不影响这里插入的内容。
  // ASS 特殊文本格式预设仅在当前工程启用 ASS 字幕模式时展示。
  function visibleWrapCharPresets() {
    const assMode = MaweSettings.EDITOR_SETTINGS.assMode === true;
    return (window.AsrEditorUtils.WRAP_CHAR_PRESETS || []).filter(preset => !preset.ass || assMode);
  }
  function addWrapCharsSubmenu(targets, container = MaweDom.ctxmenu) {
    const wrapPresets = visibleWrapCharPresets();
    const { wrapper: row, list } = createContextSubmenu('左右添加字符');
    wrapPresets.forEach((preset) => {
      const entry = document.createElement('div');
      entry.className = 'item';
      entry.style.cssText = 'padding:5px 10px;border-radius:var(--radius-sm);';
      const name = document.createElement('span');
      name.textContent = preset.label;
      entry.appendChild(name);
      const sample = document.createElement('kbd');
      sample.textContent = `${preset.left}文${preset.right}`;
      entry.appendChild(sample);
      entry.addEventListener('click', (e) => {
        e.stopPropagation();
        MaweDom.ctxmenu.classList.remove('show');
        MaweTextProcess.applyWrapChars(targets, preset.left, preset.right, preset.label, { warnWordTimings: false });
      });
      list.appendChild(entry);
    });
    const custom = document.createElement('div');
    custom.className = 'item';
    custom.style.cssText = 'padding:5px 10px;border-radius:var(--radius-sm);';
    const customName = document.createElement('span');
    customName.textContent = '自定义…';
    custom.appendChild(customName);
    custom.addEventListener('click', (e) => {
      e.stopPropagation();
      MaweDom.ctxmenu.classList.remove('show');
      MaweTextProcess.openWrapCharsModal(targets);
    });
    list.appendChild(custom);
    container.appendChild(row);
  }

  if (!isMulti) {
    // 组 1：拆分与跳转。拆分是字幕行右键菜单的首要动作；按住 Shift 时
    // 换成「渐进拆分」（后半句保留整句原文），再按住 Ctrl/Cmd 换成「复制拆分」。
    const splitLabel = splitTextMode === 'progressive'
      ? '渐进拆分'
      : splitTextMode === 'duplicate'
        ? '复制拆分'
        : Number.isFinite(waveformTimeMs)
          ? '按音频位置拆分'
          : '按文字位置拆分';
    // 「按音频位置拆分」对应波形上的 B；「渐进拆分」对应 Shift+B；「复制拆分」对应 Ctrl/Cmd+Shift+B。
    const splitKbd = splitTextMode === 'progressive'
      ? 'Shift+B'
      : splitTextMode === 'duplicate'
        ? 'Ctrl/Cmd+Shift+B'
        : 'B';
    addItem(splitLabel, splitKbd, () => MaweSplitContext.splitFromContextMenu(
      idx, x, y, waveformTimeMs, { splitTextMode },
    ));
    // 仅「仅选中」模式提供「跳转并播放」——其它两种单击行为本身就会跳转。
    if (MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-only') {
      addItem('跳转并播放', '', () => {
        MaweTextCleanup.seekFromWaveform(MaweBoot.DATA.segments[idx].start / 1000);
        if (MaweCoreState.player.paused) MaweMediaPlayback.togglePlayback();
      });
    }
    // 试听：只播放该字幕自身的时间范围，到终点自动暂停；F 为全局快捷键。
    addItem('试听', 'F', () => {
      const segment = MaweBoot.DATA.segments[idx];
      MaweMediaPlayback.auditionRange(segment.start, segment.end);
    });
    addSep();
    // 组 2：外观（表情包与颜色）；表情包功能关闭时隐藏分配入口
    const stickersEnabled = MaweSettings.EDITOR_SETTINGS.stickersEnabled !== false;
    if (stickersEnabled) addItem('分配表情包…', 'T', () => MaweStickerPicker.openStickerPicker([idx], false));
    if (stickersEnabled && (MaweBoot.DATA.segments[idx].sticker || MaweBoot.DATA.segments[idx].sticker_ref)) {
      addItem('删除表情包', '', () => {
        MaweStickerPicker.removeStickerCascade(idx);
        MaweCuePanel.renderAll();
        MaweHint.flashHint('已删除', 'success');
      }, { danger: true });
    }
    addColorSubmenu(targetIdxs);
    if (colorGroupHeadIndex(idx) >= 0) {
      addItem('移出颜色组', '', () => detachColorFromGroup(idx));
    }
    addSep();
    // 组 3：状态与删除
    addItem(
      MaweBoot.DATA.segments[idx].disabled ? '启用此条' : '禁用此条',
      'Alt+点击',
      () => MaweStickerPicker.toggleDisabled([idx])
    );
    addItem('删除字幕', 'Delete', () => {
      MaweSegmentOps.deleteSegments([idx]);
    }, { danger: true });
    if (MaweMultiSubtitleCore.bindingForMainIndex(idx)) {
      addItem('解绑', 'Shift+G', () => {
        MaweSelection.selectOnly(idx);
        MaweBindingAlign.unbindSelectedSubtitlePair();
      });
    }
    // 低频动作收进高级操作：左右添加字符（淡出淡入、音符等单条场景）与叠加轨迁移。
    addWrapCharsSubmenu(targetIdxs, advancedList);
    addAdvancedOverlayConvert([idx]);
  } else {
    // 组 1：合并与批量文本操作
    addItem(`合并 ${targetIdxs.length} 条字幕`, 'C', () => MaweSegmentOps.mergeSegments(targetIdxs));
    addItem('批量替换选中字幕…', '', () => MaweFindReplace.openReplaceModal(targetIdxs));
    addSep();
    // 组 2：外观（表情包与颜色）；「延长表情包」仅在范围内已有表情包时显示
    const stickersEnabled = MaweSettings.EDITOR_SETTINGS.stickersEnabled !== false;
    const hasStickerInRange = stickersEnabled && targetIdxs.some(i =>
      MaweBoot.DATA.segments[i].sticker || MaweBoot.DATA.segments[i].sticker_ref);
    if (hasStickerInRange) {
      addItem('延长表情包', '', () => MaweStickerPicker.expandStickerTime(targetIdxs));
    }
    if (stickersEnabled) addItem('分配表情包…', 'T', () => MaweStickerPicker.openStickerPicker(targetIdxs, true));
    addColorSubmenu(targetIdxs);
    addSep();
    // 组 3：状态与删除
    const _disabledInSel = targetIdxs.filter(i => MaweBoot.DATA.segments[i].disabled).length;
    addItem(
      _disabledInSel === targetIdxs.length ? '启用选中' : '禁用选中',
      '',
      () => MaweStickerPicker.toggleDisabled(targetIdxs)
    );
    addItem(`删除 ${targetIdxs.length} 条字幕`, 'Delete', () => {
      MaweSegmentOps.deleteSegments(targetIdxs);
    }, { danger: true });
    addItem('取消选择', `${MaweDisplaySettings.modKeyLabel()}+D`, () => MaweSelection.clearSelection());
    addWrapCharsSubmenu(targetIdxs, advancedList);
    addAdvancedOverlayConvert(targetIdxs);
  }

  if (MaweWordTiming.enabled) advancedList.appendChild(convertWords);
  addSep();
  MaweDom.ctxmenu.appendChild(advanced);
  // 调整 ctxmenu 位置（避免溢出）
  MaweDom.ctxmenu.classList.add('show');
  const rect = MaweDom.ctxmenu.getBoundingClientRect();
  let nx = x, ny = y;
  if (x + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 4;
  MaweDom.ctxmenu.style.left = nx + 'px';
  MaweDom.ctxmenu.style.top = ny + 'px';
}



  function showExtensionContextMenu(x, y, index, timeMs = null, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    const segment = track?.segments?.[index];
    if (!segment) return;
    MaweDom.ctxmenu.innerHTML = '';
    const addItem = (label, fn, danger = false, disabled = false, kbd = '') => {
      const item = document.createElement('div');
      item.className = `item${danger ? ' danger' : ''}${disabled ? ' disabled' : ''}`;
      const text = document.createElement('span');
      text.textContent = label;
      item.appendChild(text);
      const key = document.createElement('kbd');
      key.textContent = kbd;
      if (!kbd) key.style.visibility = 'hidden';
      item.appendChild(key);
      if (disabled) {
        item.setAttribute('aria-disabled', 'true');
        item.title = '请先解绑当前副字幕';
      } else item.addEventListener('click', () => {
        MaweDom.ctxmenu.classList.remove('show');
        fn();
      });
      MaweDom.ctxmenu.appendChild(item);
    };
    const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(index, track);
    addItem('在鼠标位置拆分', () => MaweSplitCore.openExtensionSplitModal(index, timeMs, track), false, false, 'B');
    const extensionSelectionOnly = MaweSelection.selectedExtensionIdxs.size > 1
      && MaweSelection.selectedExtensionIdxs.has(index);
    addItem(
      '合并副字幕块',
      () => MaweSegmentOps.mergeExtensionSegments([...MaweSelection.selectedExtensionIdxs], track),
      false,
      !extensionSelectionOnly,
      'C',
    );
    addItem(
      segment.disabled ? '启用副字幕' : '禁用副字幕',
      () => MaweStickerPicker.toggleDisabled([index], track),
      false,
      false,
      'Alt+点击',
    );
    addItem('删除副字幕', () => MaweSegmentOps.deleteExtensionSegments([index]), true);
    if (binding) addItem('对齐主字幕时间范围', () => MaweBindingAlign.alignExtensionToMainTimeRange(index, track), false, false, 'H');
    if (binding) addItem('解绑', () => {
      MaweSelection.selectOnlyExtension(index);
      MaweBindingAlign.unbindSelectedSubtitlePair();
    }, false, false, 'Shift+G');
    if (binding) {
      // 一对一关系已经存在时，必须先解绑，避免用户误以为点击后会静默换绑。
      addItem('重新绑定需先解绑', null, false, true);
    } else {
      if (MaweSelection.selectedIdxs.size === 1) {
        addItem('与选中的主字幕绑定', () => {
          // 右键不会触发副字幕的普通 pointerdown；先补上副轨选择，
          // 再复用顶部「绑定」操作。这里是用户明确保留主字幕后发起的绑定，
          // 因此保留主字幕选区，作为有意的直接绑定/替换入口。
          MaweSelection.selectOnlyExtension(index, track, true, true);
          MaweBindingAlign.bindSelectedSubtitlePair();
        }, false, false, 'G');
      }
      // 即使当前还保留着一条主字幕选区，也保留自动匹配入口，方便按时间
      // 选择最早的未绑定主字幕；明确绑定选中项则使用上面的入口。
      addItem('绑定到主字幕', () => MaweBindingAlign.beginPendingExtensionBinding(index, track), false, false, 'G');
    }
    MaweDom.ctxmenu.classList.add('show');
    const rect = MaweDom.ctxmenu.getBoundingClientRect();
    MaweDom.ctxmenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    MaweDom.ctxmenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  }



  function showGapContextMenu(x, y, index) {
    const gap = MaweGapRemoveData.getGapRemoveGaps()[index];
    if (!gap) return;
    MaweDom.ctxmenu.innerHTML = '';
    const addItem = (label, fn, { danger = false } = {}) => {
      const item = document.createElement('div');
      item.className = 'item' + (danger ? ' danger' : '');
      const text = document.createElement('span');
      text.textContent = label;
      item.appendChild(text);
      item.addEventListener('click', () => {
        MaweDom.ctxmenu.classList.remove('show');
        fn();
      });
      MaweDom.ctxmenu.appendChild(item);
    };
    addItem(gap.removed === false ? '移除区段' : '恢复区段', () => MaweGapRemoveUi.toggleGapRemoved(index));
    const separator = document.createElement('div');
    separator.className = 'sep';
    MaweDom.ctxmenu.appendChild(separator);
    addItem('清理空隙', () => MaweGapRemoveUi.clearGap(index), { danger: true });

    MaweDom.ctxmenu.classList.add('show');
    const rect = MaweDom.ctxmenu.getBoundingClientRect();
    MaweDom.ctxmenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    MaweDom.ctxmenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  }



  function closeContextMenuOnOutsidePointerDown(event) {
    if (!MaweDom.ctxmenu.contains(event.target)) MaweDom.ctxmenu.classList.remove('show');
  }

  global.MaweContextMenus = Object.freeze({
    findWaveformCueAtTime,
    showWaveformBlankMenu,
    get ctxLastClickX() { return ctxLastClickX; },
    set ctxLastClickX(v) { ctxLastClickX = v; },
    get ctxLastClickY() { return ctxLastClickY; },
    set ctxLastClickY(v) { ctxLastClickY = v; },
    showContextMenu,
    showExtensionContextMenu,
    showGapContextMenu,
    closeContextMenuOnOutsidePointerDown
  });
})(typeof window !== 'undefined' ? window : globalThis);
