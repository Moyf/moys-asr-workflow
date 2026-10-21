import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson, generateWav, makeTempDir } from './helpers.mjs';
import { spawnServerProcess, stopServerProcess } from './server-process.mjs';

test('Launcher keeps the local editor while retiring standalone actions', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('web/launcher/index.html')).href);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await expect(page.locator('#openMenu')).toBeVisible();
  const config = await page.evaluate(() => window.MAWLauncher.config);
  // Deliver the capability through the initial backend response. Dispatching
  // a checkbox change after startup would conceal missing initialization.
  await page.addInitScript(config => {
    window.pywebview = { api: new Proxy({}, { get(_, method) {
      if (method === 'then') return undefined;
      if (method === 'get_config') return async () => ({ ...config, standaloneEditorSupported: false });
      if (method === 'default_output') return async () => ({ ok: true, path: '', renamed: false });
      return async () => ({ ok: true });
    } }) };
  }, config);
  await page.reload();
  await page.waitForFunction(() => window.MAWLauncher?.config?.standaloneEditorSupported === false);
  await expect(page.locator('#generateHtml')).toBeDisabled();
  await expect(page.locator('#openMenu')).toBeHidden();
  await expect(page.locator('#openBlankHtml')).toBeHidden();
  await expect(page.locator('#openMawe')).toBeVisible();
  await expect(page.locator('#openMawe')).toBeEnabled();
  await page.screenshot({ path: info.outputPath('launcher-retired.png'), fullPage: true });

  await page.evaluate(() => {
    window.MAWLauncher.config.standaloneEditorSupported = true;
    document.getElementById('generateHtml').dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#openMenu')).toBeVisible();
  await expect(page.locator('#generateHtml')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('built website recommends the local app with spaced actions', async ({ page }, info) => {
  const root = path.resolve('website/dist');
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      let file = path.resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) throw new Error('outside fixture');
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp' }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await expect(page.locator('.hero-actions .button-primary')).toHaveText('下载本地应用 ↗');
    await expect(page.locator('a[href$="/editor/"]')).toHaveCount(0);
    const spacing = await page.locator('.hero-actions').evaluate(element => {
      const [first, second] = [...element.children].map(child => child.getBoundingClientRect());
      const above = element.previousElementSibling.getBoundingClientRect();
      return { gap: parseFloat(getComputedStyle(element).gap), pixels: second.left - first.right,
        abovePixels: element.getBoundingClientRect().top - above.bottom };
    });
    expect(spacing.gap).toBeGreaterThanOrEqual(8);
    expect(spacing.pixels).toBeGreaterThanOrEqual(8);
    expect(spacing.abovePixels).toBeGreaterThanOrEqual(8);
    await writeFile(info.outputPath('action-spacing.json'), JSON.stringify(spacing, null, 2));
    await info.attach('action-spacing', { body: JSON.stringify(spacing), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('website-local-entry.png'), fullPage: true });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('actual 2.0 source Server opens saves backs up and exports without a standalone fixture', async ({ page }, info) => {
  const directory = makeTempDir('actual-two-entry');
  const source = path.join(directory, 'source');
  const configured = process.env.MAW_E2E_PYTHON;
  const python = configured || 'uv';
  const prefix = configured ? [] : ['run', '--no-sync', 'python'];
  let server;
  try {
    // Real metadata plus the normal version sync, no patched policy or renderer.
    execFileSync(python, [...prefix, 'tests/helpers/versioned_source.py', source], { windowsHide: true });
    const media = path.join(source, 'synthetic.wav');
    const project = path.join(source, 'legacy.json');
    generateWav(media, 6);
    generateProjectJson(project);
    const initial = JSON.parse(readFileSync(project, 'utf8'));
    initial.extension_review = { preserved: true };
    writeFileSync(project, JSON.stringify(initial));
    const port = await findFreePort();
    const url = `http://127.0.0.1:${port}/`;
    const settings = path.join(directory, 'settings');
    server = spawnServerProcess(python, [...prefix, path.join(source, 'server-editor/serve.py'),
      project, '-m', media, '--no-open', '--no-waveform', '--port', String(port)],
    { cwd: process.cwd(), env: { ...process.env, MAW_APP_DATA_ROOT: settings,
      LOCALAPPDATA: settings, XDG_CONFIG_HOME: settings } });
    await expect.poll(async () => {
      try {
        const response = await fetch(`${url}api/startup-status`, { signal: AbortSignal.timeout(1500) });
        return (await response.json()).status;
      } catch { return 'starting'; }
    }, { timeout: 45000 }).toBe('ready');
    await disableOnboarding(page);
    await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
    await page.goto(`${url}?lang=en`);
    expect(await page.content()).toContain('v2.0.0-beta.1');
    await page.locator('.cue .text').first().click();
    await page.locator('#cue-panel-text').fill('Version two saved');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/project') && response.request().method() === 'POST');
    await page.keyboard.press('Control+s');
    expect((await saved).ok()).toBe(true);
    const content = JSON.parse(readFileSync(project, 'utf8'));
    expect(content.segments[0].text).toBe('Version two saved');
    expect(content.extension_review).toEqual({ preserved: true });
    expect(existsSync(`${project}.bak`)).toBe(true);
    expect(await page.evaluate(() => window.MaweExportSrt.buildSrt())).toContain('Version two saved');
    const beforeFailure = readFileSync(project, 'utf8');
    const rejected = await page.request.post(`${url}api/project`, { data: { schema: 'unknown.future.schema', segments: 'invalid' } });
    expect(rejected.status()).toBeGreaterThanOrEqual(400);
    expect(rejected.status()).toBeLessThan(500);
    expect(readFileSync(project, 'utf8')).toBe(beforeFailure);
    expect(existsSync(path.join(source, 'blank-editor.html'))).toBe(false);
    await page.screenshot({ path: info.outputPath('actual-two-server.png') });
  } finally {
    if (server) await stopServerProcess(server);
    cleanupTempDir(directory);
  }
});
