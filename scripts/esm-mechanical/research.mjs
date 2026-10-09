// Read-only inventory and fail-closed ESM factory codemod for an isolated copy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import * as eslintScope from 'eslint-scope';
import { unresolvedRefs } from '../refactor-tools/scope-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_BATCH = ['data', 'fonts', 'speakers', 'media-metadata', 'navigation']
  .map(name => `shared/utils/${name}.js`);
export const readManifest = root => fs.readFileSync(path.join(root, 'web/editor-scripts.txt'), 'utf8')
  .split('\n').map(line => line.split('#')[0].trim()).filter(Boolean);
const parse = (source, sourceType = 'script') => acorn.parse(source,
  { ecmaVersion: 16, sourceType, locations: true, ranges: true });
const prop = node => node?.computed ? (node.property?.type === 'Literal' ? node.property.value : null)
  : node?.property?.name;
function chain(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'ChainExpression') return chain(node.expression);
  if (node?.type === 'MemberExpression') return `${chain(node.object)}.${prop(node) ?? '[dynamic]'}`;
  return '';
}
const registryCall = (node, method) => node?.type === 'CallExpression'
  && /^(window|globalThis|global)\.MAWE\./.test(chain(node.callee))
  && prop(node.callee) === method;
const snippet = (source, node) => source.slice(node.start, node.end);
const key = property => property.computed ? null : property.key?.name ?? property.key?.value;
const json = value => JSON.stringify(value, null, 2) + '\n';
function allFiles(dir, suffix) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? allFiles(path.join(dir, entry.name), suffix)
      : entry.name.endsWith(suffix) ? [path.join(dir, entry.name)] : []);
}
function returnsOf(factory, source) {
  const returns = [];
  walk.ancestor(factory.body, { ReturnStatement(node, ancestors) {
    const owner = [...ancestors].reverse().find(n => /Function/.test(n.type));
    if (owner && owner !== factory) return;
    let value = node.argument;
    if (value?.type === 'CallExpression' && chain(value.callee) === 'Object.freeze') value = value.arguments[0];
    returns.push(value?.type === 'ObjectExpression'
      ? { keys: value.properties.map(key), expression: snippet(source, node.argument) }
      : { keys: null, expression: node.argument ? snippet(source, node.argument) : '' });
  }});
  return returns;
}

export function inspectSource(source, file) {
  const ast = parse(source);
  const registrations = [], resolutions = [], globals = [], hazards = [];
  walk.ancestor(ast, {
    CallExpression(node, ancestors) {
      if (registryCall(node, 'register')) {
        const factory = node.arguments[1];
        const bagReads = [];
        if (factory && /Function/.test(factory.type)) {
          walk.simple(factory.body, { VariableDeclarator(decl) {
            if (decl.id.type === 'ObjectPattern' && factory.params.some(p => p.type === 'Identifier'
              && decl.init?.type === 'Identifier' && decl.init.name === p.name)) {
              bagReads.push(...decl.id.properties.map(p => ({ key: key(p), binding: snippet(source, p.value ?? p.argument) })));
            }
          }});
        }
        registrations.push({ name: node.arguments[0]?.value ?? null, line: node.loc.start.line,
          factoryType: factory?.type, factoryName: factory?.id?.name ?? null,
          signature: factory?.params?.map(p => snippet(source, p)) ?? [], bagReads,
          returns: factory && /Function/.test(factory.type) ? returnsOf(factory, source) : [],
          topLevel: ancestors.length === 3, start: node.start, end: node.end });
      }
      if (registryCall(node, 'resolve')) {
        resolutions.push({ name: node.arguments[0]?.value ?? null, line: node.loc.start.line,
          arguments: node.arguments.slice(1).map(arg => ({ expression: snippet(source, arg),
            kind: arg.type, keys: arg.type === 'ObjectExpression' ? arg.properties.map(key) : null })),
          enclosingFunction: [...ancestors].reverse().find(n => /Function/.test(n.type))?.id?.name ?? null });
      }
      if (node.callee.type === 'Identifier' && ['eval', 'Function'].includes(node.callee.name)) hazards.push('dynamic-code');
    },
    AssignmentExpression(node) {
      const target = chain(node.left);
      if (/^(window|globalThis|global)\./.test(target)) globals.push({ target, line: node.loc.start.line });
    },
    ThisExpression(node, ancestors) {
      if (!ancestors.some(n => /Function/.test(n.type))) hazards.push('top-level-this');
    },
  });
  const free = [...new Set(unresolvedRefs(source).map(ref => ref.name))].sort();
  const templates = [...new Set(source.match(/__[A-Z][A-Z_]+__/g) ?? [])].sort();
  const simple = ast.body.length === 1 && ast.body[0].type === 'ExpressionStatement'
    && registryCall(ast.body[0].expression, 'register') && registrations[0]?.factoryType === 'FunctionExpression'
    && registrations[0]?.name !== null;
  // This classification is syntactic eligibility, not a proof of safe direct imports.
  const category = templates.length ? 'template' : simple ? 'factory'
    : file.includes('editor-wiring-') || /editor-(startup|onboarding)\.js$/.test(file) ? 'wiring' : 'facade-or-state';
  const declarations = ast.body.flatMap(n => n.type === 'VariableDeclaration'
    ? n.declarations.filter(d => d.id.type === 'Identifier').map(d => d.id.name)
    : /^(Function|Class)Declaration$/.test(n.type) && n.id ? [n.id.name] : []);
  return { file, category, registrations, resolutions, globals, free, templates,
    declarations, hazards: [...new Set(hazards)], simpleFactory: simple };
}

