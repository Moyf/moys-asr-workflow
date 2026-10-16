import fs from 'node:fs';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;

const splitContext = () => ({
  window: { AsrEditorUtils: h },
  MULTI_SUBTITLE_UTILS: h,
  MaweMultiSubtitleCore: { SUBTITLE_MIN_DURATION_MS: 100 },
  MaweSettings: { EDITOR_SETTINGS: { assMode: true, assSpecialSymbolRule: 'both', assEmphasisSyntax: 'both' } },
});

const segment = { id: 'a', start: 0, end: 2000, text: '今天*的解说*完', items: [
  { text: '今天*', start: 0, end: 600 }, { text: '的', start: 600, end: 900 },
  { text: '解说*', start: 900, end: 1500 }, { text: '完', start: 1500, end: 1900 },
] };

const context1 = splitContext();
vm.runInNewContext(fs.readFileSync(new URL('../web/editor/cues/editor-split-core.js', import.meta.url), 'utf8'), context1);

// ① 纯 splitStyledTextParts（绕过补齐，直接调用内部流程的前半段）
const utils = h;
const parts0 = {
  left: utils.applySplitEdgeTrim(segment.text.slice(0, 5), 'end'),
  right: utils.applySplitEdgeTrim(segment.text.slice(5), 'start'),
  offset: 5,
};
console.log('trim 后 parts:', JSON.stringify(parts0));
// 直接调 buildSplitPair 前无法插桩内部，改从结果反推：
const built = context1.window.MaweSplitCore.buildSplitPair(segment, 5, 1000, 'a', true, 'continuous', { headIndex: 0 });
console.log('buildSplitPair left =', JSON.stringify(built.left.text));
console.log('buildSplitPair right =', JSON.stringify(built.right.text));
console.log('buildSplitPair leftItems 拼接 =', JSON.stringify(built.left.items.map(i => i.text).join('')));

// ② utils 层直接验证：splitStyledTextParts 不可独立调用（在 split-core 内），
//    但 completeSplitMassPairs 对「trim 后未补齐」的 parts 应当生效：
const completed = utils.completeSplitMassPairs('今天*的解', '说*完', 'both');
console.log('completeSplitMassPairs(今天*的解, 说*完) =', JSON.stringify(completed));
