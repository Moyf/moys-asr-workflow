import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { initModuleSource } from './helpers/init-module-source.mjs';

test('ASS export keeps distinct renderable family names while replacing typographic aliases', async () => {
  const config = {};
  const context = {
    window: { MaweBoot: { SERVER_CONFIG: config }, location: { href: 'http://localhost/' } },
    document: { dispatchEvent() {} },
    CustomEvent: class {},
    URL,
    fetch: async () => ({ ok: true, json: async () => ({
      schema: 'moy.asr.font_aliases.v1',
      fonts: [{ canonical: 'Example Sans',
        names: ['Example Sans', 'Example Sans Semibold', 'Example Sans Typographic', 'ExampleSans-Semibold'],
        family: ['Example Sans', 'Example Sans Semibold'],
        canonicalByName: { 'examplesans-semibold': 'Example Sans Semibold',
          'example sans semibold': 'Example Sans Semibold' } }],
    }) }),
  };
  loadEditorModule(context, 'shared/editor-utils.js');
  vm.runInNewContext(fs.readFileSync(new URL(
    '../web/editor/styles/editor-wiring-ass-font-aliases.js', import.meta.url,
  ), 'utf8'), context);
  config.assFontAliasesUrl = '/api/ass-font-aliases';
  const aliases = context.window.MaweAssFontAliases;
  await aliases.reload();
  const choices = aliases.entries().map((entry) => ({
    value: entry.canonical, label: entry.canonical, aliases: entry.names,
  }));
  assert.deepEqual(Array.from(context.window.AsrEditorUtils.filterFontFamilyOptions(choices, 'Semibold'),
    (entry) => entry.value), ['Example Sans Semibold']);
  aliases.beginReplacementCapture();
  try {
    const payload = context.window.AsrEditorUtils.buildAssPayload([
      { start: 0, end: 2000, text: '字重保留' },
    ], {
      assProfile: {},
      assStyle: { fontName: 'Example Sans Semibold' },
      assExtensionStyle: { fontName: 'ExampleSans-Semibold' },
      extensionSegments: [{ start: 0, end: 1000, text: 'A' }],
    });
    assert.match(payload, /Style: Default,Example Sans Semibold,/);
    assert.match(payload, /Style: Extension,Example Sans Semibold,/);
    assert.equal(aliases.canonicalFor('example sans semibold'), 'example sans semibold');
    assert.equal(aliases.canonicalFor('Example Sans Typographic'), 'Example Sans');
    assert.deepEqual(Array.from(aliases.aliasChainFor('ExampleSans-Semibold')),
      ['Example Sans Semibold']);
  } finally {
    aliases.endReplacementCapture();
  }
  assert.deepEqual(JSON.parse(JSON.stringify(aliases.takeReplacementNotice())), [
    { from: 'ExampleSans-Semibold', to: 'Example Sans Semibold' },
    { from: 'Example Sans Typographic', to: 'Example Sans' },
  ]);
});

test('loaded font aliases invalidate the paused preview plan before its first refresh', async () => {
  const config = {};
  const listeners = new Map();
  const context = {
    window: { MaweBoot: { SERVER_CONFIG: config }, location: { href: 'http://localhost/' } },
    document: {
      addEventListener(type, listener) { listeners.set(type, listener); },
      dispatchEvent(event) { listeners.get(event.type)?.(); },
    },
    CustomEvent: class { constructor(type) { this.type = type; } },
    URL,
    fetch: async () => ({ ok: true, json: async () => ({
      schema: 'moy.asr.font_aliases.v1', fonts: [{ canonical: 'Example', names: ['Example'] }],
    }) }),
  };
  vm.createContext(context);
  vm.runInContext(initModuleSource('editor/styles/editor-wiring-ass-preview.js'), context);
  vm.runInContext("cachedAssStackKey = 'old'; assPreviewFontMetrics.set('old', 1)", context);
  let refreshed = false;
  context.window.MawePlaybackLoop = { refreshSubtitlePreview() {
    assert.equal(vm.runInContext('cachedAssStackKey', context), '');
    assert.equal(vm.runInContext('assPreviewFontMetrics.size', context), 0);
    assert.equal(vm.runInContext('assStackFontRevision', context), 1);
    refreshed = true;
  } };
  vm.runInContext(fs.readFileSync(new URL(
    '../web/editor/styles/editor-wiring-ass-font-aliases.js', import.meta.url,
  ), 'utf8'), context);
  config.assFontAliasesUrl = '/api/ass-font-aliases';
  await context.window.MaweAssFontAliases.reload();
  assert.equal(refreshed, true);
});

