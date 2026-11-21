import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { collectImageSources, readDocument } from '../website/scripts/sync-maw-docs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = 'website/scripts/sync-maw-docs.mjs';
const marker = 'LOCAL-SOURCE-SINGLE-TRUTH-TEST';
const { marked } = createRequire(import.meta.url)('../tools/shared/vendor/marked-18.1.3/marked.umd.js');

// These fixtures are deliberately retained: no test cleanup removes user files.
async function fixture({ missing = '' } = {}) {
  const target = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maw-docs-preserved-')));
  const generator = await readDocument(script, { root });
  const sources = [...generator.matchAll(/source: '([^']+\.md)'/g)].map((match) => match[1]);
  const copy = async (relative) => {
    if (relative === missing) return;
    const dest = path.join(target, relative);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await readDocument(relative, { root }));
  };
  await copy(script);
  await copy('tools/shared/vendor/marked-18.1.3/marked.umd.js');
  const entitiesEntry = createRequire(path.join(root, 'website/package.json')).resolve('entities');
  await mkdir(path.join(target, 'website/node_modules'), { recursive: true });
  await symlink(path.dirname(path.dirname(entitiesEntry)), path.join(target, 'website/node_modules/entities'), 'junction');
  for (const registry of ['website/scripts/legacy-doc-assets.json', 'website/scripts/authored-doc-assets.json']) await copy(registry);
  for (const config of ['website/package.json', 'website/astro.config.mjs', 'website/tsconfig.json']) await copy(config);
  for (const source of sources) {
    if (source === missing) continue;
    const dest = path.join(target, source);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, source === 'docs/user/FAQ.md'
      ? '# FAQ fixture\n\n![fixture](../assets/fixture.webp)\n' : '# Document fixture\n');
  }
  for (const [image, contents] of [['docs/assets/fixture.webp', 'fixture image'], ['docs/assets/guides/workflow.svg', 'fixture svg']]) {
    if (image === missing) continue;
    const dest = path.join(target, image);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, contents);
  }
  const docs = path.join(target, 'website/src/pages/docs');
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, 'index.astro'), await readDocument('website/src/pages/docs/index.astro', { root }));
  await writeFile(path.join(docs, 'faq.md'), 'fixture prior contents');
  return target;
}
function run(target, ...args) {
  return spawnSync(process.execPath, [path.join(target, script), ...args], {
    cwd: target, encoding: 'utf8', env: { ...process.env, MAW_SOURCE_DIR: '', MAW_DOCS_OUTPUT_SITE: path.join(target, 'website'), MAW_DOCS_PRINT_IMAGES: '0' },
  });
}

test('clean checkout generates then checks local documents and preserves unrelated pages', async () => {
  const target = await fixture();
  const unrelated = path.join(target, 'website/src/pages/docs/index.astro');
  const before = await readFile(unrelated);
  assert.equal(run(target).status, 0);
  assert.equal(run(target, '--check').status, 0);
  assert.deepEqual(await readFile(unrelated), before);
});

test('new source images do not require mirrors and obsolete mirrors are preserved', async () => {
  const target = await fixture();
  const source = path.join(target, 'docs/user/FAQ.md');
  await writeFile(source, (await readFile(source, 'utf8')) + '\n![new](../assets/new-fixture.webp)\n');
  const image = Buffer.from('new image bytes');
  await writeFile(path.join(target, 'docs/assets/new-fixture.webp'), image);
  const obsolete = path.join(target, 'website/public/docs-assets/obsolete.webp');
  await mkdir(path.dirname(obsolete), { recursive: true });
  await writeFile(obsolete, 'retained mirror');
  assert.equal(run(target).status, 0);
  assert.equal(run(target, '--check').status, 0);
  assert.deepEqual(await readFile(path.join(target, 'website/public/docs-assets/docs/assets/new-fixture.webp')), image);
  assert.equal(await readFile(obsolete, 'utf8'), 'retained mirror');
});

test('edited sources and stale mirrors regenerate from the checkout', async () => {
  const target = await fixture();
  const source = path.join(target, 'docs/user/FAQ.md');
  await writeFile(source, (await readFile(source, 'utf8')) + `\n${marker}\n`);
  const page = path.join(target, 'website/src/pages/docs/faq.md');
  await writeFile(page, 'STALE MIRROR');
  const image = 'docs/assets/fixture.webp';
  const changedImage = Buffer.from('changed image fixture');
  await writeFile(path.join(target, image), changedImage);
  assert.notEqual(run(target, '--check').status, 0);
  assert.equal(run(target).status, 0);
  assert.match(await readFile(page, 'utf8'), new RegExp(marker));
  assert.deepEqual(await readFile(path.join(target, 'website/public/docs-assets', image)), changedImage);
  assert.match(await readFile(page, 'utf8'), /\.\.\/\.\.\/docs-assets\/docs\/assets\/fixture\.webp/);
  assert.equal(run(target, '--check').status, 0);
});

