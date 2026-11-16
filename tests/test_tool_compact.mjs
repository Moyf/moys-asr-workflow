import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('shared switches copy the authoritative OCR declarations without visual redesign', () => {
  const rules = css => [...css.matchAll(/\.switch[^{}]*\{[^{}]+\}/g)].map(match => match[0]);
  const reference = rules(read('tools/term-extract/term_extract/report.py'));
  const shared = read('tools/shared/tool-page.css');
  assert.equal(reference.length, 8);
  for (const rule of reference) assert.ok(shared.includes(rule), `Missing OCR rule: ${rule}`);
  assert.ok(!shared.includes('.tool-density::before'));
  const tokens = css => [css.match(/:root[^{}]*\{([^}]+)\}/)[1], css.match(/\[data-theme=["']?light["']?\]\s*\{([^}]+)\}/)[1]];
  const values = block => new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].replace(/\s/g, '')]));
  const ocr = tokens(read('tools/term-extract/term_extract/report.py')), actual = tokens(shared);
  for (let theme = 0; theme < 2; theme++) {
    for (const name of ['border', 'border-strong', 'shadow-1', 'text-primary', 'text-secondary', 'accent', 'accent-text']) {
      assert.equal(values(actual[theme]).get('--' + name), values(ocr[theme]).get('--' + name), name);
    }
  }
});

test('maintained compact controls are native switches, not styled buttons', () => {
  for (const path of ['tools/timestamp-compare.html', 'tools/dev-dashboard/index.html', 'tools/verification-checklist/templates/verification-checklist.html']) {
    const html = read(path);
    assert.match(html, /<label class="switch tool-density"(?: for="tool-compact-toggle")?><input (?:id="tool-compact-toggle" )?type="checkbox" data-tool-compact role="switch"><span class="switch-track" aria-hidden="true"><\/span>精简显示<\/label>/, path);
    assert.doesNotMatch(html, /<button[^>]*data-tool-compact/, path);
  }
  assert.match(read('tools/timestamp-compare.html'), /<input id="showItemText" type="checkbox" role="switch">\s*<span class="switch-track"/);
});

test('compact mode trims content rather than shrinking primary reading text', () => {
  for (const path of ['tools/verification-checklist/templates/verification-checklist.html', 'tools/dev-dashboard/style.css']) {
    const css = read(path);
    for (const match of css.matchAll(/\.tool-compact[^{}]*\{([^}]+)\}/g)) {
      assert.doesNotMatch(match[1], /font(?:-size)?\s*:/, path + ': ' + match[0]);
    }
  }
});

test('checklist compact checkbox has a stable explicit label and stays outside business items', () => {
  const html=read('tools/verification-checklist/templates/verification-checklist.html');
  assert.equal([...html.matchAll(/id="tool-compact-toggle"/g)].length,1);
  assert.match(html, /<label class="switch tool-density" for="tool-compact-toggle">/);
  assert.ok(html.indexOf('id="tool-compact-toggle"') < html.indexOf('<main class="content">'));
});
