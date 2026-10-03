// 绑定对齐：主副字幕绑定、按点击选中与对齐批处理。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweBindingAlign 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweBindingAlign(global) {
  'use strict';


  // 返回与 idx 同属一个表情包/颜色分组的全部字幕下标（含 idx 自身）。
  // head 持有 sticker/color，成员持 sticker_ref/color_ref 指向 head。
  function groupMemberIdxs(idx) {
    const seg = MaweBoot.DATA.segments[idx];
    if (!seg) return [idx];
    const heads = new Set();
    if (seg.sticker) heads.add(idx);
    else if (seg.sticker_ref) heads.add(seg.sticker_ref.headIdx);
    if (seg.color) heads.add(idx);
    else if (seg.color_ref) heads.add(seg.color_ref.headIdx);
    if (!heads.size) return [idx];
    const members = [];
    MaweBoot.DATA.segments.forEach((s, i) => {
      const sHead = s.sticker ? i : (s.sticker_ref ? s.sticker_ref.headIdx : null);
      const cHead = s.color ? i : (s.color_ref ? s.color_ref.headIdx : null);
      if ((sHead !== null && heads.has(sHead)) || (cHead !== null && heads.has(cHead))) {
        members.push(i);
      }
    });
    return members.length ? members : [idx];
  }


  // 普通单击字幕时的选择逻辑：开启「同时选中分组内项目」且属于分组时选整组，否则只选本行。
  function selectCueByClick(idx) {
    MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', idx);
    if (MaweSelection.pendingExtensionBinding) {
      const pending = MaweSelection.pendingExtensionBinding;
      MaweSelection.pendingExtensionBinding = null;
      const track = MaweMultiSubtitleCore.getExtensionTrack(pending.trackId);
      const extensionIndex = track?.segments?.findIndex(
        (segment) => segment.id === pending.extensionId,
      ) ?? -1;
      if (extensionIndex < 0) {
        MaweHint.flashHint('副字幕已不存在，绑定已取消', 'warning');
        return;
      }
      // selectOnly 会清空副轨选择，因此先完成主轨选择，再恢复待绑定的副轨选择。
      MaweSelection.selectOnly(idx, false);
      MaweSelection.selectOnlyExtension(extensionIndex, track, false, true);
      bindSelectedSubtitlePair();
      return;
    }
    if (MaweSettings.EDITOR_SETTINGS.selectGroupMembers) {
      const members = groupMemberIdxs(idx);
      if (members.length > 1) {
        MaweCuePanel.commitCuePanelEdit();
        MaweSelection.clearSelection({ silent: true });
        members.forEach((i) => {
          MaweState.selection.add('main', i);
          MaweSelection.syncBoundSelection('main', i);
          const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
          if (el) el.classList.add('selected');
        });
        MaweDom.selCountEl.textContent = String(MaweSelection.selectedIdxs.size);
        if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
        MaweCuePanel.setCurrentCuePanelIndex(idx);
        return;
      }
    }
    MaweSelection.selectOnly(idx);
  }



  function overlappingMainIndexesForExtension(extension) {
    const start = Number(extension?.start);
    const end = Number(extension?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return MaweBoot.DATA.segments.map((main, mainIndex) => ({ main, mainIndex }))
      .filter(({ main }) => Number(main?.start) < end && Number(main?.end) > start)
      .map(({ mainIndex }) => mainIndex);
  }



  function beginPendingExtensionBinding(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    const extension = track?.segments?.[index];
    if (!extension || !track) return;
    const overlapping = overlappingMainIndexesForExtension(extension);
    const unbound = overlapping.filter((mainIndex) => !MaweMultiSubtitleCore.bindingForMainIndex(mainIndex));
    if (unbound.length) {
      // 有多个候选时仍优先选择时间最早且尚未绑定的主字幕，避免每次绑定都要手动点选。
      const mainIndex = unbound.slice().sort((left, right) => (
        Number(MaweBoot.DATA.segments[left]?.start) - Number(MaweBoot.DATA.segments[right]?.start) || left - right
      ))[0];
      MaweSelection.selectOnly(mainIndex);
      MaweSelection.selectOnlyExtension(index, track, true, true);
      bindSelectedSubtitlePair({
        successMessage: overlapping.length > 1
          ? `有多条主字幕与当前副字幕重叠，已自动绑定时间最早的未绑定主字幕（第 ${mainIndex + 1} 条）`
          : null,
      });
      return;
    }
    MaweSelection.pendingExtensionBinding = { trackId: track.id, extensionId: extension.id };
    MaweSelection.selectOnlyExtension(index, track);
    if (overlapping.length) {
      MaweHint.flashHint('重叠的主字幕已有绑定，请点击主字幕后替换绑定；按 Esc 取消', 'warning');
    } else {
      MaweHint.flashHint('请点击一条主字幕完成绑定；按 Esc 或点击空白处取消');
    }
  }



  function bindSelectedSubtitlePair({ successMessage = null } = {}) {
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (MaweSelection.selectedIdxs.size !== 1 || MaweSelection.selectedExtensionIdxs.size !== 1) {
    MaweHint.flashHint('请分别选中一条主字幕和一条副字幕后再绑定', 'invalid');
    return;
  }
  const mainIndex = [...MaweSelection.selectedIdxs][0];
  const extensionIndex = [...MaweSelection.selectedExtensionIdxs][0];
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const main = MaweBoot.DATA.segments[mainIndex];
  const extension = track?.segments?.[extensionIndex];
  if (!main || !extension) return;
  const replacedBinding = MaweMultiSubtitleCore.bindingForMainIndex(mainIndex);
  return MaweCommands.run('绑定双语字幕', (command) => {
    MaweMultiSubtitleCore.addSubtitleBinding(main, extension, track);
    const autoSynced = MaweSettings.EDITOR_SETTINGS.multiSubtitleAutoSyncDuration
      && alignExtensionToMainTimeRange(extensionIndex, track, { pushHistory: false, showHint: false });
    MaweMultiSubtitleCore.markMainSegmentsDirty([main]);
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    // 绑定会更新波形上的绑定标记；自动同步时也会改变副字幕范围，
    // 因此列表与波形都需要同步刷新。
    command.commit({ cueList: true, waveform: 'overlay' });
    MaweCoreState.waveformEditor?.updateSelection();
    const bindingMessage = successMessage
      || (replacedBinding
        ? `已替换主字幕 ${mainIndex + 1} 的绑定，改为副字幕 ${extensionIndex + 1}`
        : `已绑定主字幕 ${mainIndex + 1} 与副字幕 ${extensionIndex + 1}`);
    MaweHint.flashHint(`${bindingMessage}${autoSynced ? '，并同步时长' : ''}`, 'success');
  });
}



  function unbindSelectedSubtitlePair() {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const ids = new Set();
  MaweSelection.selectedIdxs.forEach((index) => { if (MaweBoot.DATA.segments[index]?.id) ids.add(MaweBoot.DATA.segments[index].id); });
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  MaweSelection.selectedExtensionIdxs.forEach((index) => { if (track?.segments[index]?.id) ids.add(track.segments[index].id); });
  if (!ids.size) return;
  const removed = MULTI_SUBTITLE_UTILS.removeSubtitleBindings(multi, (binding) => (
    binding.main_segment_ids?.some((id) => ids.has(id))
      || binding.extension_segment_ids?.some((id) => ids.has(id))
  ));
  if (!removed.length) {
    MaweHint.flashHint('当前选中字幕没有绑定关系', 'invalid');
    return;
  }
  // removeSubtitleBindings 已经返回具体关系；快照必须在真正修改前建立。
  // 这里把预览关系恢复后再记录，避免解绑动作无法撤销。
  multi.bindings.push(...removed);
  return MaweCommands.run('解绑双语字幕', (command) => {
    MULTI_SUBTITLE_UTILS.removeSubtitleBindings(multi, (binding) => removed.includes(binding));
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweMultiSubtitleCore.syncBindingOffsets();
    // 解绑会移除波形上的绑定标记，也需要刷新字幕块覆盖层。
    command.commit({ cueList: true, waveform: 'overlay' });
    MaweCoreState.waveformEditor?.updateSelection();
    MaweHint.flashHint(`已解绑 ${removed.length} 对字幕`, 'success');
  });
}



  function alignExtensionToMainTimeRanges(
    indices,
    track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
    { pushHistory = true, showHint = true, batch = false } = {},
  ) {
    const uniqueIndices = [...new Set((Array.isArray(indices) ? indices : [indices])
      .map((index) => Number(index)).filter(Number.isInteger))];
    const targets = [];
    let skippedUnbound = 0;
    let skippedInvalid = 0;
    uniqueIndices.forEach((index) => {
      const extension = track?.segments?.[index];
      const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(index, track);
      const main = binding ? MaweMultiSubtitleCore.mainSegmentById(binding.main_segment_ids?.[0]) : null;
      if (!extension || !binding || !main) {
        skippedUnbound += 1;
        return;
      }
      const start = Math.round(Number(main.start));
      const end = Math.round(Number(main.end));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        skippedInvalid += 1;
        return;
      }
      const alreadyAligned = Number(extension.start) === start && Number(extension.end) === end;
      const hasOverlap = MaweMultiSubtitleCore.extensionRangeOverlapsNeighbors(extension, start, end, track);
      if (!alreadyAligned || hasOverlap) targets.push({ extension, start, end });
    });

    if (!targets.length) {
      if (showHint) {
        if (skippedInvalid && !skippedUnbound) MaweHint.flashHint('主字幕时间范围无效，无法对齐', 'warning');
        else if (batch || uniqueIndices.length > 1) {
          MaweHint.flashHint(skippedUnbound
            ? '选中的副字幕中没有可对齐的绑定关系'
            : '选中的副字幕已经与各自主字幕时间范围一致');
        } else if (skippedUnbound) {
          MaweHint.flashHint('请先绑定副字幕，才能对齐主字幕时间范围', 'invalid');
        } else {
          MaweHint.flashHint('副字幕已经与主字幕时间范围一致');
        }
      }
      return false;
    }

    const mutate = (command) => {
      // 先写入全部目标范围，再统一处理其它副字幕的冲突；主字幕范围不会被改写。
      targets.forEach(({ extension, start, end }) => MaweMultiSubtitleCore.setExtensionSegmentRange(extension, start, end));
      const resolved = MaweMultiSubtitleCore.reconcileExtensionTrack(track, targets.map(({ extension }) => extension));
      MaweMultiSubtitleCore.markMultiSubtitleDirty();
      MaweMultiSubtitleCore.syncBindingOffsets();
      command.commit({ cueList: true, preview: 'update' });

      const details = [];
      if (resolved.squeezedCount) details.push(`挤压 ${resolved.squeezedCount} 条副字幕`);
      if (resolved.removedCount) details.push(`删除 ${resolved.removedCount} 条副字幕`);
      if (showHint) {
        const prefix = batch || targets.length > 1
          ? `已批量对齐 ${targets.length} 条副字幕`
          : '已将副字幕对齐到主字幕时间范围';
        const suffix = details.length
          ? `，${details.join('，')}${resolved.unboundCount ? '并解除绑定' : ''}`
          : skippedUnbound ? `，跳过 ${skippedUnbound} 条未绑定副字幕` : '';
        MaweHint.flashHint(`${prefix}${suffix}`, details.length ? 'warning' : 'success');
      }
      return true;
    };
    return pushHistory ? MaweCommands.run(batch || targets.length > 1 ? '批量对齐副字幕' : '对齐副字幕时间范围', mutate) : mutate({ commit: options => MaweViewUpdates.invalidate(options) });
  }



  function alignExtensionToMainTimeRange(
    index,
    track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
    { pushHistory = true, showHint = true } = {},
  ) {
    return alignExtensionToMainTimeRanges([index], track, { pushHistory, showHint });
  }



  function alignSelectedExtensionSubtitleRanges() {
    if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return false;
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const indices = [...MaweSelection.selectedExtensionIdxs];
    if (!indices.length) {
      MaweHint.flashHint('请先选中至少一条副字幕', 'invalid');
      return false;
    }
    return alignExtensionToMainTimeRanges(indices, track, {
      batch: indices.length > 1,
    });
  }

  global.MaweBindingAlign = Object.freeze({
    groupMemberIdxs,
    selectCueByClick,
    overlappingMainIndexesForExtension,
    beginPendingExtensionBinding,
    bindSelectedSubtitlePair,
    unbindSelectedSubtitlePair,
    alignExtensionToMainTimeRanges,
    alignExtensionToMainTimeRange,
    alignSelectedExtensionSubtitleRanges
  });
})(typeof window !== 'undefined' ? window : globalThis);
