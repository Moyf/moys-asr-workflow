import { expect, test } from '@playwright/test';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, makeTempDir, startBlankServer, testSegments } from './helpers.mjs';

async function startLauncherTestEditor(root, pick) {
  const key = randomBytes(32).toString('hex');
  const sign = (domain, ...parts) => {
    const hmac = createHmac('sha256', key).update(domain + '\0');
    parts.forEach(part => hmac.update(part));
    return hmac.digest('hex');
  };
  // Stand-in for the Launcher process; the browser and editor server still
  // use the real grant, signed picker protocol and binding/save endpoints.
  const host = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const operation = request.url.slice(1);
    if (request.headers['x-maw-host-proof'] !== sign(operation, body)) {
      response.writeHead(403).end();
      return;
    }
    const path = await pick(operation);
    const reply = Buffer.from(JSON.stringify(path ? { path } : { cancelled: true }));
    response.writeHead(200, { 'X-MAW-Host-Proof': sign('chosen', body, '\0', reply) }).end(reply);
  });
  const closeHost = () => new Promise(resolve => host.close(resolve));
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  try {
    const server = await startBlankServer(await findFreePort(), join(root, '.settings'), {
      env: { _MAW_NATIVE_BURN_HOST: `${host.address().port}:${key}` },
    });
    const grant = `${Math.floor(Date.now() / 1000) + 120}.${randomBytes(32).toString('hex')}`;
    return {
      url: `${server.url}#maw-burn-host=${grant}.${sign('launch', grant)}`,
      async stop() {
        try { await server.stop(); } finally { await closeHost(); }
      },
    };
  } catch (error) {
    await closeHost();
    throw error;
  }
}

function pausePicker(operation) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  return {
    entered: entered.promise,
    release: released.resolve,
    async wait(actual) {
      if (actual !== operation) return;
      entered.resolve();
      await released.promise;
    },
  };
}

