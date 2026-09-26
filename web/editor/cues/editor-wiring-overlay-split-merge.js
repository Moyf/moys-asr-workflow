






















// === 拆分 ===








function fallbackSplitOffset(text, requestedOffset = null) {
  const length = String(text || '').length;
  if (!length) return null;
  if (length <= 1) return 0;
  const requested = Number.isFinite(Number(requestedOffset))
    ? Math.round(Number(requestedOffset)) : Math.floor(length / 2);
  return Math.max(1, Math.min(length - 1, requested));
}

function splitOffsetNearTimeForModal(segment, timeMs, splitMode) {
  const offset = MaweSplitCore.splitOffsetNearTime(segment, timeMs, splitMode);
  if (Number.isInteger(offset)) return offset;
  const start = Number(segment?.start);
  const end = Number(segment?.end);
  const time = Number(timeMs);
  const ratio = Number.isFinite(start) && Number.isFinite(end) && end > start && Number.isFinite(time)
    ? (time - start) / (end - start) : 0.5;
  return fallbackSplitOffset(segment?.text, ratio * String(segment?.text || '').length);
}

function splitOffsetNearTextPositionForModal(text, offset, splitMode) {
  const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(text || '', splitMode);
  const requested = Math.max(0, Math.min(String(text || '').length, Math.round(Number(offset) || 0)));
  if (legalOffsets.length) {
    return legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best
    ), legalOffsets[0]);
  }
  return fallbackSplitOffset(text, requested);
}

















// 拆分对齐的兜底提示（修复③）：文本与词时间戳脱钩、且切分边界明显偏离
// 下刀位置时给出警告，杜绝「字拆对、时拆错」的静默错拆与静默失败。强制
// 拆分（force）会刻意把切点移出词边界，不适用本提示。
function flashSplitAlignmentHint(alignment, { committed = true } = {}) {
  if (!alignment?.broken) return;
  const drift = Number(alignment.driftMs);
  if (!Number.isFinite(drift) || drift <= SPLIT_ALIGNMENT_DRIFT_WARN_MS) return;
  const message = committed
    ? `已拆分，但字幕文本与词时间戳不完全一致，切点与下刀位置相差约 ${Math.round(drift)} ms；如需贴合语音，可先校正文本或检查词时间戳`
    : `未完成拆分：字幕文本与词时间戳不完全一致，切点与下刀位置相差约 ${Math.round(drift)} ms；请调整切点或校正文本后重试`;
  MaweHint.flashHint(window.MAWE_I18N?.translateText?.(message) || message, 'warning');
}

// 拆分失败路径上拿不到 pair，用相同入参重新评估一次对齐质量（纯计算）。
function assessSplitAlignment(segment, offset, cutMs, options = {}) {
  const itemParts = MaweSplitCore.splitItemsAtChar(segment, offset, cutMs, options);
  return {
    ...(itemParts.alignment || { total: 0, aligned: 0, broken: false }),
    driftMs: MULTI_SUBTITLE_UTILS.splitAlignmentDriftMs(itemParts.leftEndMs, itemParts.rightStartMs, cutMs),
  };
}













// 键盘可交互：⌚️ 时间码锚定的主轨和已用 Space/点击锁定的 lane 不响应移动键。




// 左右移动：在当前 lane 的合法断点序列中前进/后退一步。


// 上下移动：按渲染后的视觉行定位。gap 元素样式一致，同一行的 top 相同；
// 行距约等于 line-height（36px），用远小于行距的容差聚类即可。




// 上下移动：目标行上取与当前断点水平距离最近的 gap；单行或越界时返回 null。


// 键盘操作的 lane：优先看真实焦点，失焦（如点到复选框）时回退到上次记录。






// Tab 在主/副 lane 间切换：仅在联动模式且主轨可交互时可用。


// Space 与鼠标点击同语义：锁定当前断点；再按一次解锁以便继续移动。


// 已锁定的 lane 上按移动键：闪烁边缘并提示先解锁再移动。


























// 拆分弹窗状态对应的轨：叠加轨拆分复用副轨弹窗机制，但轨解析走叠加轨。
function splitStateTrack(state) {
  if (state?.kind === 'overlay') return getOverlayTrack();
  return MaweMultiSubtitleCore.getExtensionTrack(state?.trackId);
}

function splitTimingIsValid(segment, cutMs) {
  const start = Number(segment?.start);
  const end = Number(segment?.end);
  const cut = Number(cutMs);
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(cut)
    && end - start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2
    && cut - start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
    && end - cut >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS;
}

