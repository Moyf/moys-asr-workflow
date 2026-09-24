// 右键拆分入口：从右键菜单/波形位置安全拆分。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSplitContext 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweSplitContext(global) {
  'use strict';



  function splitFromContextMenu(idx, x, y, waveformTimeMs = null) {
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (!el) return false;
    if (Number.isFinite(waveformTimeMs)) {
      waveformTimeMs = MaweTimeline.timelineFrameAlignedMilliseconds(waveformTimeMs);
    }
    // 从非编辑态按 B / 右键拆分时，startEdit() 可能让当前行先发生一次布局
    // 变化；锚点必须取自用户按键前看到的位置，而不是临时编辑态的位置。
    const cueListAnchor = Number.isFinite(waveformTimeMs)
      ? null
      : MaweCueListAnchor.captureCueListVisualAnchor(el);
    const waveformFeedbackPoint = Number.isFinite(waveformTimeMs)
      ? MaweCoreState.waveformEditor?.getSplitPointAtTime?.(waveformTimeMs, 'main') || null
      : null;
    const listCaretInfo = Number.isFinite(waveformTimeMs)
      ? null : MaweInlineEdit.caretInfoFromPoint(el.querySelector('.text'), x, y);
    if (MaweMultiSubtitleCore.multiSubtitleVisible() && MaweMultiSubtitleCore.bindingForMainIndex(idx)) {
      MaweSplitCore.notifyMainSplitTimestampFallback(MaweBoot.DATA.segments[idx]);
      const initial = Number.isFinite(waveformTimeMs)
        ? { timeMs: waveformTimeMs }
        : Number.isFinite(listCaretInfo?.offset)
          ? {
            mainOffset: listCaretInfo.offset,
            feedbackPoint: MaweNinja.ninjaSplitPointFromRect(listCaretInfo.rect),
            ninjaFromList: true,
          }
          : {};
      if (waveformFeedbackPoint) initial.feedbackPoint = waveformFeedbackPoint;
      MaweSplitCore.pendingLinkedSplit = MaweSplitCore.linkedSplitState(idx, initial);
      if (!MaweSplitCore.pendingLinkedSplit) return false;
      MaweDom.multiSubtitleSplitModal?.classList.add('show');
      MaweSplitCore.renderLinkedSplitText(MaweSplitCore.pendingLinkedSplit);
      return false;
    }
    if (Number.isFinite(waveformTimeMs)) {
      if (!MaweSplitCore.shouldUseMainSplitTimestamps(MaweBoot.DATA.segments[idx])) {
        MaweSplitCore.notifyMainSplitTimestampFallback(MaweBoot.DATA.segments[idx]);
        MaweSplitCore.openMainWaveformSplitModal(idx, waveformTimeMs);
        return false;
      }
      const segment = MaweBoot.DATA.segments[idx];
      const cursorOffset = MaweSplitCore.splitOffsetNearTime(
        segment,
        waveformTimeMs,
        MaweMultiSubtitleCore.getMainSubtitleSplitMode(segment),
      );
      if (!Number.isInteger(cursorOffset)) {
        MaweHint.flashHint('这条字幕没有可拆分的文字边界', 'invalid');
        return false;
      }
      MaweInlineEdit.startEdit(el, idx);
      if (!MaweInlineEdit.setEditingCaretOffset(cursorOffset)) {
        MaweInlineEdit.finishEdit(false);
        MaweHint.flashHint('无法定位波形中的拆分位置', 'warning');
        return false;
      }
      const didSplit = MaweSplitCore.splitAtCursor(waveformFeedbackPoint, { listFeedback: false });
      return didSplit;
    }
    // 字幕列表：在指定位置进入编辑，光标定位到 (x,y) 后立即拆分
    const caretInfo = listCaretInfo || MaweInlineEdit.caretInfoFromPoint(el.querySelector('.text'), x, y);
    const markerX = Number.isFinite(caretInfo?.rect?.left) ? caretInfo.rect.left : x;
    // 先在非编辑态记录文字偏移；进入 contenteditable 后字体/边界可能变化，
    // 再次用同一坐标命中会把「就是｜这颗」漂移到下一个字符。
    MaweInlineEdit.startEdit(el, idx);
    if (Number.isFinite(caretInfo?.offset)) MaweInlineEdit.setEditingCaretOffset(caretInfo.offset);
    return MaweSplitCore.splitAtCursor(
      { clientX: markerX, clientY: caretInfo?.rect?.top ?? y },
      { listFeedback: true, cueListAnchor },
    );
  }

  global.MaweSplitContext = Object.freeze({
    splitFromContextMenu
  });
})(typeof window !== 'undefined' ? window : globalThis);
