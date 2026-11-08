// waveform-cue-quick-edit：波形字幕块双击快速编辑气泡。
// 覆盖三件事：
// 1. 定位纯函数 cueQuickEditLayout：默认在点击片段上方、贴顶翻到下方、
//    水平/垂直钳制与气泡三角的箭头钳制（跨行字幕跟随指针位置的核心）；
// 2. 气泡 CSS 契约（waveform.css 提供样式与箭头变量）；
// 3. 接线契约：三轨字幕块 dblclick 打开气泡，旧的「聚焦字幕编辑区」
//    回调（enter*Editor）不再被波形引用。
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';


const root = fileURLToPath(new URL('../', import.meta.url));

const waveContext = {
  window: {
    // waveform.js 顶部只需要最小 palette fixture（同 test_waveform_js.mjs）。
    ASR_EDITOR_PALETTE: [
      { name: 'yellow', value: '#c4a019' },
      { name: 'green', value: '#66bb6a' },
      { name: 'red', value: '#f07f6f' },
      { name: 'purple', value: '#bf89e6' },
      { name: 'blue', value: '#61a7fa' },
    ],
  },
};
loadEditorModule(waveContext, 'editor/media/waveform.js');
const testing = waveContext.window.AsrWaveform.testing;

test('cueQuickEditLayout：默认浮在点击片段上方，箭头对准指针', () => {
  const layout = testing.cueQuickEditLayout(
    { pointerX: 300, blockTop: 200, blockBottom: 240 }, 300, 120, 0, 0, 1200, 800);
  assert.equal(layout.placement, 'above');
  assert.equal(layout.left, 150);
  assert.equal(layout.top, 200 - 120 - 8);
  assert.equal(layout.arrowX, 150);
});

test('cueQuickEditLayout：水平贴边时钳制在可视区内，箭头跟随指针', () => {
  const left = testing.cueQuickEditLayout(
    { pointerX: 50, blockTop: 200, blockBottom: 240 }, 300, 120, 0, 0, 1200, 800);
  assert.equal(left.left, 4);
  assert.equal(left.arrowX, 46);
  const right = testing.cueQuickEditLayout(
    { pointerX: 1150, blockTop: 200, blockBottom: 240 }, 300, 120, 0, 0, 1200, 800);
  assert.equal(right.left, 1200 - 300 - 4);
  assert.equal(right.arrowX, 1150 - right.left);
});

test('cueQuickEditLayout：片段贴着可视区顶部时翻到下方并钳制', () => {
  const flip = testing.cueQuickEditLayout(
    { pointerX: 300, blockTop: 100, blockBottom: 140 }, 300, 120, 0, 0, 1200, 800);
  assert.equal(flip.placement, 'below');
  assert.equal(flip.top, 140 + 8);
  // 下方也放不下（可视区过矮）时退一步钳在可视区底部内。
  const clamped = testing.cueQuickEditLayout(
    { pointerX: 300, blockTop: 100, blockBottom: 280 }, 300, 120, 0, 0, 1200, 300);
  assert.equal(clamped.placement, 'below');
  assert.equal(clamped.top, 300 - 120 - 4);
});

test('cueQuickEditLayout：滚动后按可视视口翻转，不把气泡顶进裁剪区', () => {
  // 视口已滚到内容 y=1700：贴近视口顶部的块（blockTop=1780）上方放不下
  // 气泡，必须翻到下方而不是按内容顶部误判为「上方充足」。
  const scrolled = testing.cueQuickEditLayout(
    { pointerX: 300, blockTop: 1780, blockBottom: 1820 }, 300, 120, 0, 1700, 1200, 800);
  assert.equal(scrolled.placement, 'below');
  assert.equal(scrolled.top, 1820 + 8);
  assert.ok(scrolled.top >= 1700 + 4, '气泡不得高出可视视口顶部');
  // 可视区内上方确实放得下时仍优先上方。
  const above = testing.cueQuickEditLayout(
    { pointerX: 300, blockTop: 1900, blockBottom: 1940 }, 300, 120, 0, 1700, 1200, 800);
  assert.equal(above.placement, 'above');
  assert.equal(above.top, 1900 - 120 - 8);
});

test('cueQuickEditLayout：箭头位置始终留在弹窗左右边缘之内', () => {
  for (const pointerX of [0, 4, 600, 1196, 1200]) {
    const layout = testing.cueQuickEditLayout(
      { pointerX, blockTop: 200, blockBottom: 240 }, 300, 120, 0, 0, 1200, 800);
    assert.ok(layout.arrowX >= 14, `arrowX >= 14 (pointerX=${pointerX})`);
    assert.ok(layout.arrowX <= 300 - 14, `arrowX <= width-14 (pointerX=${pointerX})`);
  }
});

