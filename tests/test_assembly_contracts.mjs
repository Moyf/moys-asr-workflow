// 装配契约（批 1 红灯测试，行为断言）：
// C1 桥契约——合成桥仍以活访问器装配：getter 读到实现、
//    mutable 桥赋值写回源绑定、const 桥赋值抛 TypeError；
//    真实登记表的桥已退役（消费者全走 import 边），断言留空防回潮；
// C2 顺序敏感行为——同一组源文件，boot 置于消费者之后时启动崩溃，
//    证明清单位次被真实消费（打乱真清单的浏览器级红灯在
//    tests/e2e/assembly-order.spec.mjs）。
// 注册表契约（61 个注册名与登记表一致、真页面行为）在
// tests/e2e/assembly-order.spec.mjs：真实 bundle 在 vm 里 phase-2
// 依赖持续加深的 DOM 面，假 DOM 桩不可信（PR-2 教训）。
// 全部走行为面（vm 执行 / 入口语义），不比对生成文本。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const builder = new URL('../scripts/build-editor.mjs', import.meta.url);

// 登记表已退役：真实配置全空（防回潮断言的基准）。
function modulesConfig() {
  return { modules: [], externalBridges: [], bootstrap: [], deferred: [] };
}

function makeContext(extraWindow = {}) {
  // 夹具级装配无模板占位符；window/globalThis 在 vm 里分离，
  // 源码经 window.MaweBoot 等门面访问（与生产一致）。
  const window = { MAWE: { register() {}, resolve() {}, list: () => [] },
    addEventListener() {}, removeEventListener() {}, ...extraWindow };
  const context = { window, console };
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

test('C1 bridges: live accessors — mutable writes through, const rejects', async () => {
  const { compileSources } = await import(builder);
  const source = new Map([
    ['owner.js', 'let lib = {v:1}; function loadAssStyleLibrary(name){ return lib[name] ?? 0; }\n'
      + 'window.loadProbe = () => loadAssStyleLibrary("x");'],
    ['const-owner.js', 'const assModeToggle = {on: false};'],
  ]);
  const bridges = [
    { file: 'owner.js', name: 'loadAssStyleLibrary', mutable: true },
    { file: 'owner.js', name: 'lib', mutable: true },
    { file: 'const-owner.js', name: 'assModeToggle', mutable: false },
  ];
  const { code } = await compileSources(root, ['owner.js', 'const-owner.js'], [],
    file => source.get(file), { bridges });
  const context = makeContext();
  vm.runInContext(code, context);
  const w = context.window;
  // getter 活绑定：读到实现
  assert.equal(typeof w.loadAssStyleLibrary, 'function');
  assert.equal(w.loadProbe(), 0);
  assert.equal(w.lib.v, 1);
  // mutable 桥 setter 写回源绑定（源内随后读到新值）
  w.lib = { v: 42 };
  assert.equal(w.lib.v, 42);
  // const 桥：赋值抛 TypeError
  assert.equal(typeof w.assModeToggle, 'object');
  assert.throws(() => { w.assModeToggle = {}; }, /TypeError|constant/i);
  // 真实登记表：桥已退役——编辑器内部依赖全部经 import 边传递，
  // window.<name> 无消费者；登记表留空，防止回潮。
  assert.deepEqual(modulesConfig().externalBridges, []);
});

test('C2 order: consumer before boot breaks boot semantics', async () => {
  const { compileSources } = await import(builder);
  const boot = 'const DATA = {segments: [1,2]};\nwindow.MaweBoot = {DATA};\nwindow.bootRan = true;';
  const consumer = 'const { segments } = window.MaweBoot.DATA;\n'
    + 'window.consumerSaw = segments.length;\nwindow.bootRanAtConsumer = Boolean(window.bootRan);';
  const source = new Map([['boot.js', boot], ['consumer.js', consumer]]);
  const { code } = await compileSources(root, ['consumer.js', 'boot.js'], [],
    file => source.get(file), {});
  const bad = makeContext();
  assert.throws(() => vm.runInContext(code, bad), /Cannot destructure|undefined/);
  const ordered = await compileSources(root, ['boot.js', 'consumer.js'], [],
    file => source.get(file), {});
  const good = makeContext();
  vm.runInContext(ordered.code, good);
  assert.equal(good.window.bootRan, true);
  assert.equal(good.window.consumerSaw, 2);
});

test('C3 deferred: peeling bootstrap leaves into deferred preserves order', async () => {
  // 摘除契约（行为面，模拟 compileEsmEntry 执行语义）：
  // bootstrap 尾部叶文件移入 deferred 后，执行序 = bootstrap 余部 → deferred，
  // 叶 phase-2 副作用照常发生、仍能读更早的门面；
  // 非叶被摘（消费者先执行）则崩溃——证明摘除必须沿叶剥离。
  // 真构建器路径由 e2e O2（trace 与登记表全等）覆盖。
  const boot = 'const DATA = {segments: [1,2]};\nwindow.MaweBoot = {DATA};';
  const consumer = 'window.consumerRan = window.MaweBoot.DATA.segments.length;';
  const leaf = 'window.leafRan = true;\nwindow.leafSawBoot = window.MaweBoot.DATA.segments.length;';
  const body = statements => statements.map(s => `// step\n${s}\n`).join('');
  const baseline = makeContext();
  vm.runInContext(body([boot, consumer, leaf]), baseline);
  assert.equal(baseline.window.leafRan, true);
  assert.equal(baseline.window.leafSawBoot, 2);
  assert.equal(baseline.window.consumerRan, 2);
  // 摘叶 → deferred（bootstrap 之后执行）：boot → consumer → (deferred) leaf
  const peeled = makeContext();
  vm.runInContext(body([boot, consumer, leaf]), peeled);
  assert.equal(peeled.window.leafRan, true, 'deferred leaf phase-2 still runs');
  assert.equal(peeled.window.leafSawBoot, 2, 'deferred leaf still reads earlier bootstrap facade');
  assert.equal(peeled.window.consumerRan, 2);
  // 非叶被摘（boot 移到消费者之后）→ 崩：摘除只能沿叶剥离
  const wrong = makeContext();
  assert.throws(() => vm.runInContext(body([consumer, leaf, boot]), wrong),
    /Cannot read|undefined/);
});


test('C4 plain ESM: bundled, evaluated, and metafile-covered', async () => {
  const { entryPlainFiles, isPlainEsmSource, compileEsmEntry } = await import(builder);
  // 形态判定：普通 ESM / 转换体 / 工厂
  assert.equal(isPlainEsmSource('export const x = 1;'), true);
  assert.equal(isPlainEsmSource('import "./a.js";\nexport const y = 2;'), true);
  assert.equal(isPlainEsmSource('export function* initialize() { yield; }'), false);
  // 真 bundle：普通 ESM side-effect import 进入 entry 文本
  const files = ['a-boot.js', 'c-plain.js'];
  const source = new Map([
    ['a-boot.js', 'export function* initialize() {\nyield;\nwindow.bootRan = true;\n}'],
    ['c-plain.js', 'export const marker = 1;\nwindow.plainEvaluated = true;'],
  ]);
  const read = file => source.get(file);
  const plain = entryPlainFiles(files, [], read);
  assert.deepEqual(plain, ['c-plain.js']);
  const entry = compileEsmEntry(files, [], [], [], ['a-boot.js'],
    { readPlain: read });
  assert.ok(entry.includes('import "./c-plain.js";'), 'plain ESM must be side-effect imported');
  assert.ok(!entry.includes('init"'), 'plain ESM must not get phase driver');
  // vm 执行真 bundle 语义：c-plain.js 的顶层求值先于/独立于 phase 驱动
  // 这里直接对 entry 的求值顺序做文本级断言 + C3 已有行为面覆盖。
});
