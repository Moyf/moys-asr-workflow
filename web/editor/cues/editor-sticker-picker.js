// 表情包选择器：网格渲染、分配/清除与时长拓展。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweStickerPicker 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweStickerPicker(global) {
  'use strict';



  // === 表情包 ===
  let stickerTargetMode = null;

    // 'single' | 'multi'
  let stickerTargetIdxs = [];

       // 要分配的 segment indexes

  function openStickerPicker(idxs, isMulti, { overlay = false } = {}) {
  if (!MaweBoot.STICKERS.length) {
    MaweHint.flashHint('没有可用的表情包，请先用🦊按钮配置表情包文件夹', 'invalid');
    return;
  }
  stickerTargetMode = isMulti ? 'multi' : 'single';
  stickerTargetIdxs = idxs;
  stickerTargetTrack = overlay ? 'overlay' : 'main';
  document.getElementById('sticker-modal-title').textContent =
    isMulti ? `分配表情包到 ${idxs.length} 条字幕（跨时间）` : `分配表情包到${overlay ? '叠加字幕' : '第'} ${idxs[0] + 1}${overlay ? '' : ' 条'}`;
  renderStickerGrid('');
  document.getElementById('sticker-filter').value = '';
  MaweDom.stickerModal.classList.add('show');
  setTimeout(() => document.getElementById('sticker-filter').focus(), 50);
}



  function renderStickerGrid(filter) {
    const grid = document.getElementById('sticker-grid');
    grid.innerHTML = '';
    const f = filter.trim().toLowerCase();
    MaweBoot.STICKERS.forEach((s, i) => {
      const it = document.createElement('div');
      it.className = 'sticker-item';
      if (f && !s.name.toLowerCase().includes(f) && !s.filename.toLowerCase().includes(f)) {
        it.classList.add('hidden');
      }
      const img = document.createElement('img');
      img.src = MaweSelection.stickerUrl(s); img.alt = s.name;
      const nameEl = document.createElement('div');
      nameEl.className = 'sname'; nameEl.textContent = s.name;
      it.appendChild(img); it.appendChild(nameEl);
      it.addEventListener('click', () => assignSticker(s));
      grid.appendChild(it);
    });
  }



  function assignSticker(sticker) {
  const segments = stickerTargetTrack === 'overlay'
    ? (getOverlayTrack()?.segments || null) : MaweBoot.DATA.segments;
  if (!segments) return;
  const hadStickers = MaweBoot.DATA.segments.some((segment) => segment.sticker || segment.sticker_ref)
    || (getOverlayTrack()?.segments || []).some((segment) => segment.sticker || segment.sticker_ref);
  MaweHistory.pushUndo('分配表情包');
  if (stickerTargetMode === 'multi' && stickerTargetIdxs.length > 1) {
    const sorted = [...stickerTargetIdxs].sort((a, b) => a - b);
    const headIdx = sorted[0];
    // 每条字幕都是一个独立的时间实例；head 只负责保存素材，不能把多条字幕
    // 的时间范围合并成一条，否则 XML/OTIO 会把中间的引用压成连续长片段。
    segments[headIdx].sticker = {
      ...sticker, start: segments[headIdx].start, end: segments[headIdx].end,
    };
    segments[headIdx].sticker_ref = null;
    // 后续条：sticker_ref 标记，便于显示和导航
    for (let i = 1; i < sorted.length; i++) {
      segments[sorted[i]].sticker = null;
      segments[sorted[i]].sticker_ref = { name: sticker.name, headIdx };
    }
  } else {
    const idx = stickerTargetIdxs[0];
    // 如果当前条已经是 head（被其他 ref 引用），同步更新所有引用 idx 的 ref.name
    segments.forEach(s => {
      if (s.sticker_ref && s.sticker_ref.headIdx === idx) {
        s.sticker_ref.name = sticker.name;
      }
    });
    segments[idx].sticker = { ...sticker };
    segments[idx].sticker_ref = null;
  }
  MaweDom.stickerModal.classList.remove('show');
  // 叠加轨目标：同步脏标记与保存调度，否则分配只改内存、不落盘。
  if (stickerTargetTrack === 'overlay') {
    const overlay = getOverlayTrack();
    if (overlay) {
      overlay._dirty = true;
      stickerTargetIdxs.forEach((idx) => {
        const segment = overlay.segments?.[idx];
        if (segment) segment._dirty = true;
      });
      MaweServerSave.scheduleAutoSaveFlush();
    }
  }
  if (!hadStickers && !MaweSettings.EDITOR_SETTINGS.cueListShowSticker && !MaweSettings.EDITOR_SETTINGS.cueEditorShowSticker
      && confirm('Oi！检测到你添加了表情包，是否需要帮你打开「设置」中的字幕列表/编辑区的表情包显示开关？   ヾ(´･ω･｀)ﾉ')) {
    MaweSettings.updateEditorSettings({ cueListShowSticker: true, cueEditorShowSticker: true });
    MaweDisplaySettings.applyCueListDisplaySettings();
    MaweDisplaySettings.applyCueEditorDisplaySettings();
  }
  MaweColorFilter.refreshStickerAssignmentUi();
  MaweHint.flashHint(`已分配「${sticker.name}」`, 'success');
}



  function clearStickerOnTargets() {
    MaweHistory.pushUndo('清除表情包');
    // 一次性切除所有目标 idx，触发组拆分
    MaweSegmentOps.splitGroupsAtCutPoints(new Set(stickerTargetIdxs), 'sticker', 'sticker_ref');
    MaweDom.stickerModal.classList.remove('show');
    MaweColorFilter.refreshStickerAssignmentUi();
    MaweHint.flashHint('已清除', 'success');
  }



  // 表情包预览 modal
  let previewIdx = -1;


  function openStickerPreview(idx, { overlay = false } = {}) {
  const segments = stickerSegmentsForTrack(overlay ? 'overlay' : 'main');
  const seg = segments[idx];
  if (!seg?.sticker) return;
  previewIdx = idx;
  previewTrack = overlay ? 'overlay' : 'main';
  document.getElementById('sticker-preview-img').src = MaweSelection.stickerUrl(seg.sticker);
  document.getElementById('sticker-preview-name').textContent = seg.sticker.name;
  MaweDom.stickerPreviewModal.classList.add('show');
}



  // 删除表情包时级联清理引用：
  // - 如果 idx 是 head，清掉所有 headIdx===idx 的 sticker_ref
  // - 如果 idx 是 ref，仅清自己（不影响 head）
  function removeStickerCascade(idx, { overlay = false } = {}) {
  MaweHistory.pushUndo('删除表情包');
  // 走组拆分：被切除的 idx 后面的同 group ref 自动晋升新 head
  MaweSegmentOps.splitGroupsAtCutPoints(
    new Set([idx]), 'sticker', 'sticker_ref',
    overlay ? (getOverlayTrack()?.segments || []) : MaweBoot.DATA.segments,
  );
}



  // 拓展表情包时间到多选范围
  // 选中范围内可以包含 sticker（head）或 sticker_ref（引用），都视作"已有表情包"
  function expandStickerTime(idxs) {
    const sorted = [...idxs].sort((a, b) => a - b);
    // 找选中范围内的 sticker：优先取 head；如果只有 ref，从 ref 回溯到原 head
    let sourceSticker = null;
    for (const i of sorted) {
      if (MaweBoot.DATA.segments[i].sticker) {
        sourceSticker = MaweBoot.DATA.segments[i].sticker;
        break;
      }
    }
    if (!sourceSticker) {
      for (const i of sorted) {
        const ref = MaweBoot.DATA.segments[i].sticker_ref;
        if (ref && MaweBoot.DATA.segments[ref.headIdx]?.sticker) {
          sourceSticker = MaweBoot.DATA.segments[ref.headIdx].sticker;
          break;
        }
      }
    }
    if (!sourceSticker) {
      MaweHint.flashHint('选中范围内没有表情包', 'invalid');
      return;
    }
    MaweHistory.pushUndo('拓展表情包时长');
    const sticker = { ...sourceSticker };
    sticker.start = MaweBoot.DATA.segments[sorted[0]].start;
    sticker.end = MaweBoot.DATA.segments[sorted[sorted.length - 1]].end;
    // 清除范围内所有 sticker / sticker_ref
    sorted.forEach(i => {
      MaweBoot.DATA.segments[i].sticker = null;
      MaweBoot.DATA.segments[i].sticker_ref = null;
    });
    // head：放完整 sticker；后续：放 sticker_ref
    const headIdx = sorted[0];
    MaweBoot.DATA.segments[headIdx].sticker = sticker;
    for (let k = 1; k < sorted.length; k++) {
      MaweBoot.DATA.segments[sorted[k]].sticker_ref = { name: sticker.name, headIdx };
    }
    MaweCuePanel.renderAll();
    MaweHint.flashHint(`已拓展到 ${sorted.length} 条`, 'success');
  }



  // === 标记颜色 ===
  // 数据结构与表情包同构：head 持完整 color，后续条持 color_ref（仅 name + headIdx）
  // 单选 → 设为 head；多选 → 第一条为 head，时间跨整个范围，后续为 ref
  function assignColor(idxs, colorName) {
    if (!idxs.length) return;
    const def = MaweColors.COLOR_BY_NAME[colorName];
    if (!def) return;
    MaweHistory.pushUndo('标记颜色');
    const sorted = [...idxs].sort((a, b) => a - b);
    if (sorted.length === 1) {
      const idx = sorted[0];
      // 如果当前条已经是 head，同步更新所有引用 idx 的 ref.name
      MaweBoot.DATA.segments.forEach(s => {
        if (s.color_ref && s.color_ref.headIdx === idx) {
          s.color_ref.name = colorName;
        }
      });
      MaweBoot.DATA.segments[idx].color = {
        name: colorName, value: def.value,
        start: MaweBoot.DATA.segments[idx].start, end: MaweBoot.DATA.segments[idx].end,
      };
      MaweBoot.DATA.segments[idx].color_ref = null;
    } else {
      const headIdx = sorted[0];
      // 选区可能只包含已有颜色组的一部分。先在选中项处切开旧组，
      // 让未选中的成员保留原颜色，并避免旧 head 被降级后仍被外部 ref 指向。
      // （main 218ee1e0 修复，合并时补录；splitGroupsAtCutPoints 为 editor.js 全局。）
      MaweSegmentOps.splitGroupsAtCutPoints(new Set(sorted), 'color', 'color_ref');
      const start = MaweBoot.DATA.segments[headIdx].start;
      const end = MaweBoot.DATA.segments[sorted[sorted.length - 1]].end;
      MaweBoot.DATA.segments[headIdx].color = { name: colorName, value: def.value, start, end };
      MaweBoot.DATA.segments[headIdx].color_ref = null;
      for (let k = 1; k < sorted.length; k++) {
        MaweBoot.DATA.segments[sorted[k]].color = null;
        MaweBoot.DATA.segments[sorted[k]].color_ref = { name: colorName, headIdx };
      }
    }
    // 单条修改 lead（其 color_ref 成员仍指向它）或多选统一分配时，视为整组联动修改
    const isUnifiedGroup = sorted.length > 1
      || MaweBoot.DATA.segments.some((s) => s.color_ref && s.color_ref.headIdx === sorted[0]);
    MaweColorFilter.refreshColorAssignmentUi();
    MaweHint.flashHint(isUnifiedGroup
      ? `已将关联字幕统一设为「${def.label}色」`
      : `已将字幕设为「${def.label}色」`, 'success');
  }



  // 删除颜色（级联清理）：
  //   - idx 是 head: 清自己 + 所有 headIdx===idx 的 ref
  //   - idx 是 ref: 仅清自己
  function removeColorCascade(idx) {
    // 走组拆分：被切除的 idx 后面的同 group ref 自动晋升新 head
    MaweSegmentOps.splitGroupsAtCutPoints(new Set([idx]), 'color', 'color_ref');
  }



  function clearColorOnTargets(idxs) {
    MaweHistory.pushUndo('清除颜色');
    // 一次性切除所有目标 idx，触发组拆分
    MaweSegmentOps.splitGroupsAtCutPoints(new Set(idxs), 'color', 'color_ref');
    MaweColorFilter.refreshColorAssignmentUi();
    MaweHint.flashHint('已清除颜色', 'success');
  }



  // === 禁用/启用 ===
  // 统一切换语义：目标全部禁用 → 全部启用；否则全部禁用
  // 单条时即"切换这一条的状态"（Alt+点击 / 右键菜单均走这里）
  function toggleDisabled(idxs, track = 'main', { successDetail = null } = {}) {
  const overlayTrackObj = track === 'overlay' ? getOverlayTrack() : null;
  const extensionTrack = track === 'extension'
    ? MaweMultiSubtitleCore.getActiveExtensionTrack()
    : (track?.segments ? track : null);
  const isOverlay = Boolean(overlayTrackObj);
  const isExtension = Boolean(extensionTrack);
  const segments = isOverlay ? overlayTrackObj.segments
    : isExtension ? extensionTrack.segments
    : MaweBoot.DATA.segments;
  const validIdxs = [...new Set(idxs.filter((index) => Number.isInteger(index) && segments[index]))];
  if (!validIdxs.length) return;
  MaweHistory.pushUndo('切换禁用');
  const allDisabled = validIdxs.every((index) => segments[index].disabled);
  const nextDisabled = !allDisabled;
  const boundExtensionTargets = new Map();
  validIdxs.forEach((index) => {
    segments[index].disabled = nextDisabled;
    segments[index]._dirty = true;
  });
  if (!isExtension) {
    // 主字幕是绑定关系的控制端：禁用/启用时同步同一绑定的副字幕；
    // 副字幕自身的操作不反向修改主字幕，保持它可以单独禁用。
    validIdxs.forEach((index) => {
      const binding = MaweMultiSubtitleCore.bindingForMainIndex(index);
      const boundTrack = binding ? MaweMultiSubtitleCore.getExtensionTrack(binding.track_id) : null;
      if (!boundTrack) return;
      const targets = boundExtensionTargets.get(boundTrack) || new Set();
      (binding.extension_segment_ids || []).forEach((id) => {
        const extensionIndex = boundTrack.segments.findIndex((segment) => segment?.id === id);
        if (extensionIndex < 0) return;
        const extension = boundTrack.segments[extensionIndex];
        extension.disabled = nextDisabled;
        extension._dirty = true;
        targets.add(extensionIndex);
      });
      if (targets.size) boundExtensionTargets.set(boundTrack, targets);
    });
  }
  if (isExtension || boundExtensionTargets.size) MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweCuePanel.renderAll();
  // 隐藏开关开启时，刚禁用的项需从选中集移除（保持状态一致）
  if (MaweDom.hideDisabled && !allDisabled) {
    if (isOverlay) {
      validIdxs.forEach((index) => {
        MaweState.selection.remove('overlay', index);
        MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`)?.classList.remove('selected');
      });
    } else {
      const mainDisabled = new Set();
      if (!isExtension) validIdxs.forEach((index) => mainDisabled.add(index));
      const extensionDisabled = isExtension
        ? new Map([[extensionTrack, new Set(validIdxs)]])
        : boundExtensionTargets;
      mainDisabled.forEach((index) => {
        MaweState.selection.remove('main', index);
        MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`)?.classList.remove('selected');
      });
      extensionDisabled.forEach((indexes) => indexes.forEach((index) => {
        MaweState.selection.remove('extension', index);
        MaweCoreState.container.querySelectorAll(
          `.multi-cue[data-ext-idx="${index}"], .multi-extension-cue[data-ext-idx="${index}"]`,
        ).forEach((el) => el.classList.remove('selected'));
      }));
      MaweSelection.updateMultiSelectionClasses();
      updateSelectionCountText();
    }
  }
  const action = allDisabled ? '启用' : '禁用';
  const extensionCount = [...boundExtensionTargets.values()]
    .reduce((total, indexes) => total + indexes.size, 0);
  const detail = successDetail && !allDisabled
    ? `${validIdxs.length} 条${successDetail}${!isExtension && extensionCount ? `，以及副字幕 ${extensionCount} 条` : ''}`
    : !isExtension && extensionCount
    ? `主字幕 ${validIdxs.length} 条及副字幕 ${extensionCount} 条`
    : `${validIdxs.length} 条`;
  MaweHint.flashHint(`已${action} ${detail}`, 'success');
  // 禁用状态同时决定当前时间的预览可见性；列表重绘不会自动触发播放头刷新。
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
}

  global.MaweStickerPicker = Object.freeze({
    get stickerTargetMode() { return stickerTargetMode; },
    set stickerTargetMode(v) { stickerTargetMode = v; },
    get stickerTargetIdxs() { return stickerTargetIdxs; },
    set stickerTargetIdxs(v) { stickerTargetIdxs = v; },
    openStickerPicker,
    renderStickerGrid,
    assignSticker,
    clearStickerOnTargets,
    get previewIdx() { return previewIdx; },
    set previewIdx(v) { previewIdx = v; },
    openStickerPreview,
    removeStickerCascade,
    expandStickerTime,
    assignColor,
    removeColorCascade,
    clearColorOnTargets,
    toggleDisabled
  });
})(typeof window !== 'undefined' ? window : globalThis);