function duplicateSplitTimingIsValid(state) {
  if (!state) return false;
  if (state.kind === 'main') {
    return splitTimingIsValid(MaweBoot.DATA.segments[state.mainIndex], state.mainCutMs);
  }
  const track = splitStateTrack(state);
  if (state.kind === 'extension' || state.kind === 'overlay') {
    return splitTimingIsValid(
      MaweMultiSubtitleCore.extensionSegmentById(state.extensionId, track),
      state.extensionCutMs,
    );
  }
  const main = MaweBoot.DATA.segments[state.mainIndex];
  const extension = MaweMultiSubtitleCore.extensionSegmentById(state.extensionId, track);
  return splitTimingIsValid(main, state.mainCutMs)
    && splitTimingIsValid(extension, state.extensionCutMs);
}











// 降级路径：副轨无法形成合法拆分时，只拆主轨并解除与副字幕的绑定。




// 叠加轨拆分：复用副轨的独立拆分弹窗机制（单 lane、无主副联动），
// 但组引用（颜色/表情包）按主轨拆分规则在叠加轨数组内维护。
function openOverlaySplitModal(index, timeMs, initial = {}) {
  const track = getOverlayTrack();
  const segment = track?.segments?.[index];
  if (!segment) return false;
  if (segment.end - segment.start < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2) {
    MaweHint.flashHint('叠加字幕总时长不足 200ms，无法拆分', 'warning');
    return false;
  }
  const state = MaweSplitCore.extensionOnlySplitState(index, track, { timeMs, ...initial });
  if (!state) {
    MaweHint.flashHint('这条叠加字幕没有可用的文字边界', 'invalid');
    return false;
  }
  state.kind = 'overlay';
  state.feedbackPoint = state.feedbackPoint
    || MaweCoreState.waveformEditor?.getSplitPointAtTime?.(timeMs, 'extension') || null;
  MaweSplitCore.pendingLinkedSplit = state;
  MaweDom.multiSubtitleSplitModal?.classList.add('show');
  MaweSplitCore.renderLinkedSplitText(state);
  return true;
}

