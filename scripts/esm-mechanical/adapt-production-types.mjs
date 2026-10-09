// Reviewed type-only follow-up for the pinned upstream PR projections.
// Applies only to disposable exported cases, never the primary workspace.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';

const [rootArg, numberArg, head] = process.argv.slice(2);
const root = fs.realpathSync(path.resolve(rootArg || '.')), number = Number(numberArg);
const repository = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const allowed = new Map([[177,'1ad2f641daa6f6260c16ac88176aa2c0aad9566a'],
  [179,'6e23fd75ba34a5c403f78674d3074ef2163dbe88'], [180,'40d8cca5288d0fd8890f71e54d248eb9ae856088']]);
if (!root.startsWith(path.join(repository,'.worktrees')+path.sep)
    || !fs.existsSync(path.join(root,'.esm-mechanical-sandbox.json')) || allowed.get(number) !== head) {
  throw new Error('Expected a disposable projected case and an exact reviewed upstream HEAD');
}
const edits = new Map();
function update(file, transform) {
  const absolute = path.join(root,file), before = fs.readFileSync(absolute,'utf8');
  const after = transform(before);
  if (before === after) throw new Error('Reviewed input already adapted or shape changed: '+file);
  // Comments, assertions and parentheses may change; JavaScript semantics may not.
  if (file.endsWith('.js')) {
    const ast = text => JSON.stringify(parse(text,{ecmaVersion:'latest',sourceType:'module'}),
      (key,value) => ['start','end','raw'].includes(key) ? undefined : value);
    if (ast(before) !== ast(after)) throw new Error('Type adaptation changed JavaScript AST: '+file);
  }
  edits.set(absolute,after);
}

if (number === 180) {
  update('web/shared/utils/ass-canvas-layout.js', source => source.replace(
    '  function assCanvasAnchorPoint(',
    '  /** @param {{alignment?: unknown, margins?: {left?: unknown, right?: unknown, vertical?: unknown}, playResX?: unknown, playResY?: unknown, move?: {x?: unknown, y?: unknown}}} [options] */\n  function assCanvasAnchorPoint('));
} else {
  update('web/editor/boot/editor-globals.d.ts', source => source.replace(
    '  cueListPatch?: { mainIndices?: number[]; overlayIndices?: number[] } | null;\n', ''));
  update('tsconfig.typecheck.json', source => {
    const config = JSON.parse(source);
    if (config.compilerOptions.lib) throw new Error('Existing lib requires review');
    // Word timing uses Array.findLast. Declare its API without changing output target.
    config.compilerOptions.lib = ['es2023','dom'];
    return JSON.stringify(config,null,2)+'\n';
  });
  const contract = `import {WaveformInstance, Cue, Clock, RowGeometry, TimedItem} from './waveform-types.js';
export interface WordDragState {
  pointerId: number; segment: Cue; timing: Clock; row: HTMLElement; geometry: RowGeometry;
  pointer: number; clientX: number; clientY: number; moved: boolean; command: EditorTransaction | null;
  original: Cue; indices: number[]; resize: boolean; edge: string; seam: boolean; itemIndex: number;
  move?: (event: PointerEvent) => void; up?: (event: PointerEvent) => void; cancel?: () => void;
}
declare module './waveform-types.js' {
  interface WaveformState {
    ${number === 177 ? 'bindWordModeSentenceHandle(handle: HTMLElement, index: number, row: HTMLElement): void;' : ''}
    wordDrag?: WordDragState | null; wordRefreshFrame?: number;
    appendWordBlocks(row: HTMLElement, index: number, startMs: number, endMs: number): void;
    refreshWordBlocks(): void;
    beginWordDrag(event: PointerEvent, index: number, itemIndex: number, row: HTMLElement, seam?: boolean): void;
    updateWordDrag(event: PointerEvent): void; detachWordDrag(drag: WordDragState): void;
    endWordDrag(event: PointerEvent): void; cancelWordDrag(): void;
  }
  interface WaveformOptions {
    beginWordEdit?(): EditorTransaction;
    commitWordEdit?(command: EditorTransaction, segment: Cue): boolean;
    wordTiming?: {enabled: boolean; getSelection(segment: Cue): ReadonlySet<number>;
      showMenu(x: number, y: number, index: number, itemIndex: number): void;
      select(index: number, itemIndex: number, event: PointerEvent): void;
      previewItems(segment: Cue, items: TimedItem[]): void; clearSelection(): void;};
  }
}
export type WordWaveformInstance = WaveformInstance;
`;
  const contractPath = path.join(root,'web/editor/media/waveform/waveform-upstream-types.d.ts');
  if (fs.existsSync(contractPath)) throw new Error('Already adapted');
  edits.set(contractPath,contract);
  update('web/editor/media/waveform/word-blocks.js', source => {
    const ast = parse(source,{ecmaVersion:'latest',sourceType:'script'}), inserts = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'MethodDefinition') inserts.push([node.start,"/** @this {import('./waveform-upstream-types.js').WordWaveformInstance} */\n    "]);
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
          && node.callee.property.name === 'querySelectorAll' && node.arguments[0]?.value === '.waveform-row') {
        inserts.push([node.start,'(/** @type {NodeListOf<HTMLElement>} */ ('],[node.end,'))']);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
    }
    walk(ast);
    let result = source;
    for (const [at,text] of inserts.sort((a,b)=>b[0]-a[0])) result = result.slice(0,at)+text+result.slice(at);
    return result.replace('const drag = {', "/** @type {import('./waveform-upstream-types.js').WordDragState} */\n      const drag = {")
      .replace("event.target.closest('.waveform-cue-handle')", "(/** @type {Element} */ (event.target)).closest('.waveform-cue-handle')");
  });
}
// Every shape and AST assertion finishes before any file is written.
for (const [file,source] of edits) fs.writeFileSync(file,source);
console.log(JSON.stringify({pr:number,head,typeOnlyFiles:edits.size,javaScriptAstUnchanged:true}));
