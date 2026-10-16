// 编辑器模块测试加载器：把 classic/ESM 源按生产同构的入口装配成 bundle 并在 vm 中执行。
//
// 单一事实源：源文件集合从 web/editor+web/shared 目录推导
// （与 build-editor.deriveSources 同口径，清单已退役），闭包只从
// 源码 import 语句推导（转换体的 provider 边 = import 边）。不依赖
// 任何转换期副产物（full-conversion.json / editor-sources.txt）。
//
// 语义与生产装配一致（scripts/build-editor.mjs compileEsmEntry）：
//   工厂文件按 exportName 导入并在清单位注册；转换体（export function*
//   initialize）两阶段驱动——第一轮全体发布闭包，第二轮按清单序交错执行
//   语句与注册。provider 的 phase2 副作用（如 MAWE.resolve 挂门面）必须
//   执行，否则消费方面对空门面——所以没有「只跑目标」的捷径；需要完整
//   启动链的断言请走浏览器测试，不要在这里堆假 DOM。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import * as acorn from 'acorn';
import { isPlainEsmSource } from '../../scripts/build-editor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'web');
// 与 build-editor.deriveSources 同口径：editor/ 与 shared/ 全部 .js，
// 排除 bundle 产物，排序保证确定性。
const manifest = ['editor', 'shared'].flatMap((base) =>
  (function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!entry.name.endsWith('.js')) return [];
      return [path.relative(web, full).replaceAll('\\', '/')];
    });
  })(path.join(web, base))
).filter((file) => !file.startsWith('shared/templates/') && !file.endsWith('.bundle.js')).sort();
// 登记表退役：bootstrap/deferred 保序表不再存在，位次全按字母序。
const modulesConfig = { modules: [], bootstrap: [], deferred: [] };
// phase-2 位次以登记表 bootstrap 显式序为准（清单退役）；
// deferred（已脱离启动序的叶转换体）排在 bootstrap 之后，
// 其余文件（当前应只有 bundle 产物）排最后（字母序）。
const bootstrapOrder = modulesConfig.bootstrap ?? [];
const deferredOrder = modulesConfig.deferred ?? [];
const manifestIndex = new Map([
  ...bootstrapOrder.map((file, i) => [file, i]),
  ...deferredOrder.map((file, i) => [file, bootstrapOrder.length + i]),
  ...manifest.filter((file) => !bootstrapOrder.includes(file) && !deferredOrder.includes(file))
    .map((file, i) => [file, bootstrapOrder.length + deferredOrder.length + i]),
]);
const factoryByFile = new Map(modulesConfig.modules.map((item) => [item.file, item]));

// provider 边：文件源码里的相对 import（转换体与工厂都适用）。解析失败或
// 目标不在清单内（如 ./boot.js 之类的非清单路径）忽略。
const importGraphCache = new Map();
function importTargets(file) {
  if (importGraphCache.has(file)) return importGraphCache.get(file);
  const targets = new Set();
  try {
    const source = fs.readFileSync(path.join(web, file), 'utf8');
    const ast = acorn.parse(source, {
      ecmaVersion: 16, sourceType: file.endsWith('.mjs') ? 'module' : 'module', locations: false,
    });
    for (const statement of ast.body) {
      if (statement.type === 'ImportDeclaration' && statement.source.type === 'Literal'
        && typeof statement.source.value === 'string' && statement.source.value.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), statement.source.value));
        if (manifestIndex.has(target)) targets.add(target);
      }
    }
  } catch { /* 非 ESM 源（classic 或夹具自建）：无 import 边 */ }
  importGraphCache.set(file, targets);
  return targets;
}

// 依赖集合：直接 import 边（转换体的 provider 即 import 源），按清单序输出。
// 不做递归拉深——传递 provider 由 esbuild 照常打进 bundle 但不执行 initialize，
// 其 legacyBindings 只在被直接依赖的路径求值时访问；递归闭包会把 wiring 层的
// 事件监听语句拉进 phase2 执行，正是假 DOM 膨胀的源头（copy 实测回归 +21）。
export function fixtureClosure(file) {
  return [file, ...importTargets(file)]
    .filter((value, index, self) => self.indexOf(value) === index)
    .sort((a, b) => manifestIndex.get(a) - manifestIndex.get(b));
}