function commitOverlaySplit(
  state,
  {
    force = false,
    duplicateText = false,
    successMessage = '已按选择的断点拆分叠加字幕',
  } = {},
) {
  const track = getOverlayTrack();
  const overlayIndex = track?.segments?.findIndex((segment) => segment.id === state.extensionId) ?? -1;
  const segment = track?.segments?.[overlayIndex];
  if (!track || overlayIndex < 0 || !segment) return false;
  const splitMs = force
    ? MaweSplitCore.forceSplitCutForSegments([segment], state.extensionCutMs)
    : state.extensionCutMs;
  if (!Number.isFinite(splitMs)) {
    MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
    return false;
  }
  const splitAlignmentOptions = {
    preserveCutMs: force || Number.isFinite(state.fixedCutMs),
    forceCut: force,
  };
  const pair = MaweSplitCore.buildSplitPair(
    segment,
    state.offset,
    splitMs,
    segment.id || `overlay-${overlayIndex}`,
    true,
    state.extensionMode,
    { ...splitAlignmentOptions, duplicateText },
  );
  if (!pair) {
    if (!force && !duplicateText) {
      flashSplitAlignmentHint(
        assessSplitAlignment(segment, state.offset, splitMs, splitAlignmentOptions),
        { committed: false },
      );
    }
    return false;
  }
  if (!force && !duplicateText) flashSplitAlignmentHint(pair.alignment, { committed: true });
  MaweHistory.pushUndo(duplicateText ? '拆分叠加字幕并保留原文' : '拆分叠加字幕', { captureView: true });
  MaweSelection.clearSelection({ commitCuePanel: false });
  track.segments.splice(overlayIndex, 1, pair.left, pair.right);
  // 组引用维护与主轨拆分一致：替换下标之后的引用右移一格，
  // 左半继承 head 时右半以 ref 指回它；其余指向旧 head 的引用仍有效。
  for (let index = overlayIndex + 2; index < track.segments.length; index++) {
    const item = track.segments[index];
    if (item.sticker_ref?.headIdx > overlayIndex) item.sticker_ref.headIdx += 1;
    if (item.color_ref?.headIdx > overlayIndex) item.color_ref.headIdx += 1;
  }
  if (pair.left.sticker) pair.right.sticker_ref = { name: pair.left.sticker.name, headIdx: overlayIndex };
  if (pair.left.color) pair.right.color_ref = { name: pair.left.color.name, headIdx: overlayIndex };
  track._dirty = true;
  MaweSplitCore.closeLinkedSplitModal();
  MaweSelection.clearSelection({ commitCuePanel: false });
  MaweCuePanel.renderAll();
  MaweState.selection.clear('overlay');
  MaweState.selection.add('overlay', overlayIndex + 1);
  MaweState.selection.overlayAnchor = overlayIndex + 1;
  MaweCuePanel.setCuePanelTarget('overlay', overlayIndex + 1);
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweSplitCore.flashSplitFeedback({
    index: overlayIndex,
    track: 'overlay',
    splitMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  MaweNinja.triggerNinjaSplitFeedback(MaweNinja.ninjaModalSplitPoint(state, splitMs, 'overlay'));
  if (successMessage) MaweHint.flashHint(successMessage, 'success');
  return true;
}







// 拆分来源可能是字幕列表、当前编辑区或弹窗；只有列表来源有可靠的列表坐标，
// 其它来源统一回退到波形时间位置。波形反馈只创建一个短暂标记，不参与播放帧刷新。




// === 合并 ===
// 把 DATA.segments 中连续下标 sorted 合并为一条，并维护 group 引用与组时间范围。
// 不做参数校验、撤销与渲染，由调用方负责（mergeSegments / autoMergeSegments 共用）。




// 只合并副轨连续字幕。副字幕没有主轨的 group 引用和 items，
// 因此这里保留独立轨的文本/时间合并语义；如果被合并段存在一对一绑定，
// 合并后无法同时指向多个主字幕，旧绑定会被移除并提示用户重新绑定。


// 只合并叠加轨连续字幕。叠加轨的分组（颜色/表情包）引用叠加轨自身段，
// 合并语义与主轨一致：全部成员同组时继承，混合组不继承。
function mergeOverlaySegments(idxs) {
  const track = getOverlayTrack();
  if (!track || !idxs?.length) return false;
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length < 2) {
    MaweHint.flashHint('请选择至少两个叠加字幕块！', 'invalid');
    return false;
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      MaweHint.flashHint('选中的叠加字幕必须连续', 'invalid');
      return false;
    }
  }
  const segments = sorted.map((index) => track.segments[index]).filter(Boolean);
  if (segments.length !== sorted.length) return false;
  const sourceEl = MaweCoreState.container.querySelector(`.overlay-track-cue[data-overlay-idx="${sorted[0]}"]`);
  const cueListAnchor = MaweCueListAnchor.captureVisibleCueListVisualAnchor(sourceEl);
  const stickerGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
    track.segments, sorted, 'sticker', 'sticker_ref',
  );
  const colorGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
    track.segments, sorted, 'color', 'color_ref',
  );
  const merged = {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
      track.segments,
      `${segments[0].id || track.id}-merged`,
      'overlay',
    ),
    start: segments[0].start,
    end: segments[segments.length - 1].end,
    text: window.AsrEditorUtils.joinSegmentTexts(
      segments,
      MaweMultiSubtitleCore.mergeJoinSeparatorForMode(MaweMultiSubtitleCore.getMainSubtitleSplitMode({ text: segments.map((s) => s.text || '').join('\n') })),
    ),
    items: segments.flatMap((segment) => segment.items || []),
    sticker: stickerGroup.head,
    sticker_ref: stickerGroup.ref,
    color: colorGroup.head,
    color_ref: colorGroup.ref,
    disabled: !!segments[0].disabled,
    _dirty: true,
  };
  if (Array.isArray(merged.items) && merged.items.length === 0) merged.items = null;
  MaweSelection.clearSelection();
  MaweHistory.pushUndo('合并叠加字幕');
  track.segments.splice(sorted[0], sorted.length, merged);
  track._dirty = true;
  MaweCuePanel.renderAll();
  MaweState.selection.clear('overlay');
  MaweState.selection.add('overlay', sorted[0]);
  MaweState.selection.overlayAnchor = sorted[0];
  MaweCuePanel.setCuePanelTarget('overlay', sorted[0]);
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  const el = MaweCoreState.container.querySelector(`.overlay-track-cue[data-overlay-idx="${sorted[0]}"]`);
  if (cueListAnchor) MaweCueListAnchor.restoreCueListVisualAnchor(el, cueListAnchor);
  MaweHint.flashHint(`已合并 ${sorted.length} 条叠加字幕`, 'success');
  return true;
}





// === 拼合字幕 ===
// 把工具窗参数同步到控件；「吸收过短字幕」关闭时禁用短句相关参数。




// 一键处理整段工程：相邻间隔不超过 autoMergeGapMs 时按吸附方向拼接；
// 过短的字幕（中文 < N 字 / 英文 < N 词）按吸收方向并入相邻字幕。


// 「拼合字幕」的自动延展直接修改主轨边界，不能绕过普通时间编辑使用的
// 绑定同步路径。每个 snap 单独记录旧边界，确保连续间隔同时调整时，副字幕
// 仍按对应的 start/end offset 跟随；Alt 独立拖动不会进入这里。


// === 组拆分 helper（删除 / 清除颜色 / 清除表情包 通用）===
// cutSet: Set<number> 包含被"切开"的 idx；这些 idx 的 head/ref 字段都会被清空，
//         同时把它们所在 group 的成员从切点处拆开，切点之后的部分重新组队，
//         首条升级为新 head，后续 ref 指向它。
//   - 删除场景：cutSet = 被物理删除的 idx；切完后由调用方负责 splice
//   - 清除场景：cutSet = 被清除 group 字段的 idx；调用方不删除字幕本身


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
