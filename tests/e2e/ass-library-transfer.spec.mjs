import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { DURATION_MS, cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson, generateWav, makeTempDir, openSettingsPage, startServer } from './helpers.mjs';

let dir, server, projectPath;
test.beforeAll(async () => {
  dir = makeTempDir('ass-library-transfer');
  const audio = join(dir, 'synthetic.wav');
  projectPath = generateProjectJson(join(dir, 'project.mosp'));
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  project.tracks.find(track => track.role === 'main').segments[0].assStyle = {
    id: 'ass', name: 'Project snapshot', fontSize: 73,
  };
  writeFileSync(projectPath, JSON.stringify(project), 'utf8');
  generateWav(audio, DURATION_MS / 1000);
  server = await startServer(projectPath, audio, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });

test('shows import errors and migration guidance in English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await disableOnboarding(page);
  await page.goto(server.url);
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await expect(page.locator('.ass-style-more-actions > summary')).toHaveText('More');
  const malformed = await page.evaluate(() => window.AsrEditorUtils.defaultAssStyleLibrary());
  malformed.assProfiles[0].styleId = 'missing';
  await page.locator('#ass-style-import-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(malformed)) });
  await expect(page.locator('#hint-stack')).toContainText('references a missing style');
  const buffer = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ass-styles', 'legacy-v1.json'));
  await page.locator('#ass-style-import-file').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer });
  await expect(page.locator('#ass-style-import-preview')).toContainText('Fields from the older library');
  await expect(page.locator('#ass-style-import-preview')).toContainText('Migrated:');
});

test('shows server backup and sync failures in English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await disableOnboarding(page);
  await page.goto(server.url);
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await page.route('**/api/ass-styles-backup', route => route.fulfill({ status: 404, json: { error: '没有找到导入前的样式库副本。' } }));
  await page.locator('.ass-style-more-actions > summary').click();
  await page.locator('#ass-style-restore-backup').click();
  await expect(page.locator('#hint-stack')).toContainText('Cannot restore: No pre-import backup was found.');
  await page.route('**/api/ass-styles', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, json: { error: 'conflict' } }) : route.continue());
  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await page.locator('#ass-style-font-size').fill('91');
  await expect(page.locator('#ass-style-library-status')).toContainText('Save failed: The library was changed in another window');
  await page.unroute('**/api/ass-styles');
  await page.route('**/api/ass-styles', route => route.abort());
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.ass-style-more-actions > summary').click();
  await page.locator('#ass-style-reload-library').click();
  await expect(page.locator('#ass-style-library-status')).toHaveText('Reload failed; keeping the current styles');
  await expect(page.locator('#ass-style-library-path-hint')).toHaveText('Not synced with the server yet; check the current styles and try saving again.');
});

async function openLibrary(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await expect(page.locator('#ass-style-library-status')).toContainText('已与用户级配置同步');
}

test('keeps server styles read-only until the initial library arrives', async ({ page }) => {
  await disableOnboarding(page);
  const requested = Promise.withResolvers();
  const initialLoad = Promise.withResolvers();
  await page.route('**/api/ass-styles', async route => {
    if (route.request().method() === 'GET') {
      requested.resolve();
      await initialLoad.promise;
    }
    await route.continue();
  });
  const size = page.locator('#ass-style-font-size');
  try {
    await page.goto(server.url);
    await requested.promise;
    await openSettingsPage(page, 'subtitle-style');
    await page.locator('#ass-style-manager-open').click();
    await expect(page.locator('#ass-style-library-status')).toContainText('正在加载');
    await expect(size).toBeDisabled();
    await expect(page.locator('#ass-style-font-toggle')).toBeDisabled();
    await expect(page.locator('#ass-srt-default-style')).toBeDisabled();
    await expect(page.locator('#main-ass-style-select')).toBeDisabled();
    await expect(page.locator('#ass-style-new')).toBeDisabled();
    await expect(page.locator('#ass-style-save')).toBeDisabled();
  } finally {
    initialLoad.resolve();
  }
  await expect(page.locator('#ass-style-library-status')).toContainText('已与用户级配置同步');
  await expect(page.locator('#ass-style-font-toggle')).toBeEnabled();
  await expect(page.locator('#ass-srt-default-style')).toBeEnabled();
  await expect(page.locator('#main-ass-style-select')).toBeEnabled();
  await page.locator('#ass-mode-toggle').evaluate(toggle => toggle.click());
  await expect(size).toBeEnabled();
  await size.fill('107');
  await expect.poll(() => page.evaluate(async () => {
    const library = await (await fetch('/api/ass-styles')).json();
    return library.styles.find(style => style.id === 'ass').fontSize;
  })).toBe(107);
});

test('warns before leaving while server style edits are still saving', async ({ page }) => {
  await openLibrary(page);
  // Edit the SRT burn preset independently of the project's linked ASS tracks.
  await page.locator('#ass-style-list [data-ass-selection-id="default"]').click();
  const requested = Promise.withResolvers();
  const firstSave = Promise.withResolvers();
  await page.route('**/api/ass-styles', async route => {
    if (route.request().method() === 'POST') {
      requested.resolve();
      await firstSave.promise;
    }
    await route.continue();
  });
  const size = page.locator('#ass-style-font-size');
  try {
    await size.fill('108');
    await page.locator('#ass-style-save').click();
    await requested.promise;
    await size.fill('109');
    expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(false);
  } finally {
    firstSave.resolve();
  }
  await expect.poll(() => page.evaluate(async () => {
    const library = await (await fetch('/api/ass-styles')).json();
    return library.styles.find(style => style.id === 'default').fontSize;
  })).toBe(109);
  await expect(page.locator('#ass-style-library-status')).toContainText('已与用户级配置同步');
  expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
});

test('merges and restores an exported library and rejects stale writes', async ({ page, context }) => {
  await page.addInitScript(() => {
    window.__styleExports = [];
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
      write: async blob => window.__styleExports.push(await blob.text()), close: async () => {},
    }) });
  });
  await openLibrary(page);
  const projectSnapshot = () => page.evaluate(() => {
    const project = window.MaweBoot.DATA;
    const cue = project.tracks.find(track => track.role === 'main').segments[0];
    return { schema: project.schema, assStyle: cue.assStyle };
  });
  const beforeImport = await projectSnapshot();
  expect(beforeImport).toMatchObject({ schema: 'moy.asr.project.v2', assStyle: { id: 'ass', fontSize: 73 } });
  await expect(page.locator('#ass-style-project-hint')).toBeVisible();
  const projectFile = readFileSync(projectPath, 'utf8');
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
  expect(await projectSnapshot()).toEqual(beforeImport);
  expect(readFileSync(projectPath, 'utf8')).toBe(projectFile);
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
