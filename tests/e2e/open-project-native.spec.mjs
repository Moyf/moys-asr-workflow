import { expect, test } from '@playwright/test';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { cleanupTempDir, findFreePort, generateWav, makeTempDir, startBlankServer, testSegments } from './helpers.mjs';

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
    const path = pick(operation);
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

test('Launcher Open Project keeps edits on cancellation and Ctrl+S writes to the selected path', async ({ page }) => {
  const root = makeTempDir('native-open');
  let server, selected, selectedMedia;
  try {
    mkdirSync(join(root, 'projects'));
    generateWav(join(root, 'source.wav'), 5);
    const first = join(root, 'first.mosp');
    const second = join(root, 'projects', 'second.mosp');
    writeFileSync(first, JSON.stringify({ media: 'source.wav', segments: testSegments() }));
    writeFileSync(second, JSON.stringify({ media: 'missing.wav', segments: testSegments() }));
    const original = readFileSync(first, 'utf-8');
    server = await startLauncherTestEditor(root, operation => ({
      'choose-project': selected, 'choose-media': selectedMedia,
    })[operation]);
    await page.goto(server.url);

    const open = page.locator('#open-project');
    async function pick(path, { reload = false } = {}) {
      selected = path;
      const response = page.waitForResponse('**/api/project/native-pick');
      const loaded = reload ? page.waitForEvent('load', { timeout: 20_000 }) : null;
      await open.click();
      expect((await response).ok()).toBe(true);
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
    const dialogs = [];
    let acceptDiscard = false;
    page.on('dialog', async dialog => {
      dialogs.push(dialog.type());
      if (acceptDiscard) await dialog.accept();
      else await dialog.dismiss();
    });

    await pick(first, { reload: true });
    await expect(projectName).toHaveText('first.mosp');
    await edit('Keep this unsaved edit');
    await pick(null);
    await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('Keep this unsaved edit');
    expect(dialogs).toEqual([]);

    await pick(second); // Cancel the follow-up linked-media picker.
    expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
    expect(dialogs).toEqual([]);
    selectedMedia = join(root, 'source.wav');
    await pick(second);
    await expect.poll(() => dialogs).toEqual(['confirm']);
    await expect(projectName).toHaveText('first.mosp');
    expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);

    acceptDiscard = true;
    await pick(second, { reload: true });
    await expect(projectName).toHaveText('second.mosp');
    await expect(page.locator('#media-name')).toHaveText('source.wav');
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
    try { await server?.stop(); }
    finally { cleanupTempDir(root); }
  }
});

test('Launcher folder picker fills both sticker settings but only Apply changes them', async ({ page }, testInfo) => {
  const root = makeTempDir('native-sticker-root');
  const folders = ['default', 'override'].map(name => join(root, name).replaceAll('\\', '/'));
  let server, selected;
  try {
    for (const folder of folders) mkdirSync(folder);
    server = await startLauncherTestEditor(root, op => op === 'choose-sticker-root' ? selected : undefined);
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
      await expect(browse).toBeVisible();
      if (index === 1) {
        await expect(browse).toBeDisabled();
        await page.locator('#project-sticker-root-override').check();
      }
      const previous = await input.inputValue();
      selected = undefined;
      await browse.click();
      await expect(browse).toBeEnabled(); // picker returned
      await expect(input).toHaveValue(previous);

      selected = folders[index];
      await browse.click();
      await expect(input).toHaveValue(selected);
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
    try { await server?.stop(); }
    finally { cleanupTempDir(root); }
  }
});
