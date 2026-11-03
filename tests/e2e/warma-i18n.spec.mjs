import { expect, test } from '@playwright/test';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';

let server, dir;
test.beforeAll(async () => { dir = makeTempDir('warma-i18n'); server = await startBlankServer(await findFreePort(), dir); });
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.segments = [{ id: 'one', start: 0, end: 2000, text: '嗯 test', items: null }];
    MaweCuePanel.renderAll();
  });
});

test('ASS style choices follow language while custom names remain literal', async ({ page }) => {
  await expect(page.locator('#ass-style-library-status')).toHaveAttribute('data-state', 'success');
  await page.evaluate(() => {
    const styles = MaweAssStorageWiring.styles();
    styles.push({ ...styles.find(style => style.id === 'ass'), id: 'custom-style', name: 'ASS 默认样式', builtin: false });
    MaweCuePanel.setCuePanelTarget('main', 0);
  });
  const select = page.locator('#cue-ass-style');
  await expect(select.locator('option[value="ass"]')).toHaveText('ASS default style');
  await expect(select.locator('option[value="custom-style"]')).toHaveText('ASS 默认样式');
  await select.selectOption('custom-style');
  await expect(select.locator('option[value="__snapshot"]')).toHaveText('ASS 默认样式');
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await expect(select.locator('option[value="ass"]')).toHaveText('ASS 默认样式');
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(select.locator('option[value="ass"]')).toHaveText('ASS default style');
  await expect(select.locator('option[value="__snapshot"]')).toHaveText('ASS 默认样式');
  await select.selectOption('ass');
  await expect(select.locator('option[value="__snapshot"]')).toHaveText('ASS default style');
});

test('English preset editing, confirmations and rule errors remain understandable', async ({ page }) => {
  await page.evaluate(() => { MaweBoot.DATA.segments[0].text = '删除'; MaweTextProcess.openTextProcessModal(); });
  await expect(page.locator('#text-preset-select')).toBeEnabled();
  await page.locator('#text-preset-add-rule').click();
  const rule = page.locator('.text-preset-rule').first();
  const find = rule.locator('input[type="text"]').nth(0);
  const replacement = rule.locator('input[type="text"]').nth(1);
  await expect(find).toHaveAttribute('placeholder', 'Rule 1 find');
  await expect(replacement).toHaveAttribute('placeholder', 'Rule 1 replace with');
  await expect(find).toHaveAttribute('aria-label', 'Rule 1 find');
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await expect(find).toHaveAttribute('aria-label', '规则 1 查找');
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(find).toHaveAttribute('aria-label', 'Rule 1 find');
  await expect(page.locator('#text-process-preview')).toContainText('Rule 1');
  await find.fill('(');
  await rule.getByLabel('Regex').check();
  await expect(page.locator('#text-process-preview')).toContainText('Rule 1:');
  await expect(page.locator('#text-process-confirm')).toBeDisabled();
  await find.fill('删除');
  await rule.getByLabel('Regex').uncheck();
  await replacement.fill('保存');
  await expect(page.locator('#text-process-preview')).toContainText('Processing 1 subtitles');
  await expect(page.locator('#text-process-preview .replace-preview-before')).toHaveText('Before: 删除');
  await expect(page.locator('#text-process-preview .replace-preview-after')).toHaveText('After: 保存');
  page.once('dialog', dialog => { expect(dialog.message()).toBe('Preset name'); return dialog.accept('文本处理'); });
  await page.locator('#text-preset-save-as').click();
  await expect(page.locator('#text-preset-status')).toHaveText('Preset library saved');
  await expect(page.locator('#text-preset-select option:checked')).toHaveText('文本处理');
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(page.locator('#text-preset-select option:checked')).toHaveText('文本处理');
  page.once('dialog', dialog => { expect(dialog.message()).toBe('Delete this preset?'); return dialog.dismiss(); });
  await page.locator('#text-preset-delete').click();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('replace the current preset library'); return dialog.dismiss(); });
  await page.locator('#text-preset-import').setInputFiles({ name: 'preset.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.locator('#text-preset-select option:checked')).toHaveText('文本处理');
});

test('English users see an actionable stale-library error', async ({ page }) => {
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-select')).toBeEnabled();
  await page.locator('#text-process-trim').check();
  await page.route('**/api/text-processing-presets', async route => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 409, contentType: 'application/json', body: '{}' });
    else await route.continue();
  });
  page.once('dialog', dialog => dialog.accept('Conflict'));
  await page.locator('#text-preset-save-as').click();
  await expect(page.locator('#text-preset-status')).toContainText(/reopen text processing/i);
  await expect(page.locator('#text-preset-status')).not.toContainText('预设');
});

test('invalid preset names report a fully translated save error', async ({ page }) => {
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-select')).toBeEnabled();
  await page.locator('#text-process-trim').check();
  page.once('dialog', dialog => dialog.accept('x'.repeat(161)));
  await page.locator('#text-preset-save-as').click();
  await expect(page.locator('#text-preset-status')).toHaveText('Save failed: Invalid preset');
});

test('invalid imports retain the library and explain the error in English', async ({ page }) => {
  await page.evaluate(() => MaweTextProcess.openTextProcessModal());
  await expect(page.locator('#text-preset-select')).toBeEnabled();
  await page.locator('#text-process-trim').check();
  page.once('dialog', dialog => dialog.accept('Keep me'));
  await page.locator('#text-preset-save-as').click();
  await expect(page.locator('#text-preset-status')).toHaveText('Preset library saved');
  const invalid = { schema: 'moy.asr.text_processing_presets.v1', presets: [{
    id: 'invalid', name: 'Invalid', scope: 'all', rules: [], operations: { wraps: [null] },
  }] };
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#text-preset-import').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
  await expect(page.locator('#text-preset-status')).toHaveText('Import failed: Invalid preset operations');
  await expect(page.locator('#text-preset-select option:checked')).toHaveText('Keep me');
});

test('ASS-only presets explain how to use them when ASS mode is off', async ({ page }) => {
  await page.evaluate(async () => {
    const url = MaweBoot.SERVER_CONFIG.textProcessingPresetsUrl;
    const library = await (await fetch(url)).json();
    const preset = { id: 'ass-only', name: 'Styled', scope: 'all', rules: [],
      operations: { wraps: [{ id: 'emphasis', left: '**', right: '**' }] } };
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...library, presets: [...library.presets, preset], expected: library, requestToken: MaweBoot.SERVER_CONFIG.requestToken }) });
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MaweTextProcess.openTextProcessModal();
  });
  await expect(page.locator('#text-preset-select option[value="ass-only"]')).toHaveCount(1);
  await page.locator('#text-preset-select').selectOption('ass-only');
  await expect(page.locator('#text-preset-status')).toContainText('Enable ASS mode first');
  await expect(page.locator('#text-process-confirm')).toBeDisabled();
});

test('a slow regular expression reports a timeout without changing subtitles', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = 'a'.repeat(40) + '!';
    MaweCuePanel.renderAll(); MaweTextProcess.openTextProcessModal();
  });
  await page.locator('#text-preset-add-rule').click();
  const rule = page.locator('.text-preset-rule').first();
  await rule.getByLabel('Regex').check();
  await rule.getByRole('textbox', { name: 'Rule 1 find' }).fill('(a+)+$');
  await expect(page.locator('#text-process-preview')).toContainText('The rules timed out', { timeout: 10000 });
  await expect(page.locator('#text-process-confirm')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('a'.repeat(40) + '!');
});