test('CSS 契约：快速编辑气泡样式与箭头变量存在于 waveform.css', () => {
  const css = fs.readFileSync(path.join(root, 'web', 'waveform.css'), 'utf8');
  for (const needle of [
    '.waveform-cue-quick-edit {',
    '.waveform-cue-quick-edit-text',
    '.waveform-cue-quick-edit-help',
    '.waveform-cue-quick-edit.placement-below::after',
    'var(--cue-quick-edit-arrow-x, 50%)',
  ]) {
    assert.ok(css.includes(needle), `waveform.css 缺少 ${needle}`);
  }
  // 字体契约：气泡（含 textarea，覆盖 UA 等宽默认）与 cue 正文同族。
  const popupCss = css.slice(css.indexOf('.waveform-cue-quick-edit {'));
  const fontMatches = popupCss.match(/font-family: var\(--font-sans\);/g) || [];
  assert.ok(fontMatches.length >= 2, '气泡容器与 textarea 都应声明 --font-sans');
});

test('接线契约：三轨字幕块 dblclick 打开快速编辑气泡，旧聚焦回调退役', () => {
  const cueBlocks = fs.readFileSync(
    path.join(root, 'web/editor/media/waveform/cue-blocks.js'), 'utf8');
  assert.ok(cueBlocks.includes("this.openCueQuickEdit('main', index, block, event)"));
  assert.ok(cueBlocks.includes("this.openCueQuickEdit('overlay', index, block, event)"));
  assert.ok(cueBlocks.includes("this.openCueQuickEdit('extension', index, block, event)"));
  for (const retired of ['enterCueEditor', 'enterExtensionCueEditor', 'enterOverlayCueEditor']) {
    assert.ok(!cueBlocks.includes(retired), `cue-blocks.js 仍引用 ${retired}`);
  }
  const wiring = fs.readFileSync(
    path.join(root, 'web/editor/media/editor-waveform-init.js'), 'utf8');
  assert.ok(wiring.includes('onCueQuickEditText: (track, index, text)'));
  for (const retired of ['enterCueEditor:', 'enterExtensionCueEditor:', 'enterOverlayCueEditor:']) {
    assert.ok(!wiring.includes(retired), `editor-waveform-init.js 仍定义 ${retired}`);
  }
});

test('接线契约：创建空字幕改为弹出快速编辑气泡，聚焦面板仅作回退', () => {
  const addCue = fs.readFileSync(
    path.join(root, 'web/editor/cues/editor-add-cue.js'), 'utf8');
  assert.ok(addCue.includes("editNewCue('main', index, () => focusCuePanelText(index))"));
  assert.equal(addCue.split("editNewCue('extension'").length - 1, 2);
  const overlay = fs.readFileSync(
    path.join(root, 'web/editor/cues/overlay-track.js'), 'utf8');
  assert.ok(overlay.includes("'overlay', index, () => MaweCuePanel.focusCuePanelText(index, 'overlay')"));
  // 三处创建路径都不再直接/延迟聚焦面板文本框（聚焦只存在于回退 lambda）。
  assert.ok(!addCue.includes('setTimeout(() => focusCuePanelText(index), 0)'));
  assert.ok(!overlay.includes("setTimeout(() => MaweCuePanel.focusCuePanelText(index, 'overlay'), 0)"));
});

test('接线契约：气泡内 Tab 切换字幕并阻断原生焦点移动', () => {
  const source = fs.readFileSync(
    path.join(root, 'web/editor/media/waveform/cue-quick-edit.js'), 'utf8');
  // 通用壳把 Tab 分发给入口注入的 navigate；字幕与字词各自接线。
  assert.ok(source.includes('state.navigate?.(state, keyEvent.shiftKey ? -1 : 1)'));
  assert.ok(source.includes('navigate: (state, direction) => this.navigateCueQuickEdit('));
  assert.ok(source.includes('navigate: (_state, direction) => this.navigateWordQuickEdit('));
  // 字词导航到句首/句尾弹 invalid 提示（与字幕导航的静默保持不同）。
  assert.ok(source.includes('当前已经是第一个字词码，无法跳转'));
  assert.ok(source.includes("localizedWaveformMessage("));
  // 创建/导航入口的光标放句尾，双击入口按点击定位。
  assert.ok(source.includes("caret: caretAtEnd ? 'end' : 'click'"));
  assert.ok(source.includes("caret === 'select'"));
  // 光标定位兼容字词标签（不折叠空白时走恒等捷径）。
  assert.ok(source.includes("caretCollapsed.collapsed === text"));
});

test('接线契约：输入法组词期间跳过气泡快捷键，Ctrl+S 保存前先提交气泡', () => {
  const source = fs.readFileSync(
    path.join(root, 'web/editor/media/waveform/cue-quick-edit.js'), 'utf8');
  assert.ok(source.includes('keyEvent.isComposing || keyEvent.keyCode === 229'));
  // 保存与导出的 flushInlineEditsForSave 都要先提交气泡（幂等）。
  const save = fs.readFileSync(
    path.join(root, 'web/editor/io/editor-project-save.js'), 'utf8');
  assert.ok(save.includes('MaweCoreState.waveformEditor?.commitCueQuickEdit?.()'));
  const exportActions = fs.readFileSync(
    path.join(root, 'web/editor/io/editor-wiring-export-actions.js'), 'utf8');
  assert.ok(exportActions.includes('MaweCoreState.waveformEditor?.commitCueQuickEdit?.()'));
});

