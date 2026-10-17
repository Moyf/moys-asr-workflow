import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { disableOnboarding, findFreePort, generateWav, startServer } from './helpers.mjs';

const directory = path.resolve('.artifacts/translation-fixed-track-e2e');
const python = process.env.MAW_E2E_PYTHON || 'python';
let server, translated, source, media;

test.beforeAll(async () => {
  mkdirSync(directory, { recursive: true });
  execFileSync(python, [path.resolve('tests/helpers/generate-ai-review-fixture.py'), directory], { timeout: 30000, windowsHide: true });
  const cases = JSON.parse(readFileSync(path.join(directory, 'cases.json'), 'utf8'));
  translated = JSON.parse(readFileSync(cases.bilingual.project, 'utf8'));
  source = JSON.parse(readFileSync(cases.bilingual.source, 'utf8'));
  media = path.join(directory, 'fixture.wav');
  generateWav(media, 3);
  server = await startServer(cases.bilingual.project, media, await findFreePort());
});

test.afterAll(async () => { await server?.stop(); });

test('overwritten secondary survives preview, MOSP save/reopen and bilingual SRT export', async ({ page }, testInfo) => {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    window.__translationSaves = [];
    window.showSaveFilePicker = async options => ({
      name: options.suggestedName,
      async createWritable() {
        return { async write(blob) { window.__translationSaves.push({ name: options.suggestedName, text: await blob.text() }); }, async close() {} };
      },
    });
  });
  await page.goto(server.url);
  await expect(page.locator('#cues-container > .cue')).toHaveCount(2);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().id)).toBe('fixed-secondary');
  expect(translated.multi_subtitle.tracks).toHaveLength(1);
  expect(translated.multi_subtitle.tracks[0].segments).toHaveLength(2);
  expect(translated.segments).toEqual(source.segments);
  await page.evaluate(() => MawePlaybackLoop.refreshSubtitlePreview(500, 0));
  await expect(page.locator('#overlay-extension-text')).toContainText('Introduce the API.');
  await expect(page.locator('#cues-container')).not.toContainText('过期译文');
  await page.locator('#download-json').click();
  await expect.poll(() => page.evaluate(() => window.__translationSaves.length)).toBe(1);
  const saved = JSON.parse(await page.evaluate(() => window.__translationSaves[0].text));
  expect(saved.segments).toMatchObject(translated.segments);
  expect(saved.multi_subtitle.tracks).toHaveLength(1);
  expect(saved.multi_subtitle.tracks[0].id).toBe('fixed-secondary');
  expect(saved.multi_subtitle.tracks[0].segments.map(cue => cue.text)).toEqual(['Introduce the API.', 'It processes subtitles.']);
  expect(saved.multi_subtitle.bindings[0].id).toBe('existing-binding');
  const reopened = testInfo.outputPath('reopened.mosp');
  writeFileSync(reopened, JSON.stringify(saved), 'utf8');
  await server.stop();
  server = await startServer(reopened, media, await findFreePort());
  await page.goto(server.url);
  await expect(page.locator('#cues-container > .cue')).toHaveCount(2);
  await page.evaluate(() => MawePlaybackLoop.refreshSubtitlePreview(500, 0));
  await expect(page.locator('#overlay-extension-text')).toContainText('Introduce the API.');
  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-bilingual-srt').click();
  await expect.poll(() => page.evaluate(() => window.__translationSaves.length)).toBe(1);
  const srt = await page.evaluate(() => window.__translationSaves[0].text);
  expect(srt).toContain('介绍 API。');
  expect(srt).toContain('Introduce the API.');
  expect(srt).toContain('It processes subtitles.');
  expect(srt).not.toContain('过期译文');
  await page.screenshot({ path: testInfo.outputPath('fixed-secondary-reopened.png'), fullPage: true });
});
