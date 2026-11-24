// Editor build entry and transitional fixture readers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { assertBuildInputsUnchanged, assertMetafileInputsCaptured, captureBuildInputs, compileSources,
  dependencyHash, json, sha, shouldRebuildBundle, validateSources, writeArtifact } from './build-shared.mjs';

export { compileSources, isBundleArtifact, shouldRebuildBundle, validateSources, writeArtifact } from './build-shared.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUNDLE = 'editor/boot/editor-bundle.js';
export const BUILD_INFO = 'editor/boot/editor-bundle.meta.json';
export const BUILDERS = ['scripts/build-editor.mjs', 'scripts/build-shared.mjs'];

export function readSources(root = ROOT) {
  const web = fs.realpathSync(path.join(root,'web'));
  const files = validateSources(fs.readFileSync(path.join(web,'editor-scripts.txt'),'utf8').split('\n')
    .map(line => line.split('#')[0].trim()).filter(Boolean));
  for (const file of files) {
    const canonical = fs.realpathSync(path.join(web,file));
    if (!canonical.startsWith(web+path.sep) || !fs.statSync(canonical).isFile()) {
      throw new Error(`Source path escapes web or is not a file: ${file}`);
    }
  }
  return files;
}

export function readModules(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root,'web/editor-modules.json'),'utf8')).modules;
}

export async function buildEditor(root = ROOT, options = {}) {
  const snapshot = captureBuildInputs(root, ['web/editor-scripts.txt', 'web/editor-modules.json',
    ...BUILDERS, 'package.json', 'pnpm-lock.yaml']);
  const files = readSources(root), configText = snapshot['web/editor-modules.json'];
  const config = JSON.parse(configText), modules = config.modules, inputHashes = {};
  const result = await compileSources(root,files,modules,file => {
    const original = fs.readFileSync(path.join(root,'web',file),'utf8');
    snapshot['web/'+file] = original;
    const source = options.transform ? options.transform(file,original) : original;
    inputHashes[file] = sha(source); return source;
  },{bridges:config.externalBridges,trace:true,transform:options.transform,onDependency:(relative,original) => {
    const key = 'web/'+relative;
    // Transform hook covers imported inputs too (tests mutate non-manifest
    // sources like shared/utils/data.js after G04 retire). Snapshot keeps
    // the disk bytes for the unchanged check; the hash covers what esbuild
    // consumed (the transformed text).
    if (!Object.hasOwn(snapshot,key)) snapshot[key] = original;
    const source = options.transform ? options.transform(relative,original) : original;
    inputHashes[relative] = sha(source);
  }});
  // The bytes hashed above are the bytes given to esbuild, not a later read.
  assertMetafileInputsCaptured(root,result,inputHashes);
  assertBuildInputsUnchanged(root, snapshot);
  // esbuild resolves imports with worker parallelism, so onDependency
  // fires in nondeterministic order once the manifest no longer lists
  // every module (G04 retire). Sort the ledger so metadata is stable.
  const sortedInputHashes = Object.fromEntries(Object.entries(inputHashes).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
  const metadata = {format:1,esbuild:esbuild.version,sourceFiles:files,esmFactories:modules.length,
    inputs:sortedInputHashes,configHash:sha(configText),builderHash:sha(BUILDERS.map(name => snapshot[name]).join('\n')),
    dependencyHash:dependencyHash(snapshot),
    // esbuild sees remaining classic sources as a single transitional scope.
    // Explicit hashes above cover every source, including this virtual input.
    metafile:result.metafile};
  const identity = `/* MAW ESM artifact: ${sha(result.code+json(metadata))} */`;
  metadata.bundleHash = sha(identity+'\n'+result.code);
  return {...result,code:identity+'\n'+result.code,identity,metadata};
}

export function assertFresh(actual, expected) {
  if (actual !== expected) throw new Error('Editor bundle is stale; run pnpm run build:editor');
}

export async function checkEditor(root = ROOT) {
  const built = await buildEditor(root);
  // Bundles are build artifacts (not committed): a missing file is the normal
  // fresh-clone state, so point at the build command instead of "stale".
  if (!fs.existsSync(path.join(root,'web',BUNDLE))) throw new Error('Editor bundle missing; run pnpm run build:editor');
  assertFresh(fs.readFileSync(path.join(root,'web',BUNDLE),'utf8'),built.code);
  assertFresh(fs.readFileSync(path.join(root,'web',BUILD_INFO),'utf8'),json(built.metadata));
  return built;
}

async function writeEditor(root) {
  const built = await buildEditor(root);
  // Write only after the entire build succeeds; never repair while checking.
  await writeArtifact(root, BUNDLE, BUILD_INFO, built);
  console.log(`Editor: ${built.modules.length} ESM factories / ${built.sourceFiles.length} sources`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode,rootArg = ROOT] = process.argv.slice(2), root = path.resolve(rootArg);
  if (mode === '--check') { await checkEditor(root); console.log('Editor bundle is fresh'); }
  else if (mode === '--write') await writeEditor(root);
  else if (mode === '--watch') {
    await writeEditor(root);
    let pending = false, running = false;
    const rebuild = async () => {
      pending = true;
      if (running) return;
      running = true;
      while (pending) {
        pending = false;
        try { await writeEditor(root); } catch (error) { console.error(error.message); }
      }
      running = false;
    };
    fs.watch(path.join(root,'web'),{recursive:true},(_event,file) => {
      if (shouldRebuildBundle(root, file)) void rebuild();
    });
    for (const builder of BUILDERS) fs.watch(path.join(root, builder), () => {
      console.error('Build script changed; restart pnpm run watch:editor');
    });
  } else throw new Error('Usage: build-editor.mjs --write|--check|--watch [ROOT]');
}
