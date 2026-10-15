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

test('markdown export mirrors confirmations and notes and disables with no exportable items', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(generate(testInfo));
  await expect(page.locator('#export-md')).toBeVisible();
  await expect(page.locator('#copy-md')).toBeVisible();
  await page.locator('#manual-persistence').check();
  const first = page.locator('#manual .item').first();
  await first.locator('.note-toggle').click();
  await first.locator('textarea').fill('第一行\n<script>仅为备注文本</script>');

  const downloaded = page.waitForEvent('download');
  await page.locator('#export-md').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/-全部-\d{4}-\d{2}-\d{2}\.md$/);
  const markdown = readFileSync(await download.path(), 'utf8');
  expect(markdown).toMatch(/^# MAW 核查清单 · JSON 生成示例 · 核对结果\n/);
  expect(markdown).toContain('> 导出范围：全部核对项');
  expect(markdown).toContain('## 人工核验');
  expect(markdown).not.toContain('## 实现 / 审查结论');
  expect(markdown).not.toContain('## 自动化验证证据');
  expect(markdown).toContain('- [x] 生成的 HTML 页面 → 勾选本项，点击备注填写两行文字，然后刷新 → 勾选与备注仍保留，进度显示 1 / 2 <!-- id: manual-persistence -->');
  expect(markdown).toContain('  > 第一行\n  > <script>仅为备注文本</script>');
  expect(markdown).toContain('- [ ] 侧栏导出范围 → 选择仅未确认项并导出 JSON → 只包含未勾选项目，保留稳定 ID 与备注 <!-- id: manual-export -->');
  expect(errors).toEqual([]);

  await page.locator('#export-scope').selectOption('unconfirmed');
  const pendingDownload = page.waitForEvent('download');
  await page.locator('#export-md').click();
  const pending = readFileSync(await (await pendingDownload).path(), 'utf8');
  expect(pending).toContain('> 导出范围：仅未确认项');
  expect(pending).toContain('- [ ] 侧栏导出范围 → 选择仅未确认项并导出 JSON → 只包含未勾选项目，保留稳定 ID 与备注 <!-- id: manual-export -->');
  expect(pending).not.toContain('## 实现 / 审查结论');
  expect(pending).not.toContain('第一行');
});

test('export buttons disable when nothing is exportable in unconfirmed scope', async ({ page }, testInfo) => {
  await page.goto(generate(testInfo));
  await page.locator('#manual-persistence').check();
  await page.locator('#manual-export').check();
  await page.locator('#export-scope').selectOption('unconfirmed');
  for (const id of ['export-json', 'export-md', 'copy-md']) {
    await expect(page.locator(`#${id}`)).toBeDisabled();
  }
  await page.locator('#manual-export').uncheck();
  for (const id of ['export-json', 'export-md', 'copy-md']) {
    await expect(page.locator(`#${id}`)).toBeEnabled();
  }
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