const cache = new Map();
// 模板占位符：生产由 serve.py/edit.py 渲染注入；测试 bundle 给中性 JSON 字面量。
const DEFINES = {
  __DATA_JSON__: '{"segments":[]}',
  __FILENAME_BASE_JSON__: '""',
  __STICKERS_JSON__: '[]',
  __STICKER_ROOT_JSON__: '""',
  __STICKER_URL_PREFIX_JSON__: '""',
  __SERVER_CONFIG_JSON__: '{}',
  __NINJA_SFX_BASE_URL_JSON__: '""',
  __UI_LANGUAGE_JSON__: '"zh"',
};

function compile(files, entry, { phase2All = true } = {}) {
  const key = `${files.join(',')}|${entry}|${phase2All ? 'all' : 'target'}`;
  if (cache.has(key)) return cache.get(key);
  const imports = [], classicFiles = [], classicIndex = new Map();
  const plainFiles = [];
  files.forEach((file, i) => {
    const factory = factoryByFile.get(file);
    if (factory) { imports.push(`import { ${factory.exportName} as factory${i} } from ${JSON.stringify('./' + file)};`); return; }
    const source = fs.readFileSync(path.join(web, file), 'utf8');
    if (isPlainEsmSource(source)) {
      // 普通 ESM：side-effect import，门面在 import 期发布
      imports.push(`import ${JSON.stringify('./' + file)};`);
      plainFiles.push(file);
      return;
    }
    imports.push(`import { initialize as init${classicFiles.length} } from ${JSON.stringify('./' + file)};`);
    classicIndex.set(file, classicFiles.length);
    classicFiles.push(file);
  });
// 隐式 window 契约门面：生产里由清单中更早的模块挂上（如 MaweFloatingPanel
// 由 markers/ass-frame 挂、dom 面板在其后按裸名引用）。单元夹具的闭包不含
// 挂载方时，入口预挂中性桩（以源码字面量嵌入 bundle）：测试自备的顶层同名
// stub 优先；束内真实挂载是无条件赋值，覆盖预挂——时序与生产一致。
const IMPLICIT_FACADE_SOURCE = {
  MaweShortcuts: '(() => ({ showShortcutBlocked() {}, interceptedSpace: false, PLAYBACK_RATE_MIN: 0.25, PLAYBACK_RATE_MAX: 4, fmtRate: (v) => String(v) }))()',
  MaweBoot: '(() => ({ DATA: { segments: [], preview: {}, workspace: {} }, SERVER_CONFIG: {}, PROJECT_NAME: "", FILENAME_BASE: "", maweDebug() {}, maweDomContractCheck() {} }))()',
  MaweMultiSubtitleCore: "({ MULTI: 'main', getActiveExtensionTrack: () => ({ segments: [] }),"
    + " getExtensionSubtitleSplitMode: () => 'word', getMainSubtitleSplitMode: () => 'word',"
    + " getMultiSubtitleState: () => ({ enabled: false, tracks: [] }),"
    + " normalizeMultiSubtitleState: (state) => state ?? { enabled: false, tracks: [] } })",
  MaweDom: "(() => { const store = new Map(); const el = () => ({ style: { setProperty() {} },"
    + " classList: { add() {}, remove() {}, toggle() {}, contains: () => false },"
    + " dataset: {}, addEventListener() {}, removeEventListener() {}, appendChild() {}, append() {},"
    + " removeChild() {}, querySelector: () => null, querySelectorAll: () => [], textContent: '', value: '',"
    + " hidden: false, disabled: false, checked: false, title: '',"
    + " getBoundingClientRect: () => ({ width: 0, height: 0 }) });"
    + " return new Proxy({}, { get: (_t, k) => { if (!store.has(k)) store.set(k, el()); return store.get(k); } }); })()",
  MaweFloatingPanel: "(() => { const el = () => ({ style: { setProperty() {} },"
    + " classList: { add() {}, remove() {}, toggle() {}, contains: () => false },"
    + " dataset: {}, addEventListener() {}, removeEventListener() {}, appendChild() {}, append() {},"
    + " removeChild() {}, querySelector: () => null, querySelectorAll: () => [], textContent: '', value: '',"
    + " hidden: false, disabled: false, getBoundingClientRect: () => ({ width: 0, height: 0 }) });"
    + " return { createFloatingPanel: () => ({ root: el(), card: el(), body: el(), titleBar: el(), overlay: el(), show() {}, hide() {} }),"
    + " bindFloatingSurfaceActivation() {}, syncFloatingSurfaceLayers() {}, bringFloatingSurfaceToFront() {},"
    + " floatingSurfaceIsOpen: () => false, floatingSurfaceStack: [], autoMergeFloatingPanel() {},"
    + " subtitleExtendFloatingPanel: () => ({ titleBar: el(), body: el(), card: el(), overlay: el() }) }; })()",
};

// 浏览器语义对齐：window === globalThis。测试把 stub 挂在 sandbox.window 上，
// 装配体（及模块自身 `global.MaweX = ...` 挂载）都假定两者同一。
// 放进 banner（bundle 最前）：普通 ESM 的 import 求值先于 stdin 语句，
// 模块顶层的 defineProperty(window,...) 必须在 window 别名建立之后执行，
// 否则 getter 会挂到测试 sandbox.window 而装配体读的是别名后的 globalThis。
// beforeEntry（__mawBeforeFixture）同样在 banner 调用——「测试自备的
// 同名 stub 优先于模块门面」的语义要求 stub 在一切模块求值（含 import）
// 之前挂上；旧 classic 场景在 entry next 前调用，两者取更早者且各调一次。
const IDENTITY_SOURCE = '(() => { if (typeof globalThis.queueMicrotask !== "function") globalThis.queueMicrotask = (fn) => Promise.resolve().then(fn); if (typeof globalThis.URLSearchParams !== "function" && typeof globalThis.__mawSearchParams === "function") globalThis.URLSearchParams = globalThis.__mawSearchParams; const w = globalThis.window;'
  + ' if (w && w !== globalThis) { for (const k of Object.getOwnPropertyNames(w))'
  + ' if (!(k in globalThis)) { try { globalThis[k] = w[k]; } catch { /* getter-only */ } }'
  + ' try { globalThis.window = globalThis; } catch { /* read-only elsewhere */ } }'
  + Object.entries(IMPLICIT_FACADE_SOURCE).map(([name, source]) =>
      ` if (!('${name}' in globalThis)) globalThis.${name} = ${source};`).join('')
  + ' if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};'
  + ' if (typeof globalThis.removeEventListener !== "function") globalThis.removeEventListener = () => {};'
  + ' if (!Array.isArray(globalThis.ASR_EDITOR_PALETTE) || !globalThis.ASR_EDITOR_PALETTE.length)'
  + ' globalThis.ASR_EDITOR_PALETTE = [{name:"yellow",value:"#c4a019"},{name:"green",value:"#66bb6a"},'
  + '{name:"red",value:"#f07f6f"},{name:"purple",value:"#bf89e6"},{name:"blue",value:"#61a7fa"}];'
  + ' if (globalThis.__mawBeforeFixture) { globalThis.__mawBeforeFixture(globalThis.window); globalThis.__mawBeforeFixture = null; }'
  + ' })();';
  const statements = [IDENTITY_SOURCE,
    'const steps = [' + classicFiles.map((f) => `init${classicIndex.get(f)}()`).join(',') + '];',
    'for (const step of steps) step.next();',
    // 注册表创建者先行（与生产一致）：runtime 的 phase-2 创建 window.MAWE
    ...files.filter((file) => file === 'editor/boot/editor-runtime.js' && classicIndex.has(file))
      .map((file) => `steps[${classicIndex.get(file)}].next();`),
    // 与生产 compileEsmEntry 同语义：全部工厂注册先于任何其余
    // classic phase-2（工厂是纯 export function，注册与位置无关）。
    ...files.filter((file) => factoryByFile.has(file) && file !== 'editor/boot/editor-runtime.js')
      .map((file) => `window.MAWE.register(${JSON.stringify(factoryByFile.get(file).name)},`
        + ` factory${files.indexOf(file)});`),
    ...files.flatMap((file, i) => {
      const factory = factoryByFile.get(file);
      const isTarget = file === entry;
      const ops = [];
      if (factory || plainFiles.includes(file)) {
        // 工厂已在上方统一注册（与生产一致）；
        // 普通 ESM 的求值与发布发生在 import 期（bundle 顶部），
        // 无 phase-2 驱动——与生产 compileEsmEntry 一致。
      } else {
        // phase-2 驱动序与生产 compileEsmEntry 一致：runtime 先行，
        // 再按 manifestIndex（bootstrap → deferred → 其余）次序驱动。
        // files 已按 manifestIndex 排序传入（fixtureClosure/compileEditorFiles），
        // 全清单路径 manifest 本身按该序排列。
        if (file !== 'editor/boot/editor-runtime.js') { if (phase2All || isTarget) ops.push(`steps[${classicIndex.get(file)}].next();`); }
        if (phase2All || isTarget) ops.push(`steps[${classicIndex.get(file)}].next();`);
      }
      if (isTarget && !plainFiles.includes(file)) ops.unshift('globalThis.__mawBeforeFixture?.(window);');
      return ops;
    })];
  const result = esbuild.buildSync({
    stdin: { contents: [...imports, ...statements].join('\n'), resolveDir: web, loader: 'js', sourcefile: 'fixture-entry.mjs' },
    absWorkingDir: root, bundle: true, format: 'iife', write: false, logLevel: 'silent',
    banner: { js: "'use strict';" + IDENTITY_SOURCE },
    define: DEFINES,
  });
  const code = result.outputFiles[0].text;
  cache.set(key, code); return code;
}

