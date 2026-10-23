import { captureCueListVisualAnchor } from './editor-cue-list-anchor.js';
import { caretInfoFromPoint, finishEdit, setEditingCaretOffset, startEdit } from './editor-inline-edit.js';
import { linkedSplitState, notifyMainSplitTimestampFallback, openMainWaveformSplitModal, renderLinkedSplitText, shouldUseMainSplitTimestamps, splitAtCursor, splitOffsetNearTime } from './editor-split-core.js';
import { timelineFrameAlignedMilliseconds } from './editor-timeline.js';

// 右键拆分入口：从右键菜单/波形位置安全拆分。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSplitContext 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
// 右键拆分入口：从右键菜单/波形位置安全拆分。 ESM init 模块：initMaweSplitContext 在原清单位次执行原 IIFE 体（挂
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSplitContext 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。

// window.MaweSplitContext 冻结门面——classic 侧出接口）；底部具名导出经门面在调用时转发，
// 兄弟模块可静态 import。
export function initMaweSplitContext() {
(function initMaweSplitContext(global) {
  'use strict';



  // 波形来源拆分的外置强制拆分 armed：<100ms 切点首次被拒时记录
  // { idx, segment, cutMs }，同一字幕再次按 B 直接强制拆分。segment 引用
  // 用于惰性失效：撤销、合并、再次拆分都会替换该对象，armed 随之作废。
  let waveformForcedSplit = null;

  // 取消时机对照编辑态 armed：编辑态下点击外部（pointerdown 收尾）或按
  // Escape 都会结束编辑并连带销毁 editingState.forceSplitArmed；波形来源
  // 没有编辑态，这里等价地在任何 pointerdown 与 Escape 时清除外置 armed。
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', () => { waveformForcedSplit = null; }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') waveformForcedSplit = null;
    }, true);
  }

  function splitFromContextMenu(idx, x, y, waveformTimeMs = null, { splitTextMode = null } = {}) {
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (!el) return false;
    if (Number.isFinite(waveformTimeMs)) {
      waveformTimeMs = timelineFrameAlignedMilliseconds(waveformTimeMs);
    }
    // 从非编辑态按 B / 右键拆分时，startEdit() 可能让当前行先发生一次布局
    // 变化；锚点必须取自用户按键前看到的位置，而不是临时编辑态的位置。
    const cueListAnchor = Number.isFinite(waveformTimeMs)
      ? null
      : captureCueListVisualAnchor(el);
    const waveformFeedbackPoint = Number.isFinite(waveformTimeMs)
      ? MaweCoreState.waveformEditor?.getSplitPointAtTime?.(waveformTimeMs, 'main') || null
      : null;
    const listCaretInfo = Number.isFinite(waveformTimeMs)
      ? null : caretInfoFromPoint(el.querySelector('.text'), x, y);
    if (MaweMultiSubtitleCore.multiSubtitleVisible() && MaweMultiSubtitleCore.bindingForMainIndex(idx)) {
      notifyMainSplitTimestampFallback(MaweBoot.DATA.segments[idx]);
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
      MaweSplitCore.pendingLinkedSplit = linkedSplitState(idx, { ...initial, splitTextMode });
      if (!MaweSplitCore.pendingLinkedSplit) return false;
      MaweDom.multiSubtitleSplitModal?.classList.add('show');
      renderLinkedSplitText(MaweSplitCore.pendingLinkedSplit);
      return false;
    }
    if (Number.isFinite(waveformTimeMs)) {
      if (!shouldUseMainSplitTimestamps(MaweBoot.DATA.segments[idx])) {
        notifyMainSplitTimestampFallback(MaweBoot.DATA.segments[idx]);
        openMainWaveformSplitModal(idx, waveformTimeMs, { splitTextMode });
        return false;
      }
      const segment = MaweBoot.DATA.segments[idx];
      const cursorOffset = splitOffsetNearTime(
        segment,
        waveformTimeMs,
        MaweMultiSubtitleCore.getMainSubtitleSplitMode(segment),
      );
      if (!Number.isInteger(cursorOffset)) {
        MaweHint.flashHint('这条字幕没有可拆分的文字边界', 'invalid');
        return false;
      }
      // 波形来源不再激活行内编辑：把切点显式交给拆分核心执行（刀光反馈仍按
      // 波形位置触发）。<100ms 首次被拒时 armed 外置在本模块，同一字幕再次
      // 按 B 直接强制拆分。
      const armed = waveformForcedSplit;
      const forcedArmed = Boolean(armed
        && armed.idx === idx
        && armed.segment
        && MaweBoot.DATA.segments[idx] === armed.segment);
      const didSplit = splitAtCursor(waveformFeedbackPoint, {
        listFeedback: false,
        splitTextMode,
        explicit: {
          idx,
          cursorOffset,
          force: forcedArmed,
          onForcedSplitArmed: (cutMs) => {
            waveformForcedSplit = { idx, segment, cutMs };
          },
        },
      });
      if (didSplit) waveformForcedSplit = null;
      return didSplit;
    }
    // 字幕列表：在指定位置进入编辑，光标定位到 (x,y) 后立即拆分
    const caretInfo = listCaretInfo || caretInfoFromPoint(el.querySelector('.text'), x, y);
    const markerX = Number.isFinite(caretInfo?.rect?.left) ? caretInfo.rect.left : x;
    // 先在非编辑态记录文字偏移；进入 contenteditable 后字体/边界可能变化，
    // 再次用同一坐标命中会把「就是｜这颗」漂移到下一个字符。
    startEdit(el, idx);
    if (Number.isFinite(caretInfo?.offset)) setEditingCaretOffset(caretInfo.offset);
    return splitAtCursor(
      { clientX: markerX, clientY: caretInfo?.rect?.top ?? y },
      { listFeedback: true, cueListAnchor, splitTextMode },
    );
  }

  global.MaweSplitContext = Object.freeze({
    splitFromContextMenu
  });
})(typeof window !== 'undefined' ? window : globalThis);
}

export function splitFromContextMenu(...args) { return window.MaweSplitContext.splitFromContextMenu(...args); }