test('legacy dirty font names stay out of the dropdown while still resolving to matchable canonicals', async () => {
  // 寒蝉活仿楷场景：坏 Macintosh 记录的脏名（CoreText/libass 匹配不到）进
  // legacy——下拉不展示，但旧工程存量的脏名仍能解析出可匹配 canonical，
  // 导出改写与预览别名链都能自愈。
  const config = {};
  const context = {
    window: { MaweBoot: { SERVER_CONFIG: config }, location: { href: 'http://localhost/' } },
    document: { dispatchEvent() {} },
    CustomEvent: class {},
    URL,
    fetch: async () => ({ ok: true, json: async () => ({
      schema: 'moy.asr.font_aliases.v1',
      fonts: [{ canonical: '寒蝉活仿楷_復 Con',
        names: ['ChillHuoFangKai_F Con', '寒蝉活仿楷_復 Con', '寒蝉活仿楷_復ConRegular'],
        family: ['ChillHuoFangKai_F Con', '寒蝉活仿楷_復 Con'],
        legacy: ['寒蝉活仿楷__ Con', '_______ConRegular'],
        canonicalByName: {
          'chillhuofangkai_f con': '寒蝉活仿楷_復 Con',
          '寒蝉活仿楷_復 con': '寒蝉活仿楷_復 Con',
          '寒蝉活仿楷_復conregular': '寒蝉活仿楷_復 Con',
          '寒蝉活仿楷__ con': '寒蝉活仿楷_復 Con',
          '_______conregular': '寒蝉活仿楷_復 Con',
        } }],
    }) }),
  };
  loadEditorModule(context, 'shared/editor-utils.js');
  vm.runInNewContext(fs.readFileSync(new URL(
    '../web/editor/styles/editor-wiring-ass-font-aliases.js', import.meta.url,
  ), 'utf8'), context);
  config.assFontAliasesUrl = '/api/ass-font-aliases';
  const aliases = context.window.MaweAssFontAliases;
  await aliases.reload();

  const choices = Array.from(aliases.entries(), (entry) => entry.canonical);
  assert.deepEqual(choices, ['寒蝉活仿楷_復 Con']);
  for (const entry of aliases.entries()) {
    assert.ok(!entry.names.includes('寒蝉活仿楷__ Con'), '脏名不能进下拉');
    assert.ok(!entry.names.includes('_______ConRegular'), '垃圾名不能进下拉');
  }

  // 存量脏名：查询命中、导出改写记录替换、预览链落到可匹配名。
  assert.equal(aliases.canonicalFor('寒蝉活仿楷__ Con'), '寒蝉活仿楷_復 Con');
  assert.deepEqual(Array.from(aliases.aliasChainFor('寒蝉活仿楷__ Con')), ['寒蝉活仿楷_復 Con']);
  assert.equal(aliases.chainCssFor('寒蝉活仿楷__ Con'),
    '"寒蝉活仿楷__ Con", "寒蝉活仿楷_復 Con", sans-serif');
  aliases.beginReplacementCapture();
  try {
    assert.equal(aliases.canonicalFor('寒蝉活仿楷__ Con'), '寒蝉活仿楷_復 Con');
  } finally {
    aliases.endReplacementCapture();
  }
  assert.deepEqual(JSON.parse(JSON.stringify(aliases.takeReplacementNotice())), [
    { from: '寒蝉活仿楷__ Con', to: '寒蝉活仿楷_復 Con' },
  ]);
});

