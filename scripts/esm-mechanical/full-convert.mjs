// Isolated research only: retain private IIFEs, export factories, and wire shared
// lexical names through ESM imports of live accessors. Initialization is explicit.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import * as eslintScope from 'eslint-scope';
import { unresolvedRefs } from '../refactor-tools/scope-core.mjs';
import { convertFactory, readManifest } from './research.mjs';

function declarations(ast, writes) {
  return ast.body.flatMap(node => {
    if (node.type === 'VariableDeclaration') return node.declarations.map(decl => {
      if (decl.id.type !== 'Identifier') throw new Error('Top-level destructuring requires a separate conversion rule');
      return { name: decl.id.name, mutable: node.kind !== 'const', kind: node.kind };
    });
    // 函数声明的绑定不可被赋值（共享消费者从未写函数名），只发布
    // getter；这同时消除 TS2630「函数名 setter 内自赋值」族诊断。
    if (node.type === 'FunctionDeclaration') return [{ name: node.id.name, mutable: false, kind: 'function' }];
    if (node.type === 'ClassDeclaration') throw new Error('Top-level class requires review');
    return [];
  });
}

function findFunctionWriteViolation(sources) {
  // getter-only 发布的安全性条件：任何 classic 文件对他文件声明的
  // 函数名的写入必须不存在（文件内写不影响访问器语义——绑定本身
  // 仍可变，但共享面只读）。判断依据 eslint-scope 的写入引用，
  // 不用文本启发式（比较运算符也会含「=」）。
  const functionNames = new Set(sources.filter((item) => item.kind === 'classic')
    .flatMap((item) => item.declarations.filter((d) => d.kind === 'function').map((d) => d.name)));
  if (!functionNames.size) return null;
  for (const item of sources) {
    if (item.kind !== 'classic' || !item.ast) continue;
    const scope = eslintScope.analyze(item.ast, { ecmaVersion: 16, sourceType: 'script', ignoreEval: true });
    for (const ref of scope.globalScope.through) {
      if (functionNames.has(ref.identifier.name) && ref.isWrite()) {
        return { file: item.file, name: ref.identifier.name };
      }
    }
  }
  return null;
}