const fixtureCache = new Map();
export function compileEditorFixture(file) {
  const key = file;
  if (fixtureCache.has(key)) return fixtureCache.get(key);
  const code = compile(fixtureClosure(file), file);
  fixtureCache.set(key, code);
  return code;
}

// A true unit fixture for modules whose collaborators are supplied by the test.
// AST ranges remove each static import from this one source file and replace its
// local bindings with explicit sandbox values. The editor source files and their
// transitive imports are not mirrored or rewritten. Production import-graph
// behavior remains covered by browser tests using the real built bundle.
export function compileIsolatedEsmFixture(file, providedBindings, { exposeExports = [] } = {}) {
  const absolute = path.join(web, file);
  const source = fs.readFileSync(absolute, 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 16, sourceType: 'module', ranges: true });
  const edits = [];
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const declarations = node.specifiers.map((specifier) => {
      if (specifier.type !== 'ImportSpecifier') {
        throw new Error(`Isolated fixture ${file} only accepts named imports: ${node.source.value}`);
      }
      const imported = specifier.imported.name ?? specifier.imported.value;
      const isSharedFreezeHelper = imported === 'freezeFacade'
        && path.resolve(path.dirname(absolute), node.source.value)
          === path.join(web, 'editor', 'state', 'editor-facade-utils.js');
      if (!Object.hasOwn(providedBindings, imported) && !isSharedFreezeHelper) {
        throw new Error(`Isolated fixture ${file} is missing explicit stub for ${imported} (${node.source.value})`);
      }
      return `const ${specifier.local.name} = globalThis[${JSON.stringify(imported)}];`;
    });
    edits.push({ start: node.start, end: node.end, text: declarations.join('\n') });
  }
  let isolated = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    isolated = isolated.slice(0, edit.start) + edit.text + isolated.slice(edit.end);
  }
  const exposed = exposeExports.map((name) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || !source.includes(`export function ${name}(`)) {
      throw new Error(`Isolated fixture ${file} cannot expose ${name}`);
    }
    return `globalThis.__mawTest_${name} = ${name};`;
  }).join('\n');
  const result = esbuild.buildSync({
    stdin: { contents: isolated + '\n' + exposed, resolveDir: path.dirname(absolute), loader: 'js', sourcefile: file },
    absWorkingDir: root, bundle: true, format: 'iife', write: false, logLevel: 'silent',
    banner: { js: "'use strict'; (() => { if (typeof globalThis.queueMicrotask !== 'function') globalThis.queueMicrotask = fn => Promise.resolve().then(fn); if (typeof globalThis.freezeFacade !== 'function') globalThis.freezeFacade = facade => Object.freeze(facade); const w = globalThis.window; if (w && w !== globalThis) { for (const k of Object.getOwnPropertyNames(w)) if (!(k in globalThis)) { try { globalThis[k] = w[k]; } catch {} } try { globalThis.window = globalThis; } catch {} } if (typeof globalThis.getMaweState !== 'function' && 'MaweState' in globalThis) globalThis.getMaweState = () => globalThis.MaweState; if (typeof globalThis.getMaweHost !== 'function' && 'MaweHost' in globalThis) globalThis.getMaweHost = () => globalThis.MaweHost; })();" },
    define: DEFINES,
  });
  return result.outputFiles[0].text;
}