test('Launcher Open Project keeps edits on cancellation and Ctrl+S writes to the selected path', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    window.__copiedProjectValues = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async text => { window.__copiedProjectValues.push(text); } },
    });
  });
  const root = makeTempDir('native-open');
  let server, selected, selectedMedia, paused;
  try {
    mkdirSync(join(root, 'projects'));
    generateWav(join(root, 'source.wav'), 5);
    const first = join(root, 'first.mosp');
    const second = join(root, 'projects', 'second.mosp');
    writeFileSync(first, JSON.stringify({ media: 'source.wav', segments: testSegments() }));
    writeFileSync(second, JSON.stringify({ media: 'missing.wav', segments: testSegments() }));
    const original = readFileSync(first, 'utf-8');
    server = await startLauncherTestEditor(root, async operation => {
      await paused?.wait(operation);
      return { 'choose-project': selected, 'choose-media': selectedMedia }[operation];
    });
    await page.goto(server.url);

    const open = page.locator('#open-project');
    const pickerToast = page.locator('.hint-card.hint-info').filter({ hasText: '如果提示重新定位媒体' });
    async function pick(path, { reload = false, pause, status = 200, palette = false } = {}) {
      selected = path;
      paused = pause ? pausePicker(pause) : null;
      const response = page.waitForResponse('**/api/project/native-pick');
      const loaded = reload ? page.waitForEvent('load', { timeout: 20_000 }) : null;
      if (palette) {
        await page.locator('#command-palette-open').click();
        await page.locator('#command-palette').getByRole('option', { name: /打开工程/ }).click();
      } else {
        await open.click();
      }
      if (paused) {
        await paused.entered;
        await expect(pickerToast).toBeVisible();
        await expect(pickerToast).toHaveAttribute('data-persistent', '1');
        paused.release();
      }
      expect((await response).status()).toBe(status);
      await expect(pickerToast).toHaveCount(0);
      await loaded;
    }
    async function edit(text) {
      await page.evaluate(() => {
        MaweSettings.updateEditorSettings({ autoSaveProject: false });
        MaweServerSave.scheduleAutoSave();
        MaweServerSave.scheduleAutoSaveFlush();
      });
      await page.locator('.cue').first().click();
      await page.locator('#cue-panel-text').fill(text);
      await page.locator('#cue-panel-target').click();
    }
    const projectName = page.locator('#json-name');
    const openIsRecent = () => page.evaluate(() => window.MaweCommandPalette.list()
      .find(row => row.command.id === 'file.open').recent >= 0);
    const dialogs = [];
    let acceptDiscard = false;
    page.on('dialog', async dialog => {
      dialogs.push(dialog.type());
      if (acceptDiscard) await dialog.accept();
      else await dialog.dismiss();
    });

    await pick(first, { reload: true });
    await expect(projectName).toHaveText('first.mosp');
    await expect(projectName).toHaveAttribute('data-title', '点击复制工程完整路径');
    await projectName.click();
    await expect.poll(() => page.evaluate(() => window.__copiedProjectValues)).toEqual([realpathSync(first)]);
    await edit('Keep this unsaved edit');
    await expect(projectName).toHaveAttribute('data-title', '有未保存的修改；点击复制工程完整路径');
    await pick(null, { pause: 'choose-project', palette: true });
    await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('Keep this unsaved edit');
    expect(dialogs).toEqual([]);
    expect(await openIsRecent()).toBe(false);

    await pick(second, { pause: 'choose-media', palette: true }); // Cancel the follow-up picker.
    expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
    expect(dialogs).toEqual([]);
    expect(await openIsRecent()).toBe(false);
    await pick(join(root, 'source.wav'), { status: 400, palette: true });
    await expect(page.locator('.hint-warning').filter({ hasText: '打开工程失败' })).toBeVisible();
    expect(await openIsRecent()).toBe(false);
    selectedMedia = join(root, 'source.wav');
    await pick(second, { palette: true });
    await expect.poll(() => dialogs).toEqual(['confirm']);
    await expect(projectName).toHaveText('first.mosp');
    expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
    expect(await openIsRecent()).toBe(false);

    acceptDiscard = true;
    await pick(second, { reload: true, palette: true });
    await expect(projectName).toHaveText('second.mosp');
    expect(await openIsRecent()).toBe(true);
    await expect(projectName).toHaveAttribute('data-title', '点击复制工程完整路径');
    await projectName.click();
    await expect.poll(() => page.evaluate(() => window.__copiedProjectValues)).toEqual([realpathSync(second)]);
    const mediaName = page.locator('#media-name');
    await expect(mediaName).toHaveText('source.wav');
    await expect(mediaName).toHaveAttribute('data-title', '点击复制媒体完整路径');
    await mediaName.click();
    await expect.poll(() => page.evaluate(() => window.__copiedProjectValues))
      .toEqual([realpathSync(second), realpathSync(join(root, 'source.wav'))]);
    await expect(page.locator('#save-project')).toBeEnabled();
    expect(dialogs).toEqual(['confirm', 'confirm']);
    await edit('Save to the selected project');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/project')
      && response.request().method() === 'POST');
    await page.keyboard.press('Control+s');
    expect((await saved).ok()).toBe(true);
    expect(JSON.parse(readFileSync(second, 'utf-8')).segments[0].text).toBe('Save to the selected project');
    expect(JSON.parse(readFileSync(second, 'utf-8')).media).toBe('../source.wav');
    expect(readFileSync(first, 'utf-8')).toBe(original);
  } finally {
    paused?.release();
    try { await server?.stop(); }
    finally { cleanupTempDir(root); }
  }
});

