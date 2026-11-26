import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const web = fileURLToPath(new URL('../web/', import.meta.url));

test('G08 cues modules call sibling function exports through static imports', () => {

  // Wiring and the earlier overlay-track pure module retain their own bridge
  // boundaries. G08 covers the cue-domain initializers, not every caller.
  const core = fs.readdirSync(path.join(web, 'editor'), { recursive: true })
    .map(file => 'editor/' + file.split(path.sep).join('/'))
    .filter(file => file.startsWith('editor/cues/') && file.endsWith('.js') && !path.basename(file).startsWith('editor-wiring-'));
  const owners = new Map();
  const trees = new Map();
  for (const file of core) {
    const source = fs.readFileSync(path.join(web, file), 'utf8');
    const facade = source.match(/^(?:export )?(?:const|let) (Mawe\w+)\b/m);
    if (!facade) continue;
    const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    trees.set(file, tree);
    if (facade) owners.set(facade[1], file);
  }
  assert.ok(owners.has('MaweSelection'));
  const violations = [];
  for (const [file, tree] of trees) {
    walk.simple(tree, { CallExpression(node) {
      const callee = node.callee;
      if (callee.type !== 'MemberExpression' || callee.computed) return;
      const object = callee.object;
      const facade = object.type === 'Identifier' ? object.name
        : object.type === 'MemberExpression' && !object.computed
          && ['window', 'global', 'globalThis'].includes(object.object.name) ? object.property.name : null;
      const owner = owners.get(facade);
      if (owner && owner !== file) {
        violations.push(`${file}:${node.loc.start.line}: ${facade}.${callee.property.name}`);
      }
    } });
  }
  assert.deepEqual(violations, [], 'Use the sibling function import; keep state properties on their existing facade');
});

test('adjacent merge exports the implementation directly without startup', async () => {
  const module = await import('../web/editor/cues/editor-merge-adjacent.js');
  assert.deepEqual(Object.keys(module), ['mergeAdjacentSubtitle']);
  assert.equal(module.mergeAdjacentSubtitle.length, 1);
});

test('modules do not publish compatibility objects alongside their named API', async () => {
  const modules = {
    'cues/editor-add-cue.js': 'MaweAddCue',
    'cues/editor-binding-align.js': 'MaweBindingAlign',
    'cues/editor-cue-events.js': 'MaweCueEvents',
    'cues/editor-cue-panel.js': 'MaweCuePanel',
    'cues/editor-keyboard-targets.js': 'MaweKeyboardTargets',
    'cues/editor-split-context.js': 'MaweSplitContext',
    'cues/editor-split-mode.js': 'MaweSplitMode',
    'cues/editor-split-trim.js': 'MaweSplitTrim',
    'cues/editor-text-cleanup.js': 'MaweTextCleanup',
    'cues/editor-timed-text-edit.js': 'MaweTimedTextEdit',
    'media/editor-ass-preview-refresh.js': 'MaweAssPreviewRefresh',
    'state/editor-project-settings.js': 'MaweProjectSettings',
  };
  for (const [file, facade] of Object.entries(modules)) {
    assert.equal(Object.hasOwn(await import(`../web/editor/${file}`), facade), false, file);
  }
});

test('G08 value-only facade members are not exported as callable functions', async () => {
  const valueMembers = [
    ['editor-cue-list-anchor.js', ['cueListScroll', 'cueListFollowButton']],
    ['editor-split-core.js', ['SPLIT_LANE_LINE_TOLERANCE_PX']],
    ['editor-text-process.js', ['wrapCharsModal', 'wrapCharsLeftInput', 'wrapCharsRightInput']],
    ['editor-timeline.js', ['DEFAULT_TIMELINE_FPS', 'MIN_TIMELINE_FPS', 'MAX_TIMELINE_FPS', 'TIMELINE_ROUND_MS']],
  ];
  for (const [file, members] of valueMembers) {
    // Real ESM imports must be safe before initialization. State and DOM values
    // remain on the existing facade; do not invent eager snapshots or APIs.
    const module = await import(`../web/editor/cues/${file}`);
    for (const member of members) {
      assert.equal(Object.hasOwn(module, member), false, `${file}: ${member} is a value, not a function`);
    }
  }
});