export function inventory(root = ROOT) {
  const manifest = readManifest(root);
  const files = manifest.map(file => inspectSource(fs.readFileSync(path.join(root, 'web', file), 'utf8'), file));
  const extraFiles = allFiles(path.join(root, 'web'), '.js')
    .map(file => path.relative(path.join(root, 'web'), file).replaceAll('\\', '/'))
    .filter(file => !manifest.includes(file));
  const extras = extraFiles.map(file => inspectSource(fs.readFileSync(path.join(root, 'web', file), 'utf8'), file));
  const registrations = files.flatMap(f => f.registrations.map(r => ({ file: f.file, ...r })));
  const resolutions = files.flatMap(f => f.resolutions.map(r => ({ file: f.file, ...r })));
  const providers = new Map();
  for (const file of files) for (const r of file.registrations) for (const ret of r.returns) {
    for (const name of ret.keys ?? []) if (name) providers.set(name, [...(providers.get(name) ?? []), r.name]);
  }
  const dependencyCandidates = files.flatMap(f => f.registrations.flatMap(r => r.bagReads.map(b => ({
    file: f.file, module: r.name, ...b, candidateProviders: providers.get(b.key) ?? [],
    decision: 'keep-injection-until-callsite-provenance-proved',
  }))));
  const declarationOwners = new Map(files.flatMap(f => f.declarations.map(n => [n, f.file])));
  const crossLexical = files.flatMap(f => f.free.filter(n => declarationOwners.has(n))
    .map(name => ({ consumer: f.file, name, provider: declarationOwners.get(name) })));
  // Writes cannot be replaced with assignment to an imported binding.
  const crossLexicalWrites = files.flatMap(f => {
    const source = fs.readFileSync(path.join(root, 'web', f.file), 'utf8');
    const scope = eslintScope.analyze(parse(source), { ecmaVersion: 16, sourceType: 'script' });
    return scope.globalScope.through.filter(r => declarationOwners.has(r.identifier.name) && r.isWrite())
      .map(r => ({ consumer: f.file, provider: declarationOwners.get(r.identifier.name),
        name: r.identifier.name, line: r.identifier.loc.start.line }));
  });
  const namespaceOwners = new Map();
  for (const file of files) for (const assignment of file.globals) {
    if (assignment.target.split('.').length !== 2) continue;
    const name = assignment.target.split('.')[1];
    namespaceOwners.set(name, [...new Set([...(namespaceOwners.get(name) ?? []), file.file])]);
  }
  const namespaceReferences = files.flatMap(f => {
    const source = fs.readFileSync(path.join(root, 'web', f.file), 'utf8'), ast = parse(source);
    const output = [];
    for (const name of f.free) if (namespaceOwners.has(name)) output.push({ consumer: f.file,
      name, form: 'bare-free-name', candidateProviders: namespaceOwners.get(name), decision: 'preserve-window-bridge' });
    walk.simple(ast, { MemberExpression(node) {
      const target = chain(node);
      if (target.split('.').length !== 2 || !/^(window|globalThis|global)\./.test(target)) return;
      const name = target.split('.')[1];
      if (namespaceOwners.has(name)) output.push({ consumer: f.file, name, form: target,
        line: node.loc.start.line, candidateProviders: namespaceOwners.get(name), decision: 'preserve-window-bridge' });
    }});
    return output;
  });
  // Resolve bags such as `helpers` accumulate previous factories' return values.
  // Report the ordered inputs, retaining expressions rather than guessing values.
  const accumulatorBags = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, 'web', file.file), 'utf8'), ast = parse(source);
    const initializers = [];
    walk.simple(ast, { VariableDeclarator(node) {
      if (node.id.type === 'Identifier' && node.init?.type === 'ObjectExpression') {
        initializers.push({ name: node.id.name, start: node.start,
          properties: node.init.properties.map(p => ({ key: key(p), expression: snippet(source, p) })) });
      }
    }});
    for (const init of initializers) {
      const calls = file.resolutions.filter(r => r.arguments.some(a => a.kind === 'Identifier' && a.expression === init.name));
      if (!calls.length) continue;
      accumulatorBags.push({ file: file.file, identifier: init.name, initialProperties: init.properties,
        orderedCalls: calls.map((r, i) => ({ module: r.name, line: r.line,
          precedingFactories: calls.slice(0, i).map(previous => previous.name) })),
        limitation: 'Syntactic candidate only; no proof of aliasing, mutation or factory return identity' });
    }
  }
  const external = new Map();
  const externalFiles = allFiles(path.join(root, 'tests/e2e'), '.mjs');
  for (const file of externalFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = parse(source, file.endsWith('.mjs') ? 'module' : 'script');
    const scope = eslintScope.analyze(ast, { ecmaVersion: 16, sourceType: file.endsWith('.mjs') ? 'module' : 'script' });
    const references = new Set(scope.globalScope.through.map(r => r.identifier.start));
    walk.simple(ast, { MemberExpression(node) {
      if (node.object.type !== 'Identifier') return;
      const rootName = node.object.name;
      if (['window', 'globalThis'].includes(rootName) && references.has(node.object.start)) {
        const name = prop(node) ?? '[dynamic]';
        const list = external.get(name) ?? [];
        list.push({ file: path.relative(root, file).replaceAll('\\', '/'), line: node.loc.start.line,
          expression: snippet(source, node) });
        external.set(name, list);
      }
    }});
    for (const ref of scope.globalScope.through) {
      if (/^(Mawe|MAWE_|Asr)/.test(ref.identifier.name) || declarationOwners.has(ref.identifier.name)) {
        const name = ref.identifier.name, list = external.get(name) ?? [];
        list.push({ file: path.relative(root, file).replaceAll('\\', '/'), line: ref.identifier.loc.start.line,
          expression: name }); external.set(name, list);
      }
    }
  }
  const summary = { editorFiles: files.length, allWebJs: files.length + extras.length,
    extraFiles: extras.length, registrations: registrations.length, resolutions: resolutions.length,
    categories: Object.fromEntries(['factory', 'wiring', 'template', 'facade-or-state']
      .map(c => [c, files.filter(f => f.category === c).length])),
    crossLexical: crossLexical.length, crossLexicalWrites: crossLexicalWrites.length,
    externalGlobalNames: external.size,
    dynamicRegisterNames: registrations.filter(r => !r.name).length,
    dynamicResolveNames: resolutions.filter(r => !r.name).length };
  return { summary, files, extras, registrations, resolutions, dependencyCandidates, crossLexical,
    crossLexicalWrites, accumulatorBags, namespaceReferences,
    externalBridges: Object.fromEntries([...external].sort(([a], [b]) => a.localeCompare(b))) };
}