test('Launcher folder picker fills both sticker settings but only Apply changes them', async ({ page }, testInfo) => {
  const root = makeTempDir('native-sticker-root');
  const folders = ['default', 'override'].map(name => join(root, name).replaceAll('\\', '/'));
  let server, selected, paused;
  try {
    for (const folder of folders) mkdirSync(folder);
    server = await startLauncherTestEditor(root, async op => {
      await paused?.wait(op);
      return op === 'choose-sticker-root' ? selected : undefined;
    });
    await page.goto(server.url);
    await page.setViewportSize({ width: 760, height: 740 });

    for (const [index, prefix, tab, panel] of [
      [0, 'sticker-root', 'sticker', 'editor-settings'],
      [1, 'project-sticker-root', 'project-sticker', 'project-settings'],
    ]) {
      await page.locator(`#${panel}-toggle`).click();
      await page.locator(`#editor-settings-tab-${tab}`).click();
      const browse = page.locator(`#${prefix}-browse`);
      const input = page.locator(`#${prefix}-input`);
      const apply = page.locator(`#${prefix}-read`);
      const pickerToast = page.locator('.hint-card.hint-info').filter({ hasText: '选择表情包目录。' });
      await expect(browse).toBeVisible();
      if (index === 1) {
        await expect(browse).toBeDisabled();
        await page.locator('#project-sticker-root-override').check();
      }
      const previous = await input.inputValue();
      selected = undefined;
      paused = pausePicker('choose-sticker-root');
      await browse.click();
      await paused.entered;
      await expect(pickerToast).toBeVisible();
      await expect(pickerToast).toHaveAttribute('data-persistent', '1');
      paused.release();
      await expect(browse).toBeEnabled(); // picker returned
      await expect(pickerToast).toHaveCount(0);
      await expect(input).toHaveValue(previous);

      selected = folders[index];
      await browse.click();
      await expect(input).toHaveValue(selected);
      await expect(pickerToast).toHaveCount(0);
      expect(await page.evaluate(index => index === 0 ? MaweStickerRoot.getDefaultRoot() : MaweStickerRoot.projectRoot(), index)).toBe('');
      await apply.click();
      await expect(page.locator(`#${prefix}-status`)).toContainText('目录已应用');
      expect(await page.evaluate(() => MaweBoot.STICKER_ROOT)).toBe(selected);

      const spacing = await browse.evaluate(button => {
        const row = button.parentElement;
        const box = row.getBoundingClientRect();
        return [box.top - row.previousElementSibling.getBoundingClientRect().bottom,
          row.nextElementSibling.getBoundingClientRect().top - box.bottom,
          button.nextElementSibling.getBoundingClientRect().left - button.getBoundingClientRect().right];
      });
      expect(spacing).toEqual([8, 8, 8]);
      await page.locator(`#${panel}-panel`).screenshot({ path: testInfo.outputPath(`${tab}.png`) });
      await page.locator(`#${panel}-close`).click();
    }
  } finally {
    paused?.release();
    try { await server?.stop(); }
    finally { cleanupTempDir(root); }
  }
});

test('changing the active sticker directory requires confirmation when the project uses stickers', async ({ page }) => {
  const root = makeTempDir('sticker-root-confirm');
  const [original, replacement] = ['original', 'replacement'].map(name => join(root, name).replaceAll('\\', '/'));
  let server;
  try {
    mkdirSync(original);
    mkdirSync(replacement);
    server = await startBlankServer(await findFreePort(), join(root, '.settings'));
    await page.goto(server.url);
    await page.evaluate(async ({ original, segment }) => {
      await MaweStickerRoot.applyRoot('default', original);
      MaweBoot.DATA.segments.push({
        ...segment, sticker: { filename: 'sample.png', rel: 'sample.png', name: 'sample', start: segment.start, end: segment.end },
      });
    }, { original, segment: testSegments()[0] });

    const dialogs = [];
    let accept = false, requests = 0;
    page.on('request', request => { if (request.url().endsWith('/api/stickers/root')) requests++; });
    page.on('dialog', async dialog => {
      dialogs.push(dialog.message());
      if (accept) await dialog.accept(); else await dialog.dismiss();
    });
    const activeRoot = () => page.evaluate(() => MaweBoot.STICKER_ROOT);
    const assertStickerIntact = async () => {
      expect(await page.evaluate(() => MaweBoot.DATA.segments[0].sticker.rel)).toBe('sample.png');
    };

    await page.locator('#editor-settings-toggle').click();
    await page.locator('#editor-settings-tab-sticker').click();
    await page.locator('#sticker-root-input').fill(replacement);
    await page.locator('#sticker-root-read').click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('原有引用不会删除');
    expect(requests).toBe(0);
    expect(await activeRoot()).toBe(original);
    await assertStickerIntact();
    await page.locator('#editor-settings-close').click();

    await page.locator('#project-settings-toggle').click();
    await page.locator('#editor-settings-tab-project-sticker').click();
    const override = page.locator('#project-sticker-root-override');
    await override.check();
    await page.locator('#project-sticker-root-input').fill(replacement);
    accept = true;
    await page.locator('#project-sticker-root-read').click();
    await expect.poll(activeRoot).toBe(replacement);
    expect(dialogs).toHaveLength(2);
    expect(requests).toBe(1);
    await assertStickerIntact();

    accept = false;
    await override.click();
    await expect.poll(() => dialogs.length).toBe(3);
    await expect(override).toBeChecked();
    expect(requests).toBe(1);
    expect(await activeRoot()).toBe(replacement);
    await assertStickerIntact();

    accept = true;
    await override.click();
    await expect.poll(activeRoot).toBe(original);
    await expect(override).not.toBeChecked();
    expect(dialogs).toHaveLength(4);
    expect(requests).toBe(2);
    await assertStickerIntact();
  } finally {
    try { await server?.stop(); }
    finally { cleanupTempDir(root); }
  }
});
