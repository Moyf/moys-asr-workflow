import { spawn, spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, symlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { documents } from './sync-maw-docs.mjs';

const ownSite = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedMarker = /<!-- Generated from [^\n]+\. Run pnpm run sync:docs to refresh\. -->/;
// Keep retired slugs here too, so even a damaged old mirror cannot become a route.
const historicalSlugs = ['documentation-index', 'launcher', 'faq', 'toolbox', 'postprocess-pipeline',
  'ass-styles', 'multi-subtitle', 'getting-started', 'workflow', 'providers', 'editor-guide', 'cli',
  'json-schema', 'keyboard-adjustment', 'local-asr', 'llm-postprocess', 'ocr-subtitle-dedup',
  'mose', 'provider-research', 'development'];
const reservedNames = new Set([...historicalSlugs, ...documents.map((document) => document.slug)].map((slug) => `${slug}.md`));
const reservedSlugs = new Set([...reservedNames].map((name) => name.slice(0, -3)));
const isEnvFile = (value) => /^\.env(?:\.|$)/i.test(path.basename(value));

async function copySafe(source, target) {
  await cp(source, target, { recursive: true, filter: async (value) => {
    if (isEnvFile(value)) return false;
    if ((await lstat(value)).isSymbolicLink()) throw new Error(`网站输入不能包含符号链接：${path.basename(value)}`);
    return true;
  } });
}

async function copyEntries(source, destination, exclude = []) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!exclude.includes(entry.name)) {
      await copySafe(path.join(source, entry.name), path.join(destination, entry.name));
    }
  }
}

function generate(site, stage, validateOnly = false) {
  const result = spawnSync(process.execPath, [path.join(site, 'scripts/sync-maw-docs.mjs'), ...(validateOnly ? ['--validate'] : [])], {
    cwd: site, env: { ...process.env, MAW_DOCS_OUTPUT_SITE: stage, MAW_DOCS_PRINT_IMAGES: '1' }, encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'document generation failed');
  const line = result.stdout.split('\n').find((value) => value.startsWith('MAW_IMAGES='));
  if (!line) throw new Error('document generator did not return its image inventory');
  return JSON.parse(line.slice('MAW_IMAGES='.length));
}

async function assetFiles(directory, prefix = '') {
  let entries;
  try { entries = await readdir(path.join(directory, prefix), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await assetFiles(directory, relative));
    else files.push(relative);
  }
  return files;
}

async function copyAuthoredAssets(site, stage, images) {
  const readList = async (name) => {
    const list = JSON.parse(await readFile(path.join(site, 'scripts', name), 'utf8'));
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item ||
      item.includes('\\') || path.posix.isAbsolute(item) || path.posix.normalize(item) !== item ||
      item.split('/').some((part) => part === '..' || isEnvFile(part)))) throw new Error(`无效的配图清单：${name}`);
    return list;
  };
  const legacy = new Set(await readList('legacy-doc-assets.json'));
  const authored = await readList('authored-doc-assets.json');
  const managed = new Set([...legacy, ...images]);
  if (authored.some((name) => managed.has(name))) throw new Error('手写配图与生成配图路径冲突');
  const directory = path.join(site, 'public/docs-assets');
  const unknown = (await assetFiles(directory)).filter((name) => !managed.has(name) && !authored.includes(name));
  if (unknown.length) throw new Error(`配图目录中有未登记的文件，请先确认来源：${unknown.join(', ')}`);
  for (const name of authored) {
    const target = path.join(stage, 'public/docs-assets', ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copySafe(path.join(directory, ...name.split('/')), target);
  }
}

export async function publishBuild(source, output) {
  await mkdir(output); // exclusive: never replace an existing output directory
  for (const entry of await readdir(source)) {
    await cp(path.join(source, entry), path.join(output, entry), { recursive: true, force: false, errorOnExist: true });
  }
}

