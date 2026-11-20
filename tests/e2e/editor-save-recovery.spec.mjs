import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir, disableOnboarding, DURATION_MS, findFreePort,
  generateProjectJson, generateWav, makeTempDir, startServer,
} from './helpers.mjs';

let directory;
let projectPath;
let mediaPath;
let server;

// Each journey owns its disk file and server. Real autosave stays enabled.
test.beforeEach(async ({ page }) => {
  directory = makeTempDir('editor-save-recovery');
  mediaPath = join(directory, 'synthetic.wav');
  projectPath = generateProjectJson(join(directory, 'project.json'));
  generateWav(mediaPath, DURATION_MS / 1000);
  server = await startServer(projectPath, mediaPath, await findFreePort());
  await disableOnboarding(page);
  await page.goto(server.url);
});

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
  cleanupTempDir(directory);
});

function cueContent(project) {
  return project.segments.map(({ text, start, end }) => ({ text, start, end }));
}

function cueTime(ms) {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor(ms / 1_000) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms % 1_000).padStart(3, '0')}`;
}

async function editFirstCue(page, text) {
  await page.locator('.cue').first().click();
  await page.locator('#cue-panel-text').fill(text);
  await page.locator('#cue-panel-target').click();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe(text);
}

test('auto-saved text and cue times survive restarting the editor server', async ({ page }) => {
  const expected = cueContent(JSON.parse(readFileSync(projectPath, 'utf8')));
  expected[0].text = 'Alpha autosaved';
  const saved = page.waitForResponse(response => (
    response.url().endsWith('/api/project') && response.request().method() === 'POST'
  ));
  await editFirstCue(page, expected[0].text);
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  await expect.poll(() => page.evaluate(() => (
    !MaweServerSave.projectSaveInFlight && !MaweServerSave.hasUnsavedProjectChanges()
  ))).toBe(true);
  expect(cueContent(JSON.parse(readFileSync(projectPath, 'utf8')))).toEqual(expected);

  // A reload alone can use the server's in-memory copy, not the written file.
  await server.stop();
  server = await startServer(projectPath, mediaPath, await findFreePort());
  await page.goto(server.url);
  await expect.poll(async () => cueContent(await page.evaluate(() => MaweBoot.DATA))).toEqual(expected);
  await expect(page.locator('.cue')).toHaveCount(expected.length);
  for (const [index, cue] of expected.entries()) {
    const row = page.locator(`.cue[data-idx="${index}"]`);
    await expect(row.locator('.text')).toHaveText(cue.text);
    await expect(row.locator('.time-start')).toHaveText(cueTime(cue.start));
    await expect(row.locator('.time-end')).toHaveText(cueTime(cue.end));
  }
  await page.locator('.cue').first().click();
  await expect(page.locator('#cue-panel-text')).toHaveValue(expected[0].text);
});

test('disconnected save downloads the latest edit without changing the original file', async ({ page }) => {
  const original = readFileSync(projectPath, 'utf8');
  const expected = cueContent(JSON.parse(original));
  expected[0].text = 'Latest offline edit';
  await page.route('**/api/project', route => route.abort('connectionrefused'));
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  const autoSaveFailure = page.waitForEvent('requestfailed', request => (
    request.url().endsWith('/api/project') && request.method() === 'POST'
  ));
  await editFirstCue(page, expected[0].text);
  await autoSaveFailure;
  // The failed real autosave must settle before the explicit recovery action.
  await expect.poll(() => page.evaluate(() => (
    !MaweServerSave.projectSaveInFlight && MaweServerSave.autoSaveFlushTimer === null
  ))).toBe(true);
  page.once('dialog', dialog => dialog.accept());
  const downloaded = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('project.mosp');
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(cueContent(JSON.parse(readFileSync(path, 'utf8')))).toEqual(expected);
  expect(readFileSync(projectPath, 'utf8')).toBe(original);
});