test('sync and check fail offline when a source or image is missing', async () => {
  for (const missing of ['docs/user/FAQ.md', 'docs/assets/fixture.webp']) {
    const target = await fixture({ missing });
    const page = path.join(target, 'website/src/pages/docs/faq.md');
    const before = await readFile(page);
    for (const args of [[], ['--check']]) {
      const result = run(target, ...args);
      assert.notEqual(result.status, 0, `missing ${missing} must fail`);
      assert.match(result.stderr, /本地缺少/);
    }
    assert.deepEqual(await readFile(page), before, 'missing input must not partially rewrite pages');
  }
});

test('missing images with titles or single-quoted HTML cannot fall back to the network', async () => {
  for (const syntax of ['![alt](../assets/missing.webp "caption")', "<img src='../assets/missing.webp'>", '<img src = "../assets/missing">', '<img src=../assets/missing>', '<img srcset="../assets/missing.webp 1x">', '![missing]\n\n[missing]: ../assets/missing.webp', '<img data-src="https://example.org/a.png" src="../assets/missing.png">', '<img src="/missing.png">', '![missing](/missing.png)', '<picture><source srcset="../assets/missing.webp 1x"><img src="https://example.org/a.png"></picture>']) {
    const target = await fixture();
    const source = path.join(target, 'docs/user/FAQ.md');
    await writeFile(source, (await readFile(source, 'utf8')) + `\n${syntax}\n`);
    const result = run(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /本地缺少配图|暂不支持/);
  }
});

test('website entry points and acceptance build through isolated staging', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'website/package.json'), 'utf8'));
  for (const name of ['dev', 'check', 'build']) assert.match(pkg.scripts[name], /stage-site\.mjs/);
  const acceptance = await readFile(path.join(root, 'scripts/ci_acceptance.py'), 'utf8');
  const part = acceptance.slice(acceptance.indexOf("        'website': [["), acceptance.indexOf("        'build': [["));
  assert(part.includes("'build'"));
  assert.equal((part.match(/\['pnpm', '--dir', 'website', 'run', 'build'\]/g) || []).length, 1,
    'CI runs one website build');
  const deploy = await readFile(path.join(root, '.github/workflows/deploy-editor-pages.yml'), 'utf8');
  assert(deploy.includes('pnpm run build'));
});

test('isolated site stage excludes obsolete generated inputs but preserves authored content', async () => {
  const target = await fixture();
  const docs = path.join(target, 'website/src/pages/docs');
  await writeFile(path.join(docs, 'faq.md'), 'DAMAGED STALE MIRROR WITHOUT MARKER');
  await writeFile(path.join(docs, 'obsolete.md'), '<!-- Generated from old.md. Run pnpm run sync:docs to refresh. -->\n');
  await writeFile(path.join(docs, 'authored.md'), '# authored page\n\n<img src="/custom.txt">\n');
  await mkdir(path.join(target, 'docs/engineering'), { recursive: true });
  await writeFile(path.join(target, 'docs/engineering/unpublished.md'), '![local](../../assets/not-synced.png)\n');
  await mkdir(path.join(target, 'website/public/docs-assets'), { recursive: true });
  const oldAsset = path.join(target, 'website/public/docs-assets/docs/assets/1.6.0/overlay-track.webp');
  await mkdir(path.dirname(oldAsset), { recursive: true });
  await writeFile(oldAsset, 'obsolete image');
  await writeFile(path.join(target, 'website/public/docs-assets/custom.txt'), 'authored nested asset');
  await writeFile(path.join(target, 'website/scripts/authored-doc-assets.json'), '["custom.txt"]\n');
  await writeFile(path.join(target, 'website/public/custom.txt'), 'authored asset');
  await writeFile(path.join(target, 'website/.env'), 'PRIVATE_SENTINEL');
  await writeFile(path.join(target, 'website/public/.env.local'), 'PRIVATE_SENTINEL');
  await writeFile(path.join(docs, '.env'), 'PRIVATE_SENTINEL');
  const { prepareSite } = await import('../website/scripts/stage-site.mjs');
  const stage = path.join(target, 'stage');
  await prepareSite(path.join(target, 'website'), stage);
  assert.equal(await stat(path.join(stage, 'src/pages/docs/obsolete.md')).then(() => true, () => false), false);
  assert.equal(await stat(path.join(stage, 'public/docs-assets/docs/assets/1.6.0/overlay-track.webp')).then(() => true, () => false), false);
  assert.equal(await readFile(path.join(stage, 'src/pages/docs/authored.md'), 'utf8'), '# authored page\n\n<img src="/custom.txt">\n');
  assert.doesNotMatch(await readFile(path.join(stage, 'src/pages/docs/faq.md'), 'utf8'), /DAMAGED STALE/);
  assert.equal(await readFile(path.join(stage, 'public/custom.txt'), 'utf8'), 'authored asset');
  assert.equal(await readFile(path.join(stage, 'public/docs-assets/custom.txt'), 'utf8'), 'authored nested asset');
  assert.equal(await stat(path.join(stage, '.env')).then(() => true, () => false), false);
  assert.equal(await stat(path.join(stage, 'public/.env.local')).then(() => true, () => false), false);
  assert.equal(await stat(path.join(stage, 'src/pages/docs/.env')).then(() => true, () => false), false);
  assert.equal(run(target).status, 0);
  assert.equal(await readFile(path.join(docs, 'obsolete.md'), 'utf8'), '<!-- Generated from old.md. Run pnpm run sync:docs to refresh. -->\n');
});

