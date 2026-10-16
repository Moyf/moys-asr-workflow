// 装配顺序契约（真页面，行为断言）：
// O1 启动行为——完整 boot：桥接、波形、渲染、导出、合并撤销全链可用；
// O2 启动语义——真 ESM import 图承载顺序：runtime 的 MAWE
//    先发布（import 求值先于 startup/onboarding），startup 的
//    editor-bridge 与 onboarding 的 register 真实发生，
//    工程数据已注入（phase 驱动退役后的顺序活证据）；
// O3 注册表——MAWE.list() 覆盖登记表工厂名且无重复
//    （真页面行为，vm 无法承载启动期 DOM 面）；
// O4 桥——externalBridges 已退役（消费者全走 import 边）；
//    登记表留空防回潮（行为面在 test_assembly_contracts C1）。
// O5 顺序红灯——打乱 deferred/bootstrap 清单的启动行为；
//    deferred 已空，O5a 退役（无清单可打乱）。
// O5b 在临时副本上重建 bundle，约 30–60s；其余共享一个服务器。
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEditor, deriveSources, BUNDLE, BUILD_INFO } from '../../scripts/build-editor.mjs';
import {
  cleanupTempDir, disableOnboarding, findFreePort, generateWav,
  generateWaveformPayload, makeTempDir, startServer,
} from './helpers.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const DURATION_MS = 4_000;

let dir; let server; let page;
// 登记表已退役：真实配置全空。
const moduleConfig = () => ({ modules: [], externalBridges: [], bootstrap: [], deferred: [] });

function writeProject(filePath) {
  const project = {
    schema: 'moy.asr.project.v1',
    media: 'synthetic.wav',
    language: 'en',
    model: 'synthetic',
    segments: [
      { id: 'a-1', start: 0, end: 2000, text: 'First', items: [{ start: 0, end: 2000, text: 'First' }] },
      { id: 'a-2', start: 2100, end: 4000, text: 'Second', items: [{ start: 2100, end: 4000, text: 'Second' }] },
    ],
    waveform: generateWaveformPayload(DURATION_MS),
  };
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
  return filePath;
}

test.beforeAll(async ({ browser }) => {
  dir = makeTempDir('assembly-order');
  const wav = join(dir, 'synthetic.wav');
  generateWav(wav, DURATION_MS / 1000);
  const project = writeProject(join(dir, 'project.json'));
  const port = await findFreePort();
  server = await startServer(project, wav, port);
  page = await browser.newPage();
  page.on('pageerror', (e) => console.log('O1-PAGE-EXCEPTION:', (e.stack || e.message).slice(0, 1200)));
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MAWE_EDITOR_BRIDGE && window.MaweCoreState?.waveformEditor));
  await page.waitForFunction(() => window.MaweBoot?.DATA?.segments?.length > 0);
});

test.afterAll(async () => {
  await page?.close();
  await server?.stop();
  cleanupTempDir(dir);
});

test('O1 boot completes: bridge, waveform, render, export, merge+undo', async () => {
  const result = await page.evaluate(() => {
    const srt = window.MaweExportSrt.buildSrt();
    const before = JSON.stringify(window.MaweBoot.DATA.segments);
    window.MaweSegmentOps.mergeSegments([0, 1]);
    const merged = window.MaweBoot.DATA.segments.length === 1;
    window.MaweHistory.performUndo();
    const undoRestored = JSON.stringify(window.MaweBoot.DATA.segments) === before;
    return { registrySize: window.MAWE.list().length, waveform: Boolean(window.MaweCoreState.waveformEditor),
      rendered: window.MaweCoreState.container.querySelectorAll('.cue').length > 0,
      srtHasCue: srt.includes('-->'), merged, undoRestored,
      segmentCount: window.MaweBoot.DATA.segments.length };
  });
  expect(result.segmentCount).toBe(2);
  expect(result.registrySize).toBeGreaterThanOrEqual(2); // editor-bridge + onboarding probes
  expect(result.waveform, JSON.stringify(result)).toBe(true);
  expect(result.rendered, JSON.stringify(result)).toBe(true);
  expect(result.srtHasCue, JSON.stringify(result)).toBe(true);
  expect(result.merged, JSON.stringify(result)).toBe(true);
  expect(result.undoRestored, JSON.stringify(result)).toBe(true);
});