export function convertFactory(source) {
  const info = inspectSource(source, 'prototype');
  if (!info.simpleFactory || info.hazards.length) throw new Error('Unsupported factory shape: requires review');
  const ast = parse(source), call = ast.body[0].expression, factory = call.arguments[1];
  if (!factory.id || factory.async || factory.generator) throw new Error('Unsupported factory signature');
  const code = source.slice(0, ast.body[0].start) + 'export '
    + snippet(source, factory) + '\n';
  parse(code, 'module');
  return { name: info.registrations[0].name, exportName: factory.id.name, code };
}

export async function loadEsbuild(root = ROOT) {
  // Deliberate reuse of the existing pilot dependency; no package installation.
  const candidates = [path.join(root, 'node_modules/esbuild/lib/main.js'),
    path.join(ROOT, '.qwen/worktrees/esm-pilot/node_modules/esbuild/lib/main.js')];
  const existing = candidates.find(file => fs.existsSync(file));
  if (!existing) throw new Error('esbuild is required; no gate is skipped');
  return import(pathToFileURL(existing).href);
}

export async function buildBundle(root, modules) {
  const esbuild = await loadEsbuild(root);
  const entry = modules.map((item, i) => `import { ${item.exportName} as factory${i} } from './${item.file}';`)
    .concat(modules.map((item, i) => `window.MAWE.register(${JSON.stringify(item.name)}, factory${i});`)).join('\n');
  const result = esbuild.buildSync({ absWorkingDir: path.resolve(root),
    stdin: { contents: entry, resolveDir: path.resolve(root, 'web'), loader: 'js' },
    bundle: true, format: 'iife', target: ['chrome120'], write: false, logLevel: 'silent',
    minifyWhitespace: true });
  return { entry: entry + '\n', code: result.outputFiles[0].text };
}

