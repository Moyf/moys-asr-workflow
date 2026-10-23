import { commitCuePanelEdit } from './editor-cue-panel.js';
import { selectOnly } from './editor-selection.js';
import { syncTimelineGroupRanges } from './editor-text-cleanup.js';
import { timelineTimingAdapter } from './editor-timeline.js';

// 字词时间码：字词对齐数据与行渲染。 ESM init 模块：initMaweWordTiming 在原清单位次执行原 IIFE 体（挂
// window.MaweWordTiming 冻结门面——classic 侧出接口）；底部具名导出经门面在调用时转发，
// 兄弟模块可静态 import。
export function initMaweWordTiming() {
(function initWordTiming(global) {
  'use strict';
  let enabled = false, selection = null, conversionTarget = null;
  const ui = (zh, en) => global.MAWE_I18N?.language === 'en' ? en : zh;
  const dialog = () => document.getElementById('word-conversion-dialog');
  const refresh = () => MaweCoreState.waveformEditor?.refreshCueOverlay();
  const clock = () => timelineTimingAdapter();
  const conversionFingerprint = plan => JSON.stringify([plan, MaweMultiSubtitleCore.getMultiSubtitleState()?.bindings]);

  function clearSelection() {
    if (!selection) return;
    selection = null;
    MaweCoreState.waveformEditor?.content.querySelectorAll('.waveform-word-block.selected')
      .forEach(block => block.classList.remove('selected'));
  }
  function getSelection(segment) {
    if (selection && (!MaweBoot.DATA.segments.includes(selection.segment)
        || selection.segment.items !== selection.items || selection.segment.text !== selection.text)) clearSelection();
    return selection?.segment === segment ? selection.indices : new Set();
  }
  function setEnabled(value) {
    MaweCoreState.waveformEditor?.cancelWordDrag();
    enabled = Boolean(value);
    clearSelection();
    const toggle = document.getElementById('word-timing-toggle');
    if (toggle) toggle.checked = enabled;
    syncQuickToggle();
    MaweCoreState.waveformEditor?.pane.classList.toggle('word-timing-mode', enabled);
    // 启用/关闭时切到字词码预设的行高与每行长度（关闭恢复原设置）。
    const rendered = MaweDisplaySettings?.syncWordTimingWaveformSettings?.(enabled);
    if (!rendered) refresh();
  }
  // 波形工具栏的「字词」按钮与项目设置镜像开关由模板可选提供；不存在时零开销。
  function syncQuickToggle() {
    const quick = document.getElementById('word-timing-quick-toggle');
    if (quick) {
      quick.classList.toggle('active', enabled);
      quick.setAttribute('aria-pressed', String(enabled));
    }
    const mirror = document.getElementById('project-word-timing-toggle');
    if (mirror && mirror.checked !== enabled) mirror.checked = enabled;
  }
  function reset() {
    setEnabled(false);
    conversionTarget = null;
    if (dialog()?.open) dialog().close();
  }
  function select(index, itemIndex, event = {}) {
    commitCuePanelEdit();
    const segment = MaweBoot.DATA.segments[index];
    if (!segment) return;
    const entries = global.AsrEditorUtils.getWordTimingEntries(segment, clock());
    if (!entries.some(e => e.index === itemIndex)) return;
    const previous = getSelection(segment);
    const same = selection?.segment === segment;
    if (!same) selection = { segment, items: segment.items, text: segment.text, indices: new Set(), anchor: itemIndex };
    if (event.shiftKey && same) {
      const from = Math.min(selection.anchor, itemIndex), to = Math.max(selection.anchor, itemIndex);
      selection.indices = new Set(entries.filter(e => e.index >= from && e.index <= to).map(e => e.index));
    } else if (event.ctrlKey || event.metaKey) {
      selection.indices = new Set(previous);
      if (selection.indices.has(itemIndex)) selection.indices.delete(itemIndex);
      else selection.indices.add(itemIndex);
      selection.anchor = itemIndex;
    } else if (!previous.has(itemIndex)) {
      selection.indices = new Set([itemIndex]);
      selection.anchor = itemIndex;
    }
    selectOnly(index);
    MaweSelection.lastClickedIdx = index;
    refresh();
  }
  function previewItems(segment, items) {
    segment.items = items;
    if (selection?.segment === segment) selection.items = items;
  }
  // 等长替换（改错别字）时同步 items 文字；在文本提交点调用，与文字同一命令快照。
  // quietMismatch 供仍然逐键处理的旧调用路径抑制重复提示。
  function syncTextChange(segment, previousText, { quietMismatch = false } = {}) {
    if (!segment || typeof segment.text !== 'string') return;
    const result = global.AsrEditorUtils.planWordTimingTextSync(segment, previousText);
    if (!result) return;
    if (result.items) {
      segment.items = result.items;
      if (selection?.segment === segment) selection.items = result.items;
      const details = Array.isArray(result.details) ? result.details : [];
      // 提示条空间有限：超过 3 处只展示前 3 处并以「等」收尾。
      const shown = details.slice(0, 3).map(d => `[${d.before} -> ${d.after}]`).join(' ');
      const more = details.length > 3 ? ' 等' : '';
      const suffix = details.length ? `（共${result.changed}处：${shown}${more}）` : `（${result.changed} 处）`;
      MaweHint.flashHint(ui(
        `已同步字词时间码文字${suffix}`,
        `Synced timed text labels (${result.changed}: ${shown}${more})`,
      ), 'success');
    } else if (result.warn && !quietMismatch) {
      MaweHint.flashHint(ui(
        `字词时间码未同步：[${result.before} -> ${result.after}] 不是等长替换`,
        `Timed text not synced: [${result.before} -> ${result.after}] is not an equal-length replacement`,
      ), 'warning');
    }
  }
  function merge() {
    if (!enabled || !selection || !getSelection(selection.segment).size) return false;
    const segment = selection.segment;
    const items = global.AsrEditorUtils.mergeWordTimingItems(segment, [...selection.indices], clock());
    if (!items) {
      MaweHint.flashHint(ui('请选择同一句内连续且说话人一致的字词块', 'Select consecutive timed text blocks with the same speaker in one sentence'), 'warning');
      return false;
    }
    MaweCommands.run(ui('合并字词块', 'Merge timed text blocks'), () => {
      segment.items = items;
      MaweMultiSubtitleCore.markMainSegmentsDirty([segment]);
      clearSelection();
    }, { captureView: true, invalidate: { cueList: true } });
    MaweDom.ctxmenu.classList.remove('show');
    return true;
  }
  function auditionWords(segment, indices) {
    const timing = clock();
    const entries = global.AsrEditorUtils.getWordTimingEntries(segment, timing)
      .filter(entry => indices.includes(entry.index));
    if (!entries.length) return;
    MaweMediaPlayback.auditionRange(timing.toMs(entries[0].start), timing.toMs(entries[entries.length - 1].end));
  }
  function showMenu(x, y, index, itemIndex) {
    const segment = MaweBoot.DATA.segments[index];
    if (!getSelection(segment).has(itemIndex)) select(index, itemIndex);
    const menu = MaweDom.ctxmenu;
    menu.replaceChildren();
    const indices = [...getSelection(segment)];
    // 试听放菜单最上方：字词核对场景下最高频的动作。
    const audition = document.createElement('div');
    audition.className = 'item';
    const auditionLabel = document.createElement('span');
    auditionLabel.textContent = ui('试听', 'Audition');
    audition.appendChild(auditionLabel);
    const auditionKbd = document.createElement('kbd');
    auditionKbd.textContent = 'F';
    audition.appendChild(auditionKbd);
    audition.addEventListener('click', () => {
      menu.classList.remove('show');
      auditionWords(segment, indices);
    });
    menu.append(audition);
    const entry = document.createElement('div');
    entry.className = 'item';
    const entryLabel = document.createElement('span');
    entryLabel.textContent = ui('合并选中的字词块', 'Merge selected timed text blocks');
    entry.appendChild(entryLabel);
    const entryKbd = document.createElement('kbd');
    entryKbd.textContent = 'C';
    entry.appendChild(entryKbd);
    if (!global.AsrEditorUtils.mergeWordTimingItems(segment, indices, clock())) entry.classList.add('disabled');
    else entry.addEventListener('click', () => { menu.classList.remove('show'); merge(); });
    menu.append(entry);
    menu.classList.add('show');
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`;
  }

  function conversionPlan() {
    if (!conversionTarget || conversionTarget.project !== MaweBoot.DATA.segments) return null;
    const indices = MaweBoot.DATA.segments.map((segment, index) => conversionTarget.ids.includes(segment.id) ? index : -1).filter(i => i >= 0);
    return global.AsrEditorUtils.planWordTimingConversion(MaweBoot.DATA.segments, indices, clock(), {
      // 转换产物对跨行 MASS 对做两侧补齐（账本 #21），预览与确认同一计划。
      rule: MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule,
    });
  }
  function renderConversion() {
    const plan = conversionPlan();
    const bindings = MaweMultiSubtitleCore.getMultiSubtitleState()?.bindings || [];
    const ids = new Set(plan?.conversions.map(c => c.id) || []);
    const count = bindings.filter(binding => binding.main_segment_ids?.some(id => ids.has(id)) || ids.has(binding.main_segment_id)).length;
    document.getElementById('word-conversion-summary').textContent = ui(
      `将转换${plan?.conversions.length || 0}句，生成${plan?.generatedCount || 0}条新的字幕（跳过${plan?.skipped.length || 0}句，解除${count}个副字幕绑定）`,
      `Convert ${plan?.conversions.length || 0} sentences into ${plan?.generatedCount || 0} new subtitles (skip ${plan?.skipped.length || 0} sentences and unlink ${count} secondary subtitles)`,
    );
    const reasons = {
      missing: ui('没有有效字词时间码', 'No valid timed text blocks'),
      timing: ui('字词时间越界、重叠或无效', 'Invalid, overlapping or out-of-sentence word timings'),
      text: ui('文字未被完整覆盖或无法对应', 'Text is not fully covered or cannot be matched'),
      unchanged: ui('已经是对应单个 item 的字幕', 'Already matches a single item'),
    };
    const list = document.getElementById('word-conversion-skipped');
    list.replaceChildren();
    plan?.skipped.forEach(row => {
      const item = document.createElement('li');
      item.textContent = ui(`第 ${row.index + 1} 句：${reasons[row.reason]}`, `Sentence ${row.index + 1}: ${reasons[row.reason]}`);
      list.append(item);
    });
    document.getElementById('word-conversion-confirm').disabled = !plan?.conversions.length;
    return plan;
  }
  function openConversion(indices) {
    commitCuePanelEdit();
    MaweCoreState.waveformEditor?.cancelWordDrag();
    conversionTarget = { project: MaweBoot.DATA.segments, ids: indices.map(i => MaweBoot.DATA.segments[i]?.id).filter(Boolean) };
    conversionTarget.fingerprint = conversionFingerprint(renderConversion());
    dialog().showModal();
  }
  function confirmConversion() {
    commitCuePanelEdit();
    const plan = renderConversion();
    if (!plan?.conversions.length) return;
    // Review an updated preview rather than silently converting changed targets.
    if (conversionTarget.fingerprint !== conversionFingerprint(plan)) {
      conversionTarget.fingerprint = conversionFingerprint(plan);
      MaweHint.flashHint(ui('请检查转换预览后再次确认', 'Review the updated conversion preview and confirm again'), 'warning');
      return;
    }
    MaweCommands.run(ui('字词拆成字幕', 'Split words into subtitles'), () => {
      clearSelection({ commitCuePanel: false });
      clearSelection();
      MaweMultiSubtitleCore.removeBindingsForSegmentIds(plan.conversions.map(c => c.id), []);
      MaweBoot.DATA.segments.splice(0, MaweBoot.DATA.segments.length, ...plan.segments);
      syncTimelineGroupRanges();
      MaweMultiSubtitleCore.markMainSegmentsDirty(plan.conversions.flatMap(c => c.segments));
      MaweMultiSubtitleCore.syncBindingOffsets();
      MaweCuePanelState.currentCuePanelIdx = -1;
      MaweCuePanelState.resetCuePanelEditState({ discard: true });
    }, { captureView: true, invalidate: { cueList: true, preview: 'update' } });
    dialog().close();
    conversionTarget = null;
  }
  function bind() {
    document.getElementById('word-timing-toggle')?.addEventListener('change', event => setEnabled(event.target.checked));
    document.getElementById('word-timing-quick-toggle')?.addEventListener('click', () => setEnabled(!enabled));
    // Q：全局切换字词时间码（与波形设置/工具栏按钮互为镜像）。
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'q' && event.key !== 'Q') return;
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) return;
      if (dialog()?.open) return;
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (MaweCoreState.waveformEditor?.wordDrag) return;
      if (!document.getElementById('word-timing-quick-toggle')
        && !document.getElementById('word-timing-toggle')) return;
      event.preventDefault();
      setEnabled(!enabled);
    });
    document.getElementById('word-conversion-cancel')?.addEventListener('click', () => dialog().close());
    document.getElementById('word-conversion-confirm')?.addEventListener('click', confirmConversion);
    // Native close is queued; it may arrive after a new preview has opened.
    dialog()?.addEventListener('close', () => { if (!dialog().open) conversionTarget = null; });
  }
  // Capture before subtitle hotkeys: unsupported actions cannot hit the parent cue.
  document.addEventListener('keydown', event => {
    if (dialog()?.open) { event.stopImmediatePropagation(); return; }
    if (!enabled || event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const waveform = MaweCoreState.waveformEditor;
    if (waveform?.wordDrag) {
      const key = event.key.toLowerCase();
      if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(key))) {
        event.preventDefault(); event.stopImmediatePropagation(); waveform.cancelWordDrag();
      } else if (!['alt', 'control', 'meta', 'shift', 'j', 'k', 'l', ' '].includes(key)) {
        // Finish or cancel the gesture before running another project command.
        event.preventDefault(); event.stopImmediatePropagation();
      }
      return;
    }
    if (event.key === 'Escape' && MaweDom.ctxmenu.classList.contains('show')) {
      event.preventDefault(); event.stopImmediatePropagation(); MaweDom.ctxmenu.classList.remove('show'); return;
    }
    if (!selection || !getSelection(selection.segment).size) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'a' && !event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation();
      selection.indices = new Set(global.AsrEditorUtils.getWordTimingEntries(selection.segment, clock()).map(e => e.index));
      refresh();
    } else if (key === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && !event.repeat && !MaweDom.ctxmenu.classList.contains('show')) {
      event.preventDefault(); event.stopImmediatePropagation();
      auditionWords(selection.segment, [...selection.indices]);
    } else if (key === 'c' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopImmediatePropagation(); merge();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); clearSelection(); refresh();
    } else if (['delete', 'backspace', 'b', 'n', 'r', 'enter', 'g', 'h', 't', '1', '2', '3', '4', '5', '0',
      'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)
        || (['z', 'x'].includes(key) && !event.ctrlKey && !event.metaKey)
        || (['a', 'd', 'w', 's'].includes(key) && (event.altKey || event.shiftKey))) {
      event.preventDefault(); event.stopImmediatePropagation();
    } else if (['a', 'd', 'w', 's', 'home', 'end'].includes(key)) {
      clearSelection(); refresh();
    }
  }, true);
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest?.('.waveform-word-block, .waveform-word-boundary, #ctxmenu') && !MaweCoreState.waveformEditor?.wordDrag) clearSelection();
  }, true);
  global.MaweWordTiming = Object.freeze({ get enabled() { return enabled; }, setEnabled, reset, bind,
    select, getSelection, clearSelection, previewItems, merge, showMenu, openConversion, syncTextChange });
})(window);
}

export function setEnabled(...args) { return window.MaweWordTiming.setEnabled(...args); }
export function reset(...args) { return window.MaweWordTiming.reset(...args); }
export function bind(...args) { return window.MaweWordTiming.bind(...args); }
export function select(...args) { return window.MaweWordTiming.select(...args); }
export function getSelection(...args) { return window.MaweWordTiming.getSelection(...args); }
export function clearSelection(...args) { return window.MaweWordTiming.clearSelection(...args); }
export function previewItems(...args) { return window.MaweWordTiming.previewItems(...args); }
export function merge(...args) { return window.MaweWordTiming.merge(...args); }
export function showMenu(...args) { return window.MaweWordTiming.showMenu(...args); }
export function openConversion(...args) { return window.MaweWordTiming.openConversion(...args); }
export function syncTextChange(...args) { return window.MaweWordTiming.syncTextChange(...args); }
