import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { disableOnboarding, findFreePort, generateProjectJson, generateWav, makeTempDir, startServer } from './helpers.mjs';
let server;
test.beforeAll(async () => {
  const dir = makeTempDir('modal-save-investigation');
  const media = join(dir, 'synthetic.wav');
  const project = join(dir, 'project.json');
  generateWav(media, 60);
  generateProjectJson(project);
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
});
test('default save should be intercepted in a normal modal', async ({ page }) => {
  await page.locator('#timed-text-edit-btn').click();
  await expect(page.locator('#timed-text-edit-modal')).toHaveClass(/show/);
  await page.evaluate(() => {
    window.__saveAudit = [];
    document.addEventListener('keydown', event => {
      if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
        setTimeout(() => window.__saveAudit.push(event.defaultPrevented), 0);
      }
    }, true);
  });
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__saveAudit)).toEqual([true]);
});
test('project save excludes an unapplied timed text modal draft', async ({ page }) => {
  await page.locator('#timed-text-edit-btn').click();
  const textarea = page.locator('#timed-text-edit-rows textarea').first();
  await textarea.fill('Unapplied modal draft must not disappear');
  const saveUrl = new URL(await page.evaluate(() => MaweBoot.SERVER_CONFIG.saveUrl), server.url).href;
  let body;
  await page.route(saveUrl, async route => {
    body = route.request().postData();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const response = page.waitForResponse(response => response.url() === saveUrl && response.request().method() === 'POST');
  await page.evaluate(() => MaweProjectSave.saveCurrentProject());
  await response;
  expect(body).not.toContain('Unapplied modal draft must not disappear');
  await expect(textarea).toHaveValue('Unapplied modal draft must not disappear');
});
