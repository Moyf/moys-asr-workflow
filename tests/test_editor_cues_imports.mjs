import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const web = fileURLToPath(new URL('../web/', import.meta.url));

test('G08 cues initializers call sibling function exports through static imports', () => {
  const { modules } = JSON.parse(fs.readFileSync(path.join(web, 'editor-modules.json'), 'utf8'));
  // Wiring and the earlier overlay-track pure module retain their own bridge
  // boundaries. G08 covers the cue-domain initializers, not every caller.
  const core = modules.filter(item => item.kind === 'init'
    && item.file.startsWith('editor/cues/') && !path.basename(item.file).startsWith('editor-wiring-'));
  assert.ok(core.length > 0);
  const owners = new Map();
  const trees = new Map();
  for (const item of core) {
    const source = fs.readFileSync(path.join(web, item.file), 'utf8');
    const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    trees.set(item.file, tree);
    const facade = source.match(/(?:global|window)\.(Mawe\w+)\s*=\s*Object\.freeze/);
    assert.ok(facade, `Missing cue facade for ${item.file}`);
    owners.set(facade[1], item.file);
  }
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
