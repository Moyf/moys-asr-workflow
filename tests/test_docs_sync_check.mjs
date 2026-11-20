import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectImageSources, readDocument, readImage } from '../website/scripts/sync-maw-docs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = 'website/scripts/sync-maw-docs.mjs';
const marker = 'LOCAL-SOURCE-SINGLE-TRUTH-TEST';

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
  for (const registry of ['website/scripts/legacy-doc-assets.json', 'website/scripts/authored-doc-assets.json']) await copy(registry);
  for (const config of ['website/package.json', 'website/astro.config.mjs', 'website/tsconfig.json']) await copy(config);
  for (const source of sources) await copy(source);
  // Copy only images referenced by these documents, including untracked sources.
  for (const source of sources) {
    const body = await readDocument(source, { root });
    for (const image of collectImageSources(body, source)) {
      if (image === missing) continue;
      const contents = await readImage(image, { root });
      const dest = path.join(target, image);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, contents);
    }
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
  const image = 'docs/assets/readme/overview.webp';
  const changedImage = Buffer.from('changed image fixture');
  await writeFile(path.join(target, image), changedImage);
  assert.notEqual(run(target, '--check').status, 0);
  assert.equal(run(target).status, 0);
  assert.match(await readFile(page, 'utf8'), new RegExp(marker));
  assert.deepEqual(await readFile(path.join(target, 'website/public/docs-assets', image)), changedImage);
  const gettingStarted = await readFile(path.join(target, 'website/src/pages/docs/getting-started.md'), 'utf8');
  assert.match(gettingStarted, /\.\.\/\.\.\/docs-assets\/docs\/assets\/readme\/overview\.webp/);
  assert.equal(run(target, '--check').status, 0);
});

test('sync and check fail offline when a source or image is missing', async () => {
  for (const missing of ['docs/user/FAQ.md', 'docs/assets/readme/overview.webp']) {
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
  for (const syntax of ['![alt](../assets/missing.webp "caption")', "<img src='../assets/missing.webp'>", '<img src = "../assets/missing">', '<img src=../assets/missing>', '<img srcset="../assets/missing.webp 1x">', '![missing]', '<img data-src="https://example.org/a.png" src="../assets/missing.png">', '<img src="/missing.png">', '![missing](/missing.png)', '<picture><source srcset="../assets/missing.webp 1x"><img src="https://example.org/a.png"></picture>']) {
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
  const deploy = await readFile(path.join(root, '.github/workflows/deploy-editor-pages.yml'), 'utf8');
  assert(deploy.includes('pnpm run build'));
});

test('isolated site stage excludes obsolete generated inputs but preserves authored content', async () => {
  const target = await fixture();
  const docs = path.join(target, 'website/src/pages/docs');
  await writeFile(path.join(docs, 'faq.md'), 'DAMAGED STALE MIRROR WITHOUT MARKER');
  await writeFile(path.join(docs, 'obsolete.md'), '<!-- Generated from old.md. Run pnpm run sync:docs to refresh. -->\n');
  await writeFile(path.join(docs, 'authored.md'), '# authored page\n');
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
  assert.equal(await readFile(path.join(stage, 'src/pages/docs/authored.md'), 'utf8'), '# authored page\n');
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
  for (const missing of ['docs/user/FAQ.md', 'docs/assets/readme/overview.webp']) {
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

test('development entry rejects a custom host before starting a server', async () => {
  const result = spawnSync(process.execPath, [path.join(root, 'website/scripts/stage-site.mjs'), 'dev', '--host', '0.0.0.0'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /只监听 127\.0\.0\.1/);
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
    assert.match(result.stderr, /禁止|符号链接/);
  }
});

test('image syntax examples in code are not treated as document images', async () => {
  assert.deepEqual(collectImageSources('`![example][id]`\n```md\n![example][id]\n```\n', 'docs/user/FAQ.md'), []);
  assert.deepEqual(collectImageSources('![remote](//example.org/a.png) <img src="//example.org/a.png">', 'docs/user/FAQ.md'), []);
});

test('publishing a build copies files into a new directory without replacing an existing one', async () => {
  const { publishBuild } = await import('../website/scripts/stage-site.mjs');
  const target = await mkdtemp(path.join(os.tmpdir(), 'maw-publish-preserved-'));
  const source = path.join(target, 'source');
  await mkdir(path.join(source, 'nested'), { recursive: true });
  await writeFile(path.join(source, 'nested/index.html'), 'new page');
  const output = path.join(target, 'output');
  await publishBuild(source, output);
  assert.equal(await readFile(path.join(output, 'nested/index.html'), 'utf8'), 'new page');
  await assert.rejects(publishBuild(source, output), /EEXIST/);
  assert.equal(await readFile(path.join(output, 'nested/index.html'), 'utf8'), 'new page');
});
