import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import { initModuleSource } from './helpers/init-module-source.mjs';

function canvasFixture() {
  const paint = [];
  const measuredFonts = [];
  const fontListeners = new Map();
  const makeContext = () => new Proxy({
    letterSpacing: '0px',
    measureText(text) {
      measuredFonts.push(this.font);
      const size = Number(/([\d.]+)px/u.exec(this.font || '')?.[1]) || 100;
      return { width: text.length * size * 0.2, fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.2 };
    },
    fillText(text) { paint.push({ mode: 'fill', text, color: this.fillStyle, font: this.font }); },
    strokeText(text) { paint.push({ mode: 'stroke', text, color: this.strokeStyle, font: this.font }); },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const context = { window: {} };
  loadEditorModule(context, 'shared/editor-utils.js');
  context.window.MaweDom = { overlayEl: { prepend() {} } };
  context.window.MaweAppearance = { subtitleFontFamilyCss: () => 'sans-serif' };
  context.document = {
    createElement() { const ctx = makeContext(); return { getContext: () => ctx }; },
    fonts: { addEventListener(type, fn) { fontListeners.set(type, fn); } },
  };
  vm.runInNewContext(initModuleSource('editor/styles/editor-wiring-ass-canvas.js'), context);
  const style = context.window.AsrEditorUtils.normalizeAssStyle({ commentColor: '#111111', outline: 2, shadow: 0 });
  const track = { style, nativeFontSize: 72, runs: [{ text: 'comment', comment: true }] };
  const render = () => context.window.MaweAssCanvas.render({ playResX: 1920, playResY: 1080, tracks: [track] });
  return { paint, measuredFonts, fontListeners, track, render, context, canvas: context.window.MaweAssCanvas };
}

test('stacked fractional plain font sizes retain line advance and invalidate raster cache', () => {
  const { paint, track, render, canvas } = canvasFixture();
  track.runs = [{ text: Array(11).fill('M').join('\n') }];
  track.nativeFontSize = 41.4221;
  track.fractionalFontSize = true;
  render();
  assert.ok(Math.abs(canvas.lastRender.tracks[0].blockHeight - 41.4221 * 11) < 0.0001);
  paint.length = 0;
  track.nativeFontSize = 41.43;
  render();
  assert.ok(paint.length > 0, 'a fractional font-size update cannot reuse the old bitmap');
  assert.ok(Math.abs(canvas.lastRender.tracks[0].blockHeight - 41.43 * 11) < 0.0001);
});

test('changing the comment color repaints the cached line bitmap', () => {
  const { paint, track, render } = canvasFixture();
  render();
  assert.ok(paint.some(item => item.mode === 'fill' && item.color === '#111111'));
  paint.length = 0;
  track.style = { ...track.style, commentColor: '#ff0000' };
  render();
  assert.ok(paint.some(item => item.mode === 'fill' && item.color === '#ff0000'));
  // A subsequent unchanged frame should still reuse its rasterized bitmap.
  paint.length = 0;
  render();
  assert.equal(paint.length, 0);
});

test('changing comment text color to stroke color repaints both glyph layers', () => {
  const { paint, track, render } = canvasFixture();
  render();
  paint.length = 0;
  track.style = { ...track.style, commentStyle: 'stroke' };
  render();
  assert.ok(paint.some(item => item.mode === 'stroke' && item.color === '#111111'));
  assert.ok(paint.some(item => item.mode === 'fill' && item.color === track.style.primaryColor));
});

test('italic runs paint with the italic font face while sibling runs stay upright', () => {
  const { paint, track, render } = canvasFixture();
  track.runs = [{ text: 'normal' }, { text: '斜体', italic: true }];
  render();
  const italicPaint = paint.find(item => item.text === '斜体');
  const normalPaint = paint.find(item => item.text === 'normal');
  assert.ok(italicPaint && normalPaint, 'both runs are painted');
  assert.match(italicPaint.font, /^italic /);
  assert.doesNotMatch(normalPaint.font, /^italic /);
  // 样式级斜体已开启时，普通 run 也按斜体绘制；lineCacheKey 含 run 级斜体，
  // 同一 track 的斜体状态变化必须换新位图。
  paint.length = 0;
  track.style = { ...track.style, italic: true };
  render();
  assert.ok(paint.every(item => item.mode !== 'fill' || /^italic /.test(item.font)));
  paint.length = 0;
  track.style = { ...track.style, italic: false };
  track.runs = [{ text: 'normal' }];
  render();
  assert.doesNotMatch(paint.find(item => item.text === 'normal').font, /^italic /);
});


test('Canvas paints manual overlays above automatic main in ASS layer order', () => {
  const { context, track, canvas } = canvasFixture();
  const tracks = ['overlay', 'main', 'extension', 'overlay'].map((role, index) => ({ ...track,
    role, cueId: index, anchor: { x: 500, y: 500 }, runs: [{ text: role + index }] }));
  canvas.render({ playResX: 1920, playResY: 1080, tracks });
  assert.deepEqual(Array.from(canvas.lastRender.tracks, record => record.role), ['main', 'extension', 'overlay', 'overlay']);
  assert.deepEqual(tracks.map(item => item.role), ['overlay', 'main', 'extension', 'overlay'], 'input plan remains unchanged');
});

const systemSans = fs.readFileSync(new URL('../web/editor.css', import.meta.url), 'utf8')
  .match(/--font-sans:\s*([^;]+);/u)[1].trim();

async function fontFallbackFixture({ loaded = true, sans = systemSans } = {}) {
  const fixture = canvasFixture();
  const { context, track } = fixture;
  context.getComputedStyle = () => ({ getPropertyValue: () => sans });
  context.window.MaweAppearance.subtitleFontFamilyCss = name => `"${name}", var(--font-sans)`;
  track.style.fontName = '得意黑';
  track.runs = [{ text: '(╬￣皿￣)ノ' }];
  const config = {};
  context.window.MaweBoot = { SERVER_CONFIG: config };
  context.window.location = { href: 'http://localhost/' };
  context.URL = URL;
  context.CustomEvent = class {};
  context.document.dispatchEvent = () => {};
  context.fetch = async () => ({ ok: true, json: async () => ({
    schema: 'moy.asr.font_aliases.v1',
    fonts: [{ canonical: 'Smiley Sans', names: ['得意黑', 'Smiley Sans', 'SmileySans-Oblique'] }],
  }) });
  vm.runInNewContext(fs.readFileSync(new URL(
    '../web/editor/styles/editor-wiring-ass-font-aliases.js', import.meta.url), 'utf8'), context);
  if (loaded) {
    config.assFontAliasesUrl = '/api/ass-font-aliases';
    await context.window.MaweAssFontAliases.reload();
  }
  return fixture;
}

test('ASS Canvas retains aliases before the original cross-platform system fallback', async () => {
  const { context, paint, measuredFonts, render } = await fontFallbackFixture();
  const expected = `"得意黑", "Smiley Sans", "SmileySans-Oblique", ${systemSans}`;
  render();
  assert.ok(paint.length && measuredFonts.length);
  for (const font of [...paint.map(item => item.font), ...measuredFonts]) {
    assert.ok(font.endsWith(expected), font);
    assert.ok(!font.includes('var('), 'Canvas receives concrete font families');
  }
  assert.ok(systemSans.indexOf('Segoe UI') < systemSans.indexOf('Microsoft YaHei'));
  assert.ok(systemSans.indexOf('PingFang SC') < systemSans.indexOf('Microsoft YaHei'));
  assert.ok(systemSans.indexOf('Microsoft YaHei') < systemSans.indexOf('Noto Sans CJK SC'));
  // Other consumers keep the existing default; ASS export/canonicalization is not changed.
  assert.equal(context.window.MaweAssFontAliases.chainCssFor('得意黑'),
    '"得意黑", "Smiley Sans", "SmileySans-Oblique", sans-serif');
});

test('unloaded and unmatched alias tables retain the existing appearance fallback', async () => {
  for (const loaded of [false, true]) {
    const { track, paint, render } = await fontFallbackFixture({ loaded });
    track.style.fontName = loaded ? 'Unknown Font' : '得意黑';
    render();
    assert.ok(paint.length);
    assert.ok(paint.every(item => item.font.endsWith(`"${track.style.fontName}", ${systemSans}`)));
  }
});

test('empty system stack resolves to sans-serif, and font loading clears all font caches', async () => {
  const { context, track, paint, measuredFonts, fontListeners, render, canvas } = await fontFallbackFixture({ sans: '' });
  const measure = () => canvas.measureRun(track.style, 72, track.runs[0], '╬');
  render();
  measure();
  assert.ok(paint.every(item => item.font.endsWith(', sans-serif')));
  paint.length = 0;
  measuredFonts.length = 0;
  render();
  assert.equal(paint.length, 0, 'unchanged frames reuse raster cache');
  assert.ok(measuredFonts.every(font => !font.includes('100px')), 'font-box ratios remain cached');
  measuredFonts.length = 0;
  measure();
  assert.equal(measuredFonts.length, 0, 'unchanged measurements reuse metric cache');
  context.getComputedStyle = () => ({ getPropertyValue: () => systemSans });
  fontListeners.get('loadingdone')();
  render();
  measure();
  assert.ok(paint.length && measuredFonts.length, 'font loading invalidates raster and metric caches');
  assert.ok([...paint.map(item => item.font), ...measuredFonts].every(font => font.endsWith(systemSans)));
});

test('legacy DOM font-box measurement uses the same system fallback after aliases', async () => {
  const { context, track } = await fontFallbackFixture();
  const probes = [];
  context.document.addEventListener = () => {};
  context.document.body = { append(probe) { probes.push(probe); } };
  context.document.createElement = () => ({ style: {}, getBoundingClientRect: () => ({ height: 200 }), remove() {} });
  vm.createContext(context);
  vm.runInContext(initModuleSource('editor/styles/editor-wiring-ass-preview.js'), context);
  context.testStyle = track.style;
  assert.equal(vm.runInContext('assPreviewFontScale(testStyle)', context), 1);
  assert.equal(probes[0].style.fontFamily,
    '"得意黑", "Smiley Sans", "SmileySans-Oblique", var(--font-sans)');
});

test('Canvas uses selected fallback family and per-face ratio, with font-aware raster cache', () => {
  const { context, track, paint, render } = canvasFixture();
  context.window.MaweAppearance.subtitleFontFamilyCss = name => `"${name}"`;
  track.runs = [{ text: '•̀', fontName: 'Arial', fontEmRatio: .89 }];
  track.nativeFontSize = 100;
  render();
  assert.match(paint.find(p => p.mode === 'fill').font, /89px "Arial"/);
  paint.length = 0;
  track.runs = [{ text: '•̀', fontName: 'Different', fontEmRatio: .89 }];
  render();
  assert.match(paint.find(p => p.mode === 'fill').font, /89px "Different"/,
    'equal-width font change still invalidates line bitmap');
});

test('Canvas-only emoji hints leave original plan text untouched and use the displayed text for paint', () => {
  const { track, paint, render } = canvasFixture();
  track.runs = [{ text: '❤️ 👩‍👩‍👧‍👧 🤔' }];
  render();
  assert.equal(track.runs[0].text, '❤️ 👩‍👩‍👧‍👧 🤔');
  assert.equal(paint.find(p => p.mode === 'fill').text, '❤︎ 👩‍👩‍👧‍👧 🤔︎');
});

test('stack metric probes re-resolve a fallback face after bold/italic changes', () => {
  const { context, canvas, track } = canvasFixture();
  const probes = [];
  context.window.MaweAssFontAliases = { resolveRuns(runs, style) {
    probes.push([style.bold, style.italic]);
    return runs.map(run => ({ ...run, fontEmRatio: style.bold && style.italic ? .5 : 1 }));
  } };
  const run = { text: '•̀', fontName: 'Fallback', fontEmRatio: 1 };
  const normal = canvas.measureRun(track.style, 100, run, run.text);
  const italic = canvas.measureRun({ ...track.style, bold: true, italic: true }, 100, run, run.text);
  assert.ok(probes.some(([bold, italic]) => bold && italic));
  assert.equal(italic.width, normal.width / 2);
});
