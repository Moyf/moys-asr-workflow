import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildEditor, isBundleArtifact, shouldRebuildBundle, writeArtifact } from '../scripts/build-editor.mjs';
import { buildLauncher } from '../scripts/build-launcher.mjs';

const bundle = 'editor/boot/editor-bundle.js';
const meta = 'editor/boot/editor-bundle.meta.json';
const hash = code => createHash('sha256').update(code).digest('hex');
const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-atomic-bundle-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
};
const seamFixture = (t, kind, specifier = './helper.js', imports = {}) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root,'web'),{recursive:true});
  fs.mkdirSync(path.join(root,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(root,`web/${kind}-scripts.txt`),'seam.js\n');
  fs.writeFileSync(path.join(root,`web/${kind}-modules.json`),JSON.stringify({format:1,
    modules:[{file:'seam.js',kind:'init',name:'seam',exportName:'runSeam'}],externalBridges:[]}));
  fs.writeFileSync(path.join(root,'web/seam.js'),
    `import { value } from ${JSON.stringify(specifier)};\nexport function runSeam() { window.result = value; }\n`);
  fs.writeFileSync(path.join(root,'web/helper.js'),"export const value = 'inside';\n");
  fs.writeFileSync(path.join(root,'outside-helper.js'),"export const value = 'outside';\n");
  for (const name of ['scripts/build-editor.mjs','scripts/build-launcher.mjs','pnpm-lock.yaml']) {
    fs.writeFileSync(path.join(root,name),'fixture input\n');
  }
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({imports})+'\n');
  return root;
};

test('watchers ignore both bundles, metadata and atomic publication files on either path separator', () => {
  for (const kind of ['editor', 'launcher']) {
    for (const name of [`${kind}-bundle.js`, `${kind}-bundle.meta.json`, '.maw-bundle-test.tmp']) {
      const file = `${kind}/boot/${name}`;
      assert.equal(isBundleArtifact(file), true, file);
      assert.equal(isBundleArtifact(file.replaceAll('/', '\\')), true, file);
    }
  }
  for (const file of ['editor-scripts.txt', 'launcher-modules.json', 'editor/boot/editor.js',
    'launcher/boot/launcher-state.js', 'shared/utils.js']) {
    assert.equal(isBundleArtifact(file), false, file);
  }
});

test('watchers ignore existing directory events but still rebuild for edited or deleted sources', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'web/editor/boot'), {recursive:true});
  fs.writeFileSync(path.join(root, 'web/editor/boot/editor.js'), 'window.fixture = 1;\n');
  assert.equal(shouldRebuildBundle(root, 'editor/boot'), false);
  assert.equal(shouldRebuildBundle(root, 'editor\\boot'), false);
  assert.equal(shouldRebuildBundle(root, 'editor/boot/editor.js'), true);
  assert.equal(shouldRebuildBundle(root, 'editor/deleted-source.js'), true);
  assert.equal(shouldRebuildBundle(root, 'launcher/boot/launcher-bundle.js'), false);
});