export async function convertAll(root, { rewriteShared = true } = {}) {
  const marker = path.join(root, '.esm-mechanical-sandbox.json');
  if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, 'utf8')).purpose !== 'esm-mechanical-research') {
    throw new Error('Conversion is restricted to an isolated research copy');
  }
  const files = readManifest(root);
  // 工厂时代的适配：清单里已有真 ESM 工厂（export function create*，注册由构建
  // 入口按清单序注入）。它们不参与 classic 词法共享（其绑定不裸漏），原样透传。
  // E8/E9 等语义夹具没有 editor-modules.json：缺省视为全部 classic。
  const modulesPath = path.join(root, 'web/editor-modules.json');
  const modulesConfig = fs.existsSync(modulesPath)
    ? JSON.parse(fs.readFileSync(modulesPath, 'utf8')) : { modules: [] };
  const factoryByFile = new Map(modulesConfig.modules.map(item => [item.file, item]));
  const sources = files.map(file => {
    const source = fs.readFileSync(path.join(root, 'web', file), 'utf8');
    if (factoryByFile.has(file)) return { file, source, kind: 'esm', ast: null, declarations: [] };
    const ast = acorn.parse(source, { ecmaVersion: 16, sourceType: 'script', ranges: true });
    return { file, source, kind: 'classic', ast, declarations: declarations(ast) };
  });
  const owners = new Map();
  for (const item of sources) for (const declaration of item.declarations) {
    if (owners.has(declaration.name)) throw new Error(`Duplicate shared binding: ${declaration.name}`);
    owners.set(declaration.name, { file: item.file, ...declaration });
  }
  const consumed = new Set(), connections = [];
  const externalBridges = new Map();
  const writeViolation = findFunctionWriteViolation(sources);
  if (writeViolation) {
    throw new Error(`Function shared binding has a write point: ${writeViolation.name} in ${writeViolation.file}`
      + ' (getter-only publishing requires assignment-free function names)');
  }
  const collectFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? collectFiles(path.join(dir, entry.name))
      : entry.name.endsWith('.mjs') ? [path.join(dir, entry.name)] : []) : [];
  const externalFiles = collectFiles(path.join(root, 'tests/e2e'));
  for (const file of externalFiles) {
    const sourceType = file.endsWith('.mjs') ? 'module' : 'script';
    const ast = acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 16, sourceType, ranges: true });
    const scope = eslintScope.analyze(ast, { ecmaVersion: 16, sourceType });
    for (const ref of scope.globalScope.through) if (owners.has(ref.identifier.name)) {
      const owner = owners.get(ref.identifier.name);
      externalBridges.set(owner.name, owner); consumed.add(owner.name);
    }
  }
  const refsByFile = new Map();
  for (const item of sources) {
    if (item.kind === 'esm') { refsByFile.set(item.file, []); continue; }
    const refs = unresolvedRefs(item.source).filter(ref => owners.has(ref.name));
    refsByFile.set(item.file, refs);
    for (const ref of refs) {
      consumed.add(ref.name);
      connections.push({ consumer: item.file, provider: owners.get(ref.name).file, name: ref.name });
    }
  }
  const outputs = new Map(), records = [];
  for (const item of sources) {
    if (item.kind === 'esm') {
      // 真 ESM 工厂：原样透传；注册由构建入口按清单序注入（保持现有 interleaving）。
      outputs.set(item.file, item.source);
      records.push({ file: item.file, factory: true, passthrough: true, importedBindings: 0,
        providers: [], publishedBindings: [] });
      continue;
    }
    const refs = refsByFile.get(item.file);
    const providerFiles = [...new Set(refs.map(ref => owners.get(ref.name).file))];
    const aliases = new Map(providerFiles.map((file, i) => [file, `__mawImportedBindings${i}`]));
    if (/\b(?:legacyBindings|__mawImportedBindings\d+|initialize)\b/.test(item.source)) {
      // Existing private functions named initialize are allowed; generated exports
      // live outside the preserved IIFE. Top-level conflicts are rejected below.
      if (item.declarations.some(d => d.name === 'initialize' || d.name === 'legacyBindings'
        || /^__mawImportedBindings\d+$/.test(d.name))) throw new Error('Generated binding collision');
    }
    let source = item.source;
    if (rewriteShared) for (const ref of [...refs].reverse()) {
      const replacement = `${aliases.get(owners.get(ref.name).file)}.${ref.name}`;
      source = source.slice(0, ref.start) + (ref.shorthand ? `${ref.name}: ${replacement}` : replacement) + source.slice(ref.end);
    }
    const imports = rewriteShared ? providerFiles.map(file => {
      let relative = path.posix.relative(path.posix.dirname(item.file), file);
      if (!relative.startsWith('.')) relative = './' + relative;
      return `import { legacyBindings as ${aliases.get(file)} } from ${JSON.stringify(relative)};`;
    }).join('\n') : '';
    const published = item.declarations.filter(d => consumed.has(d.name));
    const accessor = published.length ? `export let legacyBindings;\n` : '';
    const installAccessors = published.length ? `legacyBindings = Object.freeze({\n`
      + published.map(d => `get ${d.name}() { return ${d.name}; }`
        + (d.mutable ? `, set ${d.name}(value) { ${d.name} = value; }` : '')).join(',\n') + '\n});\n' : '';
    let body;
    let factory;
    try { factory = convertFactory(source); } catch (error) {
      if (!/Unsupported factory/.test(error.message)) throw error;
    }
    if (factory) {
      body = imports + '\n' + factory.code + '\nexport function* initialize() {\nyield;\n'
        + `window.MAWE.register(${JSON.stringify(factory.name)}, ${factory.exportName});\n}\n`;
    } else {
      // Phase one instantiates declarations and publishes closures, then yields.
      // Phase two executes statements in the original manifest order. This keeps
      // function/var hoisting and lexical TDZ even across forward references.
      body = imports + '\n' + accessor + 'export function* initialize() {\n'
        + installAccessors + 'yield;\n' + source + '\n}\n';
    }
    acorn.parse(body, { ecmaVersion: 16, sourceType: 'module' });
    outputs.set(item.file, body);
    records.push({ file: item.file, factory: Boolean(factory), importedBindings: rewriteShared ? refs.length : 0,
      providers: rewriteShared ? providerFiles : [], publishedBindings: published });
  }
  // No mutation before every output parses successfully.
  fs.writeFileSync(path.join(root, 'web/editor-sources.txt'), files.join('\n') + '\n');
  for (const [file, code] of outputs) fs.writeFileSync(path.join(root, 'web', file), code);
  fs.writeFileSync(path.join(root, 'web/package.json'), '{"private":true,"type":"module"}\n');
  fs.writeFileSync(path.join(root, 'full-conversion.json'), JSON.stringify({ rewriteShared, records, connections,
    externalBridges: [...externalBridges.values()] }, null, 2) + '\n');
  return { files: files.length, factoryExports: records.filter(r => r.factory).length,
    crossFileReferences: connections.length, rewriteShared };
}

export function adaptConsumers(root) {
  const marker = path.join(root, '.esm-mechanical-sandbox.json');
  if (!fs.existsSync(marker)) throw new Error('Missing isolated research marker');
  const pythonPath = path.join(root, 'edit.py');
  const before = fs.readFileSync(pythonPath, 'utf8');
  const original = 'return "\\n\\n".join(read_web_asset(name).rstrip() for name in read_editor_script_manifest())';
  // 消费端切 bundle 已在上游完成（bundle 退 Git 批次），此处幂等：已切则跳过。
  if (before.includes(original)) {
    fs.writeFileSync(pythonPath, before.replace(original,
      'return read_web_asset("editor/boot/editor-bundle.js").rstrip()'));
  } else if (!before.includes('read_web_asset("editor/boot/editor-bundle.js")')) {
    throw new Error('Unknown Python assembly shape');
  }
  // Keep source manifest for research audit; consumers no longer use it.
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const [rootArg, ...modes] = process.argv.slice(2);
  if (!rootArg) throw new Error('Usage: full-convert.mjs ROOT [--naive]');
  const root = path.resolve(rootArg);
  console.log(JSON.stringify(await convertAll(root, { rewriteShared: !modes.includes('--naive') })));
  if (!modes.includes('--sources-only')) adaptConsumers(root);
}
