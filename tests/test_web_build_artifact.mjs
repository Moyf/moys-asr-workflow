import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildEditor, writeArtifact } from '../scripts/build-editor.mjs';
import { buildLauncher } from '../scripts/build-launcher.mjs';

const bundle = 'editor/boot/editor-bundle.js';
const meta = 'editor/boot/editor-bundle.meta.json';
const hash = code => createHash('sha256').update(code).digest('hex');
const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-atomic-bundle-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
};

test('failed staging preserves the last complete artifact', async t => {
  const root = fixture(t);
  await writeArtifact(root, bundle, meta, {code:'old', metadata:{bundleHash:hash('old')}});
  const write = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (...args) => {
    if (++calls === 2) throw new Error('disk full');
    return write(...args);
  };
  try {
    await assert.rejects(writeArtifact(root, bundle, meta, {code:'new', metadata:{}}), /disk full/);
  } finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(path.join(root, 'web', bundle), 'utf8'), 'old');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'web', meta), 'utf8')).bundleHash, hash('old'));
  assert.equal(fs.readdirSync(path.join(root, 'web/editor/boot')).length, 2);
});

test('interrupted publication leaves complete JS and a detectable hash mismatch', async t => {
  const root = fixture(t);
  await writeArtifact(root, bundle, meta, {code:'old', metadata:{bundleHash:hash('old')}});
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination.endsWith('.meta.json')) throw new Error('interrupted');
    return rename(source, destination);
  };
  try {
    await assert.rejects(writeArtifact(root, bundle, meta, {code:'new', metadata:{bundleHash:hash('new')}}), /interrupted/);
  } finally { fs.renameSync = rename; }
  const code = fs.readFileSync(path.join(root, 'web', bundle), 'utf8');
  assert.equal(code, 'new');
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(root, 'web', meta), 'utf8')).bundleHash, hash(code));
});

test('concurrent processes never expose a truncated JS file', async t => {
  const root = fixture(t), width = 262144;
  await writeArtifact(root, bundle, meta, {code:'A'.repeat(width), metadata:{}});
  const worker = path.join(root, 'worker.mjs');
  fs.writeFileSync(worker, `import fs from 'node:fs';
import {writeArtifact} from ${JSON.stringify(new URL('../scripts/build-editor.mjs', import.meta.url).href)};
const [root, mode] = process.argv.slice(2);
for (let i = 0; i < 100; i++) {
  if (mode === 'read') {
    const code = fs.readFileSync(root + '/web/${bundle}', 'utf8');
    if (code.length !== ${width} || !/^A+$|^B+$/.test(code)) throw new Error('partial artifact');
  } else await writeArtifact(root, ${JSON.stringify(bundle)}, ${JSON.stringify(meta)}, {code:mode.repeat(${width}),metadata:{}});
}
`);
  const run = mode => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, mode], {stdio:['ignore','ignore','pipe']});
    let diagnostic = '';
    child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-2000); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(diagnostic || `exit ${code}`)));
  });
  await Promise.all([run('A'), run('B'), run('read')]);
});

for (const [kind, build] of [['editor', buildEditor], ['launcher', buildLauncher]]) {
  const source = kind === 'editor' ? 'web/editor/source.js' : 'web/source.js';
  const inputs = kind === 'editor'
    ? ['scripts/build-editor.mjs', 'package.json', 'pnpm-lock.yaml', source]
    : ['web/launcher-modules.json', 'scripts/build-editor.mjs', 'pnpm-lock.yaml', source];
  for (const changed of inputs) {
    test(`${kind} rejects ${changed} changing while compilation yields`, async t => {
      const root = fixture(t);
      fs.mkdirSync(path.join(root, 'web'), {recursive:true});
      fs.mkdirSync(path.join(root, 'web/editor'), {recursive:true});
      fs.mkdirSync(path.join(root, 'web/shared'), {recursive:true});
      fs.mkdirSync(path.join(root, 'scripts'), {recursive:true});
      fs.writeFileSync(path.join(root, source), 'window.fixture = 1;\n');
      if (kind === 'launcher') {
        fs.writeFileSync(path.join(root, 'web/launcher-scripts.txt'), 'source.js\n');
        fs.writeFileSync(path.join(root, 'web/launcher-modules.json'), '{"modules":[],"externalBridges":[]}\n');
        fs.writeFileSync(path.join(root, 'web/shared/tooltip.js'), 'window.MaweTooltip = {};\n');
      }
      for (const name of ['scripts/build-editor.mjs', 'scripts/build-launcher.mjs', 'package.json', 'pnpm-lock.yaml']) {
        fs.writeFileSync(path.join(root, name), '{}\n');
      }
      // build() has consumed its synchronous inputs when it yields to esbuild.
      const pending = build(root);
      fs.appendFileSync(path.join(root, changed), '\n');
      await assert.rejects(pending, /Build input changed during compilation/);
    });
  }
}