test('two real watchers rebuild edited sources and then stay idle together', {timeout:20000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-dual-watch-'));
  fs.mkdirSync(path.join(root, 'web'), {recursive:true});
  fs.mkdirSync(path.join(root, 'scripts'), {recursive:true});
  fs.writeFileSync(path.join(root, 'web/source.js'), 'window.fixture = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'fixture\n');
  for (const kind of ['editor', 'launcher']) {
    // 开发会话已先完成两套构建，watcher 启动时双方输出目录都已存在。
    fs.mkdirSync(path.join(root, `web/${kind}/boot`), {recursive:true});
    fs.writeFileSync(path.join(root, `web/${kind}-scripts.txt`), 'source.js\n');
    fs.writeFileSync(path.join(root, `web/${kind}-modules.json`), '{"modules":[],"externalBridges":[]}\n');
    fs.writeFileSync(path.join(root, `scripts/build-${kind}.mjs`), '// fixture build input\n');
  }
  const states = [];
  t.after(async () => {
    await Promise.all(states.map(({child}) => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', resolve);
      child.kill();
    })));
    fs.rmSync(root, {recursive:true, force:true});
  });
  for (const kind of ['editor', 'launcher']) {
    const script = new URL(`../scripts/build-${kind}.mjs`, import.meta.url);
    const child = spawn(process.execPath, [fileURLToPath(script), '--watch', root],
      {stdio:['ignore', 'pipe', 'pipe']});
    const state = {child, output:'', error:null};
    child.on('error', error => { state.error = error; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', data => { state.output = (state.output + data).slice(-4000); });
    }
    states.push(state);
  }
  const builds = state => (state.output.match(/^(Editor|Launcher):/gm) ?? []).length;
  const waitFor = async predicate => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      for (const state of states) {
        assert.equal(state.error, null, state.output);
        assert.equal(state.child.exitCode, null, state.output);
        assert.ok(builds(state) < 10, `watcher rebuild loop: ${state.output}`);
      }
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`watchers did not settle: ${states.map(state => state.output).join('\n')}`);
  };
  const settle = async () => {
    let previous = '', quietSince = Date.now();
    await waitFor(() => {
      const current = states.map(builds).join(',');
      if (current !== previous) { previous = current; quietSince = Date.now(); }
      return Date.now() - quietSince >= 800;
    });
  };
  await waitFor(() => states.every(state => builds(state) >= 1));
  await settle();
  assert.deepEqual(states.map(builds), [1, 1]);
  fs.writeFileSync(path.join(root, 'web/source.js'), 'window.fixture = 2;\n');
  await waitFor(() => states.every(state => builds(state) >= 2));
  await settle();
  for (const kind of ['editor', 'launcher']) {
    const code = fs.readFileSync(path.join(root, `web/${kind}/boot/${kind}-bundle.js`), 'utf8');
    assert.match(code, /window\.fixture\s*=\s*2/);
  }
});

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
  test(`${kind} records and hashes an imported module outside its source list`, async t => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root,'web'),{recursive:true});
    fs.mkdirSync(path.join(root,'scripts'),{recursive:true});
    fs.writeFileSync(path.join(root,`web/${kind}-scripts.txt`),'seam.js\n');
    fs.writeFileSync(path.join(root,`web/${kind}-modules.json`),JSON.stringify({format:1,
      modules:[{file:'seam.js',kind:'init',name:'seam',exportName:'runSeam'}],externalBridges:[]}));
    fs.writeFileSync(path.join(root,'web/seam.js'),
      `import { value } from './helper.js';\nexport function runSeam() { window.result = value; }\n`);
    fs.writeFileSync(path.join(root,'web/helper.js'),"export const value = 'first';\n");
    for (const name of ['scripts/build-editor.mjs','scripts/build-launcher.mjs','pnpm-lock.yaml']) {
      fs.writeFileSync(path.join(root,name),'fixture input\n');
    }
    fs.writeFileSync(path.join(root,'package.json'),'{}\n');

    const first = await build(root);
    assert.ok(first.metafile.inputs['web/helper.js']);
    assert.ok(first.metadata.inputs['helper.js']);
    fs.writeFileSync(path.join(root,'web/helper.js'),"export const value = 'second';\n");
    const second = await build(root);
    assert.notEqual(first.metadata.inputs['helper.js'],second.metadata.inputs['helper.js']);
    assert.notEqual(first.code,second.code);
  });

  test(`${kind} rejects a dependency changed after esbuild read its bytes`, async t => {
    const root = seamFixture(t,kind);
    const helper = path.resolve(root,'web/helper.js'), originalRead = fs.readFileSync;
    let changed = false;
    fs.readFileSync = (file,...args) => {
      const source = originalRead(file,...args);
      if (!changed && path.resolve(file) === helper) {
        changed = true;
        fs.writeFileSync(helper,"export const value = 'changed';\n");
      }
      return source;
    };
    try {
      await assert.rejects(build(root), /Build input changed during compilation/);
    } finally { fs.readFileSync = originalRead; }
    assert.ok(changed, 'the dependency was read during compilation');
  });

  test(`${kind} captures in-web aliases and rejects aliases outside web`, async t => {
    const root = seamFixture(t,kind,'#inside',
      {'#inside':'./web/helper.js','#outside':'./outside-helper.js'});
    const inside = await build(root);
    assert.ok(inside.metadata.inputs['helper.js']);
    fs.writeFileSync(path.join(root,'web/seam.js'),
      `import { value } from '#outside';\nexport function runSeam() { window.result = value; }\n`);
    await assert.rejects(build(root), /Static import escapes web/);
  });
}

for (const [kind, build] of [['editor', buildEditor], ['launcher', buildLauncher]]) {
  for (const changed of [`web/${kind}-modules.json`, 'scripts/build-editor.mjs', 'pnpm-lock.yaml', 'web/source.js']) {
    test(`${kind} rejects ${changed} changing while compilation yields`, async t => {
      const root = fixture(t);
      fs.mkdirSync(path.join(root, 'web'), {recursive:true});
      fs.mkdirSync(path.join(root, 'scripts'), {recursive:true});
      fs.writeFileSync(path.join(root, 'web/source.js'), 'window.fixture = 1;\n');
      fs.writeFileSync(path.join(root, `web/${kind}-scripts.txt`), 'source.js\n');
      fs.writeFileSync(path.join(root, `web/${kind}-modules.json`), '{"modules":[],"externalBridges":[]}\n');
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
