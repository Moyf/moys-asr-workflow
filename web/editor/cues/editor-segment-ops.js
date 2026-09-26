// 段落操作：连续合并、主/副合并与范围延展。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSegmentOps 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweSegmentOps(global) {
  'use strict';



  // === 合并 ===
  // 把 DATA.segments 中连续下标 sorted 合并为一条，并维护 group 引用与组时间范围。
  // 不做参数校验、撤销与渲染，由调用方负责（mergeSegments / autoMergeSegments 共用）。
  function mergeContiguousIndices(sorted) {
    const segs = sorted.map(i => MaweBoot.DATA.segments[i]);
    const mergeStart = segs[0]?.start;
    const mergeEnd = segs[segs.length - 1]?.end;
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    const extensionTrack = MaweMultiSubtitleCore.multiSubtitleVisible() ? MaweMultiSubtitleCore.getActiveExtensionTrack() : null;
    const oldMainIds = segs.map((segment) => segment.id).filter(Boolean);
    const boundExtensionIds = new Set();
    if (extensionTrack) {
      oldMainIds.forEach((mainId) => {
        const binding = window.AsrEditorUtils.bindingForSegment(multi, mainId, 'main');
        (binding?.extension_segment_ids || []).forEach((extensionId) => boundExtensionIds.add(extensionId));
      });
    }
    const hasMeaningfulExtensionOverlap = (segment) => {
      const overlapStart = Math.max(Number(segment.start), Number(mergeStart));
      const overlapEnd = Math.min(Number(segment.end), Number(mergeEnd));
      return Number.isFinite(overlapStart) && Number.isFinite(overlapEnd)
        && overlapEnd - overlapStart >= MaweMultiSubtitleCore.MULTI_SUBTITLE_MERGE_OVERLAP_TOLERANCE_MS;
    };
    const extensionMergeIndices = extensionTrack
      ? extensionTrack.segments.map((segment, index) => ({ segment, index }))
        .filter(({ segment }) => boundExtensionIds.has(segment.id)
          || hasMeaningfulExtensionOverlap(segment))
        .map(({ index }) => index)
      : [];
    const extensionMergeSegments = extensionMergeIndices.map((index) => extensionTrack.segments[index]);
    const oldExtensionIds = extensionMergeSegments.map((segment) => segment.id).filter(Boolean);
    const stickerGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
      MaweBoot.DATA.segments, sorted, 'sticker', 'sticker_ref',
    );
    const colorGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
      MaweBoot.DATA.segments, sorted, 'color', 'color_ref',
    );
    const commonSpeaker = segs[0].speaker != null
      && segs.every((segment) => segment.speaker === segs[0].speaker)
      ? segs[0].speaker
      : null;
    const merged = {
      id: window.AsrEditorUtils.uniqueStableSegmentId(
        MaweBoot.DATA.segments, `${segs[0].id || 'main'}-merged`, 'main',
      ),
      start: segs[0].start,
      end: segs[segs.length - 1].end,
      text: window.AsrEditorUtils.joinSegmentTexts(
        segs,
        MaweMultiSubtitleCore.mergeJoinSeparatorForMode(MaweMultiSubtitleCore.getMainSubtitleSplitMode({ text: segs.map((s) => s.text || '').join('\n') })),
      ),
      items: segs.flatMap(s => s.items || []),
      sticker: stickerGroup.head,
      sticker_ref: stickerGroup.ref,
      color: colorGroup.head,
      color_ref: colorGroup.ref,
      ...(commonSpeaker !== null ? { speaker: commonSpeaker } : {}),
      disabled: !!segs[0].disabled,  // 合并后取 index=0 的禁用状态
      _dirty: true,
    };
    if (merged.items.length === 0) merged.items = null;

    let mergedExtension = null;
    if (extensionTrack && extensionMergeSegments.length) {
      mergedExtension = {
        id: window.AsrEditorUtils.uniqueStableSegmentId(
          extensionTrack.segments, `${extensionMergeSegments[0].id || extensionTrack.id}-merged`, `${extensionTrack.id}-segment`,
        ),
        start: Math.min(...extensionMergeSegments.map((segment) => segment.start)),
        end: Math.max(...extensionMergeSegments.map((segment) => segment.end)),
        text: window.AsrEditorUtils.joinSegmentTexts(
          extensionMergeSegments,
          MaweMultiSubtitleCore.mergeJoinSeparatorForMode(MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(extensionTrack, {
            text: extensionMergeSegments.map((s) => s.text || '').join('\n'),
          })),
        ),
        _dirty: true,
      };
      if (extensionMergeSegments.some((segment) => Array.isArray(segment.items))) {
        mergedExtension.items = extensionMergeSegments.flatMap((segment) => segment.items || []);
      }
    }

    MaweMultiSubtitleCore.removeBindingsForSegmentIds(oldMainIds, oldExtensionIds);

    // 选区并非全部同组时，不继承该组；先按删除切点规则重组外部存活成员，
    // 避免合并掉某个 head 后留下悬空引用。
    const mergeSet = new Set(sorted);
    if (stickerGroup.headIdx === null) {
      splitGroupsAtCutPoints(mergeSet, 'sticker', 'sticker_ref');
    }
    if (colorGroup.headIdx === null) {
      splitGroupsAtCutPoints(mergeSet, 'color', 'color_ref');
    }

    MaweBoot.DATA.segments.splice(sorted[0], sorted.length, merged);
    if (extensionTrack && extensionMergeIndices.length) {
      for (let i = extensionMergeIndices.length - 1; i >= 0; i--) {
        extensionTrack.segments.splice(extensionMergeIndices[i], 1);
      }
      if (mergedExtension) extensionTrack.segments.splice(extensionMergeIndices[0], 0, mergedExtension);
      if (mergedExtension) {
        multi.bindings.push(window.AsrEditorUtils.buildSubtitleBinding(merged, mergedExtension, extensionTrack.id));
        if (MaweSettings.EDITOR_SETTINGS.multiSubtitleAutoSyncDuration) {
          // C 合并会重新创建一对绑定字幕；与手动绑定保持一致，按开关
          // 将新副字幕的时间范围同步到合并后的主字幕，并整理副轨冲突。
          MaweMultiSubtitleCore.setExtensionSegmentRange(mergedExtension, merged.start, merged.end);
          MaweMultiSubtitleCore.reconcileExtensionTrack(extensionTrack, [mergedExtension]);
          MaweMultiSubtitleCore.syncBindingOffsets();
        }
      }
      MaweMultiSubtitleCore.markMultiSubtitleDirty();
    }
    // splice 后统一重映射 group head：选区内继承的 head 移到首项，
    // 选区之后的 head 则按减少的字幕数量左移。
    const removedCount = sorted.length - 1;  // 合并把 sorted.length 条变成 1 条
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    function remapRef(ref) {
      if (!ref || !Number.isInteger(ref.headIdx)) return;
      if (ref.headIdx >= first && ref.headIdx <= last) {
        ref.headIdx = first;
      } else if (ref.headIdx > last) {
        ref.headIdx -= removedCount;
      }
    }
    MaweBoot.DATA.segments.forEach((segment) => {
      remapRef(segment.sticker_ref);
      remapRef(segment.color_ref);
    });
    MaweTextCleanup.syncTimelineGroupRanges();
    return merged;
  }



  function mergeSegments(idxs) {
  if (idxs.length < 2) { MaweHint.flashHint('请选择至少两个同轨道字幕块！', 'invalid'); return; }
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length < 2) { MaweHint.flashHint('请选择至少两个同轨道字幕块！', 'invalid'); return; }
  // 确保连续
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      MaweHint.flashHint('选中的字幕必须连续', 'invalid');
      return;
    }
  }
  const sourceEl = MaweCoreState.container.querySelector(`.cue[data-idx="${sorted[0]}"]`);
  const cueListAnchor = MaweCueListAnchor.captureVisibleCueListVisualAnchor(sourceEl);
  MaweCuePanel.commitCuePanelEdit();
  MaweHistory.pushUndo('合并字幕', { captureView: true });
  MaweSelection.clearSelection({ silent: true });
  mergeContiguousIndices(sorted);
  MaweCuePanel.renderAll({ cueListAnchor });
  // 合并完成后选中合并结果，方便继续对这句新字幕操作
  MaweSelection.selectOnly(sorted[0]);
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweHint.flashHint(`已合并 ${sorted.length} 条`, 'success');
}



  // 只合并副轨连续字幕。副字幕没有主轨的 group 引用和 items，
  // 因此这里保留独立轨的文本/时间合并语义；如果被合并段存在一对一绑定，
  // 合并后无法同时指向多个主字幕，旧绑定会被移除并提示用户重新绑定。
  function mergeExtensionSegments(idxs, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    if (!track || !idxs?.length) return false;
    const sorted = [...new Set(idxs)].sort((a, b) => a - b);
    if (sorted.length < 2) {
      MaweHint.flashHint('请选择至少两个副字幕块！', 'invalid');
      return false;
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        MaweHint.flashHint('选中的副字幕必须连续', 'invalid');
        return false;
      }
    }
    const segments = sorted.map((index) => track.segments[index]).filter(Boolean);
    if (segments.length !== sorted.length) return false;
    const sourceEl = MaweCoreState.container.querySelector(`.cue[data-ext-idx="${sorted[0]}"]`);
    const cueListAnchor = MaweCueListAnchor.captureVisibleCueListVisualAnchor(sourceEl);

    const oldIds = segments.map((segment) => segment.id).filter(Boolean);
    const merged = {
      id: window.AsrEditorUtils.uniqueStableSegmentId(
        track.segments,
        `${segments[0].id || track.id}-merged`,
        `${track.id}-segment`,
      ),
      start: segments[0].start,
      end: segments[segments.length - 1].end,
      text: window.AsrEditorUtils.joinSegmentTexts(
        segments,
        MaweMultiSubtitleCore.mergeJoinSeparatorForMode(MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, {
          text: segments.map((s) => s.text || '').join('\n'),
        })),
      ),
      _dirty: true,
    };
    const hadBindings = oldIds.some((id) => window.AsrEditorUtils.bindingForSegment(
      MaweMultiSubtitleCore.getMultiSubtitleState(), id, 'extension', track.id,
    ));

    MaweHistory.pushUndo('合并副字幕', { captureView: true });
    MaweSelection.clearSelection();
    MaweMultiSubtitleCore.removeBindingsForSegmentIds([], oldIds);
    track.segments.splice(sorted[0], sorted.length, merged);
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweCuePanel.renderAll({ cueListAnchor });
    MaweSelection.selectOnlyExtension(sorted[0]);
    MaweSelection.lastClickedExtensionIdx = sorted[0];
    MawePlaybackLoop.updateWithoutCueListAutoScroll();
    MaweHint.flashHint(
      hadBindings
        ? `已合并 ${sorted.length} 条副字幕，原绑定已解除`
        : `已合并 ${sorted.length} 条副字幕`,
      'success',
    );
    return true;
  }



  function parseSubtitleExtendMs(input) {
    const raw = String(input?.value ?? '').trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 0) return null;
    return Math.round(value);
  }



  function extendSubtitleRanges() {
    const forwardMs = parseSubtitleExtendMs(MaweDom.subtitleExtendForwardInput);
    if (forwardMs === null) {
      MaweHint.flashHint('向前延长时长必须是大于等于 0 的数字', 'invalid');
      return;
    }
    const backwardMs = parseSubtitleExtendMs(MaweDom.subtitleExtendBackwardInput);
    if (backwardMs === null) {
      MaweHint.flashHint('向后延长时长必须是大于等于 0 的数字', 'invalid');
      return;
    }

    const hasSelection = MaweSelection.selectedIdxs.size > 0;
    const indices = hasSelection ? [...MaweSelection.selectedIdxs] : [];
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(false);
    MaweCuePanel.commitCuePanelEdit();
    const plan = window.AsrEditorUtils.planSubtitleExtension(MaweBoot.DATA.segments, indices, {
      forwardMs,
      backwardMs,
      durationMs: MaweMultiSubtitleCore.getSubtitleTimelineDuration(),
    });
    if (plan.changedIndices.length) {
      MaweHistory.pushUndo('延长字幕');
      let linkedChanged = false;
      const changedSegments = [];
      plan.changes.forEach((change) => {
        const segment = MaweBoot.DATA.segments[change.index];
        if (!segment || !change.changed) return;
        const syncPatch = { oldStart: segment.start, oldEnd: segment.end, mode: 'range' };
        // 这里的 items 绝对时间码保持原样，延长只改变字幕段的外壳范围。
        segment.start = change.start;
        segment.end = change.end;
        segment._dirty = true;
        changedSegments.push(segment);
        linkedChanged = MaweMultiSubtitleCore.syncBoundExtensionForMain(segment, syncPatch) || linkedChanged;
      });
      MaweMultiSubtitleCore.markMainSegmentsDirty(changedSegments);
      MaweTextCleanup.syncTimelineGroupRanges();
      if (linkedChanged || MaweMultiSubtitleCore.multiSubtitleVisible()) MaweMultiSubtitleCore.markMultiSubtitleDirty();
      MaweMultiSubtitleCore.syncBindingOffsets();
      MaweServerSave.scheduleAutoSaveFlush();
      MaweCuePanel.renderAll();
      MawePlaybackLoop.updateWithoutCueListAutoScroll();
    }
    const scope = hasSelection ? `已处理 ${plan.indices.length} 个选中字幕` : `已处理 ${plan.indices.length} 个字幕`;
    MaweHint.flashHint(
      `${scope}：完整延长 ${plan.fullCount} 条，部分延长 ${plan.partialCount} 条，未延长 ${plan.unchangedCount} 条`,
      plan.changedIndices.length ? 'success' : 'warning',
    );
  }



  // === 拼合字幕 ===
  // 把工具窗参数同步到控件；「吸收过短字幕」关闭时禁用短句相关参数。
  function syncAutoMergePanelInputs() {
    if (MaweDom.autoMergeGapMsInput) MaweDom.autoMergeGapMsInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeGapMs);
    if (MaweDom.autoMergeSnapDirectionSelect) MaweDom.autoMergeSnapDirectionSelect.value = MaweSettings.EDITOR_SETTINGS.autoMergeSnapDirection;
    if (MaweDom.autoMergeAbsorbShortToggle) MaweDom.autoMergeAbsorbShortToggle.checked = MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbShort;
    if (MaweDom.autoMergeShortCountInput) MaweDom.autoMergeShortCountInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeShortCount);
    if (MaweDom.autoMergeAbsorbDirectionSelect) MaweDom.autoMergeAbsorbDirectionSelect.value = MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbDirection;
    syncAutoMergeAbsorbFields();
  }



  function syncAutoMergeAbsorbFields() {
    const enabled = MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbShort;
    if (MaweDom.autoMergeShortCountInput) MaweDom.autoMergeShortCountInput.disabled = !enabled;
    if (MaweDom.autoMergeAbsorbDirectionSelect) MaweDom.autoMergeAbsorbDirectionSelect.disabled = !enabled;
    MaweDom.autoMergePanel?.classList.toggle('absorb-disabled', !enabled);
  }



  // 一键处理整段工程：相邻间隔不超过 autoMergeGapMs 时按吸附方向拼接；
  // 过短的字幕（中文 < N 字 / 英文 < N 词）按吸收方向并入相邻字幕。
  function autoMergeSegments() {
    const plan = window.AsrEditorUtils.planAutoMerge(MaweBoot.DATA.segments, {
      gapMs: MaweSettings.EDITOR_SETTINGS.autoMergeGapMs,
      snapDirection: MaweSettings.EDITOR_SETTINGS.autoMergeSnapDirection,
      absorbShort: MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbShort,
      shortCount: MaweSettings.EDITOR_SETTINGS.autoMergeShortCount,
      absorbDirection: MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbDirection,
    });
    if (!plan.snaps.length && !plan.groups.length) {
      MaweHint.flashHint('没有需要拼接/合并的间隔或过短字幕', 'invalid');
      return;
    }
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(false);
    MaweCuePanel.commitCuePanelEdit();
    MaweSelection.clearSelection({ silent: true });
    MaweHistory.pushUndo('拼接/合并字幕');
    const snappedCount = applyAutoMergeSnapsWithBindings(plan.snaps);
    // 合并从后往前进行，保持靠前组的下标仍然有效
    for (let i = plan.groups.length - 1; i >= 0; i--) {
      mergeContiguousIndices(plan.groups[i]);
    }
    MaweCuePanel.renderAll();
    MawePlaybackLoop.updateWithoutCueListAutoScroll();
    const mergedCount = plan.groups.reduce((sum, group) => sum + group.length - 1, 0);
    const parts = [];
    if (snappedCount) parts.push(`吸附 ${snappedCount} 处间隔`);
    if (mergedCount) parts.push(`吸收 ${mergedCount} 条短字幕`);
    MaweHint.flashHint(`已拼接/合并字幕：${parts.join('，')}`, 'success');
  }



  // 「拼合字幕」的自动延展直接修改主轨边界，不能绕过普通时间编辑使用的
  // 绑定同步路径。每个 snap 单独记录旧边界，确保连续间隔同时调整时，副字幕
  // 仍按对应的 start/end offset 跟随；Alt 独立拖动不会进入这里。
  function applyAutoMergeSnapsWithBindings(snaps) {
    let changed = 0;
    let linkedChanged = false;
    (Array.isArray(snaps) ? snaps : []).forEach((snap) => {
      const segment = MaweBoot.DATA.segments[snap?.index];
      if (!segment || !Number.isFinite(snap?.time)) return;
      const oldStart = segment.start;
      const oldEnd = segment.end;
      const snapChanged = window.AsrEditorUtils.applyAutoMergeSnaps(MaweBoot.DATA.segments, [snap]);
      if (!snapChanged) return;
      changed += snapChanged;
      linkedChanged = MaweMultiSubtitleCore.syncBoundExtensionForMain(segment, {
        oldStart,
        oldEnd,
        edge: snap.edge === 'end' ? 'end' : 'start',
      }) || linkedChanged;
    });
    if (linkedChanged) {
      MaweMultiSubtitleCore.markMultiSubtitleDirty();
      MaweMultiSubtitleCore.syncBindingOffsets();
    }
    return changed;
  }



  // === 组拆分 helper（删除 / 清除颜色 / 清除表情包 通用）===
  // cutSet: Set<number> 包含被"切开"的 idx；这些 idx 的 head/ref 字段都会被清空，
  //         同时把它们所在 group 的成员从切点处拆开，切点之后的部分重新组队，
  //         首条升级为新 head，后续 ref 指向它。
  //   - 删除场景：cutSet = 被物理删除的 idx；切完后由调用方负责 splice
  //   - 清除场景：cutSet = 被清除 group 字段的 idx；调用方不删除字幕本身
  function splitGroupsAtCutPoints(cutSet, headField, refField, segments = MaweBoot.DATA.segments) {
  function groupHeadOf(seg, idx) {
    if (seg[headField]) return idx;
    if (seg[refField]) return seg[refField].headIdx;
    return -1;
  }
  // 1) 收集所有原始 group：headIdx → [members 升序]
  const groups = new Map();
  segments.forEach((s, i) => {
    const g = groupHeadOf(s, i);
    if (g < 0) return;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });

  for (const [oldHeadIdx, members] of groups.entries()) {
    // 把成员按"切点"切成多个连续段
    const sub = [];
    let cur = [];
    for (const m of members) {
      if (cutSet.has(m)) {
        if (cur.length) { sub.push(cur); cur = []; }
      } else {
        cur.push(m);
      }
    }
    if (cur.length) sub.push(cur);

    // 拿原 head 数据作为新 head 的模板（深拷贝）
    const oldHead = segments[oldHeadIdx];
    const template = oldHead ? oldHead[headField] : null;
    if (!template) continue;

    sub.forEach((segIdxs, segNo) => {
      if (!segIdxs.length) return;
      const segHeadIdx = segIdxs[0];
      const segLastIdx = segIdxs[segIdxs.length - 1];
      const newStart = segments[segHeadIdx].start;
      const newEnd = segments[segLastIdx].end;

      if (segNo === 0 && segHeadIdx === oldHeadIdx) {
        // 原 head 还活着且未被切除 → 仅修正其时间范围
        if (oldHead[headField].end !== newEnd || oldHead[headField].start !== newStart) {
          oldHead[headField].end = newEnd;
          oldHead[headField].start = newStart;
        }
      } else {
        // 新段段首升级为 head
        const promoted = JSON.parse(JSON.stringify(template));
        promoted.start = newStart;
        promoted.end = newEnd;
        segments[segHeadIdx][headField] = promoted;
        segments[segHeadIdx][refField] = null;
        // 段内其余 ref 改指向新 head
        for (let k = 1; k < segIdxs.length; k++) {
          const refSeg = segments[segIdxs[k]];
          if (refSeg[refField]) {
            refSeg[refField].headIdx = segHeadIdx;
          }
        }
      }
    });
  }

  // 把切点位置的 head/ref 字段全部清空（调用方期望的副作用）
  cutSet.forEach(i => {
    const s = segments[i];
    if (!s) return;
    if (s[headField]) s[headField] = null;
    if (s[refField])  s[refField]  = null;
  });
}



  // === 删除 ===
  // 删除一组 idx，并智能维持 head/ref 链（"组拆分"语义）：
  //   核心规则：被删的任一 idx 都会把它所属的 group 拆成"前段"和"后段"
  //     - 前段（idx < 被删 idx 且原本同组）：保留原 head；head 的 .end 收缩到
  //       前段最后一个存活的 ref/head 的 .end
  //     - 后段（idx > 被删 idx 且原本同组）：第一个存活 ref 晋升为新 head，
  //       后续同组 ref 改指向它
  //   当被删的是 head：前段为空，整段后段重组（与之前的"head 晋升"语义吻合）
  //   当被删的是 ref：head 仍是 head，但 group 被切成两块——这是用户原话
  //     "删除中间的 3 → 4 变 head，5 改 ref→4"
  function deleteSegments(idxs) {
    if (!idxs.length) return;
    const sorted = [...new Set(idxs)].sort((a, b) => a - b);
    if (sorted.length === MaweBoot.DATA.segments.length) {
      MaweHint.flashHint('不能删除全部字幕', 'warning');
      return;
    }
    // Commit any pending cue-panel edit and reset panel state BEFORE splicing.
    // Without this, clearSelection() → setCurrentCuePanelIndex(-1) → commitCuePanelEdit()
    // would write the stale panel text to whatever segment now occupies the old index
    // after splice shifts the array — causing wrong-adjacent text overwrites.
    MaweCuePanel.commitCuePanelEdit();
    MaweCuePanelState.currentCuePanelIdx = -1;
    MaweCuePanelState.currentCuePanelKind = 'main';
    MaweCuePanelState.currentCuePanelTrackId = null;
    MaweCuePanelState.resetCuePanelEditState();
    MaweHistory.pushUndo(`删除 ${sorted.length} 条字幕`);
    const pairedExtensionIndices = new Set();
    const pairedMainIds = sorted.map((index) => MaweBoot.DATA.segments[index]?.id).filter(Boolean);
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    const extensionTrack = MaweMultiSubtitleCore.multiSubtitleVisible() ? MaweMultiSubtitleCore.getActiveExtensionTrack() : null;
    (multi.bindings || []).forEach((binding) => {
      if (!binding.main_segment_ids?.some((id) => pairedMainIds.includes(id))) return;
      const extensionId = binding.extension_segment_ids?.[0];
      const extensionIndex = extensionTrack?.segments?.findIndex((segment) => segment.id === extensionId);
      if (extensionIndex >= 0) pairedExtensionIndices.add(extensionIndex);
    });
    // 关闭多字幕时仍清理已失效的主轨绑定，但不删除隐藏的副字幕。
    MaweMultiSubtitleCore.removeBindingsForSegmentIds(
      pairedMainIds,
      MaweMultiSubtitleCore.multiSubtitleVisible()
        ? [...pairedExtensionIndices].map((index) => extensionTrack?.segments[index]?.id)
        : [],
    );
    const removeSet = new Set(sorted);

    // ---- 用通用 helper 做组拆分（同时清掉被删 idx 的 head/ref 字段）----
    splitGroupsAtCutPoints(removeSet, 'sticker', 'sticker_ref');
    splitGroupsAtCutPoints(removeSet, 'color',   'color_ref');

    // ---- 兜底：清"指向被删 idx 但没被规划"的残余 ref（理论上 splitGroups 已处理）----
    MaweBoot.DATA.segments.forEach((s, i) => {
      if (removeSet.has(i)) return;
      if (s.sticker_ref && removeSet.has(s.sticker_ref.headIdx)) {
        s.sticker_ref = null;
      }
      if (s.color_ref && removeSet.has(s.color_ref.headIdx)) {
        s.color_ref = null;
      }
    });

    // ---- 倒序 splice 实际删除 ----
    for (let i = sorted.length - 1; i >= 0; i--) {
      MaweBoot.DATA.segments.splice(sorted[i], 1);
    }

    // ---- 修正剩余 *_ref.headIdx：减去"前面被删的数量"----
    function shiftHeadIdx(ref) {
      let shift = 0;
      for (const r of sorted) { if (r < ref.headIdx) shift++; else break; }
      if (shift) ref.headIdx -= shift;
    }
    MaweBoot.DATA.segments.forEach(s => {
      if (s.sticker_ref) shiftHeadIdx(s.sticker_ref);
      if (s.color_ref)   shiftHeadIdx(s.color_ref);
    });
    if (extensionTrack && pairedExtensionIndices.size) {
      [...pairedExtensionIndices].sort((a, b) => b - a).forEach((index) => extensionTrack.segments.splice(index, 1));
    }
    if (pairedExtensionIndices.size) MaweMultiSubtitleCore.markMultiSubtitleDirty();
    // 同样修正"刚被晋升为新 head 的段中"指向它的 ref：
    // splitGroups 写入的 refField.headIdx 是删除前的 idx，需要同样位移
    // 上面 shiftHeadIdx 已经覆盖（它扫所有 segments 的所有 ref）
    MaweSelection.clearSelection({ silent: true });
    MawePlaybackLoop.lastActive = -1;
    MaweCuePanel.renderAll();
    MaweHint.flashHint(`已删除 ${sorted.length} 条`, 'success');
  }



  function deleteExtensionSegments(indices, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    if (!track || !indices?.length) return;
    const sorted = [...new Set(indices)].filter((index) => Number.isInteger(index)
      && index >= 0 && index < track.segments.length).sort((a, b) => a - b);
    if (!sorted.length) return;
    // 先提交并解除编辑区对旧副字幕下标的引用，避免删除前面的段后，
    // 编辑区下标漂移到另一条副字幕。
    MaweCuePanel.commitCuePanelEdit();
    MaweCuePanelState.currentCuePanelIdx = -1;
    MaweCuePanelState.currentCuePanelKind = 'main';
    MaweCuePanelState.currentCuePanelTrackId = null;
    MaweCuePanelState.resetCuePanelEditState();
    const ids = sorted.map((index) => track.segments[index]?.id).filter(Boolean);

    // 删除绑定副字幕时沿用主轨删除语义：绑定关系和另一侧字幕一起删除，
    // 这样从任意 lane 删除都能用同一条撤销记录完整恢复。未绑定的副轨段
    // 仍允许单独删除；混合选择时两类操作会分别使用各自的历史记录。
    const pairedMainIndices = new Set();
    const unboundIds = new Set(ids);
    ids.forEach((id) => {
      const binding = window.AsrEditorUtils.bindingForSegment(
        MaweMultiSubtitleCore.getMultiSubtitleState(), id, 'extension', track.id,
      );
      if (!binding) return;
      const mainId = binding.main_segment_ids?.[0];
      const mainIndex = MaweBoot.DATA.segments.findIndex((segment) => segment.id === mainId);
      if (mainIndex >= 0) pairedMainIndices.add(mainIndex);
      unboundIds.delete(id);
    });
    if (pairedMainIndices.size) {
      deleteSegments([...pairedMainIndices]);
    }

    const remainingIndices = track.segments
      .map((segment, index) => unboundIds.has(segment.id) ? index : -1)
      .filter((index) => index >= 0);
    if (!remainingIndices.length) return;

    MaweHistory.pushUndo(`删除 ${sorted.length} 条副字幕`);
    MaweMultiSubtitleCore.removeBindingsForSegmentIds([], [...unboundIds]);
    remainingIndices.reverse().forEach((index) => track.segments.splice(index, 1));
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweState.selection.clear('extension');
    MaweCuePanel.renderAll();
    MaweHint.flashHint(`已删除 ${remainingIndices.length} 条副字幕`, 'success');
  }

  global.MaweSegmentOps = Object.freeze({
    mergeContiguousIndices,
    mergeSegments,
    mergeExtensionSegments,
    parseSubtitleExtendMs,
    extendSubtitleRanges,
    syncAutoMergePanelInputs,
    syncAutoMergeAbsorbFields,
    autoMergeSegments,
    applyAutoMergeSnapsWithBindings,
    splitGroupsAtCutPoints,
    deleteSegments,
    deleteExtensionSegments
  });
})(typeof window !== 'undefined' ? window : globalThis);
