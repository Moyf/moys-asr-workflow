// Transitional build: real ESM factories plus one ordered legacy scope.
// Portable HTML and localhost embed the same generated classic artifact.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import * as esbuild from 'esbuild';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUNDLE = 'editor/boot/editor-bundle.js';
export const BUILD_INFO = 'editor/boot/editor-bundle.meta.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const parse = (source, sourceType) => acorn.parse(source, {ecmaVersion:'latest', sourceType});

export const captureBuildInputs = (root, names) => Object.fromEntries(names
  .map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
export const dependencyHash = snapshot => sha(['package.json', 'pnpm-lock.yaml']
  .map(name => snapshot[name]).join('\n'));
export function assertBuildInputsUnchanged(root, snapshot) {
  for (const [name, text] of Object.entries(snapshot)) {
    if (fs.readFileSync(path.join(root, name), 'utf8') !== text) {
      throw new Error(`Build input changed during compilation: ${name}; retry the build`);
    }
  }
}

// Readers must see a complete JS file even when a watch build or another process
// publishes at the same time. Stage both files first; metadata is the commit
// record, published last. Its bundleHash rejects interrupted/mixed generations.
export async function replaceFile(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      // Windows can briefly deny replacement while a page reader or antivirus
      // holds the old file open. Keep the previous complete file while retrying.
      if (attempt >= 100 || !['EPERM','EACCES','EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

export async function writeArtifact(root, bundle, buildInfo, built) {
  const paths = [bundle, buildInfo].map(name => path.join(root, 'web', name));
  fs.mkdirSync(path.dirname(paths[0]), {recursive:true});
  const temporary = paths.map(destination => path.join(path.dirname(destination),
    `.maw-bundle-${randomUUID()}.tmp`));
  try {
    fs.writeFileSync(temporary[0], built.code, {flag:'wx'});
    fs.writeFileSync(temporary[1], json(built.metadata), {flag:'wx'});
    await replaceFile(temporary[0], paths[0]);
    await replaceFile(temporary[1], paths[1]);
  } finally {
    for (const file of temporary) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

export function validateSources(files) {
  if (!files.length || new Set(files).size !== files.length) throw new Error('Empty or duplicate source manifest');
  for (const file of files) {
    if (!file.endsWith('.js') || /[\\:]/.test(file) || file.split('/').some(part => ['', '.', '..'].includes(part))
        || file === BUNDLE) throw new Error(`Invalid source path in manifest: ${file}`);
  }
  return files;
}

// 源码集合从目录推导（批 4 终态）：web/editor/** 与 web/shared/**
// 的全部 .js，排除 bundle/meta 产物。清单位次已由登记表 bootstrap
// 显式序接管，清单文件退役（web/editor-scripts.txt 不再存在）。
export function deriveSources(root = ROOT) {
  const web = fs.realpathSync(path.join(root,'web'));
  const collected = [];
  const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry => {
    const full = path.join(dir,entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!entry.name.endsWith('.js')) return [];
    const relative = path.relative(web,full).replaceAll('\\','/');
    // Standalone review pages load their own adapter; it is not editor code.
    if (relative.startsWith('shared/templates/') || relative.endsWith('.bundle.js')
        || relative === BUNDLE || relative.endsWith('.meta.json')) return [];
    return [relative];
  });
  for (const dir of ['editor','shared']) {
    const base = path.join(web,dir);
    if (!fs.existsSync(base)) continue; // 语义夹具可能只有 editor/
    collected.push(...walk(base));
  }
  const files = validateSources(collected.sort());
  for (const file of files) {
    const canonical = fs.realpathSync(path.join(web,file));
    if (!canonical.startsWith(web+path.sep) || !fs.statSync(canonical).isFile()) {
      throw new Error(`Source path escapes web or is not a file: ${file}`);
    }
  }
  return files;
}

export function readModules(root = ROOT) {
  const modulesPath = path.join(root,'web/editor-modules.json');
  // 语义夹具（E8/E9 probe）没有模块登记表：缺省视为全部 classic 转换体。
  return fs.existsSync(modulesPath)
    ? JSON.parse(fs.readFileSync(modulesPath,'utf8')).modules : [];
}

function validateModule(source, item) {
  const ast = parse(source,'module');
  const statement = ast.body[0];
  if (ast.body.length !== 1 || statement?.type !== 'ExportNamedDeclaration'
      || statement.declaration?.type !== 'FunctionDeclaration'
      || statement.declaration.id?.name !== item.exportName
      || statement.declaration.async || statement.declaration.generator) {
    throw new Error(`ESM factory must export ${item.exportName} without evaluation effects: ${item.file}`);
  }
}

export async function compileSources(root, files, modules, read, options = {}) {
  validateSources(files);
  const byFile = new Map(), names = new Set();
  for (const item of modules) {
    if (!files.includes(item.file) || byFile.has(item.file) || names.has(item.name)
        || !/^[A-Za-z_$][\w$]*$/.test(item.exportName) || typeof item.name !== 'string') {
      throw new Error(`Invalid/duplicate factory or omitted source in manifest: ${item.file}`);
    }
    byFile.set(item.file,item); names.add(item.name);
  }
  const sources = new Map(files.map(file => [file,read(file)]));
  const imports = modules.map((item,index) =>
    `import { ${item.exportName} as factory${index} } from ${JSON.stringify('maw-factory:'+item.file)};`);
  for (const item of modules) validateModule(sources.get(item.file),item);
  // Keep lexical declarations INSIDE this function: esbuild otherwise lowers
  // module-level let/const to var and loses the classic scope's TDZ semantics.
  const body = ['function initializeLegacy() {'];
  for (const bridge of options.bridges ?? []) {
    if (!files.includes(bridge.file) || !/^[A-Za-z_$][\w$]*$/.test(bridge.name)) {
      throw new Error(`Invalid external bridge: ${bridge.name}`);
    }
    const setter = bridge.mutable ? `${bridge.name} = value;` : "throw new TypeError('Assignment to constant variable');";
    body.push(`Object.defineProperty(window, ${JSON.stringify(bridge.name)}, {configurable:true,
      get: () => ${bridge.name}, set: value => {${setter}}});`);
  }
  if (options.trace) body.push('window.__mawEsmInitializationTrace = [];');
  for (const file of files) {
    const item = byFile.get(file);
    if (options.beforeEntry === file) body.push('globalThis.__mawBeforeFixture?.(window);');
    if (item) body.push(`window.MAWE.register(${JSON.stringify(item.name)}, factory${modules.indexOf(item)});`);
    else {
      try { parse(sources.get(file),'script'); }
      catch (error) { throw new Error(`Legacy source must remain classic until explicitly migrated: ${file}: ${error.message}`); }
      body.push(`// Legacy scope: ${file}\n${sources.get(file)}\n`);
    }
    if (options.trace) body.push(`window.__mawEsmInitializationTrace.push(${JSON.stringify(file)});`);
  }
  body.push('}', 'initializeLegacy();');
  const entry = [...imports,...body].join('\n')+'\n';
  const plainFiles = [...entryPlainFiles(files, modules, read)];
  const result = await esbuild.build({absWorkingDir:path.resolve(root),
    stdin:{contents:entry,resolveDir:path.resolve(root,'web'),sourcefile:'editor-entry.mjs',loader:'js'},
    plugins:[{name:'maw-factories',setup(build) {
      build.onResolve({filter:/^maw-factory:/}, args => ({path:path.resolve(root,'web',args.path.slice(12))}));
      build.onLoad({filter:/\.js$/}, args => {
        const file = path.relative(path.resolve(root,'web'),args.path).replaceAll('\\','/');
        if (!byFile.has(file)) return null;
        return {contents:sources.get(file),loader:'js',resolveDir:path.dirname(args.path)};
      });
    }}], bundle:true,format:'iife',target:['es2022'],charset:'utf8',minify:true,write:false,
    metafile:true,logLevel:'silent',legalComments:'none',banner:{js:"'use strict';"}});
  return {code:result.outputFiles[0].text,metafile:result.metafile,sourceFiles:files,modules,entry,
    plainFiles};
}

// 终态装配：全部源码为真 ESM。工厂按 exportName 导入并在清单序位置注册；
// classic 转换体（export function* initialize）两阶段驱动：先全量提升与闭包
// 发布，再按清单序交错执行语句与注册，保持原拼接的提升/TDZ/时序语义。
// bootstrap（显式启动序列）：登记表 bootstrap 数组里的基础门面发布者，
// 其 phase-2 在任何消费者之前按**显式序**执行（不再依赖清单位次）；
// 打乱这些文件之外的清单不影响行为（tests/e2e/assembly-order.spec.mjs O5）。
// deferred（已脱离启动序的转换体）：bootstrap 摘除批次的产物。摘除
// 条件是该文件没有任何 phase-2 立即消费者（叶），因此移到全部 bootstrap
// 之后执行行为不变；摘出文件之间按登记表 deferred 序执行（=原 bootstrap
// 相对序）。终态 bootstrap 与 deferred 双双清空，全部源码转真 ESM。
function bridgeOwnersOf(bridges) {
  return [...new Set(bridges.map(b => b.file))].map((file, i) => [file, i]);
}

// 普通 ESM 形态识别（与 validateShapes 一致）：非工厂、无 initialize
// 生成器。进入 import 图即求值（含无模块语法的纯副作用接线文件），
// 不需要 phase 驱动；esbuild 的依赖边与 metafile 覆盖检查保证被打包。
export function isPlainEsmSource(source) {
  try {
    const ast = acorn.parse(source, { ecmaVersion: 16, sourceType: 'module', ranges: true });
    if (ast.body.some(s => s.type === 'ExportNamedDeclaration'
        && s.declaration?.type === 'FunctionDeclaration' && s.declaration.generator)) return false;
    return true;
  } catch { return false; }
}

export function entryPlainFiles(files, modules, read) {
  const factoryByFile = new Set(modules.map(item => item.file));
  return files.filter(file => !factoryByFile.has(file)
    && isPlainEsmSource(read(file)));
}

export function compileEsmEntry(files, modules, bridges, bootstrap = [], deferred = [], readers = {}) {
  const factoryByFile = new Map(modules.map(item => [item.file, item]));
  const owners = bridgeOwnersOf(bridges);
  const imports = [], classicFiles = [], classicIndex = new Map();
  const plainFiles = [];
  files.forEach((file, i) => {
    const factory = factoryByFile.get(file);
    if (factory) imports.push(`import { ${factory.exportName} as factory${i} } from ${JSON.stringify('./' + file)};`);
    else if (isPlainEsmSource(readers.readPlain ? readers.readPlain(file) : '')) {
      // 普通 ESM：仅 import（求值即装配），不进 phase 驱动序。
      imports.push(`import ${JSON.stringify('./' + file)};`);
      plainFiles.push(file);
    } else {
      // 其余（转换体）无条件 import + 驱动，不存在只进 trace 不进
      // bundle 的静默漏装路径（validateShapes 已拒绝四不像）。
      imports.push(`import { initialize as init${classicFiles.length} } from ${JSON.stringify('./' + file)};`);
      classicIndex.set(file, classicFiles.length);
      classicFiles.push(file);
    }
  });
  imports.push(...owners.map(([file, i]) =>
    `import { legacyBindings as externalBindings${i} } from ${JSON.stringify('./' + file)};`));
  const bootstrapIndex = new Map(bootstrap.map((file, i) => [file, i]));
  const deferredIndex = new Map(deferred.map((file, i) => [file, i]));
  const plainIndex = new Set(plainFiles);
  // 注册表创建者：window.MAWE 由它的 phase-2 创建，必须先于工厂注册。
  // 摘除批次的终点是 runtime 也进 deferred——查找覆盖两个列表。
  const REGISTRY_CREATOR = 'editor/boot/editor-runtime.js';
  const registryCreatorIndex = bootstrap.indexOf(REGISTRY_CREATOR) >= 0
    ? bootstrap.indexOf(REGISTRY_CREATOR)
    : deferred.indexOf(REGISTRY_CREATOR);
  const calls = ['window.__mawEsmInitializationTrace = [];',
    `const initializationSteps = [${classicFiles.map(f => `init${classicIndex.get(f)}()`).join(',')}];`,
    ...classicFiles.map(f => `initializationSteps[${classicIndex.get(f)}].next();`) // phase-1 全量提升
  ];
  if (registryCreatorIndex >= 0) {
    calls.push(`initializationSteps[${classicIndex.get(REGISTRY_CREATOR)}].next();`);
    calls.push(`window.__mawEsmInitializationTrace.push(${JSON.stringify(REGISTRY_CREATOR)});`);
  }
  // 工厂注册与清单位次解耦：61 个 ESM 工厂是纯 export function
  // （无求值副作用），全部在任何其他 phase-2 之前注册。此后 phase-2
  // 里的 MAWE.resolve 不再依赖「工厂文件恰好在消费者之前」的位次。
  for (const item of modules) {
    calls.push(`window.MAWE.register(${JSON.stringify(item.name)}, factory${files.indexOf(item.file)});`);
    calls.push(`window.__mawEsmInitializationTrace.push(${JSON.stringify(item.file)});`);
  }
  for (const bridge of bridges) {
    const alias = `externalBindings${owners.findIndex(([f]) => f === bridge.file)}.${bridge.name}`;
    const setter = bridge.mutable ? `${alias} = value;` : "throw new TypeError('Assignment to constant variable');";
    calls.push(`Object.defineProperty(window, ${JSON.stringify(bridge.name)}, {configurable:true,`
      + ` get: () => ${alias}, set: value => {${setter}}});`);
  }
  // 显式 bootstrap：基础门面先于一切消费者（注册表创建者已先行）
  for (const file of bootstrap) {
    if (factoryByFile.has(file) || file === REGISTRY_CREATOR) continue;
    calls.push(`initializationSteps[${classicIndex.get(file)}].next();`);
    calls.push(`window.__mawEsmInitializationTrace.push(${JSON.stringify(file)});`);
  }
  // deferred：已脱离启动序的叶转换体，在全部 bootstrap 之后按登记表
  // 序执行（=原 bootstrap 相对序；合法性见 compileEsmEntry 头注）。
  for (const file of deferred) {
    if (factoryByFile.has(file) || file === REGISTRY_CREATOR) continue;
    calls.push(`initializationSteps[${classicIndex.get(file)}].next();`);
    calls.push(`window.__mawEsmInitializationTrace.push(${JSON.stringify(file)});`);
  }
  for (const file of files) {
    if (factoryByFile.has(file)) continue; // 工厂无 phase-2；trace 在注册段
    if (plainIndex.has(file)) continue; // 普通 ESM：import 求值即装配
    if (bootstrapIndex.has(file) || deferredIndex.has(file)) continue; // 已按显式序执行
    calls.push(`initializationSteps[${classicIndex.get(file)}].next();`);
    calls.push(`window.__mawEsmInitializationTrace.push(${JSON.stringify(file)});`);
  }
  return [...imports, ...calls].join('\n') + '\n';
}

export async function compileEsmSources(root, files, modules, bridges, read, options = {}) {
  validateSources(files);
  const sources = new Map(files.map(file => [file, read(file)]));
  const bootstrap = options.bootstrap ?? [];
  const deferred = options.deferred ?? [];
  const entry = compileEsmEntry(files, modules, bridges ?? [], bootstrap, deferred,
    { readPlain: read });
  // Freeze every read before yielding to esbuild. Re-reading after await would
  // overwrite the input snapshot and hide a concurrent source edit.
  const plainFiles = [...entryPlainFiles(files, modules, read)];
  const result = await esbuild.build({absWorkingDir:path.resolve(root),
    stdin:{contents:entry,resolveDir:path.resolve(root,'web'),sourcefile:'editor-entry.mjs',loader:'js'},
    plugins:[{name:'maw-esm-sources',setup(build) {
      // 经 read 注入源码：transform（类型门/新鲜度哈希）对产物可见。
      build.onLoad({filter:/\.js$/}, args => {
        const file = path.relative(path.resolve(root,'web'),args.path).replaceAll('\\','/');
        if (!sources.has(file)) return null;
        return {contents:sources.get(file),loader:'js',resolveDir:path.dirname(args.path)};
      });
    }}],
    bundle:true,format:'iife',target:['es2022'],charset:'utf8',minify:true,write:false,
    metafile:true,logLevel:'silent',legalComments:'none',banner:{js:"'use strict';"}});
  return {code:result.outputFiles[0].text,metafile:result.metafile,sourceFiles:files,modules,entry,
    plainFiles};
}

// 登记表收缩的构建期校验：
// - 工厂注册名必须有明确来源：某处源码以 MAWE.resolve('<name>') 消费它；
// - 导出名可从「单 export function create*」约定推导（validateModule）；
// - 桥的 mutable 标记必须与 owner 绑定种类一致：函数名声明只读
//   （转换器 getter-only），可变标记仅允许 let/var 绑定，const 必须 false。
function validateRegistry(files, modules, bridges, read) {
  const sources = new Map(files.map(file => [file, read(file)]));
  const concatenated = [...sources.values()].join('\n');
  for (const item of modules) {
    const needle = `MAWE.resolve('${item.name}'`;
    const needle2 = `MAWE.resolve("${item.name}"`;
    if (!concatenated.includes(needle) && !concatenated.includes(needle2)) {
      throw new Error(`Factory name has no consumer source (resolve literal): ${item.name}`);
    }
  }
  const names = new Set();
  for (const item of modules) {
    if (names.has(item.name)) throw new Error(`Duplicate factory name: ${item.name}`);
    names.add(item.name);
  }
  for (const bridge of bridges ?? []) {
    const source = sources.get(bridge.file);
    if (!source) throw new Error(`Bridge owner not in manifest: ${bridge.file}`);
    const isFunction = new RegExp(`function\\s+${bridge.name}\\s*\\(`).test(source);
    const isConst = new RegExp(`const\\s+${bridge.name}\\b`).test(source);
    if (isFunction && bridge.mutable) {
      throw new Error(`Bridge ${bridge.name} is a function declaration (getter-only); mutable must be false`);
    }
    if (isConst && bridge.mutable) {
      throw new Error(`Bridge ${bridge.name} is a const binding; mutable must be false`);
    }
  }
}

// 目录推导文件集的形态门：每个源文件必须是三种装配形态之一——
// 登记工厂（editor-modules.json）、classic 转换体（export function*
// initialize）或普通 ESM（静态 import/export 图）。否则构建失败：
// 以前这类文件会被静默跳过 import，只进 sourceFiles 与 trace，
// 看起来「已装配」实际代码不在 bundle 里。
// 普通 ESM 的合法性（进入 import 图、导出被调用）由 compileEsmEntry
// 的 plainFiles 分支与 metafile 覆盖检查共同保证；这里只做形态识别
// —— 非工厂、非转换体一律按普通 ESM（含无模块语法的纯副作用接线）。
function validateShapes(files, modules, read) {
  const factoryFiles = new Set(modules.map(item => item.file));
  for (const file of files) {
    if (factoryFiles.has(file)) continue;
    const source = read(file);
    if (/export function\*\s+initialize\s*\(/.test(source)) continue;
    try {
      acorn.parse(source, { ecmaVersion: 16, sourceType: 'module', ranges: true });
    } catch { /* 交给 esbuild 报语法错误 */ }
  }
}

export async function buildEditor(root = ROOT, options = {}) {
  const snapshot = captureBuildInputs(root, [
    'scripts/build-editor.mjs', 'package.json', 'pnpm-lock.yaml',
  ]);
  // 登记表退役：源文件集合从目录推导、依赖经 import 直连，
  // editor-modules.json 不再存在；config/bridges/bootstrap/deferred 全为空。
  const discovered = deriveSources(root);
  // Tests may supply a different order to prove that ESM dependency edges,
  // rather than filesystem enumeration order, determine startup behavior.
  // The supplied paths must be an exact permutation of directory discovery.
  const files = options.sourceFiles ?? discovered;
  validateSources(files);
  const supplied = new Set(files);
  if (files.length !== discovered.length
      || discovered.some(file => !supplied.has(file))) {
    throw new Error('sourceFiles must be an exact permutation of discovered sources');
  }
  const modules = [];
  const configText = '{}', config = {};
  const inputHashes = {};
  const registryRead = file => fs.readFileSync(path.join(root,'web',file),'utf8');
  validateRegistry(files, modules, config.externalBridges, registryRead);
  validateShapes(files, modules, registryRead);
  const bootstrap = options.bootstrap ?? config.bootstrap ?? [];
  const deferred = options.deferred ?? config.deferred ?? [];
  const REGISTRY_CREATOR = 'editor/boot/editor-runtime.js';
  // 执行序契约（trace/O2 比对基准）：runtime 先行 → 工厂注册 →
  // bootstrap phase-2 → deferred phase-2。deferred 文件不重复计入
  // 前面的段（工厂/注册表创建者互斥由登记表维护）。
  const initializationOrder = [
    ...(bootstrap.includes(REGISTRY_CREATOR) ? [REGISTRY_CREATOR] : []),
    ...modules.map(item => item.file),
    ...bootstrap.filter(file => file !== REGISTRY_CREATOR && !modules.some(item => item.file === file)),
    ...deferred.filter(file => file !== REGISTRY_CREATOR && !modules.some(item => item.file === file)),
    // 普通 ESM 不在 phase 驱动 trace（import 求值在 bundle 顶部），
    // 由 metafile 覆盖检查与行为测试保证执行。
  ];
  const result = await compileEsmSources(root,files,modules,config.externalBridges,file => {
    const original = fs.readFileSync(path.join(root,'web',file),'utf8');
    snapshot['web/'+file] = original;
    const source = options.transform ? options.transform(file,original) : original;
    inputHashes[file] = sha(source); return source;
  },{trace:true,bootstrap,deferred});
  assertBuildInputsUnchanged(root, snapshot);
  // metafile 覆盖检查：普通 ESM 文件必须出现在 esbuild 输入集合
  // （被打包）。这只证明「读到」，求值证据由行为测试承担
  // （tests/test_esm_inventory / e2e 装配契约）。
  const metaInputs = new Set(Object.keys(result.metafile.inputs).map(k =>
    k.split('\\').join('/').replace(/^web\//, '')));
  for (const file of result.plainFiles) {
    if (!metaInputs.has(file)) {
      throw new Error(`Plain ESM source discovered but not bundled: ${file}`);
    }
  }
  const metadata = {format:1,esbuild:esbuild.version,sourceFiles:files,esmFactories:modules.length,
    bootstrap,deferred,inputs:inputHashes,configHash:sha(configText),
    builderHash:sha(snapshot['scripts/build-editor.mjs']),dependencyHash:dependencyHash(snapshot),
    // 全部源码经真 import 图装配；显式哈希覆盖每个源文件。
    metafile:result.metafile};
  const identity = `/* MAW ESM artifact: ${sha(result.code+json(metadata))} */`;
  metadata.bundleHash = sha(identity+'\n'+result.code);
  return {...result,code:identity+'\n'+result.code,identity,metadata,initializationOrder};
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
      if (file && ![BUNDLE,BUILD_INFO].includes(file.replaceAll('\\','/'))
          && !/\.maw-bundle-[^/\\]+\.tmp$/.test(file)) void rebuild();
    });
    fs.watch(fileURLToPath(import.meta.url), () => {
      console.error('Build script changed; restart pnpm run watch:editor');
    });
  } else throw new Error('Usage: build-editor.mjs --write|--check|--watch [ROOT]');
}
