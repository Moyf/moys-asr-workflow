import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { createUtilsModule } from '../../web/shared/utils/project-tracks.js';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, makeTempDir, startBlankServer } from './helpers.mjs';

let directory, server;
const projectFile = {
  name: 'palette-open.mosp', mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify(createUtilsModule().makeProject([], {
    projectFields: { media: '', speakers: [] },
  }))),
};
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
  await chooser.setFiles(projectFile);
  await expect(page.locator('#json-name')).toHaveText(projectFile.name);

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

async function chooseFromPalette(page, title) {
  await page.locator('#command-palette-open').click();
  const palette = page.locator('#command-palette');
  await palette.getByRole('combobox').fill(title);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    palette.getByRole('option', { name: new RegExp(title) }).click(),
  ]);
  return chooser;
}

function commandRecent(page, id) {
  return page.evaluate(id => window.MaweCommandPalette.list().find(row => row.command.id === id).recent >= 0, id);
}

test('File picker commands are not recent while waiting or after cancellation', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  for (const [id, title] of [
    ['file.open', '打开工程'],
    ['file.import-media', '导入媒体'],
    ['file.import-subtitles', '导入字幕'],
    ['file.import-lyrics', '导入歌词'],
  ]) {
    const chooser = await chooseFromPalette(page, title);
    const recentWhileWaiting = await commandRecent(page, id);
    // Playwright intercepts the native chooser; deliver the browser's cancel event.
    await chooser.element().dispatchEvent('cancel', { bubbles: true });
    expect(await commandRecent(page, id), id).toBe(false);
    expect(recentWhileWaiting, id).toBe(false);
  }
  const chooser = await chooseFromPalette(page, '打开工程');
  await chooser.setFiles(projectFile);
  await expect(page.locator('#json-name')).toHaveText(projectFile.name);
  await expect.poll(() => commandRecent(page, 'file.open')).toBe(true);
});

test('New Project is recent only after creating a project, not after cancelling', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    window.newProjectPickerCalls = 0;
    window.showSaveFilePicker = async () => {
      window.newProjectPickerCalls++;
      throw new DOMException('Save picker cancelled', 'AbortError');
    };
  });
  const entry = page.locator('#command-palette-open');
  const palette = page.locator('#command-palette');
  const newProject = palette.getByRole('option', { name: /新建工程/ });
  await entry.click();
  await newProject.click();
  await expect(palette).not.toBeVisible();
  expect(await page.evaluate(() => window.newProjectPickerCalls)).toBe(1);
  expect(await commandRecent(page, 'file.new')).toBe(false);

  await page.evaluate(() => {
    window.showSaveFilePicker = async () => ({
      name: 'palette-new.mosp',
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    });
  });
  await entry.click();
  await newProject.click();
  await expect(page.locator('#json-name')).toHaveText('palette-new.mosp');
  await expect.poll(() => commandRecent(page, 'file.new')).toBe(true);
});

test('Failed Open Project and subsequent toolbar open do not record a command recent', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  const chooser = await chooseFromPalette(page, '打开工程');
  await chooser.setFiles({ ...projectFile, buffer: Buffer.from('invalid JSON') });
  await expect(page.locator('.hint-warning').filter({ hasText: '打开了错误的文件' })).toBeVisible();
  expect(await commandRecent(page, 'file.open')).toBe(false);

  const [toolbarChooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#open-project').click()]);
  await toolbarChooser.setFiles({ ...projectFile, name: 'toolbar-open.mosp' });
  await expect(page.locator('#json-name')).toHaveText('toolbar-open.mosp');
  expect(await commandRecent(page, 'file.open')).toBe(false);
});

test('A refused showPicker lets Open Project retry from the toolbar and palette', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    const input = document.getElementById('open-project-file');
    const click = input.click.bind(input);
    const showPicker = input.showPicker.bind(input);
    window.projectPickerCalls = { showPicker: 0, click: 0 };
    input.click = () => {
      window.projectPickerCalls.click++;
      click();
    };
    input.showPicker = () => {
      if (++window.projectPickerCalls.showPicker === 1) throw new DOMException('Picker refused', 'NotAllowedError');
      showPicker();
    };
  });

  await page.locator('#command-palette-open').click();
  await page.locator('#command-palette').getByRole('option', { name: /打开工程/ }).click();
  await expect(page.locator('.hint-warning').filter({ hasText: '无法执行命令' })).toBeVisible();
  expect(await commandRecent(page, 'file.open')).toBe(false);
  expect(await page.evaluate(() => window.projectPickerCalls)).toEqual({ showPicker: 1, click: 0 });

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#open-project').click()]);
  await chooser.setFiles({ ...projectFile, name: 'toolbar-retry.mosp' });
  await expect(page.locator('#json-name')).toHaveText('toolbar-retry.mosp');
  expect(await commandRecent(page, 'file.open')).toBe(false);
  expect(await page.evaluate(() => window.projectPickerCalls)).toEqual({ showPicker: 1, click: 1 });

  const retry = await chooseFromPalette(page, '打开工程');
  await retry.setFiles(projectFile);
  await expect(page.locator('#json-name')).toHaveText(projectFile.name);
  await expect.poll(() => commandRecent(page, 'file.open')).toBe(true);
});

