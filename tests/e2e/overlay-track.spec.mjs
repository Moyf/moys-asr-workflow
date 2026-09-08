import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir,
  copyPortableBlankEditor,
  findFreePort,
  generateWaveformPayload,
  makeTempDir,
  startStaticServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('overlay-track');
  const blankPath = copyPortableBlankEditor(join(tempDir, 'blank-editor.html'));
  server = await startStaticServer(blankPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

async function dropProject(page, project) {
  const dataTransfer = await page.evaluateHandle((spec) => {
    const bytes = Uint8Array.from(atob(spec.base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], spec.name, { type: 'application/json' }));
    return transfer;
  }, {
    name: 'overlay-track.mosp',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

async function stubSavePicker(page) {
  await page.addInitScript(() => {
    window.__overlayTrackExports = [];
    window.showSaveFilePicker = async (options) => ({
      name: options.suggestedName,
      async createWritable() {
        return {
          async write(blob) {
            window.__overlayTrackExports.push({
              name: options.suggestedName,
              content: await blob.text(),
            });
          },
          async close() {},
        };
      },
    });
  });
}

test('edits an independent overlay track, restores it through history, and exports both tracks', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 500, end: 1500, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(3000),
  };
  await stubSavePicker(page);
  await page.goto(server.url);
  await dropProject(page, project);

  const toggle = page.locator('#overlay-track-toggle');
  await expect(toggle).toBeVisible();
  const overlayCue = page.locator('.overlay-track-cue[data-overlay-idx="0"]');
  await expect(overlayCue).toHaveCount(1);
  await overlayCue.click();
  await expect(page.locator('#cue-panel-target')).toHaveText('叠加字幕');

  const panelText = page.locator('#cue-panel-text');
  await panelText.fill('overlay edited');
  await page.locator('#cue-panel-target').click();
  await expect(overlayCue).toContainText('overlay edited');

  await page.keyboard.press('Control+z');
  await expect(overlayCue).toContainText('overlay cue');
  await page.keyboard.press('Control+Shift+z');
  await expect(overlayCue).toContainText('overlay edited');

  await page.locator('#download-json').click();
  await expect.poll(() => page.evaluate(() => window.__overlayTrackExports.length)).toBe(1);
  const savedProject = await page.evaluate(() => window.__overlayTrackExports[0].content);
  const savedOverlay = JSON.parse(savedProject).overlay_track;
  expect(savedOverlay.enabled).toBe(true);
  expect(savedOverlay.segments).toHaveLength(1);
  expect(savedOverlay.segments[0]).toMatchObject({
    id: 'overlay-001', start: 500, end: 1500, text: 'overlay edited', _dirty: true,
  });

  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-full-srt').click();
  await expect.poll(() => page.evaluate(() => window.__overlayTrackExports.length)).toBe(2);
  const srt = await page.evaluate(() => window.__overlayTrackExports[1].content);
  expect(srt).toContain('00:00:00,000 --> 00:00:02,000\nmain cue');
  expect(srt).toContain('00:00:00,500 --> 00:00:01,500\noverlay edited');
});