test('接线契约：选中后 Enter 与叠加轨菜单「编辑文本」也走气泡，聚焦面板仅作回退', () => {
  const shortcuts = fs.readFileSync(
    path.join(root, 'web/editor/cues/editor-wiring-edit-shortcuts.js'), 'utf8');
  assert.ok(shortcuts.includes('editor.openCueQuickEditAtIndex('));
  assert.ok(shortcuts.includes("() => MaweCuePanel.focusCuePanelText(),"));
  const menus = fs.readFileSync(
    path.join(root, 'web/editor/ui/editor-wiring-context-menus.js'), 'utf8');
  assert.ok(menus.includes("openCueQuickEditAtIndex("));
  assert.ok(menus.includes("'overlay', index, () => MaweCuePanel.focusCuePanelText(index, 'overlay')"));
});

test('接线契约：字词码模式放开字幕块编辑，双击字词块弹出字词气泡', () => {
  // 字幕块双击不再因字词码拦截，旧守卫回调退役。
  const cueBlocks = fs.readFileSync(
    path.join(root, 'web/editor/media/waveform/cue-blocks.js'), 'utf8');
  assert.ok(!cueBlocks.includes('onMainCueDoubleClickBlocked'));
  const wiring = fs.readFileSync(
    path.join(root, 'web/editor/media/editor-waveform-init.js'), 'utf8');
  assert.ok(!wiring.includes('onMainCueDoubleClickBlocked'));
  // 字词块双击在 beginWordDrag 内按 pointerdown 序列识别（选中刷新会
  // 重建字词条带，原生 dblclick 目标不可靠），并用首次按下坐标做光标
  // 定位；提交经 onWordQuickEditText 走句文本区间替换 + 字词文本同步。
  const wordBlocks = fs.readFileSync(
    path.join(root, 'web/editor/media/waveform/word-blocks.js'), 'utf8');
  assert.ok(wordBlocks.includes('this.openWordQuickEdit(index, itemIndex, block, {'));
  assert.ok(wordBlocks.includes('clientX: lastWordClick.clientX, clientY: lastWordClick.clientY,'));
  assert.ok(wordBlocks.includes('this.openWordQuickEditAtIndex(index, itemIndex, null)'));
  assert.ok(wiring.includes('onWordQuickEditText: (segmentIndex, itemIndex, text)'));
  assert.ok(wiring.includes('wordCharRanges(previousText, segment.items || [])'));
  assert.ok(wiring.includes('MaweWordTiming.syncTextChange(segment, previousText)'));
  // 共享工具导出字词字符区间解析（纯函数，句↔字词映射真源）。
  const wordTiming = fs.readFileSync(
    path.join(root, 'web/shared/utils/word-timing.js'), 'utf8');
  assert.ok(wordTiming.includes('planWordTimingTextSync, wordCharRanges, setMassSymbolRule'));
});

test('cueQuickEditOriginalOffset：无空白差异时折叠偏移原样映射回原文', () => {
  const map = testing.cueQuickEditOriginalOffset;
  for (const offset of [0, 1, 3, 5, '第一句原文'.length]) {
    assert.equal(map('第一句原文', '第一句原文', offset), offset);
  }
  assert.equal(map('Alpha Beta', 'Alpha Beta', 7), 7);
});

test('cueQuickEditOriginalOffset：空白 run（换行/连续空格）折叠后的偏移映射', () => {
  const map = testing.cueQuickEditOriginalOffset;
  // 原文 "AB\n\nCD" → 折叠 "AB CD"。点在 C 之后（offset 3）光标落在
  // 原文的 C 之前（换行 run 之后）；点在折叠空格起点（offset 2）落在
  // run 之前（上一行行尾）。
  assert.equal(map('AB\n\nCD', 'AB CD', 3), 4);
  assert.equal(map('AB\n\nCD', 'AB CD', 2), 2);
  // 连续空格 run：原文 "A   B" → 折叠 "A B"。
  assert.equal(map('A   B', 'A B', 2), 4);
  assert.equal(map('A   B', 'A B', 3), 5);
  // 末尾空白 run：原文 "END\n" → 折叠 "END "（尾部空格）。
  assert.equal(map('END\n', 'END ', 4), 4);
});

test('cueQuickEditOriginalOffset：越界与异常输入钳制到安全范围', () => {
  const map = testing.cueQuickEditOriginalOffset;
  assert.equal(map('ABC', 'ABC', 99), 3);
  assert.equal(map('ABC', 'ABC', -1), 0);
  assert.equal(map(null, '', 0), 0);
  // 折叠文本与原文不一致（理论不可达）：返回已推进位置而不是抛错。
  assert.equal(Number.isInteger(map('ABC', 'XYZ', 2)), true);
});
