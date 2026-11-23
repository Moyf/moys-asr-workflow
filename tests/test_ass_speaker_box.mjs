import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';


const window = loadEditorModule({ window: {} }, 'shared/editor-utils.js');
const cue = { start: 0, end: 2000, text: 'HELLO WORLD', color: { name: 'red' } };
const style = {
  fontName: 'Arial', fontSize: 144, borderStyle: 3, alignment: 5, outline: 20,
  shadow: 0, primaryColor: '#ffffff', outlineColor: '#000000', outlineOpacity: 50,
};
const options = {
  playResX: 640, playResY: 360, assProfile: {}, assStyle: style,
  speakerLabelsEnabled: true, speakerLabels: { red: 'MOY' }, speakerLabelSeparator: ': ',
  appearance: { ass_color_style: 'speaker' },
};
const render = (segment = cue, overrides = {}) =>
  window.AsrEditorUtils.buildAssPayload([segment], { ...options, ...overrides });
const events = ass => ass.match(/^Dialogue: .*$/gm) || [];
const hideText = String.raw`{\1a&HFF&\2a&HFF&`;
const hideBox = String.raw`{\3a&HFF&\4a&HFF&}`;

test('speaker box and text stay consecutive on the original track and clock', () => {
  const ass = render(cue, {
    pngEventNames: true,
    assStyle: { ...style, fontSize: 90, alignment: 2, marginV: 65 },
    assExtensionStyle: { ...style, fontSize: 66, alignment: 2, marginV: 12 },
    extensionSegments: [{ ...cue, start: 500, end: 1000, text: 'EXT' }],
    overlaySegments: [{ ...cue, start: 500, end: 1000, text: 'OVERLAY' }],
  });
  const lines = events(ass);
  assert.equal(lines.length, 10);
  assert.deepEqual(lines.map(line => line.split(',')[0]), [0, 0, 0, 0, 1, 1, 2, 2, 0, 0]
    .map(layer => `Dialogue: ${layer}`));
  for (let index = 0; index < lines.length; index += 2) {
    const [box, text] = lines.slice(index, index + 2);
    assert.equal(box.split(',,')[0], text.split(',,')[0]);
    assert.ok(box.includes(hideText) && text.includes(hideBox));
    const geometry = line => line.match(/\\(?:pos|move)\([^)]*\)/u)?.[0];
    assert.equal(geometry(box), geometry(text));
  }
});

test('ordinary opening punctuation keeps a shared speaker box', () => {
  for (const text of [
    '"Good morning."', "'Good morning.'", '“你来啦。”', '‘你来啦。’',
    '「おはよう」', '『再试一次』', '＂你好＂', '＇你好＇', '(continued)', '（接上回）',
    '——我有一个问题。', '……我想想。', '  “等等。”', '\n「你好。」',
  ]) {
    for (const speakerLabelSeparator of ['：', ': ']) {
      const pair = events(render({ ...cue, text }, { speakerLabelSeparator }));
      const context = JSON.stringify({ text, speakerLabelSeparator });
      assert.equal(pair.length, 2, context);
      assert.ok(pair[0].includes(hideText) && pair[1].includes(hideBox), context);
    }
  }
});

test('manually positioned speaker boxes follow all three v2 foreground layers', () => {
  const manual = { ...cue, assOverride: { pos: { x: 170, y: 140 } } };
  const lines = events(render(manual, { assExtensionStyle: style, extensionSegments: [manual], overlaySegments: [manual] }));
  assert.deepEqual(lines.map(line => line.split(',')[0]), [3, 3, 4, 4, 5, 5].map(layer => `Dialogue: ${layer}`));
  for (const line of lines) assert.match(line, /\\pos\(170,140\)/u);
});

