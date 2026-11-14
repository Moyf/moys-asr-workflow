import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildPortableBlankEditor, cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, openSettingsPage, startServer } from './helpers.mjs';

let dir, server, portable;
test.beforeAll(async () => {
  dir = makeTempDir('ass-library-transfer');
  const audio = join(dir, 'audio.wav'), project = join(dir, 'project.json');
  generateWav(audio, 4);
  writeFileSync(project, JSON.stringify({ media: 'audio.wav', segments: [{ start: 100, end: 1000, text: '测试' }], waveform: generateWaveformPayload(4000) }));
  portable = buildPortableBlankEditor(join(dir, 'portable.html'));
  server = await startServer(project, audio, await findFreePort());
});

test('portable import persists and can restore its pre-import backup', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(pathToFileURL(portable).href);
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await expect(page.locator('#ass-style-library-status')).toContainText('当前浏览器');
  const library = await page.evaluate(() => window.AsrEditorUtils.defaultAssStyleLibrary());
  library.styles[1].fontSize = 111;
  await page.locator('#ass-style-import-file').setInputFiles({ name: 'portable.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(library)) });
  await page.locator('input[name="ass-style-import-mode"][value="restore"]').check();
  await page.locator('#ass-style-import-confirm').click();
  await expect(page.locator('#ass-style-import-dialog')).not.toBeVisible();
  await page.reload();
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await expect(page.locator('#ass-style-font-size')).toHaveValue('111');
  await page.locator('.ass-style-more-actions > summary').click();
  await page.locator('#ass-style-restore-backup').click();
  await page.locator('#ass-style-import-confirm').click();
  await expect(page.locator('#ass-style-font-size')).toHaveValue('86');
  const backupBeforeFailure = await page.evaluate(() => localStorage.getItem('moy.asr.ass.styles.v1.backup'));
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'moy.asr.ass.styles.v1') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.locator('#ass-style-import-file').setInputFiles({ name: 'portable.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(library)) });
  await page.locator('input[name="ass-style-import-mode"][value="restore"]').check();
  await page.locator('#ass-style-import-confirm').click();
  await expect(page.locator('#ass-style-import-preview')).toContainText('导入失败');
  expect(await page.evaluate(() => localStorage.getItem('moy.asr.ass.styles.v1.backup'))).toBe(backupBeforeFailure);
  await page.reload();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moy.asr.ass.styles.v1')).styles.find(s => s.id === 'ass').fontSize)).toBe(86);
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await page.locator('#ass-style-font-size').fill('88');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('moy.asr.ass.styles.v1')).styles.find(s => s.id === 'ass').fontSize)).toBe(88);
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });

async function openLibrary(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await expect(page.locator('#ass-style-library-status')).toContainText('已与用户级配置同步');
}

