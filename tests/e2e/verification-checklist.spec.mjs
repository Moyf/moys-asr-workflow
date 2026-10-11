import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const builder = fileURLToPath(new URL('../../tools/verification-checklist/build.py', import.meta.url));
const example = fileURLToPath(new URL('../../tools/verification-checklist/examples/checklist.json', import.meta.url));

function generate(testInfo, update = () => {}) {
  const source = JSON.parse(readFileSync(example, 'utf8'));
  update(source);
  const data = testInfo.outputPath('source.json');
  const output = testInfo.outputPath('checklist.html');
  writeFileSync(data, JSON.stringify(source), 'utf8');
  execFileSync(process.env.MAW_E2E_PYTHON || 'python', [builder, '--data', data, '--output', output], {
    env: { ...process.env, PYTHONUTF8: '1' }, timeout: 15_000, maxBuffer: 64 * 1024,
  });
  return pathToFileURL(output).href;
}

test('JSON checklist preserves progress and notes and exports stable unconfirmed IDs', async ({ page }, testInfo) => {
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
  await page.goto(generate(testInfo));
  await expect(page.locator('#num')).toHaveText('0 / 2');
  await expect(page.locator('#toc a')).toHaveCount(3);
  await page.locator('#manual-persistence').check();
  const first = page.locator('#manual .item').first();
  await first.locator('.note-toggle').click();
  await first.locator('textarea').fill('第一行\n<script>仅为备注文本</script>');
  await page.reload();
  await expect(page.locator('#manual-persistence')).toBeChecked();
  await expect(first.locator('textarea')).toHaveValue('第一行\n<script>仅为备注文本</script>');
  await expect(page.locator('#num')).toHaveText('1 / 2');
  await page.locator('#export-scope').selectOption('unconfirmed');
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const download = await downloaded;
  const result = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(result.schema).toBe('maw.verification-checklist.v1');
  expect(result.summary.exported).toBe(1);
  expect(result.sections[0].items.map(item => item.id)).toEqual(['manual-export']);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('JSON command whitespace and long metadata survive rendering at narrow widths', async ({ page }, testInfo) => {
  await page.goto(generate(testInfo, source => {
    source.title = 'T'.repeat(480);
    source.subtitle = 'S'.repeat(560);
    source.sections[0].title = 'G'.repeat(640);
    source.sections[1].open = true;
    source.sections[1].blocks[0].text = '\n\tpython verify.py\n';
    source.sections[2].badge.text = 'B'.repeat(300);
  }));
  expect(await page.locator('.cmd').textContent()).toBe('\n\tpython verify.py\n');
  for (const width of [1440, 980, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});