test('mixed typography and unsupported shaping preserve the existing Dialogue', () => {
  const larger = render({ ...cue, text: '**HELLO** WORLD' }, {
    assStyle: { ...style, emphasisScale: 1.7 },
  });
  assert.equal(events(larger).length, 1);
  assert.ok(events(larger)[0].includes(String.raw`\fs72`));
  for (const ass of [
    render({ ...cue, text: '**HELLO** WORLD' }, {
      assStyle: { ...style, emphasisScale: 1, emphasisStyle: 'stroke' },
    }),
    render(cue, { assProfile: { animations: { t: { enabled: true, tags: String.raw`\frx30` } } } }),
    render({ ...cue, text: 'سلام' }),
    render({ ...cue, text: String.raw`HELLO \N WORLD` }),
    render({ ...cue, text: '“سلام”' }),
    render({ ...cue, text: String.raw`“Quoted \N text”` }),
    render({ ...cue, text: '“**HELLO**” WORLD' }, {
      assStyle: { ...style, emphasisScale: 1.7 },
    }),
    render({ ...cue, text: '“HELLO WORLD”' }, { speakerLabelSeparator: ':' }),
    render({ ...cue, text: '¿HELLO WORLD?' }),
    render(cue, {
      speakerLabels: { red: 'TV' }, speakerLabelSeparator: ':',
      assStyle: { ...style, fontName: 'Smiley Sans Oblique', fontSize: 300, marginL: 62, marginR: 62, outline: 1 },
    }),
    render(cue, { speakerLabelSeparator: '' }),
    render(cue, { colorStyles: [{ name: 'red', value: '#ffffff' }] }),
    render(cue, { speakerLabelsEnabled: false }),
    render(cue, { assStyle: { ...style, borderStyle: 1 } }),
  ]) {
    assert.equal(events(ass).length, 1);
    assert.ok(!events(ass)[0].includes(hideText) && !events(ass)[0].includes(hideBox));
  }
  try {
    window.MaweAssFontAliases = {
      resolveRuns: runs => runs.map(run => run.text.includes('你好')
        ? { ...run, fontName: 'Hiragino Sans GB' } : run),
    };
    const fallbackEvents = events(render({ ...cue, text: '你好' }));
    assert.equal(fallbackEvents.length, 1);
    const [fallback] = fallbackEvents;
    assert.match(fallback, /\\fnHiragino Sans GB/u);
  } finally {
    delete window.MaweAssFontAliases;
  }
});

const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 5000 });
const hasLibass = filters.status === 0 && /\bass\s+V->V/u.test(filters.stdout);
const skipWithoutLibass = hasLibass ? false : 'FFmpeg with libass is unavailable';

function frameRenderer() {
  const root = '.artifacts/ass-speaker-box';
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'regression-'));
  return (name, ass, time = 500) => {
    writeFileSync(join(dir, `${name}.ass`), ass, { flag: 'wx' });
    const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error',
      '-filter_threads', '1', '-f', 'lavfi', '-i', 'color=white:s=640x360,format=rgb24',
      '-vf', `settb=1/1000,setpts=${time},ass=filename=${name}.ass`, '-frames:v', '1',
      '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
    { cwd: dir, timeout: 10000 });
    writeFileSync(join(dir, `${name}.log`), result.stderr || Buffer.alloc(0), { flag: 'wx' });
    assert.equal(result.status, 0, result.stderr?.toString() || String(result.error));
    assert.equal(result.stdout.length, 640 * 360 * 3);
    const ppm = Buffer.concat([Buffer.from('P6\n640 360\n255\n'), result.stdout]);
    writeFileSync(join(dir, `${name}.ppm`), ppm, { flag: 'wx' });
    return result.stdout;
  };
}

test('libass aligns native box and glyph layers and removes speaker-seam pixels', {
  skip: skipWithoutLibass,
}, () => {
  const frame = frameRenderer();
  const ass = render();
  const [box, text] = events(ass);
  const originalText = text ? text.replace(hideBox, '') : box;
  const header = ass.slice(0, ass.indexOf('Dialogue:'));
  const raw = frame('old', header + originalText + '\n');
  const fixed = frame('new', ass);
  let seams = 0;
  for (let index = 0; index < raw.length; index += 3) {
    if (raw[index] !== 64 || raw[index + 1] !== 64 || raw[index + 2] !== 64) continue;
    seams++;
    assert.deepEqual([...fixed.subarray(index, index + 3)], [128, 128, 128]);
  }
  assert.ok(seams > 200, 'the fixture must reproduce the original seam');
  const onlyBox = frame('box', header + box + '\n');
  const onlyText = frame('text', header + text + '\n');
  let glyphs = 0;
  for (let index = 0; index < raw.length; index += 3) {
    if (onlyText[index] !== 240 || onlyText[index + 1] !== 127 || onlyText[index + 2] !== 111) continue;
    glyphs++;
    assert.deepEqual([...onlyBox.subarray(index, index + 3)], [128, 128, 128]);
    assert.deepEqual([...raw.subarray(index, index + 3)], [...fixed.subarray(index, index + 3)]);
  }
  assert.ok(glyphs > 100, 'the box must sit beneath the original opaque glyphs');
});

