import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';

let directory, server;
test.beforeAll(async () => {
  directory = makeTempDir('editor-command-palette');
  server = await startBlankServer(await findFreePort(), join(directory, 'settings'));
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });

test('command palette searches and executes, persists recents, and isolates editor shortcuts', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableOnboarding(page);
  await page.goto(server.url);
  const entry = page.locator('#command-palette-open');
  const palette = page.locator('#command-palette');
  const search = palette.getByRole('combobox');
  const options = palette.getByRole('option');
  const toolbarControl = page.locator('#workspace-preset');
  const toolbarGaps = await entry.evaluate(el => {
    const toolbar = el.closest('.main-toolbar');
    const bounds = el.getBoundingClientRect();
    return [bounds.top - toolbar.previousElementSibling.getBoundingClientRect().bottom,
      el.nextElementSibling.getBoundingClientRect().left - bounds.right];
  });
  expect(Math.min(...toolbarGaps)).toBeGreaterThanOrEqual(8);
  await info.attach('command-palette-entry', { body: await page.screenshot(), contentType: 'image/png' });
  await toolbarControl.focus();
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await expect(options.first()).toHaveText(/打开工程/);
  await expect(palette.getByRole('option', { name: /播放\/暂停/ })).toHaveCount(0);
  await expect(palette.getByRole('option', { name: /保存工程/ })).toHaveCount(0);
  const gaps = await palette.evaluate(el => {
    const list = el.querySelector('ul');
    const rect = item => item.getBoundingClientRect();
    return [rect(list).top - rect(el.querySelector('input')).bottom,
      rect(list.children[1]).top - rect(list.children[0]).bottom,
      rect(el.querySelector('footer')).top - rect(list).bottom];
  });
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8);
  await info.attach('command-palette', { body: await page.screenshot(), contentType: 'image/png' });

  await page.evaluate(() => {
    window.documentKeyCount = 0;
    document.addEventListener('keydown', () => window.documentKeyCount++, true);
  });
  await page.keyboard.press('End');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  const canceled = await search.evaluate(el => ['s', 'S', 'v'].map(key => !el.dispatchEvent(new KeyboardEvent('keydown', {
    key, ctrlKey: true, shiftKey: key === 'S', bubbles: true, cancelable: true,
  }))));
  expect(canceled).toEqual([true, true, false]);
  await page.keyboard.press('Escape');
  await expect(palette).not.toBeVisible();
  await expect(toolbarControl).toBeFocused();
  expect(await page.evaluate(() => window.documentKeyCount)).toBe(0);

  await entry.click();
  await page.keyboard.press('Escape');
  await expect(entry).toBeFocused();
  await entry.click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  expect(chooser.isMultiple()).toBe(false);

  await entry.click();
  await search.fill('shortcuts');
  await expect(options.first()).toHaveText(/快捷操作/);
  await search.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(palette).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(palette).not.toBeVisible();
  await expect(page.locator('#help-tab-shortcuts')).toHaveAttribute('aria-selected', 'true');

  await page.reload();
  await page.keyboard.press('Meta+k');
  await expect(options.first()).toHaveText(/快捷操作.*最近使用/);
  await page.evaluate(() => window.MAWE_I18N.applyLanguage('en', false));
  await expect(search).toHaveAttribute('placeholder', 'Search commands…');
  await expect(options.first()).toHaveText(/Shortcuts.*Recent/);
  await search.fill('快捷操作');
  await expect(options.first()).toHaveText(/Shortcuts/);
  await search.fill('no-such-command');
  await expect(palette.getByRole('status')).toHaveText('No matching commands');
  await page.evaluate(() => window.MaweCommandPalette.register({ id: 'test.removable', title: 'Disposable test action',
    category: 'Test', run: () => { throw new Error('Removed command must not run'); } }));
  await search.fill('disposable test action');
  await expect(options.first()).toHaveText(/Disposable test action/);
  await page.evaluate(() => window.MaweCommandPalette.unregister('test.removable'));
  await page.keyboard.press('Enter');
  await expect(palette.getByRole('status')).toHaveText('No matching commands');
  await search.fill('global settings');
  await options.first().click();
  await expect(page.locator('#editor-settings-panel')).toHaveAttribute('aria-hidden', 'false');

  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'blocking-dialog';
    document.body.append(dialog);
    dialog.showModal();
  });
  await page.keyboard.press('Control+k');
  await expect(palette).not.toBeVisible();
  await expect(page.locator('#blocking-dialog')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Save As is recent only after a successful write, not after cancelling', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    window.savePickerCalls = 0;
    window.showSaveFilePicker = async () => {
      window.savePickerCalls++;
      throw new DOMException('Save picker cancelled', 'AbortError');
    };
  });

  const entry = page.locator('#command-palette-open');
  const palette = page.locator('#command-palette');
  const saveAs = palette.getByRole('option', { name: /另存为/ });
  const recentSaveAs = saveAs.getByText('最近使用', { exact: true });
  const runSaveAs = async () => {
    await entry.click();
    await palette.getByRole('combobox').fill('另存为');
    await saveAs.click();
    await expect(palette).not.toBeVisible();
  };

  await runSaveAs();
  expect(await page.evaluate(() => window.savePickerCalls)).toBe(1);
  await entry.click();
  await expect(saveAs).toBeVisible();
  await expect(recentSaveAs).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    window.showSaveFilePicker = async () => ({
      name: 'palette-save.mosp',
      createWritable: async () => ({
        write: async blob => { window.paletteSavedProject = JSON.parse(await blob.text()); },
        close: async () => {},
      }),
    });
  });
  await runSaveAs();
  await expect(page.locator('#json-name')).toHaveText('palette-save.mosp');
  const savedProject = await page.evaluate(() => window.paletteSavedProject);
  expect(Array.isArray(savedProject.segments)).toBe(true);
  expect(savedProject.tracks).toBeUndefined();
  await entry.click();
  await expect(recentSaveAs).toBeVisible();
});