test('isolated site staging reports unknown doc assets without deleting them', async () => {
  const target = await fixture();
  const asset = path.join(target, 'website/public/docs-assets/unclassified.webp');
  await mkdir(path.dirname(asset), { recursive: true });
  await writeFile(asset, 'preserved unknown');
  const { prepareSite } = await import('../website/scripts/stage-site.mjs');
  await assert.rejects(prepareSite(path.join(target, 'website'), path.join(target, 'stage')), /未登记的文件/);
  assert.equal(await readFile(asset, 'utf8'), 'preserved unknown');
});

test('isolated site staging fails when a source document or image is missing', async () => {
  const { prepareSite } = await import('../website/scripts/stage-site.mjs');
  for (const missing of ['docs/user/FAQ.md', 'docs/assets/fixture.webp']) {
    const target = await fixture({ missing });
    await assert.rejects(prepareSite(path.join(target, 'website'), path.join(target, 'stage')), /本地缺少/);
  }
});

test('isolated site staging rejects authored routes that collide with generated documents', async () => {
  const { prepareSite } = await import('../website/scripts/stage-site.mjs');
  for (const relative of ['faq.astro', 'faq/index.astro']) {
    const target = await fixture();
    const file = path.join(target, 'website/src/pages/docs', relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '<h1>conflict</h1>');
    await assert.rejects(prepareSite(path.join(target, 'website'), path.join(target, 'stage')), /文档路由冲突/);
  }
});

test('encoded local image paths resolve to the actual source image', async () => {
  const target = await fixture();
  const source = path.join(target, 'docs/user/FAQ.md');
  await writeFile(source, (await readFile(source, 'utf8')) + '\n![image](../assets/my%20image.webp)\n');
  await writeFile(path.join(target, 'docs/assets/my image.webp'), 'IMAGE_BYTES');
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(target, 'website/public/docs-assets/docs/assets/my image.webp'), 'utf8'), 'IMAGE_BYTES');
});

