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
