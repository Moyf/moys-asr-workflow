// 已选计数涵盖主轨/副轨/叠加轨三个选区集。
import { MaweBoot } from '../boot/editor-boot.js';
import { MaweCoreState } from '../state/editor-core-state.js';
import { MaweState } from '../state/editor-state.js';
import { MaweDom } from '../ui/editor-dom.js';
import { MaweCueListAnchor } from './editor-cue-list-anchor.js';
import { commitCuePanelEdit, setCuePanelTarget, focusCuePanelText } from './editor-cue-panel.js';
import { MaweSelection } from './editor-selection.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';
export function updateSelectionCountText() {
  MaweDom.selCountEl.textContent = String(
    MaweSelection.selectedIdxs.size + MaweSelection.selectedExtensionIdxs.size + MaweState.selection.indices('overlay').size,
  );
}

// 叠加字幕行选中高亮与选中计数统一同步：叠加轨没有 multi-cue 类，
// 不能走 updateMultiSelectionClasses，这里按 data-overlay-idx 直接同步。
export function syncOverlaySelectionClasses() {
  MaweCoreState.container.querySelectorAll('.cue[data-overlay-idx].selected').forEach((el) => {
    if (!MaweState.selection.indices('overlay').has(Number(el.dataset.overlayIdx))) el.classList.remove('selected');
  });
  MaweState.selection.indices('overlay').forEach((index) => {
    MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`)?.classList.add('selected');
  });
  updateSelectionCountText();
}

export function selectOverlayCueRow(index, { focusEditor = false } = {}) {
  // 与副字幕 selectOnlyExtension 同一逻辑：点击叠加字幕先清空主轨/副轨
  // 已有选区（clearSelection 同时取消待绑定状态），再单独选中本轨字幕。
  commitCuePanelEdit();
  MaweSelection.clearSelection({ silent: true });
  MaweState.selection.add('overlay', index);
  MaweState.selection.overlayAnchor = index;
  setCuePanelTarget('overlay', index);
  if (focusEditor) focusCuePanelText(index, 'overlay');
  syncOverlaySelectionClasses();
  MaweCoreState.waveformEditor?.updateSelection();
  const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`);
  if (row) MaweCueListAnchor.scrollCueIntoViewIfNeeded(row);
}

export function selectOverlayRange(fromIndex, toIndex) {
  const track = AsrEditorUtils.getOverlayTrack(MaweBoot.DATA);
  const segments = track?.segments || [];
  const from = Math.max(0, Math.min(fromIndex, toIndex));
  const to = Math.min(segments.length - 1, Math.max(fromIndex, toIndex));
  MaweState.selection.clear('overlay');
  for (let index = from; index <= to; index += 1) {
    if (MaweSelection.isHiddenDisabled(index, track)) continue;
    MaweState.selection.add('overlay', index);
  }
  setCuePanelTarget('overlay', toIndex);
  syncOverlaySelectionClasses();
  MaweCoreState.waveformEditor?.updateSelection();
  const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${toIndex}"]`);
  if (row) MaweCueListAnchor.scrollCueIntoViewIfNeeded(row);
}

export function toggleOverlaySelection(index) {
  const track = AsrEditorUtils.getOverlayTrack(MaweBoot.DATA);
  if (MaweSelection.isHiddenDisabled(index, track)) return;  // 隐藏禁用项不参与选择
  const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`);
  if (MaweState.selection.indices('overlay').has(index)) {
    MaweState.selection.remove('overlay', index);
    row?.classList.remove('selected');
  } else {
    MaweState.selection.add('overlay', index);
    row?.classList.add('selected');
  }
  MaweState.selection.overlayAnchor = index;
  // 与副字幕 Ctrl 多选一致：面板跟随被切换的字幕，便于继续编辑。
  setCuePanelTarget('overlay', index);
  updateSelectionCountText();
  MaweCoreState.waveformEditor?.updateSelection();
}
