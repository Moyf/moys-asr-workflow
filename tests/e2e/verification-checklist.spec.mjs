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

test('JSON checklist preserves progress and notes and exports pending and noted IDs', async ({ page }, testInfo) => {
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
  await page.goto(generate(testInfo));
  await expect(page.locator('#num')).toHaveText('0 / 2');
  await expect(page.locator('#toc a')).toHaveCount(3);
  await expect(page.locator('#export-scope')).toHaveValue('unconfirmed');
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
  expect(result.summary.exported).toBe(2);
  expect(result.sections[0].items.map(item => item.id)).toEqual(['manual-persistence', 'manual-export']);
  expect(result.sections[0].items[0].confirmed).toBe(true);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('default auto-collapse preserves an explicitly disabled preference after reload', async ({ page }, testInfo) => {
  await page.goto(generate(testInfo));
  const toggle = page.locator('#auto-collapse-completed');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#manual-persistence').check();
  await page.locator('#manual-export').check();
  await expect(page.locator('#manual')).not.toHaveAttribute('open');
  await expect(page.locator('#export-json')).toBeDisabled();
  await toggle.click();
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#expand').click();
  await page.locator('#manual-export').uncheck();
  await page.locator('#manual-export').check();
  await expect(page.locator('#manual')).toHaveAttribute('open', '');
  const item = page.locator('#manual .item').first();
  await item.locator('.note-toggle').click();
  await item.locator('textarea').fill('已确认但仍有反馈');
  await expect(page.locator('#export-json')).toBeEnabled();
  await item.locator('textarea').fill(' \n\t ');
  await expect(page.locator('#export-json')).toBeDisabled();
});

test('reset cancellation preserves checks, ignored groups and notes; acceptance clears only progress', async ({ page }, testInfo) => {
  await page.goto(generate(testInfo));
  await page.locator('#manual-persistence').check();
  const item = page.locator('#manual .item').first();
  await item.locator('.note-toggle').click();
  await item.locator('textarea').fill('保留的备注');
  await page.locator('#manual summary').hover();
  await page.locator('#manual .sec-ignore').click();
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#reset').click();
  await expect(page.locator('#manual-persistence')).toBeChecked();
  await expect(page.locator('#manual')).toHaveClass(/ignored/);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(before);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#reset').click();
  await expect(page.locator('#manual-persistence')).not.toBeChecked();
  await expect(page.locator('#manual')).not.toHaveClass(/ignored/);
  await page.reload();
  await expect(item.locator('textarea')).toHaveValue('保留的备注');
});

test('copy uses item text only and reports clipboard rejection', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.copiedItem = text; },
    } });
  });
  await page.goto(generate(testInfo));
  const item = page.locator('#manual .item').first();
  const text = (await item.locator('label').textContent()).replace(/\s+/g, ' ').trim();
  await item.locator('.note-toggle').click();
  await item.locator('textarea').fill('备注不能混入复制文本');
  await item.locator('.item-copy').click();
  expect(await page.evaluate(() => window.copiedItem)).toBe(text);
  await expect(page.locator('#manual-persistence')).not.toBeChecked();
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
  await item.locator('.item-copy').click();
  await expect(page.locator('#save-status')).toContainText('复制失败');
});

test('clipboard failure preserves an existing storage warning and in-memory notes', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(Storage.prototype, 'setItem', { value() { throw new Error('storage blocked'); } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new Error('clipboard denied'); },
    } });
  });
  await page.goto(generate(testInfo));
  const item = page.locator('#manual .item').first();
  await item.locator('.note-toggle').click();
  await item.locator('textarea').fill('存储失败仍保留的备注');
  const status = page.locator('#save-status');
  await expect(status).toContainText('本机存储不可用');
  await item.locator('.item-copy').click();
  await expect(status).toContainText('本机存储不可用');
  await expect(status).toContainText('请导出 JSON');
  await expect(status).toContainText('复制失败');
  await expect(status).toHaveClass(/warning/);
  await expect(item.locator('textarea')).toHaveValue('存储失败仍保留的备注');
  await page.locator('#manual-persistence').check();
  await expect(status).toContainText('本机存储不可用');
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
