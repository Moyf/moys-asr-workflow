// Launcher 装配构建器：复用 build-editor.mjs 的编译核心（compileSources），
// 按 web/launcher-scripts.txt 清单原序把 classic 模块装配为提交进仓库的单文件产物。
// pywebview 以 file:// URI 加载 index.html，运行时不依赖 Node；bundle 必须随源码重建提交。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { compileSources, validateSources } from './build-editor.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUNDLE = 'launcher/boot/launcher-bundle.js';
export const BUILD_INFO = 'launcher/boot/launcher-bundle.meta.json';
export const CONFIG = 'launcher-modules.json';
export const BUILDERS = ['scripts/build-launcher.mjs', 'scripts/build-editor.mjs'];
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

export function readSources(root = ROOT) {
  const web = fs.realpathSync(path.join(root, 'web'));
  const files = validateSources(fs.readFileSync(path.join(web, 'launcher-scripts.txt'), 'utf8').split('\n')
    .map(line => line.split('#')[0].trim()).filter(Boolean));
  for (const file of files) {
    const canonical = fs.realpathSync(path.join(web, file));
    if (!canonical.startsWith(web + path.sep) || !fs.statSync(canonical).isFile()) {
      throw new Error(`Source path escapes web or is not a file: ${file}`);
    }
  }
  return files;
}

export function readConfig(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'web', CONFIG), 'utf8'));
}

export async function buildLauncher(root = ROOT) {
  const files = readSources(root);
  const config = readConfig(root);
  const modules = config.modules ?? [];
  const inputHashes = {};
  const result = await compileSources(root, files, modules, file => {
    const source = fs.readFileSync(path.join(root, 'web', file), 'utf8');
    inputHashes[file] = sha(source);
    return source;
  }, { bridges: config.externalBridges ?? [], trace: true });
  const metadata = {
    format: 1,
    esbuild: esbuild.version,
    sourceFiles: files,
    esmFactories: modules.length,
    inputs: inputHashes,
    configHash: sha(fs.readFileSync(path.join(root, 'web', CONFIG), 'utf8')),
    // compileSources 来自 build-editor.mjs，它的变更同样要求重建产物。
    builderHash: sha(BUILDERS.map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n')),
    metafile: result.metafile,
  };
  const identity = `/* MAW Launcher artifact: ${sha(result.code + json(metadata))} */`;
  return { ...result, code: identity + '\n' + result.code, identity, metadata };
}

export function assertFresh(actual, expected) {
  if (actual !== expected) throw new Error('Launcher bundle is stale; run pnpm run build:launcher');
}

export async function checkLauncher(root = ROOT) {
  const built = await buildLauncher(root);
  assertFresh(fs.readFileSync(path.join(root, 'web', BUNDLE), 'utf8'), built.code);
  assertFresh(fs.readFileSync(path.join(root, 'web', BUILD_INFO), 'utf8'), json(built.metadata));
  return built;
}

async function writeLauncher(root) {
  const built = await buildLauncher(root);
  // Write only after the entire build succeeds; never repair while checking.
  fs.mkdirSync(path.join(root, 'web', path.dirname(BUNDLE)), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', BUNDLE), built.code);
  fs.writeFileSync(path.join(root, 'web', BUILD_INFO), json(built.metadata));
  console.log(`Launcher: ${built.modules.length} ESM factories / ${built.sourceFiles.length} sources`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, rootArg = ROOT] = process.argv.slice(2), root = path.resolve(rootArg);
  if (mode === '--check') { await checkLauncher(root); console.log('Launcher bundle is fresh'); }
  else if (mode === '--write') await writeLauncher(root);
  else if (mode === '--watch') {
    await writeLauncher(root);
    let pending = false, running = false;
    const rebuild = async () => {
      pending = true;
      if (running) return;
      running = true;
      while (pending) {
        pending = false;
        try { await writeLauncher(root); } catch (error) { console.error(error.message); }
      }
      running = false;
    };
    fs.watch(path.join(root, 'web'), { recursive: true }, (_event, file) => {
      if (file && ![BUNDLE, BUILD_INFO].includes(file.replaceAll('\\', '/'))) void rebuild();
    });
    for (const builder of BUILDERS) fs.watch(path.join(root, builder), () => {
      console.error('Build script changed; restart pnpm run watch:launcher');
    });
  } else throw new Error('Usage: build-launcher.mjs --write|--check|--watch [ROOT]');
}
