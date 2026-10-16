import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const builder = fileURLToPath(new URL('../../tools/verification-checklist/build.py', import.meta.url));
const example = fileURLToPath(new URL('../../tools/verification-checklist/examples/checklist.json', import.meta.url));

function generate(testInfo, update = () => {}, format = 'json') {
  const source = JSON.parse(readFileSync(example, 'utf8'));
  update(source);
  const data = testInfo.outputPath('source.json');
  const output = testInfo.outputPath('checklist.html');
  writeFileSync(data, JSON.stringify(source), 'utf8');
  const run = args => execFileSync(process.env.MAW_E2E_PYTHON || 'python', [builder, ...args], {
    env: { ...process.env, PYTHONUTF8: '1' }, timeout: 15_000, maxBuffer: 64 * 1024,
  });
  let input = data;
  if (format === 'markdown') {
    input = testInfo.outputPath('source.checklist.md');
    run(['--to-md', data, '--meta', 'task=checklist-regression', '--meta', 'status=pending', '--output', input]);
    run(['--check', input]);
  }
  run(['--data', input, '--output', output]);
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

test('Markdown source generates unchecked items with the same default export behavior', async ({ page }, testInfo) => {
  await page.goto(generate(testInfo, source => {
    for (const section of source.sections) {
      delete section.open;
      for (const block of section.blocks) if (block.type === 'text') block.type = 'note';
    }
  }, 'markdown'));
  await expect(page.locator('#num')).toHaveText('0 / 2');
  await expect(page.locator('#manual-persistence')).not.toBeChecked();
  await expect(page.locator('#export-scope')).toHaveValue('unconfirmed');
  await expect(page.locator('#auto-collapse-completed')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.item-copy')).toHaveCount(2);
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
  for (const id of ['export-json', 'export-md', 'copy-md']) {
    await expect(page.locator(`#${id}`)).toBeEnabled();
  }
  await item.locator('textarea').fill(' \n\t ');
  for (const id of ['export-json', 'export-md', 'copy-md']) {
    await expect(page.locator(`#${id}`)).toBeDisabled();
  }
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
  const purpose = (await item.locator('.item-purpose').textContent()).trim();
  await item.locator('.note-toggle').click();
  await item.locator('textarea').fill('备注不能混入复制文本');
  await item.locator('.item-copy').click();
  const copied = await page.evaluate(() => window.copiedItem);
  expect(copied.split('\n')[0]).toBe(purpose);
  expect(copied).toContain('（操作）');
  expect(copied).toContain('（预期）');
  expect(copied).not.toContain('备注不能混入复制文本');
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
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.locator('#copy-md').click();
  await expect(status).toContainText('本机存储不可用');
  await expect(status).toContainText('导出 Markdown');
  await expect(status).toContainText('复制失败');
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
  await page.locator('#export-scope').selectOption('all');

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
  expect(markdown).toContain('- [x] 勾选与备注在刷新后保留\n  （操作）生成的 HTML 页面 → 勾选本项，点击备注填写两行文字，然后刷新\n  （预期）勾选与备注仍保留，进度显示 1 / 2\n  <!-- id: manual-persistence -->');
  expect(markdown).toContain('  > 第一行\n  > <script>仅为备注文本</script>');
  expect(markdown).toContain('- [ ] 默认导出范围为未确认与备注并集\n  （操作）侧栏导出范围 → 选择默认范围并导出 JSON\n  （预期）包含未确认或有非空备注的项目，排除忽略组，保留稳定 ID 与备注\n  <!-- id: manual-export -->');
  expect(errors).toEqual([]);

  await page.locator('#export-scope').selectOption('unconfirmed');
  const pendingDownload = page.waitForEvent('download');
  await page.locator('#export-md').click();
  const pending = readFileSync(await (await pendingDownload).path(), 'utf8');
  expect(pending).toContain('> 导出范围：仅未确认和备注项');
  expect(pending).toContain('- [ ] 默认导出范围为未确认与备注并集');
  expect(pending).not.toContain('## 实现 / 审查结论');
  expect(pending).toContain('第一行');
  expect(pending).toContain('<!-- id: manual-persistence -->');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.copiedMarkdown = text; },
    } });
  });
  await page.locator('#copy-md').click();
  const copied = await page.evaluate(() => window.copiedMarkdown);
  expect(copied).toContain('导出范围：仅未确认和备注项');
  expect(copied).toContain('第一行');
  expect(copied).toContain('<!-- id: manual-persistence -->');
});

test('export buttons disable when nothing is exportable in unconfirmed scope', async ({ page }, testInfo) => {
  await page.goto(generate(testInfo));
  await page.locator('#manual-persistence').check();
  await page.locator('#manual-export').check();
  await page.locator('#export-scope').selectOption('unconfirmed');
  for (const id of ['export-json', 'export-md', 'copy-md']) {
    await expect(page.locator(`#${id}`)).toBeDisabled();
  }
  await page.locator('#expand').click();
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