test('Open Project can retry directly from the palette after a silent legacy click', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    const input = document.getElementById('open-project-file');
    const click = input.click.bind(input);
    window.legacyOpenCalls = 0;
    input.showPicker = undefined;
    input.click = () => { if (++window.legacyOpenCalls > 1) click(); };
  });
  const entry = page.locator('#command-palette-open');
  const openProject = page.locator('#command-palette').getByRole('option', { name: /打开工程/ });
  await entry.click();
  await openProject.click();
  expect(await commandRecent(page, 'file.open')).toBe(false);
  await entry.click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 4_000 }), openProject.click()]);
  expect(await page.evaluate(() => window.legacyOpenCalls)).toBe(2);
  await chooser.setFiles(projectFile);
  await expect(page.locator('#json-name')).toHaveText(projectFile.name);
  await expect.poll(() => commandRecent(page, 'file.open')).toBe(true);
});

test('Selecting associated media does not complete a stale palette import', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    const input = document.getElementById('load-media-file');
    const click = input.click.bind(input);
    window.legacyMediaCalls = 0;
    input.showPicker = undefined;
    input.click = () => { if (++window.legacyMediaCalls > 1) click(); };
  });
  await page.locator('#command-palette-open').click();
  await page.locator('#command-palette').getByRole('option', { name: /导入媒体/ }).click();
  expect(await commandRecent(page, 'file.import-media')).toBe(false);

  const { makeProject } = createUtilsModule();
  const project = makeProject([{ start: 0, end: 1000, text: 'Associated cue' }], {
    projectFields: { media: 'associated.wav', speakers: [] },
  });
  const open = await chooseFromPalette(page, '打开工程');
  await open.setFiles({ ...projectFile, buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.locator('#project-media-modal')).toHaveClass(/show/);
  // Neither a new checkpoint nor an implicit write is needed for the associated file.
  await page.evaluate(() => {
    window.associatedSaveCalls = 0;
    window.showSaveFilePicker = async () => {
      window.associatedSaveCalls++;
      throw new DOMException('Unexpected save picker', 'AbortError');
    };
  });
  const audio = join(directory, 'associated.wav');
  generateWav(audio, 2);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#project-media-select').click(),
  ]);
  expect(await page.evaluate(() => window.MaweProjectMediaInputs.pendingProjectMediaSelection)).toEqual({ projectReady: true });
  await chooser.setFiles(audio);
  await expect(page.locator('#media-name')).toHaveText('associated.wav');
  await expect(page.locator('.cue').first()).toContainText('Associated cue');
  expect(await page.evaluate(() => window.associatedSaveCalls)).toBe(0);
  expect(await commandRecent(page, 'file.import-media')).toBe(false);
});

test('Palette checks transient activation after confirming project replacement', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    window.confirmedReplacement = false;
    window.showPickerCalls = 0;
    // v2 uses the saved project checkpoint, not the legacy dirty flag.
    window.MaweState.establishProjectCheckpoint({ repaired: true });
    window.confirm = () => {
      window.confirmedReplacement = true;
      Object.defineProperty(navigator, 'userActivation', { value: { isActive: false } });
      return true;
    };
    document.getElementById('open-project-file').showPicker = () => { window.showPickerCalls++; };
  });
  expect(await page.evaluate(() => window.MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
  await page.locator('#command-palette-open').click();
  await page.locator('#command-palette').getByRole('option', { name: /打开工程/ }).click();
  expect(await page.evaluate(() => [window.confirmedReplacement, window.showPickerCalls])).toEqual([true, 0]);
  expect(await commandRecent(page, 'file.open')).toBe(false);
});

test('Media and lyrics can be imported from the palette after cancelling their pickers', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  await page.goto(server.url);
  const audio = join(directory, 'palette-audio.wav');
  generateWav(audio, 2);
  const mediaChooser = await chooseFromPalette(page, '导入媒体');
  await mediaChooser.element().dispatchEvent('cancel', { bubbles: true });
  const mediaRetry = await chooseFromPalette(page, '导入媒体');
  await mediaRetry.setFiles(audio);
  await expect(page.locator('#media-name')).toHaveText('palette-audio.wav');
  await expect.poll(() => commandRecent(page, 'file.import-media')).toBe(true);

  // Exercise click() when neither showPicker nor the activation API is available.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'userActivation', { value: undefined });
    document.getElementById('load-lrc-file').showPicker = undefined;
    window.confirm = () => true;
  });
  const lyricsChooser = await chooseFromPalette(page, '导入歌词');
  await lyricsChooser.element().dispatchEvent('cancel', { bubbles: true });
  const lyricsRetry = await chooseFromPalette(page, '导入歌词');
  await lyricsRetry.setFiles({
    name: 'palette.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:00.10]Palette lyric\n[00:01.00]Second line\n'),
  });
  await expect(page.locator('.cue').first()).toContainText('Palette lyric');
  await expect.poll(() => commandRecent(page, 'file.import-lyrics')).toBe(true);
});

test('Subtitle import becomes recent after applying the selected file', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  await page.goto(server.url);
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === 'palette.srt') await new Promise(resolve => { window.releasePaletteRead = resolve; });
      return read.call(this);
    };
  });
  const chooser = await chooseFromPalette(page, '导入字幕');
  await chooser.setFiles({
    name: 'palette.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nPalette subtitle\n'),
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.releasePaletteRead))).toBe(true);
  expect(await commandRecent(page, 'file.import-subtitles')).toBe(false);
  expect(await page.evaluate(() => window.MaweCommandPalette.list()
    .find(row => row.command.id === 'file.import-subtitles').command.run() === false)).toBe(true);
  await page.evaluate(() => window.releasePaletteRead());
  await expect(page.locator('.cue').first()).toContainText('Palette subtitle');
  await expect.poll(() => commandRecent(page, 'file.import-subtitles')).toBe(true);
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
  expect(await page.evaluate(() => window.paletteSavedProject)).toBeTruthy();
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
