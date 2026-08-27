import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  cleanupTempDir,
  disableOnboarding,
  findFreePort,
  generateWaveformPayload,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

const DURATION_MS = 6_000;

function generateEdlProjectJson(filePath) {
  const project = {
    media: 'synthetic.wav',
    gap_remove: {
      detector: 'audio_gate',
      gaps: [
        { start: 1000, end: 1600, removed: true },
        { start: 4000, end: 4500, removed: true },
      ],
    },
    segments: [],
    waveform: generateWaveformPayload(DURATION_MS),
  };
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
  return filePath;
}

async function stubSavePicker(page) {
  await page.addInitScript(() => {
    window.__exportSaves = [];
    window.showSaveFilePicker = async (options) => ({
      name: options.suggestedName,
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
}

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('gap-removed-edl-export');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateEdlProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('exports the audio source cuts on the packed gap-removed timeline', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);

  await page.locator('#extra-export-btn').click();
  await expect(page.locator('#extra-export-menu #download-gap-removed-edl')).toHaveCount(0);
  await page.locator('#gap-removed-export-btn').click();
  await expect(page.locator('#download-gap-removed-edl')).toHaveText('时间线 EDL');
  await expect(page.locator('#download-sticker-edl')).toHaveCount(0);
  await page.locator('#download-gap-removed-edl').click();

  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const save = (await page.evaluate(() => window.__exportSaves))[0];
  expect(save.suggestedName).toBe('project_gap-removed.edl');
  expect(save.content).toContain('TITLE: project_gap-removed');
  expect(save.content).toContain('FCM: NON-DROP FRAME');
  expect(save.content).toMatch(/^001  syntheti AA\s+C\s+00:00:00:00 00:00:01:00 00:00:00:00 00:00:01:00$/m);
  expect(save.content).toMatch(/^002  syntheti AA\s+C\s+00:00:01:18 00:00:04:00 00:00:01:00 00:00:03:12$/m);
  expect(save.content).toMatch(/^003  syntheti AA\s+C\s+00:00:04:15 00:00:06:00 00:00:03:12 00:00:04:27$/m);
  expect(save.content).not.toMatch(/^\d{3}  syntheti V/m);
  expect(save.content).toMatch(/\* SOURCE FILE: .*[\\/]synthetic\.wav/);
});