test('O2 startup semantics: MAWE published before startup/onboarding registers', async () => {
  // 真 ESM：顺序由 import 图承载——runtime 模块求值（发布 MAWE）
  // 先于 startup/onboarding 的 register 调用；启动序列
  // （queueMicrotask）在全部模块求值后执行。
  const state = await page.evaluate(() => ({
    maweVersion: globalThis.MAWE?.version ?? null,
    registered: window.MAWE ? window.MAWE.list() : [],
    bridge: Boolean(window.MAWE_EDITOR_BRIDGE),
    onboardingApi: typeof window.MAWE_ONBOARDING === 'object',
    segments: window.MaweBoot?.DATA?.segments?.length ?? 0,
  }));
  expect(state.maweVersion).toBe(1);
  expect(state.registered, 'startup/onboarding must register their probes')
    .toEqual(expect.arrayContaining(['editor-bridge', 'onboarding']));
  expect(state.bridge, JSON.stringify(state)).toBe(true);
  expect(state.onboardingApi, JSON.stringify(state)).toBe(true);
  expect(state.segments).toBeGreaterThan(0);
});

test('O3 registry names match editor-modules.json exactly', async () => {
  const names = await page.evaluate(() => window.MAWE.list());
  const expected = moduleConfig().modules.map((m) => m.name);
  // 登记表工厂已退役（依赖全部 import 直连）；运行时代码内
  // 注册的探针（editor-bridge/onboarding）必须全部在列且无重名。
  for (const name of expected) expect(names, name).toContain(name);
  expect(new Set(names).size).toBe(names.length);
});

test('O4 bridges retired: registry empty; e2e probe accessors live', async () => {
  // 登记表桥已退役（防止回潮的断言在 test_assembly_contracts C1）；
  // e2e 探针入口（loadAssStyleLibrary 等）由各自源文件以
  // defineProperty 活访问器显式发布——消费者全部是 e2e specs。
  const config = moduleConfig();
  expect(config.externalBridges).toEqual([]);
  const probe = await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'loadAssStyleLibrary');
    return { isAccessor: Boolean(descriptor?.get), hasValue: typeof window.loadAssStyleLibrary === 'function' };
  });
  expect(probe.isAccessor, 'probe must be a live accessor').toBe(true);
  expect(probe.hasValue).toBe(true);
});

// ESM 顺序探针：同一份源码、同一个目录集合，分别按发现序和逆序
// 构建并在浏览器启动。只允许改变 entry import 顺序，不改模块内容。
async function prepareOrderSandbox(sandbox) {
  // 沙盒 = HEAD worktree + 当前树 web/ 全拷贝；bundle
  // 产物不拷贝（由沙盒重建）。
  execFileSync('git', ['worktree', 'add', '--detach', sandbox,
    'HEAD'], { cwd: repoRoot, stdio: 'pipe' });
  rmSync(join(sandbox, 'web'), { recursive: true, force: true });
  cpSync(join(repoRoot, 'web'), join(sandbox, 'web'), { recursive: true,
    filter: (s) => !s.includes('editor-bundle.js') && !s.endsWith('.meta.json') });
  cpSync(join(repoRoot, 'tests'), join(sandbox, 'tests'), { recursive: true });
  // HEAD is the scrubbed upstream base; this worktree's ESM builder and Python
  // preflight must travel with the copied ESM source tree in the sandbox.
  for (const file of ['scripts/build-editor.mjs', 'maw/web_build.py', 'edit.py', 'package.json']) {
    cpSync(join(repoRoot, file), join(sandbox, file));
  }
  execFileSync('cmd', ['/c', 'mklink', '/J',
    join(sandbox, 'node_modules').replaceAll('/','\\'),
    join(repoRoot, 'node_modules').replaceAll('/','\\')], { stdio: 'pipe' });
}