test('libass removes the opening-quote seam and preserves glyph positions on wrapped lines', {
  skip: skipWithoutLibass,
}, () => {
  const frame = frameRenderer();
  const glyphHeight = new Map();
  for (const [name, text, margin] of [
    ['wide', '"Wait for me," she said.', 10],
    ['wrapped', '"Wait for me," she said.', 155],
    ['hard-break', '"Wait for me,"\nshe said.', 10],
  ]) {
    const ass = render({ ...cue, text }, {
      assStyle: { ...style, primaryColor: '#3ea4f2', marginL: margin, marginR: margin },
    });
    const pair = events(ass);
    const header = ass.slice(0, ass.indexOf('Dialogue:'));
    const original = pair.at(-1).replace(hideBox, '');
    const frameFor = (kind, line) => frame(`${name}-${kind}`, header + line + '\n');
    const raw = frameFor('old', original);
    const fixed = frame(`${name}-new`, ass);
    let restored = 0;
    for (let index = 0; index < raw.length; index += 3) {
      if (raw[index] === 64 && raw[index + 1] === 64 && raw[index + 2] === 64
          && fixed[index] === 128 && fixed[index + 1] === 128 && fixed[index + 2] === 128) {
        restored++;
      }
    }
    assert.ok(restored > 200, `${name} must remove the original speaker seam (${restored} pixels restored)`);
    assert.equal(pair.length, 2, name);
    const textAt = original.indexOf(',,') + 2;
    const originalBox = frameFor('old-box', original.slice(0, textAt) + hideText + '}' + original.slice(textAt));
    const box = frameFor('box', pair[0]);
    const glyphs = frameFor('text', pair[1]);
    const stride = 640 * 3;
    const rows = new Set();
    let speakerPixels = 0;
    let bodyPixels = 0;
    for (let index = 0; index < raw.length; index += 3) {
      const covered = box[index] < 255;
      if (covered !== (originalBox[index] < 255)) {
        const other = covered ? originalBox : box;
        const column = index % stride;
        // Combined runs can round the edge bitmap differently by one pixel.
        const nearEdge = [-stride, 0, stride].some(row =>
          [-3, 0, 3].some(dx => column + dx >= 0 && column + dx < stride && other[index + row + dx] < 255));
        assert.ok(nearEdge, `${name} must retain the original box edges`);
      }
      const contrast = image => image[index] - image[index + 2];
      const glyph = contrast(glyphs);
      assert.ok(Math.abs(contrast(raw) - contrast(fixed)) <= 1, `${name} must preserve glyph geometry`);
      if (Math.abs(glyph) <= 10) continue;
      assert.ok(Math.abs(glyph - contrast(fixed)) <= 1, `${name} must keep both glyph colours`);
      if (originalBox[index] < 255) {
        assert.ok(box[index] < 255, `${name} must keep the box under the original glyphs`);
      }
      rows.add(Math.floor(index / stride));
      if (glyph > 0) speakerPixels++;
      else bodyPixels++;
    }
    assert.ok(speakerPixels > 100 && bodyPixels > 100, name);
    glyphHeight.set(name, Math.max(...rows) - Math.min(...rows));
  }
  assert.ok(glyphHeight.get('wrapped') > glyphHeight.get('wide'), 'the narrow fixture must auto-wrap');
  assert.ok(glyphHeight.get('hard-break') > glyphHeight.get('wide'), 'the hard break must render a second line');
});

test('libass aligns both layers through move, fades, size and alpha transforms', {
  skip: skipWithoutLibass,
}, () => {
  const frame = frameRenderer();
  const ass = render(cue, {
    assStyle: { ...style, primaryColor: '#3ea4f2', backColor: '#000000', shadow: 3 },
    assProfile: { animations: {
      move: { enabled: true, x1: 240, y1: 145, x2: 365, y2: 200, t1: 0, t2: 1500 },
      fad: { enabled: true, inMs: 300, outMs: 350 },
      t: { enabled: true, startMs: 0, endMs: 1600,
        tags: String.raw`\fs60\frz15\alpha&H60&\shad6` },
    } },
  });
  const pair = events(ass);
  assert.equal(pair.length, 2);
  const [box, text] = pair;
  const header = ass.slice(0, ass.indexOf('Dialogue:'));
  const original = header + text.replace(hideBox, '') + '\n';
  for (const time of [100, 500, 1400, 1800]) {
    const raw = frame(`motion-old-${time}`, original, time);
    const fixed = frame(`motion-new-${time}`, ass, time);
    const onlyBox = frame(`motion-box-${time}`, header + box + '\n', time);
    const onlyText = frame(`motion-text-${time}`, header + text + '\n', time);
    let label = 0, body = 0;
    for (let index = 0; index < raw.length; index += 3) {
      const contrast = image => image[index] - image[index + 2];
      const glyph = contrast(onlyText);
      assert.equal(contrast(onlyBox), 0, 'the box must never paint text, even inside an alpha transform');
      assert.ok(Math.abs(contrast(raw) - contrast(fixed)) <= 1,
        `glyph colour and placement must survive at ${time} ms`);
      if (glyph > 10) label++;
      else if (glyph < -10) body++;
      else continue;
      assert.ok(onlyBox[index] < 255, `both kinds of glyph must sit in the box at ${time} ms`);
      assert.ok(Math.abs(glyph - contrast(fixed)) <= 1,
        `the composite must retain the glyph colour at ${time} ms`);
    }
    assert.ok(label > 100 && body > 100, `both colours must be visible at ${time} ms`);
  }
});