async function managedFonts(coverage) {
  const config = {};
  const context = {
    window: { MaweBoot: { SERVER_CONFIG: config }, location: { href: 'http://localhost/' } },
    document: { dispatchEvent() {} }, CustomEvent: class {}, URL,
    fetch: async () => ({ ok: true, json: async () => ({
      schema: 'moy.asr.font_aliases.v1', fonts: [], coverage,
    }) }),
  };
  loadEditorModule(context, 'shared/editor-utils.js');
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/styles/editor-wiring-ass-font-aliases.js', import.meta.url), 'utf8'), context);
  config.assFontAliasesUrl = '/api/ass-font-aliases';
  await context.window.MaweAssFontAliases.reload();
  return context.window;
}
const coverageFixture = () => ({
  schema: 'moy.asr.font_coverage.v1', complete: true,
  fallbacks: ['SimHei', 'Arial'],
  faces: [
    { family: 'Primary', names: ['Primary'], weight: 400, italic: false, ranges: [[32, 126]], emRatio: .75 },
    { family: 'SimHei', names: ['SimHei'], weight: 400, italic: false,
      ranges: [[32, 126], [0x256c, 0x256c], [0x4e00, 0x9fff]], emRatio: .76 },
    { family: 'Arial', names: ['Arial'], weight: 400, italic: false,
      ranges: [[32, 126], [0x300, 0x301], [0x3c9, 0x3c9], [0x2022, 0x2022]], emRatio: .89 },
    { family: 'Arial', names: ['Arial'], weight: 700, italic: true,
      ranges: [[32, 126], [0x300, 0x301], [0x3c9, 0x3c9], [0x2022, 0x2022]], emRatio: .88 },
  ],
});

test('managed fallback keeps graphemes, text and inline style, selecting CJK and symbols explicitly', async () => {
  const win = await managedFonts(coverageFixture());
  const text = '中╬ ( •̀ ω •́ )y';
  const input = [{ text, underlined: true }];
  const runs = win.MaweAssFontAliases.resolveRuns(input, { fontName: 'Primary' });
  assert.equal(runs.map(r => r.text).join(''), text);
  assert.equal(input[0].fontName, undefined, 'source must remain unchanged');
  assert.equal(runs.find(r => r.text.includes('中')).fontName, 'SimHei');
  for (const mark of ['•̀', '•́']) {
    assert.equal(runs.find(r => r.text.includes(mark)).fontName, 'Arial');
  }
  assert.ok(runs.every(r => r.underlined));
  assert.equal(runs.find(r => r.fontName === 'Primary').fontEmRatio, undefined,
    'do not recalibrate already-supported primary glyphs');
  assert.equal(runs.find(r => r.fontName === 'Arial').fontEmRatio, .89);
  const italic = win.MaweAssFontAliases.resolveRuns(runs, { fontName: 'Primary', bold: true, italic: true });
  assert.equal(italic.find(r => r.fontName === 'Arial').fontEmRatio, .88,
    'font transform must invalidate face metrics');
});

test('managed fallback never substitutes a covered primary, complex span, emoji, or unknown primary', async () => {
  const coverage = coverageFixture();
  const win = await managedFonts(coverage);
  const alias = win.MaweAssFontAliases;
  assert.equal(alias.resolveRuns([{ text: '•̀' }], { fontName: 'Arial' })[0].fontName, 'Arial');
  for (const text of ['مرحبا •̀', 'कर्म •̀', '𞤀𞤢 •̀', '𑀓𑀭 •̀', '👩‍👩‍👧‍👧']) {
    const runs = alias.resolveRuns([{ text }], { fontName: 'Primary' });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].text, text);
    assert.equal(runs[0].fontName, undefined);
  }
  const emojiRuns = alias.resolveRuns([{ text: '🤔' }], { fontName: 'Primary' });
  assert.equal(emojiRuns[0].fontFallbackStatus, 'unmanaged-emoji');
  const missing = alias.resolveRuns([{ text: '中' }], { fontName: 'Not inventoried' });
  assert.equal(missing[0].fontFallbackStatus, 'unknown-primary');
  const uncovered = alias.resolveRuns([{ text: 'Ж' }], { fontName: 'Primary' });
  assert.equal(uncovered[0].fontFallbackStatus, 'uncovered');
});

