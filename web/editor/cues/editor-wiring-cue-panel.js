import { MaweCoreState } from '../state/editor-core-state.js';
import { MaweCuePanelState } from '../state/editor-cue-panel-state.js';
import { MaweMultiSubtitleCore } from '../state/editor-multi-subtitle-core.js';
import { MaweSettings } from '../state/editor-settings.js';
import { MaweState } from '../state/editor-state.js';
import { MaweViewUpdates } from '../state/editor-view-updates.js';
import { MaweDom } from '../ui/editor-dom.js';
import { MaweHint } from '../ui/editor-hint.js';
import { MaweCueElements } from './editor-cue-elements.js';
import { getConfiguredEnterAction } from './editor-cue-events.js';
import { MaweCueListAnchor } from './editor-cue-list-anchor.js';
import { navigateCuePanel, captureCuePanelTextEditSnapshot, cancelCuePanelTextEdit, exitCuePanelEdit, splitCuePanelAtCursor, getCurrentCuePanelTarget, ensureCuePanelUndo, getCuePanelTextElement, commitCuePanelEdit, renderAll } from './editor-cue-panel.js';
import { MaweStickerPicker } from './editor-sticker-picker.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';
export function initMaweCuePanelWiring() {
'use strict';





  // 用于 Shift+click 范围选



// “仅看超长”开启时，刚拆出的字幕临时绕过字数过滤；使用稳定 ID，避免 splice 后下标错位。

// 右键选择「绑定到主字幕」后的等待状态。使用稳定 ID 而不是数组下标，
// 这样等待期间即使列表重绘，也不会把另一条副字幕误绑定过去。

// 隐藏开关开启时，禁用项视为"不可选"（Shift 范围选 / Ctrl 切换都跳过）












// 联动选中只补充另一轨的选中集合，不切换当前字幕编辑区；编辑区焦点仍由用户最后点击的字幕决定。












// 选中全部字幕（跳过「隐藏禁用项」开启时的禁用条目，与其它选择逻辑一致）。

// 返回与 idx 同属一个表情包/颜色分组的全部字幕下标（含 idx 自身）。
// head 持有 sticker/color，成员持 sticker_ref/color_ref 指向 head。

// 普通单击字幕时的选择逻辑：开启「选中整组」且属于分组时选整组，否则只选本行。
















// === 渲染 ===










































MaweDom.cuePanelPrev?.addEventListener('click', () => navigateCuePanel(-1));
MaweDom.cuePanelNext?.addEventListener('click', () => navigateCuePanel(1));
// A keyboard user can enter a panel field while still holding a waveform drag.
// Finish that gesture before accepting a separate edit in the panel.
function finishWaveformBeforePanelEdit() {
  const waveform = MaweCoreState.waveformEditor;
  const drag = waveform?.drag;
  if (!drag) return;
  waveform.endCueDrag({type: drag.changed ? 'pointerup' : 'pointercancel', pointerId: drag.pointerId, ...drag.lastPointerPosition});
}
for (const field of [MaweDom.cuePanelText, MaweDom.cuePanelStart, MaweDom.cuePanelDuration]) {
  field?.addEventListener('focus', finishWaveformBeforePanelEdit);
}
MaweDom.cuePanelText?.addEventListener('focus', captureCuePanelTextEditSnapshot);
MaweDom.cuePanelText?.addEventListener('keydown', (event) => {
  // Esc：按当前字幕编辑区设置决定取消还是提交文本编辑。
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (MaweSettings.EDITOR_SETTINGS.cueEditorCancelOnEscape) cancelCuePanelTextEdit();
    else exitCuePanelEdit();
    return;
  }
  const action = getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'split') splitCuePanelAtCursor();
  else exitCuePanelEdit();
});
MaweDom.cuePanelText?.addEventListener('input', () => {
  const target = getCurrentCuePanelTarget();
  if (!target) return;
  const cueListAnchor = MaweCueListAnchor.captureCueListRenderAnchor();
  ensureCuePanelUndo(target.kind === 'extension' ? '编辑副字幕' : '编辑当前字幕');
  const seg = target.segment;
  seg.text = MaweDom.cuePanelText.value.replace(/\r\n?/g, '\n');
  seg._dirty = true;
  MaweState.markProjectDirty();
  if (target.kind === 'extension') MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweViewUpdates.invalidate({ save: true });
  const splitMode = target.kind === 'extension'
    ? MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(target.track, seg)
    : MaweMultiSubtitleCore.getMainSubtitleSplitMode(seg);
  const metrics = AsrEditorUtils.cueMetrics(
    seg.text, seg.start, seg.end, splitMode,
  );
  MaweDom.cuePanelTotalLength.textContent = String(metrics.totalLength);
  MaweDom.cuePanelCharsPerSecond.textContent = metrics.charsPerSecond.toFixed(2);
  const textEl = getCuePanelTextElement(target);
  if (textEl) {
    textEl.closest('.multi-cue-column, .cue')?.classList.add('dirty');
    MaweCueElements.setTextHtml(textEl, seg.text, MaweDom.searchEl.value);
    MaweCueElements.applyCharCount(textEl.closest('.cue')?.querySelector('.charcount'), seg.text, splitMode);
  }
  if (target.kind === 'extension') MaweCoreState.waveformEditor?.refreshExtensionCueLabel(target.index, target.trackId);
  else if (target.kind === 'overlay') MaweCoreState.waveformEditor?.refreshCueOverlay();
  else MaweCoreState.waveformEditor?.refreshCueLabel(target.index);
  MaweViewUpdates.invalidate({ preview: 'refresh' });
  MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
});
MaweDom.cuePanelText?.addEventListener('blur', () => {
  if (MaweCuePanelState.cuePanelCanceling) return;
  commitCuePanelEdit();
});
MaweDom.cuePanelStart?.addEventListener('change', () => commitCuePanelEdit());
MaweDom.cuePanelDuration?.addEventListener('change', () => commitCuePanelEdit());
MaweDom.cuePanelAddSticker?.addEventListener('click', () => {
  const target = getCurrentCuePanelTarget();
  if (target?.kind === 'main') MaweStickerPicker.openStickerPicker([target.index], false);
  else if (target?.kind === 'overlay') MaweStickerPicker.openStickerPicker([target.index], false, { overlay: true });
});
MaweDom.cuePanelSticker?.addEventListener('click', () => {
  const target = getCurrentCuePanelTarget();
  if (target?.kind === 'main') MaweStickerPicker.openStickerPicker([target.index], false);
  else if (target?.kind === 'overlay') MaweStickerPicker.openStickerPicker([target.index], false, { overlay: true });
});
MaweDom.cuePanelSticker?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const target = getCurrentCuePanelTarget();
  if (target?.kind !== 'main') return;
  MaweStickerPicker.removeStickerCascade(target.index);
  renderAll();
  MaweHint.flashHint('已删除当前表情包', 'success');
});
MaweDom.cuePanelSplit?.addEventListener('click', splitCuePanelAtCursor);



























// === 字数 ===

}