// Compile only the requested module. Its named ESM imports become explicit
// reads from the test sandbox, so imported production modules cannot run their
// own page wiring or overwrite the fixture's collaborators.
export function compileEditorUnitFixture(file, options) {
  const source = fs.readFileSync(path.join(web, file), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 16, sourceType: 'module' });
  const provided = {};
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier') {
        throw new Error(`Unit fixture ${file} only accepts named imports: ${node.source.value}`);
      }
      const name = specifier.imported.name ?? specifier.imported.value;
      provided[name] = undefined;
    }
  }
  return compileIsolatedEsmFixture(file, provided, options);
}

// 全清单 bundle：与生产等价的完整装配（真实接线）。
// phase-2 驱动序 = manifestIndex（bootstrap → deferred → 其余）。
export function compileEditorBundle() {
  const ordered = manifest.slice().sort((a, b) => manifestIndex.get(a) - manifestIndex.get(b));
  return compile(ordered, ordered[ordered.length - 1]);
}

// 指定文件集合的装配 bundle（classic iife，可注入真浏览器）：自动并入各
// 文件的直接 provider 闭包、去重、按清单序排列；entry 默认清单序最后一项。
export function compileEditorFiles(files, entry) {
  const ordered = [...new Set(files)].sort((a, b) => manifestIndex.get(a) - manifestIndex.get(b));
  const closure = [...new Set(ordered.flatMap((file) => fixtureClosure(file)))].sort(
    (a, b) => manifestIndex.get(a) - manifestIndex.get(b));
  return compile(closure, entry ?? ordered[ordered.length - 1]);
}