test('merges and restores an exported library and rejects stale writes', async ({ page, context }) => {
  await page.addInitScript(() => {
    window.__styleExports = [];
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
      write: async blob => window.__styleExports.push(await blob.text()), close: async () => {},
    }) });
  });
  await openLibrary(page);
  await page.locator('#ass-style-window').screenshot({ path: test.info().outputPath('ass-library.png') });
  await page.locator('#ass-style-export-library').click();
  await expect.poll(() => page.evaluate(() => window.__styleExports.length)).toBe(1);
  const exported = JSON.parse(await page.evaluate(() => window.__styleExports[0]));
  expect(exported.schema).toBe('moy.asr.ass_styles.transfer.v1');
  expect(exported.library.assignments.assExportProfileId).toBe('ass');
  const original = await page.evaluate(async () => (await fetch('/api/ass-styles')).json());
  const imported = structuredClone(original);
  delete imported._revision;
  imported.styles.find(s => s.id === 'ass').fontSize = 123;
  imported.styles.push({ ...imported.styles.find(s => s.id === 'ass'), id: 'studio', name: 'Studio', builtin: false });
  imported.assProfiles.push({ ...structuredClone(imported.assProfiles[0]), id: 'studio-plan', name: 'Studio plan', styleId: 'studio', builtin: false });
  imported.assignments.assExportProfileId = 'studio-plan';
  const file = { name: 'styles.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schema: 'moy.asr.ass_styles.transfer.v1', version: 1, kind: 'library', library: imported })) };
  const malformed = structuredClone(imported);
  malformed.assProfiles[0].styleId = 'missing';
  await page.locator('#ass-style-import-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(malformed)) });
  await expect(page.locator('#hint-stack')).toContainText('引用的样式不存在');
  expect((await page.evaluate(async () => (await (await fetch('/api/ass-styles')).json())._revision))).toBe(original._revision);
  await page.locator('#ass-style-import-file').setInputFiles(file);
  await expect(page.locator('#ass-style-import-dialog')).toBeVisible();
  await expect(page.locator('#ass-style-import-preview')).toContainText('Studio plan');
  await expect(page.locator('#ass-style-import-dialog .modal-hint')).toHaveCSS('font-size', '12px');
  const gaps = await page.locator('#ass-style-import-dialog').evaluate(dialog => {
    const labels = [...dialog.querySelectorAll('label')];
    const first = labels[0].getBoundingClientRect();
    const second = labels[1].getBoundingClientRect();
    const preview = dialog.querySelector('pre').getBoundingClientRect();
    return [second.top - first.bottom, preview.top - second.bottom];
  });
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8);
  await page.locator('#ass-style-import-dialog').screenshot({ path: test.info().outputPath('ass-import-dialog.png') });
  await page.locator('#ass-style-import-confirm').click();
  await expect(page.locator('#ass-style-import-dialog')).not.toBeVisible();
  const merged = await page.evaluate(async () => (await fetch('/api/ass-styles')).json());
  expect(merged.styles.find(s => s.id === 'ass').fontSize).toBe(original.styles.find(s => s.id === 'ass').fontSize);
  expect(merged.styles.find(s => s.id === 'studio').fontSize).toBe(123);
  expect(merged.assProfiles.find(s => s.name === 'Studio plan').styleId).toBe('studio');
  expect(merged.assignments).toEqual(original.assignments);
  await page.locator('#ass-style-import-file').setInputFiles(file);
  await expect(page.locator('#ass-style-import-summary')).toContainText('新增 0 项');
  await expect(page.locator('#ass-style-import-confirm')).toBeDisabled();
  await expect(page.locator('#ass-style-import-preview')).toContainText('保留之前的恢复副本');
  await page.locator('#ass-style-import-cancel').click();
  await page.locator('.ass-style-more-actions > summary').click();
  await page.locator('#ass-style-restore-backup').click();
  await expect(page.locator('#ass-style-import-summary')).toContainText('将替换当前全部');
  await page.locator('#ass-style-import-confirm').click();
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()).styles.length)).toBe(original.styles.length);
  await page.locator('#ass-style-import-file').setInputFiles(file);
  await page.locator('input[name="ass-style-import-mode"][value="restore"]').check();
  await page.locator('#ass-style-import-confirm').click();
  const restored = await page.evaluate(async () => (await fetch('/api/ass-styles')).json());
  expect(restored.styles.find(s => s.id === 'ass').fontSize).toBe(123);
  expect(restored.assignments.assExportProfileId).toBe('studio-plan');
  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await page.locator('#ass-style-font-size').fill('100');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()).styles.find(s => s.id === 'ass').fontSize)).toBe(100);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#ass-style-library-status')).toContainText('已与用户级配置同步');
  const other = await context.newPage();
  await openLibrary(other);
  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await page.locator('#ass-style-font-size').fill('101');
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()).styles.find(s => s.id === 'ass').fontSize)).toBe(101);
  await other.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await other.locator('#ass-style-font-size').fill('102');
  await expect(other.locator('#ass-style-library-status')).toContainText('其他窗口修改');
  expect((await page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()).styles.find(s => s.id === 'ass').fontSize))).toBe(101);
  await other.close();
});

test('preserves a legacy full library through save, export and restore', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  const library = await page.evaluate(() => window.AsrEditorUtils.defaultAssStyleLibrary());
  library.version = 1;
  library.styles = library.styles.filter(style => style.id !== 'ass-extension');
  for (let i = 0; i < 62; i++) library.styles.push({ ...library.styles[1], id: `custom-${i}`, name: `Custom ${i}`, builtin: false });
  library.assProfiles[0].styleId = 'custom-61';
  writeFileSync(join(dir, '.settings', 'ass-styles.json'), JSON.stringify(library));
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await expect(page.locator('#ass-style-list [data-ass-selection-id="custom-61"]')).toHaveCount(1);
  await page.locator('#ass-style-save').click();
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()).styles.length)).toBe(65);
  const normalized = await page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()));
  expect(normalized.assProfiles[0].styleId).toBe('custom-61');
  delete normalized._revision;
  normalized.styles[0].fontSize += 1;
  await page.locator('#ass-style-import-file').setInputFiles({ name: 'full.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(normalized)) });
  await page.locator('input[name="ass-style-import-mode"][value="restore"]').check();
  await page.locator('#ass-style-import-confirm').click();
  await expect(page.locator('#ass-style-import-dialog')).not.toBeVisible();
  const result = await page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()));
  expect(result.styles).toHaveLength(65);
  expect(result.assProfiles[0].styleId).toBe('custom-61');
});

