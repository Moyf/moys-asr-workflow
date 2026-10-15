import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('Launcher keeps the local editor while retiring standalone actions', async ({ page }, info) => {
  await page.goto(pathToFileURL(path.resolve('web/launcher/index.html')).href);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  // The real Launcher bundle uses its built-in fixture bridge here; Python
  // contract tests independently check the production capability and API.
  await page.evaluate(() => {
    window.MAWLauncher.config.standaloneEditorSupported = false;
    document.getElementById('generateHtml').dispatchEvent(new Event('change'));
  });
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