// 通用中性 DOM 元素（懒生成、按属性缓存）：单元夹具引用 MaweDom 等门面时，
// 用它替代逐个枚举 id——只是事件/样式管道，不模拟任何编辑器逻辑。
export function neutralElement() {
  const element = {
    style: new Proxy({ setProperty() {}, removeProperty() {} }, { get: (t, k) => t[k] ?? (() => '') }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false, replace() {} },
    dataset: {}, textContent: '', value: '', id: '', title: '', innerHTML: '', hidden: false, checked: false, disabled: false,
    setAttribute() {}, removeAttribute() {}, toggleAttribute() {},
    appendChild() {}, append() {}, removeChild() {}, replaceChildren() {}, prepend() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    querySelector: () => null, querySelectorAll: () => [], closest: () => element, contains: () => false,
    focus() {}, blur() {}, click() {}, remove() {}, scrollIntoView() {}, select() {},
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
  };
  return element;
}
export function makeFacadeStub() {
  const store = new Map();
  return new Proxy({}, { get: (_t, key) => {
    if (!store.has(key)) store.set(key, neutralElement());
    return store.get(key);
  } });
}

// document 桩：中性元素工厂 + 常用查询。overrides 可为对象，或接收基础
// document 返回增量（如按 id 优先返回测试自有按钮、未命中回退中性元素）。
export function makeDocumentStub(overrides = {}) {
  const byId = new Map();
  const document = {
    createElement: () => neutralElement(),
    createTextNode: (text) => ({ textContent: text }),
    getElementById: (id) => { if (!byId.has(id)) byId.set(id, neutralElement()); return byId.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    documentElement: Object.assign(neutralElement(), { lang: '' }),
    body: neutralElement(),
    head: neutralElement(),
    fonts: { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() },
    readyState: 'complete',
    activeElement: null,
  };
  const extra = typeof overrides === "function" ? overrides(document) : overrides;
  return Object.assign(document, extra);
}

export function loadEditorModule(context, entry, beforeEntry = () => {}) {
  // 固定域集合（与 copy 通过态一致）：boot 运行时 + host 域 + utils/waveform 目录
  // + 目标。import 闭包只用于 compileEditorFixture；此处不并入，避免改变既有
  // 测试的加载范围。
  const directories = entry === 'shared/editor-utils.js' ? ['shared/utils/'] : ['editor/media/waveform/'];
  const selected = manifest.filter((name) => name === 'editor/boot/editor-runtime.js' || name === 'editor/boot/editor-host.js'
    || name.startsWith('shared/host/') || name === 'shared/gap-remove-core.js' || name === entry
    || (entry === 'editor/media/waveform.js' && name === 'editor/media/editor-thumbnails.js')
    || directories.some((prefix) => name.startsWith(prefix)));
  // phase-2 序：注册表创建者（editor-runtime）必须最先——host 的
  // phase-2 自注册需要 window.MAWE；其余按稳定序。
  const files = [...selected].sort((a, b) => {
    const rank = (name) => name === 'editor/boot/editor-runtime.js' ? 0
      : name === 'editor/boot/editor-host.js' ? 1
      : name === 'shared/gap-remove-core.js' ? 2
      : name === 'shared/utils/ass-canvas-layout.js' ? 3 : 4;
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  context.__mawBeforeFixture = beforeEntry;
  try { vm.runInNewContext(compile(files, entry), context); }
  finally { delete context.__mawBeforeFixture; }
  return context.window;
}

// 递归中性桩：任何属性访问/调用返回自身。用于 import 图拉入
// 的模块在微任务顶层初始化时兜住缺失门面（单元夹具不提供
// 完整页面环境）。
export function makeDeepStub() {
  return new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf')
      ? (() => '') : makeDeepStub(),
    apply: () => makeDeepStub(),
    set: (t, k, v) => { t[k] = v; return true; },
    has: () => true,
  });
}