export async function applyBatch(root, batch = DEFAULT_BATCH) {
  if (path.resolve(root) === ROOT) throw new Error('Research codemod refuses the primary workspace');
  const marker = path.join(root, '.esm-mechanical-sandbox.json');
  if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, 'utf8')).purpose !== 'esm-mechanical-research') {
    throw new Error('Missing isolated research sandbox marker');
  }
  const manifest = readManifest(root), indices = batch.map(file => manifest.indexOf(file));
  if (!indices.length || indices.some((index, i) => index < 0 || (i && index !== indices[i - 1] + 1))) {
    throw new Error('Batch must be a contiguous manifest range; moving effects is forbidden');
  }
  const modules = batch.map(file => ({ file,
    ...convertFactory(fs.readFileSync(path.join(root, 'web', file), 'utf8')) }));
  const packageFile = path.join(root, 'web/package.json');
  if (fs.existsSync(packageFile)) throw new Error('Existing web/package.json needs review');
  // Browser classic-script interpretation is unaffected by Node's package scope.
  fs.writeFileSync(packageFile, json({ private: true, type: 'module' }));
  for (const module of modules) fs.writeFileSync(path.join(root, 'web', module.file), module.code);
  const { entry, code } = await buildBundle(root, modules);
  const bundle = 'editor/boot/esm-mechanical-bundle.js';
  fs.writeFileSync(path.join(root, 'web', bundle), code);
  const metadataDir = path.join(root, 'scripts/esm-mechanical');
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, 'batch.json'), json(modules.map(({ code, ...item }) => item)));
  fs.writeFileSync(path.join(metadataDir, 'entry.txt'), entry);
  const original = fs.readFileSync(path.join(root, 'web/editor-scripts.txt'), 'utf8');
  let first = true;
  const output = original.split('\n').flatMap(line => {
    if (!batch.includes(line.split('#')[0].trim())) return [line];
    if (!first) return [];
    first = false; return [bundle];
  }).join('\n');
  fs.writeFileSync(path.join(root, 'web/editor-scripts.txt'), output);
  // Make the existing VM helper consume the actual manifest bundle at this slot.
  const helper = path.join(root, 'tests/helpers/editor-module-loader.mjs');
  const helperSource = fs.readFileSync(helper, 'utf8');
  const anchor = "const files = manifest.filter(name => name === 'editor/boot/editor-runtime.js'";
  if (!helperSource.includes(anchor)) throw new Error('Unknown VM helper; requires review');
  fs.writeFileSync(helper, helperSource.replace(anchor,
    `const files = manifest.filter(name => name === '${bundle}' || name === 'editor/boot/editor-runtime.js'`));
  // Update the explicit production manifest contract, without weakening assertions.
  const assets = path.join(root, 'tests/test_editor_assets.py');
  let assetsSource = fs.readFileSync(assets, 'utf8');
  const expected = batch.map(file => `                "${file}",\n`).join('');
  if (!assetsSource.includes(expected)) throw new Error('Unknown asset contract; requires review');
  assetsSource = assetsSource.replace(expected, `                "${bundle}",\n`);
  fs.writeFileSync(assets, assetsSource);
  return { modules: modules.map(({ code, ...item }) => item), bundle, bytes: Buffer.byteLength(code) };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const [mode = 'inventory', root = ROOT, output] = process.argv.slice(2);
  if (mode === 'inventory') {
    const result = inventory(root);
    if (output) fs.writeFileSync(output, json(result));
    console.log(json(result.summary));
  } else if (mode === 'convert') console.log(json(await applyBatch(root)));
  else if (mode === 'check') {
    const modules = JSON.parse(fs.readFileSync(path.join(root, 'scripts/esm-mechanical/batch.json'), 'utf8'));
    const { code } = await buildBundle(root, modules);
    if (code !== fs.readFileSync(path.join(root, 'web/editor/boot/esm-mechanical-bundle.js'), 'utf8')) {
      throw new Error('Bundle is stale');
    }
    console.log('Bundle is fresh');
  } else throw new Error(`Unknown mode: ${mode}`);
}