export async function prepareSite(site, stage) {
  await mkdir(stage, { recursive: false });
  for (const name of ['package.json', 'astro.config.mjs', 'tsconfig.json']) {
    await cp(path.join(site, name), path.join(stage, name));
  }
  await copyEntries(path.join(site, 'src'), path.join(stage, 'src'), ['pages']);
  await copyEntries(path.join(site, 'src/pages'), path.join(stage, 'src/pages'), ['docs']);
  await mkdir(path.join(stage, 'src/pages/docs'), { recursive: true });
  const docs = path.join(site, 'src/pages/docs');
  for (const entry of await readdir(docs, { withFileTypes: true })) {
    const source = path.join(docs, entry.name);
    if (reservedNames.has(entry.name)) continue;
    const slug = entry.name.replace(/\.(?:astro|md|mdx|html)$/i, '');
    if (reservedSlugs.has(slug)) throw new Error(`手写页面与文档路由冲突：${entry.name}`);
    if (entry.isFile() && entry.name.endsWith('.md') && generatedMarker.test(await readFile(source, 'utf8'))) continue;
    await copySafe(source, path.join(stage, 'src/pages/docs', entry.name));
  }
  await copyEntries(path.join(site, 'public'), path.join(stage, 'public'), ['docs-assets']);
  try { await symlink(path.join(site, 'node_modules'), path.join(stage, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const images = generate(site, stage);
  await copyAuthoredAssets(site, stage, images);
  return images;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['dev', 'build', 'check'].includes(command)) throw new Error('expected dev, build or check');
  if (command === 'dev' && args.some((arg) => ['--background', '--force'].includes(arg))) {
    throw new Error('隔离开发服务器不支持 --background 或 --force');
  }
  if (command === 'dev' && args.some((arg) => arg === '--host' || arg.startsWith('--host='))) {
    throw new Error('开发服务器只监听 127.0.0.1，不支持自定义 --host');
  }
  if (command !== 'dev' && args.length) throw new Error('检查和构建不支持额外参数');
  if (command === 'dev') {
    for (let i = 0; i < args.length; i++) {
      const value = args[i] === '--port' ? args[++i] : args[i].startsWith('--port=') ? args[i].slice(7) : '';
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 65535) throw new Error('开发服务器只支持 --port 参数');
    }
  }
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maw-website-stage-')));
  const stage = path.join(parent, 'site');
  let images = await prepareSite(ownSite, stage);
  console.log(`已生成 ${documents.length} 篇文档和 ${images.length} 张配图`);
  const astro = path.join(ownSite, 'node_modules/astro/bin/astro.mjs');
  const output = path.resolve(process.env.MAW_SITE_OUTPUT_DIR || path.join(ownSite, 'dist'));
  if (command === 'build' && await lstat(output).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) throw new Error('构建输出目录已存在；请指定一个不存在的 MAW_SITE_OUTPUT_DIR');
  const env = { ...process.env, MAW_SITE_OUTPUT_DIR: path.join(stage, 'dist') };
  const watchers = [];
  let child;
  let timer;
  if (command === 'dev') {
    const changed = new Set();
    const root = path.dirname(ownSite);
    const onChange = (file) => {
      if (!(file === 'README.md' || file.startsWith('docs/') || file.startsWith('assets/') ||
          file.startsWith('website/src/') || file.startsWith('website/public/') ||
          file === 'website/scripts/sync-maw-docs.mjs' || file === 'website/scripts/legacy-doc-assets.json' ||
          file === 'website/scripts/authored-doc-assets.json')) return;
      if (file.split('/').some(isEnvFile)) return;
      changed.add(file);
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const batch = [...changed];
          changed.clear();
          if (batch.some((file) => file === 'website/scripts/sync-maw-docs.mjs' ||
              file === 'website/scripts/legacy-doc-assets.json' || file === 'website/scripts/authored-doc-assets.json' ||
              file.startsWith('website/public/docs-assets/'))) throw new Error('文档或配图清单已改变，请重新启动开发服务器');
          for (const file of batch.filter((value) => value.startsWith('website/src/') || value.startsWith('website/public/'))) {
            const relative = file.slice('website/'.length);
            const source = path.join(ownSite, relative);
            const target = path.join(stage, relative);
            const entry = await lstat(source);
            if (entry.isDirectory()) continue;
            if (entry.isSymbolicLink()) throw new Error(`开发输入包含符号链接，请重新启动：${relative}`);
            const existing = await lstat(target).catch((error) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
            if (existing?.isSymbolicLink()) throw new Error(`隔离输入包含符号链接：${relative}`);
            if (relative.startsWith('src/pages/docs/') && relative.endsWith('.md') &&
                generatedMarker.test(await readFile(source, 'utf8'))) continue;
            if (relative.startsWith('src/pages/docs/')) {
              const entry = relative.slice('src/pages/docs/'.length).split('/')[0];
              if (reservedNames.has(entry)) continue;
              if (reservedSlugs.has(entry.replace(/\.(?:astro|md|mdx|html)$/i, ''))) throw new Error(`手写页面与文档路由冲突：${relative}`);
            }
            await mkdir(path.dirname(target), { recursive: true });
            await cp(source, target);
          }
          const nextImages = generate(ownSite, stage, true);
          if (images.length !== nextImages.length || images.some((image) => !nextImages.includes(image))) throw new Error('文档配图清单已改变，请重新启动开发服务器');
          generate(ownSite, stage);
          images = nextImages;
        } catch (error) {
          console.error(`开发服务器停止：${error.message}`);
          child?.kill('SIGTERM');
        }
      }, 150);
    };
    try {
      for (const [directory, prefix, recursive] of [
        [root, '', false], [path.join(root, 'docs'), 'docs/', true],
        [path.join(root, 'assets'), 'assets/', true], [path.join(ownSite, 'src'), 'website/src/', true],
        [path.join(ownSite, 'public'), 'website/public/', true],
        [path.join(ownSite, 'scripts'), 'website/scripts/', false],
      ]) {
        const watcher = watch(directory, { recursive }, (_event, name) => onChange(prefix + String(name || '').replaceAll('\\', '/')));
        watcher.on('error', (error) => { console.error(`开发监听失败：${error.message}`); child?.kill('SIGTERM'); });
        watchers.push(watcher);
      }
    } catch (error) {
      for (const watcher of watchers) watcher.close();
      throw error;
    }
  }
  try {
    child = spawn(process.execPath, [astro, command, '--root', stage, ...(command === 'dev' ? ['--ignore-lock', '--host', '127.0.0.1'] : []), ...args], { cwd: ownSite, env, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (status, signal) => resolve(signal ? 1 : status));
    });
    if (code !== 0) { process.exitCode = code || 1; return; }
    if (command === 'build') {
      await publishBuild(path.join(stage, 'dist'), output);
      console.log(`站点构建完成：${output}`);
    }
  } finally {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