test('Save As is recent after a fallback download without a save picker', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  await page.goto(server.url);

  const entry = page.locator('#command-palette-open');
  const palette = page.locator('#command-palette');
  const saveAs = palette.getByRole('option', { name: /另存为/ });
  await entry.click();
  await palette.getByRole('combobox').fill('另存为');
  const [download] = await Promise.all([page.waitForEvent('download'), saveAs.click()]);
  expect(download.suggestedFilename()).toMatch(/\.mosp$/);
  expect(await download.failure()).toBeNull();

  await entry.click();
  await expect(saveAs.getByText('最近使用', { exact: true })).toBeVisible();
});

test('Export project records recent only after a download, and button shares export behavior', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    window.exportPickerCalls = 0;
    window.showSaveFilePicker = async options => {
      window.exportPickerCalls++;
      window.exportPickerOptions = options;
      throw new DOMException('Save picker cancelled', 'AbortError');
    };
  });

  const entry = page.locator('#command-palette-open');
  const palette = page.locator('#command-palette');
  const exportProject = palette.getByRole('option', { name: /导出工程/ });
  const recent = exportProject.getByText('最近使用', { exact: true });
  const runExport = async () => {
    await entry.click();
    await palette.getByRole('combobox').fill('导出工程');
    await exportProject.click();
    await expect(palette).not.toBeVisible();
  };

  await runExport();
  await expect.poll(() => page.evaluate(() => window.exportPickerCalls)).toBe(1);
  await entry.click();
  await expect(recent).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    window.exportedProjects = [];
    window.showSaveFilePicker = async options => {
      window.exportPickerOptions = options;
      return { createWritable: async () => ({
        write: async blob => window.exportedProjects.push(JSON.parse(await blob.text())),
        close: async () => {},
      }) };
    };
  });
  await runExport();
  await expect.poll(() => page.evaluate(() => window.exportedProjects.length)).toBe(1);
  await entry.click();
  await expect(recent).toBeVisible();
  await page.keyboard.press('Escape');

  await page.locator('#download-json').dispatchEvent('click');
  await expect.poll(() => page.evaluate(() => window.exportedProjects.length)).toBe(2);
  const result = await page.evaluate(() => ({ projects: window.exportedProjects, options: window.exportPickerOptions }));
  expect(Array.isArray(result.projects[0].segments)).toBe(true);
  expect(result.projects[0].tracks).toBeUndefined();
  expect(result.projects[1]).toEqual(result.projects[0]);
  expect(result.options.suggestedName).toMatch(/\.mosp$/);
});


test('Export project records recent after a fallback download', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  await page.goto(server.url);

  const entry = page.locator('#command-palette-open');
  const palette = page.locator('#command-palette');
  const exportProject = palette.getByRole('option', { name: /导出工程/ });
  await entry.click();
  await palette.getByRole('combobox').fill('导出工程');
  const [download] = await Promise.all([page.waitForEvent('download'), exportProject.click()]);
  expect(download.suggestedFilename()).toMatch(/\.mosp$/);
  expect(await download.failure()).toBeNull();
  await entry.click();
  await expect(exportProject.getByText('最近使用', { exact: true })).toBeVisible();
});