test('ASS export and preview plan share explicit fallback runs with safe font restoration', async () => {
  const win = await managedFonts(coverageFixture());
  let plan;
  const text = '( •̀ ω •́ )y 中╬';
  const payload = win.AsrEditorUtils.buildAssPayload([{ start: 0, end: 2000, text }], {
    assMode: true, assProfile: {}, assStyle: { fontName: 'Primary', underline: true },
    onAssPlan: value => { plan = value; },
  });
  assert.match(payload, /\\fnArial/);
  assert.match(payload, /\\fnSimHei/);
  assert.match(payload, /\\fnPrimary/);
  assert.doesNotMatch(payload, /\\r[}\\]/);
  assert.ok(plan.slices[0].items[0].runs.some(r => r.fontName === 'Arial'));
  assert.equal(plan.slices[0].items[0].runs.map(r => r.text).join(''), text);
  const bad = coverageFixture(); bad.faces[2].family = 'Arial}\\r';
  const badWin = await managedFonts(bad);
  const badAss = badWin.AsrEditorUtils.buildAssPayload([{ start: 0, end: 1000, text: '•̀' }], {
    assMode: true, assProfile: {}, assStyle: { fontName: 'Primary' },
  });
  assert.doesNotMatch(badAss, /fnArial}\\r/);
});

test('fallback keeps the matchable candidate spelling rather than a locale-selected face family', async () => {
  const data = coverageFixture();
  data.faces[1].family = '微軟正黑測試';
  const win = await managedFonts(data);
  const runs = win.MaweAssFontAliases.resolveRuns([{ text: '中' }], { fontName: 'Primary' });
  assert.equal(runs[0].fontName, 'SimHei');
});

test('font inventory readiness settles on success and failure and resumes consumers', async () => {
  for (const ok of [true, false]) {
    let release;
    const events = [];
    const context = {
      window: { MaweBoot: { SERVER_CONFIG: { assFontAliasesUrl: '/api/ass-font-aliases' } },
        location: { href: 'http://localhost/' } },
      document: { dispatchEvent(event) { events.push(event.type); } },
      CustomEvent: class { constructor(type) { this.type = type; } }, URL,
      fetch: () => new Promise(resolve => { release = resolve; }),
    };
    vm.runInNewContext(fs.readFileSync(new URL('../web/editor/styles/editor-wiring-ass-font-aliases.js', import.meta.url), 'utf8'), context);
    const aliases = context.window.MaweAssFontAliases;
    assert.equal(aliases.pending(), true);
    let done = false;
    const waiter = aliases.whenReady().then(() => { done = true; });
    await Promise.resolve();
    assert.equal(done, false);
    release({ ok, json: async () => ({ schema: 'moy.asr.font_aliases.v1', fonts: [] }) });
    await waiter;
    assert.equal(aliases.pending(), false);
    assert.equal(aliases.loaded(), ok);
    assert.ok(events.includes('mawe:ass-font-aliases-settled'));
  }
});

test('stalled font request or JSON body times out, settles and can retry', async () => {
  for (const phase of ['fetch', 'json']) {
    let expire;
    let fail = true;
    const events = [];
    const context = {
      window: { MaweBoot: { SERVER_CONFIG: { assFontAliasesUrl: '/api/ass-font-aliases' } },
        location: { href: 'http://localhost/' },
        setTimeout(callback, ms) { assert.equal(ms, 30000); expire = callback; return 1; },
        clearTimeout() {} },
      document: { dispatchEvent(event) { events.push(event.type); } },
      CustomEvent: class { constructor(type) { this.type = type; } }, URL,
      fetch: () => fail && phase === 'fetch' ? new Promise(() => {}) : Promise.resolve({
        ok: true, json: () => fail ? new Promise(() => {})
          : Promise.resolve({ schema: 'moy.asr.font_aliases.v1', fonts: [] }),
      }),
    };
    vm.runInNewContext(fs.readFileSync(new URL('../web/editor/styles/editor-wiring-ass-font-aliases.js', import.meta.url), 'utf8'), context);
    const aliases = context.window.MaweAssFontAliases;
    await Promise.resolve();
    expire();
    await aliases.whenReady();
    assert.equal(aliases.pending(), false);
    assert.equal(aliases.loaded(), false);
    assert.ok(events.includes('mawe:ass-font-aliases-settled'));
    fail = false;
    await aliases.reload();
    assert.equal(aliases.loaded(), true);
  }
});

