import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';

const project = JSON.parse(readFileSync(new URL('../fixtures/project-tracks/legacy-three-tracks.expected.json', import.meta.url), 'utf8'));
let directory, server;
test.beforeAll(async () => {
  directory = makeTempDir('v2-bound-list');
  server = await startBlankServer(await findFreePort(), directory);
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });

test('dual-list binding markers follow re-render, unbind, rebind and track swap', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweMultiImport));
  await page.evaluate(input => {
    MaweSettings.updateEditorSettings({ autoSaveProject: false });
    MaweProjectLoad.applyCanonicalProject({ ...input, media: '' }, 'bound-list-v2.mosp');
  }, project);
  const column = () => page.locator('.multi-cue-column.extension').filter({ hasText: 'A' });
  await expect(column()).toHaveCount(1);
  await expect(column()).not.toHaveClass(/unbound/);

  await page.evaluate(() => {
    window.__savedBinding = structuredClone(MaweBoot.DATA.bindings[0]);
    MaweBoot.DATA.bindings = [];
    MaweCuePanel.renderAll({ waveform: 'none' });
  });
  await expect(column()).toHaveClass(/unbound/);

  await page.evaluate(() => {
    MaweBoot.DATA.bindings.push(window.__savedBinding);
    MaweCuePanel.renderAll({ waveform: 'none' });
  });
  await expect(column()).not.toHaveClass(/unbound/);

  await page.evaluate(() => MaweMultiImport.swapMainAndExtensionSubtitles());
  const swappedColumn = page.locator('.multi-cue-column.extension').filter({ hasText: '甲' });
  await expect(swappedColumn).toHaveCount(1);
  await expect(swappedColumn).not.toHaveClass(/unbound/);
  await page.evaluate(() => MaweHistory.performUndo());
  await expect(column()).not.toHaveClass(/unbound/);
});