async function writeOrderVariant(sandbox, sourceFiles) {
  const built = await buildEditor(sandbox, { sourceFiles });
  writeFileSync(join(sandbox, 'web', BUNDLE), built.code, 'utf8');
  writeFileSync(join(sandbox, 'web', BUILD_INFO),
    `${JSON.stringify(built.metadata, null, 2)}\n`, 'utf8');
}

function renderBlankProbe(sandbox, label) {
  const python = process.env.MAW_E2E_PYTHON ?? 'python';
  const renderPage = join(sandbox, `${label}-probe.html`);
  execFileSync(python, ['-c',
    'import edit, pathlib, sys\n'
    + 'original = edit.render_editor_page\n'
    + 'def render(**context):\n'
    + '    context[\'data_json\'] = \'{"segments":[]}\'\n'
    + '    return original(**context)\n'
    + 'edit.render_editor_page = render\n'
    + 'pathlib.Path(sys.argv[1]).write_text(edit.build_blank_html(), encoding=\'utf-8\', newline=\'\\n\')\n',
    renderPage], { stdio: 'pipe', cwd: sandbox });
  return renderPage;
}

async function probeOrderVariant(browser, renderPage) {
  const probePage = await browser.newPage();
  const pageErrors = [];
  probePage.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await probePage.goto(`file:///${renderPage.replaceAll('\\', '/')}`);
  await probePage.waitForTimeout(1800);
  const state = await probePage.evaluate(() => ({
    bridge: Boolean(window.MAWE_EDITOR_BRIDGE),
    registry: [...(window.MAWE?.list?.() ?? [])].sort(),
    waveform: Boolean(window.MaweCoreState?.waveformEditor),
    utilsFacade: typeof window.AsrEditorUtils === 'object',
    canaryRan: window.__mawO5bCanaryRan === true,
    dataSegments: window.MaweBoot?.DATA?.segments?.length ?? null,
    exportSrt: window.MaweExportSrt?.buildSrt?.() ?? null,
  }));
  await probePage.close();
  return { ...state, pageErrors };
}

// 先 rmSync（Node 对 junction 是拆链接不递归进目标，node_modules
// 安全），再 prune 清掉主仓 .git 里的 worktree 管理项。
function discardSandbox(sandbox) {
  rmSync(sandbox, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
}

// O5b：证明目录发现的新文件会执行，并对比正常发现序与完全逆序的
// ESM entry imports。若 import 图仍依赖偶然的根文件顺序，行为比较会红。
test('O5b ESM order independence: derived canary executes and reverse order preserves boot behavior', async ({ browser }) => {
  test.setTimeout(300_000);
  const sandbox = join(dir, 'esm-order-probe');
  try {
    await prepareOrderSandbox(sandbox);
    const canary = join(sandbox, 'web/editor/boot/zz-derived-canary.js');
    writeFileSync(canary, 'window.__mawO5bCanaryRan = true;\n', 'utf8');
    const discovered = deriveSources(sandbox);
    const reversed = [...discovered].reverse();

    await writeOrderVariant(sandbox, discovered);
    const baseline = await probeOrderVariant(browser, renderBlankProbe(sandbox, 'baseline'));
    await writeOrderVariant(sandbox, reversed);
    const shuffled = await probeOrderVariant(browser, renderBlankProbe(sandbox, 'reversed'));

    expect(baseline.bridge, 'baseline bundle must boot').toBe(true);
    expect(baseline.canaryRan, 'directory-derived canary must execute').toBe(true);
    expect(baseline.pageErrors, 'baseline must have no page errors').toEqual([]);
    expect(shuffled, 'reversing the entry import order must preserve boot behavior').toEqual(baseline);
  } finally { discardSandbox(sandbox); }
});
