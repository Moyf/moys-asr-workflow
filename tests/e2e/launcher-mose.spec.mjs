import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

test('native launch disables both entry points until completion and does not start Server', async ({ page }) => {
  await page.goto(pathToFileURL(launcher).href);
  await page.waitForFunction(() => window.MAWLauncher?.config?.providers?.length);
  const config = await page.evaluate(() => window.MAWLauncher.config);
  config.moseAvailable = true;
  config.guiLang = 'zh';
  config.update.autoCheck = false;
  await page.addInitScript(config => {
    window.__launchCalls = [];
    window.pywebview = { api: new Proxy({}, { get: (_, method) => method === 'then' ? undefined : async () => {
      if (method === 'get_config') return config;
      if (method === 'open_preferred_editor') {
        window.__launchCalls.push(method);
        return new Promise(resolve => { window.__completeMose = () => resolve({ ok: true, usedMose: true }); });
      }
      if (method === 'start_server') window.__launchCalls.push(method);
      return { ok: true };
    } }) };
  }, config);
  await page.reload();
  await page.waitForFunction(() => window.MAWLauncher?.config?.moseAvailable);
  await page.locator('#openMawe').click();
  await expect(page.locator('#openMawe')).toBeDisabled();
  await expect(page.locator('#openServerEditor')).toBeDisabled();
  await page.evaluate(() => {
    document.getElementById('openMawe').click();
    document.getElementById('openServerEditor').click();
    window.__completeMose();
  });
  await expect(page.locator('#openMawe')).toBeEnabled();
  await expect(page.locator('#openServerEditor')).toBeEnabled();
  await expect(page.locator('#status')).toContainText('MOSE');
  expect(await page.evaluate(() => window.__launchCalls.filter(method => method === 'open_preferred_editor'))).toHaveLength(1);
  expect(await page.evaluate(() => window.__launchCalls.includes('start_server'))).toBe(false);
});
