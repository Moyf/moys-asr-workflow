// Audit a mechanical editor split/move against a Git revision.
// Usage: node scripts/check_editor_equivalence.mjs --base <revision>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--base') {
  throw new Error('Usage: node scripts/check_editor_equivalence.mjs --base <revision>');
}
const base = execFileSync('git', ['rev-parse', '--verify', `${args[1]}^{commit}`], {
  cwd: root, encoding: 'utf8',
}).trim();
const previous = (name) => execFileSync('git', ['show', `${base}:web/${name}`], {
  cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const current = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');
function sources(read) {
  return read('editor-scripts.txt').split('\n')
    .map((line) => line.split('#')[0].trim()).filter(Boolean).map(read);
}
const before = sources(previous);
const after = sources(current);
assert.equal(after.join(''), before.join(''), 'Ordered source bytes changed');
// Python trims trailing whitespace per file; Tauri keeps it. Both assemble
// one classic script, so declaration hoisting must span every source file.
for (const trim of [false, true]) {
  const assemble = (files) => files.map((text) => trim ? text.trimEnd() : text).join('\n\n');
  const ast = (text) => parse(text, { ecmaVersion: 'latest' });
  const normalize = (program) => JSON.stringify(program, (key, value) =>
    ['start', 'end', 'loc', 'range'].includes(key) ? undefined : value);
  const oldAst = ast(assemble(before));
  const newAst = ast(assemble(after));
  assert.equal(normalize(newAst), normalize(oldAst), 'Assembled AST changed');
  console.log(`${trim ? 'Python' : 'Tauri'} assembly: ${newAst.body.length} statements, AST identical`);
}
const bytes = after.join('');
console.log(`Ordered source: ${Buffer.byteLength(bytes)} bytes identical; sha256=${createHash('sha256').update(bytes).digest('hex')}`);