test('startup loads aliases only; concurrent ASS consumers share one lazy coverage request and readiness', async () => {
  const calls = [], events = [];
  let release;
  const context = {
    window: { MaweBoot: { SERVER_CONFIG: { assFontAliasesUrl: '/aliases', assFontCoverageUrl: '/coverage' } }, location: { href: 'http://localhost/' } },
    document: { dispatchEvent(event) { events.push(event.type); } },
    CustomEvent: class { constructor(type) { this.type = type; } }, URL,
    fetch: async url => {
      calls.push(new URL(url).pathname);
      return url.pathname === '/aliases'
        ? { ok: true, json: async () => ({ schema: 'moy.asr.font_aliases.v1', fonts: [] }) }
        : new Promise(resolve => { release = resolve; });
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/styles/editor-wiring-ass-font-aliases.js', import.meta.url), 'utf8'), context);
  const aliases = context.window.MaweAssFontAliases;
  await aliases.whenReady();
  assert.deepEqual(calls, ['/aliases']);
  assert.equal(aliases.coverageAvailable(), false);
  const first = aliases.ensureCoverage(), second = aliases.ensureCoverage();
  assert.equal(first, second);
  assert.equal(aliases.pending(), true);
  let ready = false;
  const waiter = aliases.whenReady().then(() => { ready = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ready, false);
  assert.deepEqual(calls, ['/aliases', '/coverage']);
  release({ ok: true, json: async () => coverageFixture() });
  await waiter;
  assert.equal(aliases.pending(), false);
  assert.equal(aliases.coverageAvailable(), true);
  assert.equal(events.filter(type => type === 'mawe:ass-font-aliases-loaded').length, 2);
  await aliases.ensureCoverage();
  assert.equal(calls.length, 2);
});

test('lazy coverage deadline includes JSON, settles legacy fallback and does not retry per frame', async () => {
  let expire;
  let coverageCalls = 0;
  const context = {
    window: { MaweBoot: { SERVER_CONFIG: { assFontAliasesUrl: '/aliases', assFontCoverageUrl: '/coverage' } },
      location: { href: 'http://localhost/' }, setTimeout(fn, ms) { assert.equal(ms, 30000); expire = fn; return 1; }, clearTimeout() {} },
    document: { dispatchEvent() {} }, CustomEvent: class {}, URL,
    fetch: async url => url.pathname === '/aliases'
      ? { ok: true, json: async () => ({ schema: 'moy.asr.font_aliases.v1', fonts: [] }) }
      : (++coverageCalls, { ok: true, json: () => new Promise(() => {}) }),
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/styles/editor-wiring-ass-font-aliases.js', import.meta.url), 'utf8'), context);
  const aliases = context.window.MaweAssFontAliases;
  await aliases.whenReady();
  const loading = aliases.ensureCoverage();
  await Promise.resolve(); await Promise.resolve();
  expire(); await loading; await aliases.whenReady();
  assert.equal(aliases.pending(), false);
  assert.equal(aliases.coverageAvailable(), false);
  for (let i = 0; i < 10; i++) await aliases.ensureCoverage();
  assert.equal(coverageCalls, 1);
  assert.equal(aliases.loaded(), true, 'light aliases remain usable after coverage timeout');
});

test('ASS output entry points explicitly await lazy coverage before serializing', () => {
  const read = file => fs.readFileSync(new URL(`../web/editor/${file}`, import.meta.url), 'utf8');
  const downloads = read('io/editor-wiring-export-actions.js');
  assert.equal((downloads.match(/await downloadPreparedAss\(/g) || []).length, 2);
  assert.ok(downloads.indexOf('await MaweHost.files.pickSaveFile') < downloads.indexOf('await loading'), 'ASS downloads retain picker activation');
  assert.match(read('io/editor-dynamic-exports.js'), /await window\.MaweAssFontAliases\?\.ensureCoverage\?\.\(\)/);
  assert.match(read('styles/editor-wiring-ass-frame.js'), /async function renderAssFrame\(\) {\s*await global\.MaweAssFontAliases\?\.ensureCoverage/);
  const burn = read('io/editor-wiring-burn-video.js');
  assert.ok(burn.indexOf('await MaweHost.files.pickSaveFile') < burn.indexOf('await fontsReady'), 'picker retains user activation while coverage loads');
  assert.match(burn, /if \(deferRequest\) {\s*await fontsReady/);
});
