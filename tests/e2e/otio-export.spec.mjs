import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  disableOnboarding,
  findFreePort,
  generateWaveformPayload,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

const DURATION_MS = 2_000;

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('otio-export');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  writeFileSync(projectPath, JSON.stringify({
    media: 'synthetic.wav',
    segments: [{ start: 0, end: 1000, text: 'Alpha' }],
    waveform: generateWaveformPayload(DURATION_MS),
  }, null, 2), 'utf-8');
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('exports source OTIO when media metadata is missing', async ({ page }) => {
  await disableOnboarding(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__exportSaves = [];
    window.showSaveFilePicker = async (options) => ({
      async createWritable() {
        return {
          async write(blob) {
            window.__exportSaves.push({
              suggestedName: options.suggestedName,
              content: await blob.text(),
            });
          },
          async close() {},
        };
      },
    });
  });
  await page.goto(server.url);
  await page.evaluate(() => { DATA.media_metadata = null; });

  await page.locator('#extra-export-btn').click();
  await page.locator('[aria-controls="extra-otio-menu"]').hover();
  await page.locator('#download-otio').click();

  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const saved = await page.evaluate(() => window.__exportSaves[0]);
  const timeline = JSON.parse(saved.content);
  expect(saved.suggestedName).toBe('project.otio');
  expect(timeline.tracks.children.map((track) => ({
    kind: track.kind,
    name: track.name,
    clipCount: track.children.length,
  }))).toEqual([{ kind: 'Audio', name: '音频', clipCount: 1 }]);
  expect(pageErrors).toEqual([]);
});
