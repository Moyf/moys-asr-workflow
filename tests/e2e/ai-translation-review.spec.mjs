import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = path.resolve('.artifacts/translation-review-e2e');
const python = process.env.MAW_E2E_PYTHON || 'python';
const helper = path.resolve('tests/helpers/generate-ai-review-fixture.py');
let cases;
test.beforeAll(() => {
  mkdirSync(directory, { recursive: true });
  execFileSync(python, [helper, directory], { timeout: 30000, stdio: 'pipe' });
  cases = JSON.parse(readFileSync(path.join(directory, 'cases.json'), 'utf8'));
});

for (const mode of ['single', 'backfill', 'bilingual']) {
  test(`offline ${mode} translation edits export a reopenable MOSP while retaining other data`, async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(cases[mode].html).href);
    const input = page.getByRole('textbox', { name: '译文 main-001', exact: true });
    await expect(input).toHaveValue('Introduce the API.');
    await expect(page.getByText('[AI] 注：API 指接口；<script>window.__bad=true</script>', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__bad)).toBeUndefined();
    await input.fill('');
    await expect(page.locator('#download-project')).toBeDisabled();
    await expect(page.locator('#edit-status')).toContainText('译文为空');
    await input.fill('Explain the API clearly.');
    await page.locator('#search').fill('It processes');
    await expect(input).toHaveCount(0);
    await page.locator('#search').fill('');
    await expect(input).toHaveValue('Explain the API clearly.');
    const distances = await page.locator('#edit-actions').evaluate(node => ({
      buttons: parseFloat(getComputedStyle(node.querySelector('.edit-buttons')).marginTop),
      status: parseFloat(getComputedStyle(node.querySelector('#edit-status')).marginTop),
    }));
    expect(distances.buttons).toBeGreaterThanOrEqual(8);
    expect(distances.status).toBeGreaterThanOrEqual(8);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download-project').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/核对后\.mosp$/);
    const output = testInfo.outputPath('edited.mosp');
    await download.saveAs(output);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    const expected = JSON.parse(readFileSync(cases[mode].project, 'utf8'));
    const target = mode === 'backfill' ? expected.segments[0] : expected.multi_subtitle.tracks[0].segments[0];
    target.text = 'Explain the API clearly.';
    delete target.items;
    target._dirty = true;
    expect(result).toEqual(expected);
    if (mode !== 'backfill') {
      const source = JSON.parse(readFileSync(cases[mode].source, 'utf8'));
      expect(result.segments).toEqual(source.segments);
      expect(result.multi_subtitle.tracks).toHaveLength(1);
      expect(result.multi_subtitle.tracks[0].id).toBe('fixed-secondary');
      expect(result.multi_subtitle.tracks[0].segments).toHaveLength(2);
      expect(JSON.stringify(result.multi_subtitle)).not.toContain('过期译文');
      expect(result.multi_subtitle.bindings[0].id).toBe('existing-binding');
    }
    execFileSync(python, [helper, '--validate', output], { timeout: 30000, stdio: 'pipe' });
    await page.screenshot({ path: testInfo.outputPath('translation-review.png'), fullPage: true });
    await page.locator('#reset-translations').click();
    await expect(input).toHaveValue('Introduce the API.');
    await expect(page.locator('#edit-status')).toContainText('手动修改 0 条');
    expect(errors).toEqual([]);
  });
}

test('offline bilingual boundary text preserves whitespace and literal template tokens', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(cases.boundary.html).href);
  const input = page.getByRole('textbox', { name: '译文 main-space', exact: true });
  await expect(input).toHaveValue('API');
  await expect(page.getByRole('textbox', { name: '译文 main-token', exact: true }))
    .toHaveValue('translated {{REVIEW_SCRIPT}} {{DATA}}');
  expect(await page.evaluate(() => window.__bad)).toBeUndefined();
  await input.fill('Explain API');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-project').click();
  const output = testInfo.outputPath('boundary-edited.mosp');
  await (await downloadPromise).saveAs(output);
  const result = JSON.parse(readFileSync(output, 'utf8'));
  const expected = JSON.parse(readFileSync(cases.boundary.project, 'utf8'));
  expected.segments[0].text = ' API \nExplain API';
  delete expected.segments[0].items;
  expected.segments[0]._dirty = true;
  expect(result).toEqual(expected);
  execFileSync(python, [helper, '--validate', output], { timeout: 30000, stdio: 'pipe' });
  await page.locator('#reset-translations').click();
  await expect(input).toHaveValue('API');
  await page.screenshot({ path: testInfo.outputPath('boundary-review.png'), fullPage: true });
  expect(errors).toEqual([]);
});
