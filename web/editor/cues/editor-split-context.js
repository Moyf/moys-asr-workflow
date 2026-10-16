
import { MaweNinja } from "../ui/editor-ninja.js";
import { MaweCueListAnchor } from "./editor-cue-list-anchor.js";
import { MaweSplitCore } from "./editor-split-core.js";// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';



import { MaweTimeline } from "./editor-timeline.js";function splitFromContextMenu(idx, x, y, waveformTimeMs = null, { splitTextMode = null } = {}) {
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
    MaweSplitCore.pendingLinkedSplit = MaweSplitCore.linkedSplitState(idx, { ...initial, splitTextMode });
    if (!MaweSplitCore.pendingLinkedSplit) return false;
    MaweDom.multiSubtitleSplitModal?.classList.add('show');
    MaweSplitCore.renderLinkedSplitText(MaweSplitCore.pendingLinkedSplit);
    return false;
  }
  if (Number.isFinite(waveformTimeMs)) {
    if (!MaweSplitCore.shouldUseMainSplitTimestamps(MaweBoot.DATA.segments[idx])) {
      MaweSplitCore.notifyMainSplitTimestampFallback(MaweBoot.DATA.segments[idx]);
      MaweSplitCore.openMainWaveformSplitModal(idx, waveformTimeMs, { splitTextMode });
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
    const didSplit = MaweSplitCore.splitAtCursor(waveformFeedbackPoint, { listFeedback: false, splitTextMode });
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
    { listFeedback: true, cueListAnchor, splitTextMode },
  );
}

window.MaweSplitContext = Object.freeze({
  splitFromContextMenu
});


import { MaweHint } from "../ui/editor-hint.js";
import { MaweCoreState } from "../state/editor-core-state.js";
import { MaweBoot } from "../boot/editor-boot.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweMultiSubtitleCore } from "../state/editor-multi-subtitle-core.js";
import { MaweInlineEdit } from "./editor-inline-edit.js";export const MaweSplitContext = Object.freeze({
    splitFromContextMenu
  });
window.MaweSplitContext = MaweSplitContext;