test('imports actual historical v1 and v2 style libraries', async ({ page }) => {
  await openLibrary(page);
  for (const name of ['legacy-v1.json', 'legacy-v2-before-pop.json', 'legacy-v2-before-comment.json', 'legacy-v2-before-opacity.json']) {
    const buffer = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ass-styles', name));
    await page.locator('#ass-style-import-file').setInputFiles({ name, mimeType: 'application/json', buffer });
    await expect(page.locator('#ass-style-import-dialog')).toBeVisible();
    await page.locator('input[name="ass-style-import-mode"][value="restore"]').check();
    await expect(page.locator('#ass-style-import-preview')).toContainText('迁移');
    await page.locator('#ass-style-import-confirm').click();
    await expect(page.locator('#ass-style-import-dialog')).not.toBeVisible();
    const saved = await page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()));
    expect(saved.styles.find(style => style.id === 'ass-extension')).toBeTruthy();
    expect(saved.assProfiles[0].animations.pop).toBeTruthy();
  }
});

test('waits for a pending library reload before previewing a merge', async ({ page, context }) => {
  await openLibrary(page);
  const incoming = await page.evaluate(() => window.AsrEditorUtils.defaultAssStyleLibrary());
  incoming.styles.push({ ...incoming.styles[1], id: 'inside', name: 'Inside', builtin: false });
  await page.locator('#ass-style-window-close-footer').click();
  const other = await context.newPage();
  await openLibrary(other);
  await other.locator('#ass-style-new').click();
  await other.locator('#ass-style-name').fill('External');
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()).styles.some(style => style.name === 'External'))).toBe(true);
  let releaseLoad, observeLoad;
  const loadObserved = new Promise(resolve => { observeLoad = resolve; });
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  await page.route('**/api/ass-styles', async route => {
    if (route.request().method() === 'GET') { observeLoad(); await loadGate; }
    await route.continue();
  });
  await page.locator('#ass-style-manager-open').click();
  await loadObserved;
  await page.locator('#ass-style-import-file').setInputFiles({ name: 'inside.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) });
  await expect(page.locator('#ass-style-import-dialog')).not.toBeVisible();
  releaseLoad();
  await expect(page.locator('#ass-style-import-dialog')).toBeVisible();
  let releasePost, observePost;
  const postObserved = new Promise(resolve => { observePost = resolve; });
  const postGate = new Promise(resolve => { releasePost = resolve; });
  await page.route('**/api/ass-styles', async route => {
    if (route.request().method() === 'POST') { observePost(); await postGate; }
    await route.continue();
  });
  await page.locator('#ass-style-import-confirm').click();
  await postObserved;
  await page.keyboard.press('Escape');
  await expect(page.locator('#ass-style-import-dialog')).toBeVisible();
  await expect(page.locator('#ass-style-import-cancel')).toBeDisabled();
  await expect(page.locator('input[name="ass-style-import-mode"][value="restore"]')).toBeDisabled();
  releasePost();
  await expect(page.locator('#ass-style-import-dialog')).not.toBeVisible();
  const names = await page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()).styles.map(style => style.name));
  expect(names).toContain('External');
  expect(names).toContain('Inside');
  await other.close();
});

test('failed reload retains the last server library even without browser cache', async ({ page }) => {
  await openLibrary(page);
  await page.locator('#ass-style-new').click();
  await page.locator('#ass-style-name').fill('Show');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/ass-styles') && response.request().method() === 'POST');
  await page.locator('#ass-style-save').click();
  await saved;
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()).styles.some(style => style.name === 'Show'))).toBe(true);
  await expect(page.locator('#ass-style-library-status')).toContainText('已与用户级配置同步');
  await page.evaluate(() => {
    localStorage.removeItem('moy.asr.ass.styles.v1');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'moy.asr.ass.styles.v1') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.locator('#ass-style-window-close-footer').click();
  await page.route('**/api/ass-styles', async route => {
    if (route.request().method() === 'GET') await route.abort('failed');
    else await route.continue();
  });
  await page.locator('#ass-style-manager-open').click();
  await expect(page.locator('#ass-style-library-status')).toContainText('重新加载失败');
  await expect(page.locator('#ass-style-list')).toContainText('Show');
  await page.unroute('**/api/ass-styles');
  await page.locator('#ass-style-save').click();
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/ass-styles')).json()).styles.some(style => style.name === 'Show'))).toBe(true);
});