test('HTML image attributes decode entities before rewriting and escape once', async () => {
  const target = await fixture();
  const source = path.join(target, 'docs/user/FAQ.md');
  const examples = [
    ['<img src="../assets/fixture.webp?x=1&amp;y=2">', '<img src="../../docs-assets/docs/assets/fixture.webp?x=1&amp;y=2">'],
    ["<img src='../assets/fixture.webp?x=&#38;y=&copy;&quot;&apos;'>", '<img src="../../docs-assets/docs/assets/fixture.webp?x=&amp;y=©&quot;\'">'],
    ['<img src="../assets/fixture.webp?x=&amp;amp;&unknown;">', '<img src="../../docs-assets/docs/assets/fixture.webp?x=&amp;amp;&amp;unknown;">'],
    ['<img src="https://example.org/a.png?x=1&amp;y=2">', '<img src="https://example.org/a.png?x=1&amp;y=2">'],
  ];
  await writeFile(source, `# FAQ fixture\n\n${examples.map(([input]) => input).join('\n\n')}\n`);
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  const page = await readFile(path.join(target, 'website/src/pages/docs/faq.md'), 'utf8');
  for (const [, expected] of examples) assert.ok(page.includes(expected), expected);
  assert.deepEqual(collectImageSources(examples.map(([input]) => input).join('\n'), 'docs/user/FAQ.md'), ['docs/assets/fixture.webp']);
  assert.deepEqual(collectImageSources('<img src="../assets/fi&#x78;ture.webp">', 'docs/user/FAQ.md'), ['docs/assets/fixture.webp']);
  for (const input of ['<img src="&#47;missing.png">', '<img src="&#46;&#46;/&#46;&#46;/outside.png">']) {
    assert.throws(() => collectImageSources(input, 'docs/user/FAQ.md'), /暂不支持站点根路径图片|docs\/assets\//, input);
  }
});

test('development entry rejects a custom host before starting a server', async () => {
  const result = spawnSync(process.execPath, [path.join(root, 'website/scripts/stage-site.mjs'), 'dev', '--host', '0.0.0.0'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /只监听 127\.0\.0\.1/);
});

test('staging lifecycle cleans only its own directory on completion, failure and interruption', async () => {
  const failures = [];
  for (const mode of ['check', 'prepare-failure', 'build-failure', 'dev-exit', 'dev-SIGINT', 'dev-SIGTERM']) {
    if (process.platform === 'win32' && mode.startsWith('dev-SIG')) continue;
    try {
    const target = await fixture({ missing: mode === 'prepare-failure' ? 'docs/user/FAQ.md' : '' });
    const site = path.join(target, 'website');
    const scriptFile = process.env.MAW_TEST_STAGE_SCRIPT || path.join(root, 'website/scripts/stage-site.mjs');
    await writeFile(path.join(site, 'scripts/stage-site.mjs'), await readFile(scriptFile));
    await mkdir(path.join(target, 'assets'), { recursive: true });
    await mkdir(path.join(site, 'public'), { recursive: true });
    const astro = path.join(site, 'node_modules/astro/bin');
    await mkdir(astro, { recursive: true });
    await writeFile(path.join(astro, 'astro.mjs'), `
      console.log('FAKE_ASTRO_READY');
      if (process.env.FAKE_MODE === 'build-failure') process.exit(7);
      if (process.env.FAKE_MODE.startsWith('dev-SIG')) {
        process.on('SIGINT', () => process.exit(0));
        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
      }
    `);
    const temp = path.join(target, 'tmp');
    const prior = path.join(temp, 'maw-website-stage-existing');
    await mkdir(prior, { recursive: true });
    await writeFile(path.join(prior, 'user.txt'), 'keep');
    await writeFile(path.join(site, 'node_modules', 'external.txt'), 'keep dependency');
    const command = mode.startsWith('dev-') ? 'dev' : mode === 'build-failure' ? 'build' : 'check';
    const child = spawn(process.execPath, [path.join(site, 'scripts/stage-site.mjs'), command], {
      env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, FAKE_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
      if (mode.startsWith('dev-SIG') && output.includes('FAKE_ASTRO_READY')) child.kill(mode.slice(4));
    });
    child.stderr.on('data', (data) => { output += data; });
    const [code, signal] = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (status, sig) => resolve([status, sig]));
    });
    if (mode === 'prepare-failure' || mode === 'build-failure') assert.notEqual(code, 0, `${mode}: ${output}`);
    else if (mode.startsWith('dev-SIG')) assert.ok(code !== 0 || signal, `${mode}: ${output}`);
    else assert.equal(code, 0, `${mode}: ${output}`);
    assert.deepEqual(await readdir(temp), ['maw-website-stage-existing'], `${mode}: staging leaked`);
    assert.equal(await readFile(path.join(prior, 'user.txt'), 'utf8'), 'keep');
    assert.equal(await readFile(path.join(site, 'node_modules', 'external.txt'), 'utf8'), 'keep dependency');
    } catch (error) {
      failures.push(`${mode}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('consecutive builds replace stale default output', async () => {
  const target = await fixture();
  const site = path.join(target, 'website');
  const scriptFile = process.env.MAW_TEST_STAGE_SCRIPT || path.join(root, 'website/scripts/stage-site.mjs');
  await writeFile(path.join(site, 'scripts/stage-site.mjs'), await readFile(scriptFile));
  const astro = path.join(site, 'node_modules/astro/bin');
  await mkdir(astro, { recursive: true });
  await writeFile(path.join(astro, 'astro.mjs'), `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    await mkdir(process.env.MAW_SITE_OUTPUT_DIR, { recursive: true });
    await writeFile(path.join(process.env.MAW_SITE_OUTPUT_DIR, 'index.html'), 'built');
  `);
  const build = () => spawnSync(process.execPath, [path.join(site, 'scripts/stage-site.mjs'), 'build'], { encoding: 'utf8' });
  const first = build();
  assert.equal(first.status, 0, first.stderr);
  await writeFile(path.join(site, 'dist/stale.html'), 'stale');
  const second = build();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(path.join(site, 'dist/index.html'), 'utf8'), 'built');
  assert.equal(await stat(path.join(site, 'dist/stale.html')).then(() => true, () => false), false);
});

test('build refuses an existing output directory without changing it', async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), 'maw-output-preserved-'));
  const sentinel = path.join(target, 'sentinel.txt');
  await writeFile(sentinel, 'do not overwrite');
  const result = spawnSync(process.execPath, [path.join(root, 'website/scripts/stage-site.mjs'), 'build'], {
    encoding: 'utf8', env: { ...process.env, MAW_SITE_OUTPUT_DIR: target },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /输出目录已存在/);
  assert.equal(await readFile(sentinel, 'utf8'), 'do not overwrite');
});

test('build rejects arguments that override the isolated Astro root or output', async () => {
  for (const args of [['--outDir', '/tmp/other'], ['--root', '/tmp/other'], ['--config', '/tmp/other']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'website/scripts/stage-site.mjs'), 'build', ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不支持.*参数/);
  }
});

test('document images cannot read environment files or follow symlinks', async () => {
  const { symlink } = await import('node:fs/promises');
  for (const targetPath of ['../../.env', '../assets/linked.webp']) {
    const target = await fixture();
    const source = path.join(target, 'docs/user/FAQ.md');
    await writeFile(source, (await readFile(source, 'utf8')) + `\n![secret](${targetPath})\n`);
    if (targetPath.includes('linked')) {
      await writeFile(path.join(target, 'fake-secret.txt'), 'synthetic content');
      await symlink(path.join(target, 'fake-secret.txt'), path.join(target, 'docs/assets/linked.webp'));
    }
    const result = run(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /禁止|符号链接|docs\/assets\//);
  }
});

test('image syntax examples in code are not treated as document images', async () => {
  assert.deepEqual(collectImageSources('`![example][id]`\n```md\n![example][id]\n```\n', 'docs/user/FAQ.md'), []);
  assert.deepEqual(collectImageSources('![remote](//example.org/a.png) <img src="//example.org/a.png">', 'docs/user/FAQ.md'), []);
});

test('only resolved Markdown reference images are rejected', async () => {
  const source = 'docs/user/FAQ.md';
  const ordinary = [
    '提示中的 ![示例] 是普通文本。',
    '![missing][unknown] and ![missing][]',
    '![示例](普通文字 and ![示例](普通文字 无效)',
    '\\![example](../../outside.png)',
    '<span title="![example](../../outside.png)">ordinary attribute</span>',
    '\\![defined] and `![defined]`',
    '<!-- ![defined] -->',
    '    ![defined]',
  ].join('\n\n') + '\n\n[defined]: ../assets/fixture.webp\n';
  assert.deepEqual(collectImageSources(ordinary, source), []);
  assert.deepEqual(collectImageSources('![<!-- <img src="../../outside.png"> -->](../assets/fixture.webp)', source), ['docs/assets/fixture.webp']);
  assert.deepEqual(collectImageSources('![\\<img src="../assets/fake.png">](../assets/fixture.webp)', source), ['docs/assets/fixture.webp']);
  for (const image of ['![complex](<../assets/fixture.webp>)', '![a [nested]](../assets/fixture.webp)', '![alt](../assets/a(b).png)', '![<img src="../assets/fake.png">](../assets/fixture.webp)', '![alt](../assets/fixture.webp \'<img src="../assets/fake.png">\')', '![alt](../assets/fixture.webp \'<!-- <img src="../assets/fake.png"> -->\')']) {
    assert.throws(() => collectImageSources(image, source), /暂不支持此图片语法/, image);
  }
  for (const image of ['![alt][defined]', '![defined][]', '![defined]', '> ![alt][defined]', '- ![alt][defined]', '[![alt][defined]](WORKFLOW.md)']) {
    assert.throws(() => collectImageSources(`${image}\n\n[defined]: ../assets/fixture.webp\n`, source), /暂不支持引用式图片/, image);
  }
  const target = await fixture();
  const file = path.join(target, source);
  await writeFile(file, `${await readFile(file, 'utf8')}\n\n${ordinary}\n![<!-- <img src="../../outside.png"> -->](../assets/fixture.webp)\n`);
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  const page = await readFile(path.join(target, 'website/src/pages/docs/faq.md'), 'utf8');
  assert.ok(page.includes('提示中的 ![示例] 是普通文本。'));
  assert.ok(page.includes('alt="&lt;!-- &lt;img src=&quot;../../outside.png&quot;&gt; --&gt;"'));
});

test('CommonMark indented code is protected without hiding paragraph or list images', () => {
  const source = 'docs/user/FAQ.md';
  for (const markdown of [
    '    ![example](missing.png)\n',
    '\t![example][id]\n',
    '>     ![example][id]\n',
    '- item\n\n      ![example](missing.png)\n',
    '- item\n\n\t    ![example][id]\n',
    '>\t     ![example][id]\n',
    '-\t    ![example][id]\n',
    '- item\n\n  >     ![example][id]\n',
    '> ```md\n> ![example][id]\n> ```\n',
    '- ```md\n  ![example][id]\n  ```\n',
  ]) assert.deepEqual(collectImageSources(markdown, source), [], markdown);
  for (const markdown of ['> text\tmore\n', '- text\tmore\n']) {
    assert.deepEqual(collectImageSources(markdown, source), [], markdown);
  }
  for (const markdown of ['> \t![real](../assets/real.png)\n', '>\t![real](../assets/real.png)\n', '> \ttext\t![real](../assets/real.png)\n']) {
    assert.deepEqual(collectImageSources(markdown, source), ['docs/assets/real.png'], markdown);
  }
  assert.deepEqual(collectImageSources('paragraph\n    ![real](../assets/real.png)\n', source), ['docs/assets/real.png']);
  assert.deepEqual(collectImageSources('- item\n  ![real](../assets/real.png)\n', source), ['docs/assets/real.png']);
});

test('generated documents preserve indented code and rewrite real images and navigation', async () => {
  const target = await fixture();
  const source = path.join(target, 'docs/user/FAQ.md');
  const example = '    ![example][undefined-reference]';
  const nested = '> ```md\n> ![nested][undefined-reference]\n> ```';
  await writeFile(source, `${await readFile(source, 'utf8')}\n\n${example}\n\n${nested}\n\n![workflow](../assets/guides/workflow.svg)\n\n[guide](WORKFLOW.md)\n`);
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  const page = await readFile(path.join(target, 'website/src/pages/docs/faq.md'), 'utf8');
  assert.ok(page.includes(example));
  assert.ok(page.includes(nested));
  assert.doesNotMatch(page, /MAW_CODE_\d+/);
  assert.match(page, /<img src="\.\.\/\.\.\/docs-assets\/docs\/assets\/guides\/workflow\.svg"/);
  assert.ok(page.includes('[guide](../workflow/)'));
  assert.deepEqual(await readFile(path.join(target, 'website/public/docs-assets/docs/assets/guides/workflow.svg')),
    await readFile(path.join(target, 'docs/assets/guides/workflow.svg')));
});

test('source document images outside docs assets fail clearly', async () => {
  const source = 'docs/user/FAQ.md';
  for (const syntax of ['![root](../../assets/example.png)', '<img src="../user/example.svg">', '![encoded](../%75ser/example.png)']) {
    assert.throws(() => collectImageSources(syntax, source), /docs\/assets\//, syntax);
  }
  const target = await fixture();
  await writeFile(path.join(target, source), `${await readFile(path.join(target, source), 'utf8')}\n![bad](../../assets/image.png)\n`);
  for (const args of [[], ['--check'], ['--validate']]) {
    const result = run(target, ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docs\/assets\/.*assets\/image\.png/);
  }
});

test('ordinary links to images remain links to their repository targets', async () => {
  const target = await fixture();
  const source = path.join(target, 'docs/user/FAQ.md');
  const examples = [
    '[download](../../assets/screenshot.webp?download=1#view)',
    '[local](../assets/fixture.webp)',
    '<a href="../../assets/screenshot.webp">download</a>',
    '[guide](WORKFLOW.md#start)',
    '[external](https://example.org/photo.png)',
    '[anchor](#section)',
    '[file](../files/my%20notes.pdf?download=1#part)',
    '[titled](../assets/fixture.webp "image title")',
  ];
  await writeFile(source, `${await readFile(source, 'utf8')}\n${examples.join('\n')}\n`);
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  const page = await readFile(path.join(target, 'website/src/pages/docs/faq.md'), 'utf8');
  for (const expected of [
    '[download](https://raw.githubusercontent.com/Moyf/moys-asr-workflow/main/assets/screenshot.webp?download=1#view)',
    '[local](https://raw.githubusercontent.com/Moyf/moys-asr-workflow/main/docs/assets/fixture.webp)',
    '<a href="https://raw.githubusercontent.com/Moyf/moys-asr-workflow/main/assets/screenshot.webp">download</a>',
    '[guide](../workflow/#start)', examples[4], examples[5],
    '[file](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/files/my%20notes.pdf?download=1#part)',
    '[titled](https://raw.githubusercontent.com/Moyf/moys-asr-workflow/main/docs/assets/fixture.webp "image title")',
  ]) assert.ok(page.includes(expected), expected);
  assert.deepEqual(collectImageSources(examples.join('\n'), 'docs/user/FAQ.md'), []);
});

test('inline link titles preserve their syntax while destinations are rewritten', async () => {
  const target = await fixture();
  const source = path.join(target, 'docs/user/FAQ.md');
  const examples = [
    ['[plain](WORKFLOW.md)', '[plain](../workflow/)'],
    ['[parenthesized](WORKFLOW.md (指南))', '[parenthesized](../workflow/ (指南))'],
    ['[escaped](WORKFLOW.md (指南\\)及\\(说明))', '[escaped](../workflow/ (指南\\)及\\(说明))'],
    ['[backslash](WORKFLOW.md (指南\\\\))', '[backslash](../workflow/ (指南\\\\))'],
    ['[single](WORKFLOW.md \'guide\')', '[single](../workflow/ \'guide\')'],
    ['[double](WORKFLOW.md "guide")', '[double](../workflow/ "guide")'],
    ['[file](../files/my%20notes.pdf (下载))', '[file](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/files/my%20notes.pdf (下载))'],
    ['[resource](../assets/fixture.webp (查看))', '[resource](https://raw.githubusercontent.com/Moyf/moys-asr-workflow/main/docs/assets/fixture.webp (查看))'],
    ['![image](../assets/fixture.webp "caption")', '<img src="../../docs-assets/docs/assets/fixture.webp" alt="image" title="caption" loading="lazy" decoding="async" />'],
  ];
  await writeFile(source, `# FAQ fixture\n\n${examples.map(([input]) => input).join('\n\n')}\n`);
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  const page = await readFile(path.join(target, 'website/src/pages/docs/faq.md'), 'utf8');
  for (const [, expected] of examples) assert.ok(page.includes(expected), expected);
});

test('only real inline links rewrite their destinations with angle brackets and escapes', async () => {
  const target = await fixture();
  const source = path.join(target, 'docs/user/FAQ.md');
  const examples = [
    ['[guide](<WORKFLOW.md> (指南))', '[guide](<../workflow/> (指南))'],
    ['\\[guide](WORKFLOW.md (指南))', '\\[guide](WORKFLOW.md (指南))'],
    ['[guide](<WORKFLOW.md#start> "guide")', '[guide](<../workflow/#start> "guide")'],
    ["[guide](WORKFLOW%2Emd#start 'guide')", "[guide](../workflow/#start 'guide')"],
    ['[file](<../files/my%20notes.pdf?download=1#part> (下载))', '[file](<https://github.com/Moyf/moys-asr-workflow/blob/main/docs/files/my%20notes.pdf?download=1#part> (下载))'],
    ['[file](../files/name\\(draft\\).pdf "download")', '[file](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/files/name%28draft%29.pdf "download")'],
    ['[file](../files/name\\).pdf)', '[file](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/files/name%29.pdf)'],
    ['[file](../files/name\\(.pdf)', '[file](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/files/name%28.pdf)'],
    ['[file](../files/name%29.pdf)', '[file](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/files/name%29.pdf)'],
    ['[file](../files/name%28.pdf)', '[file](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/files/name%28.pdf)'],
    ['[a \\] label](WORKFLOW.md)', '[a \\] label](../workflow/)'],
    ['[a `](` label](WORKFLOW.md)', '[a `](` label](../workflow/)'],
    ['[``a` ``] ``](WORKFLOW.md)', '[``a` ``] ``](../workflow/)'],
    ['[x <!-- ![fake](../../outside.png) -->](WORKFLOW.md)', '[x <!-- ![fake](../../outside.png) -->](../workflow/)'],
    ['[x <!-- ![fake][ref] -->](WORKFLOW.md)', '[x <!-- ![fake][ref] -->](../workflow/)'],
    ['[x <!-- <img src="../assets/fake.png"> -->](WORKFLOW.md)', '[x <!-- <img src="../assets/fake.png"> -->](../workflow/)'],
    ['> [guide](<WORKFLOW.md> (指南))', '> [guide](<../workflow/> (指南))'],
    ['- [guide](WORKFLOW.md#start)', '- [guide](../workflow/#start)'],
    ['![image](../assets/fixture.webp)', '<img src="../../docs-assets/docs/assets/fixture.webp" alt="image" loading="lazy" decoding="async" />'],
    ['ordinary ](WORKFLOW.md (指南))', 'ordinary ](WORKFLOW.md (指南))'],
    ['`[guide](WORKFLOW.md)`', '`[guide](WORKFLOW.md)`'],
    ['<!-- [guide](WORKFLOW.md) -->', '<!-- [guide](WORKFLOW.md) -->'],
  ];
  await writeFile(source, `# FAQ fixture\n\n${examples.map(([input]) => input).join('\n\n')}\n`);
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  const page = await readFile(path.join(target, 'website/src/pages/docs/faq.md'), 'utf8');
  for (const [, expected] of examples) assert.ok(page.includes(expected), expected);
  for (const [, expected] of examples.filter(([input]) => input.startsWith('[file](../files/name'))) {
    const tokens = marked.lexer(expected, { gfm: false })[0].tokens;
    assert.equal(tokens.length, 1, expected);
    assert.equal(tokens[0].type, 'link', expected);
    assert.ok(tokens[0].href.endsWith('.pdf'), expected);
  }
  assert.deepEqual(collectImageSources(examples.map(([input]) => input).join('\n\n'), 'docs/user/FAQ.md'), ['docs/assets/fixture.webp']);
});

test('escaped link openers remain ordinary text', async () => {
  const target = await fixture();
  const literal = '\\[guide](WORKFLOW.md (指南))';
  await writeFile(path.join(target, 'docs/user/FAQ.md'), `# FAQ fixture\n\n${literal}\n`);
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  const page = await readFile(path.join(target, 'website/src/pages/docs/faq.md'), 'utf8');
  assert.ok(page.includes(literal), page);
});

test('comments preserve image examples while adjacent real images are synchronized', async () => {
  const target = await fixture();
  const source = path.join(target, 'docs/user/FAQ.md');
  const body = [
    '<!-- ![old](../../assets/screenshot.webp) -->![real](../assets/fixture.webp)',
    'text <!-- ![old](../../assets/screenshot.webp) --> ![real](../assets/fixture.webp)',
    '<!-- multi',
    '![old][ref] <img src="../../assets/screenshot.webp">',
    '```md',
    '![old](../../assets/screenshot.webp)',
    '```',
    '-->',
    '`<!--` ![real](../assets/fixture.webp) `-->`',
    '```md',
    '<!-- ![old](../../assets/screenshot.webp) -->',
    '```',
    '> <!-- ![old](../../assets/screenshot.webp) -->',
    '> ![real](../assets/fixture.webp)',
    '> <!-- multi',
    '> ![old][ref]',
    '> -->',
    '> ![real](../assets/fixture.webp)',
    '<div title="<!--"><img src="../assets/fixture.webp"></div>',
    '<div>\n2 < 3\n<!-- ![old](../../assets/screenshot.webp) -->\n<img src="../assets/fixture.webp">\n</div>',
  ].join('\n');
  await writeFile(source, `# FAQ fixture\n\n${body}\n`);
  assert.deepEqual(collectImageSources(body, 'docs/user/FAQ.md'), ['docs/assets/fixture.webp']);
  const result = run(target);
  assert.equal(result.status, 0, result.stderr);
  const page = await readFile(path.join(target, 'website/src/pages/docs/faq.md'), 'utf8');
  assert.ok(page.includes('<!-- ![old](../../assets/screenshot.webp) -->'));
  assert.ok(page.includes('![old][ref] <img src="../../assets/screenshot.webp">'));
  assert.equal((page.match(/<img src="\.\.\/\.\.\/docs-assets\/docs\/assets\/fixture\.webp"/g) || []).length, 7);
  assert.doesNotMatch(page, /MAW_CODE_\d+/);
});

test('Pages push paths cover deployment inputs and skip unrelated changes', async () => {
  const deploy = await readFile(path.join(root, '.github/workflows/deploy-editor-pages.yml'), 'utf8');
  const push = deploy.split('  push:\n')[1].split('  workflow_dispatch:', 1)[0];
  assert.match(push, /branches:\s*\[main\]/);
  assert.match(push, /\bpaths:/);
  const patterns = [...push.matchAll(/^\s+- ["']([^"']+)["']/gm)].map((match) => match[1]);
  const matches = (file) => patterns.some((pattern) => pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern);
  for (const file of ['website/src/pages/index.astro', 'README.md', 'CHANGELOG.md', 'docs/assets/example.webp', 'docs/user/FAQ.md', 'docs/releases/1.11.4.md', 'edit.py', 'maw/project.py', 'web/editor-scripts.txt', 'scripts/build-editor.mjs', 'scripts/run_check.py', 'scripts/prepare_release_notes.py', 'scripts/build_release_site.py', 'scripts/verify_release_site.py', 'tools/shared/vendor/marked-18.1.3/marked.umd.js', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'pyproject.toml', 'uv.lock', '.github/workflows/deploy-editor-pages.yml']) assert.ok(matches(file), file);
  for (const file of ['tests/test_unrelated.py', 'unrelated.txt', 'assets/example.png']) assert.equal(matches(file), false, file);
  const result = spawnSync(process.execPath, [path.join(root, script), '--validate'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const images = JSON.parse(result.stdout.match(/^MAW_IMAGES=(.*)$/m)[1]);
  assert.ok(images.every((image) => image.startsWith('docs/assets/')));
});

test('default output accepts an existing directory but protects custom outputs and symlinks', async () => {
  const { buildOutput } = await import('../website/scripts/stage-site.mjs');
  const site = await mkdtemp(path.join(os.tmpdir(), 'maw-output-policy-'));
  const output = path.join(site, 'dist');
  await mkdir(output);
  await writeFile(path.join(output, 'stale.html'), 'old');
  assert.equal(await buildOutput(site), output);
  const custom = path.join(site, 'custom');
  await mkdir(custom);
  await assert.rejects(buildOutput(site, custom), /输出目录已存在/);
  assert.equal(await readFile(path.join(output, 'stale.html'), 'utf8'), 'old');
  await symlink(custom, path.join(output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildOutput(site), /符号链接/);
  const otherSite = await mkdtemp(path.join(os.tmpdir(), 'maw-output-link-'));
  await symlink(custom, path.join(otherSite, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildOutput(otherSite), /符号链接/);
  const gitSite = await mkdtemp(path.join(os.tmpdir(), 'maw-output-git-'));
  await mkdir(path.join(gitSite, 'dist', '.git'), { recursive: true });
  await assert.rejects(buildOutput(gitSite), /不能包含 \.git/);
});
