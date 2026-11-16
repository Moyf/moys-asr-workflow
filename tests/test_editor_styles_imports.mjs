import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const styleFiles = [
  'editor/styles/editor-colors.js',
  'editor/styles/editor-appearance.js',
  'editor/styles/editor-appearance-inputs.js',
  'editor/styles/editor-speaker-labels.js',
];

test('G09 style initializers use static imports for sibling function calls', () => {
  const { modules } = JSON.parse(fs.readFileSync(path.join(web, 'editor-modules.json'), 'utf8'));
  const owners = new Map();
  const trees = new Map();
  for (const file of styleFiles) {
    const item = modules.find(module => module.file === file);
    assert.equal(item?.kind, 'init', `${file} must initialize at its manifest position`);
    const source = fs.readFileSync(path.join(web, file), 'utf8');
    const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    trees.set(file, tree);
    const facade = source.match(/(?:global|window)\.(Mawe\w+)\s*=\s*Object\.freeze/);
    assert.ok(facade, `Missing compatibility facade for ${file}`);
    owners.set(facade[1], file);
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
      if (owner && owner !== file) violations.push(`${file}:${node.loc.start.line}: ${facade}.${callee.property.name}`);
    } });
  }
  assert.deepEqual(violations, [], 'Import sibling functions; leave mutable properties on their facade');
});

test('G09 modules are safe to import before browser initialization', async () => {
  assert.equal(globalThis.window, undefined);
  const { modules } = JSON.parse(fs.readFileSync(path.join(web, 'editor-modules.json'), 'utf8'));
  for (const file of styleFiles) {
    const module = await import(`../web/${file}`);
    assert.equal(typeof module[modules.find(item => item.file === file).exportName], 'function');
  }
});
