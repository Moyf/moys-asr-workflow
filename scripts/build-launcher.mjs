// Launcher 装配构建器：复用 build-editor.mjs 的编译核心（compileSources），
// 按 web/launcher-scripts.txt 清单原序把 classic 模块装配为单文件构建产物。
// pywebview 以 file:// URI 加载 index.html；发布包内置 bundle，运行时不依赖 Node。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { assertBuildInputsUnchanged, captureBuildInputs, compileSources,
  dependencyHash, replaceFile, validateSources, writeArtifact } from './build-editor.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUNDLE = 'launcher/boot/launcher-bundle.js';
export const BUILD_INFO = 'launcher/boot/launcher-bundle.meta.json';
// Launcher 页面以 classic script 引用共享 tooltip（web/launcher/index.html）。
// 共享 tooltip 源码是 ESM 转换体，直引会挂——为 Launcher 单独产一个两阶段
// bootstrap 的小产物（等价生产装配：initialize() 两 next）。
export const TOOLTIP_BUNDLE = 'launcher/boot/tooltip-bundle.js';
export const TOOLTIP_SOURCE = 'shared/tooltip.js';
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
  const snapshot = captureBuildInputs(root, ['web/launcher-scripts.txt', 'web/'+CONFIG,
    ...BUILDERS, 'package.json', 'pnpm-lock.yaml']);
  const files = readSources(root);
  const configText = snapshot['web/'+CONFIG], config = JSON.parse(configText);
  const modules = config.modules ?? [];
  const inputHashes = {};
  const result = await compileSources(root, files, modules, file => {
    const source = fs.readFileSync(path.join(root, 'web', file), 'utf8');
    snapshot['web/'+file] = source;
    inputHashes[file] = sha(source);
    return source;
  }, { bridges: config.externalBridges ?? [], trace: true });
  assertBuildInputsUnchanged(root, snapshot);
  const metadata = {
    format: 1,
    esbuild: esbuild.version,
    sourceFiles: files,
    esmFactories: modules.length,
    inputs: inputHashes,
    configHash: sha(configText),
    // compileSources 来自 build-editor.mjs，它的变更同样要求重建产物。
    builderHash: sha(BUILDERS.map(name => snapshot[name]).join('\n')),
    dependencyHash: dependencyHash(snapshot),
    metafile: result.metafile,
    tooltipSourceHash: sha(fs.readFileSync(path.join(root, 'web', TOOLTIP_SOURCE), 'utf8')),
  };
  const identity = `/* MAW Launcher artifact: ${sha(result.code + json(metadata))} */`;
  metadata.bundleHash = sha(identity + '\n' + result.code);
  return { ...result, code: identity + '\n' + result.code, identity, metadata };
}

// Launcher 页面的共享 tooltip classic 产物：tooltip 已是普通 ESM，
// import 求值即挂载（模块顶层执行），与编辑器同一路径。
export async function buildTooltipBundle(root = ROOT) {
  const result = await esbuild.build({
    absWorkingDir: path.resolve(root),
    stdin: {
      contents: `import './${TOOLTIP_SOURCE}';\n`,
      resolveDir: path.resolve(root, 'web'),
      sourcefile: 'tooltip-entry.mjs',
      loader: 'js',
    },
    bundle: true, format: 'iife', target: ['chrome120'], write: false,
    legalComments: 'none', logLevel: 'silent', banner: { js: "'use strict';" },
  });
  const body = result.outputFiles[0].text;
  const source = fs.readFileSync(path.join(root, 'web', TOOLTIP_SOURCE), 'utf8');
  const identity = `/* MAW Launcher tooltip artifact: ${sha(body + sha(source))} */`;
  return { code: identity + '\n' + body, identity };
}

export function assertFresh(actual, expected) {
  if (actual !== expected) throw new Error('Launcher bundle is stale; run pnpm run build:launcher');
}

export async function checkLauncher(root = ROOT) {
  const built = await buildLauncher(root);
  // Bundles are build artifacts (not committed): a missing file is the normal
  // fresh-clone state, so point at the build command instead of "stale".
  if (!fs.existsSync(path.join(root, 'web', BUNDLE))) throw new Error('Launcher bundle missing; run pnpm run build:launcher');
  assertFresh(fs.readFileSync(path.join(root, 'web', BUNDLE), 'utf8'), built.code);
  assertFresh(fs.readFileSync(path.join(root, 'web', BUILD_INFO), 'utf8'), json(built.metadata));
  const tooltip = await buildTooltipBundle(root);
  if (!fs.existsSync(path.join(root, 'web', TOOLTIP_BUNDLE))) throw new Error('Launcher tooltip bundle missing; run pnpm run build:launcher');
  assertFresh(fs.readFileSync(path.join(root, 'web', TOOLTIP_BUNDLE), 'utf8'), tooltip.code);
  return built;
}

async function writeLauncher(root) {
  const built = await buildLauncher(root);
  const tooltip = await buildTooltipBundle(root);
  // Write only after the entire build succeeds; never repair while checking.
  const tooltipDestination = path.join(root, 'web', TOOLTIP_BUNDLE);
  fs.mkdirSync(path.dirname(tooltipDestination), { recursive: true });
  const temporary = path.join(path.dirname(tooltipDestination), `.maw-bundle-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, tooltip.code, { flag: 'wx' });
    await replaceFile(temporary, tooltipDestination);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeArtifact(root, BUNDLE, BUILD_INFO, built);
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
      if (file && ![BUNDLE, BUILD_INFO, TOOLTIP_BUNDLE].includes(file.replaceAll('\\', '/'))
          && !/\.maw-bundle-[^/\\]+\.tmp$/.test(file)) void rebuild();
    });
    for (const builder of BUILDERS) fs.watch(path.join(root, builder), () => {
      console.error('Build script changed; restart pnpm run watch:launcher');
    });
  } else throw new Error('Usage: build-launcher.mjs --write|--check|--watch [ROOT]');
}
