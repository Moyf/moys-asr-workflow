import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
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

async function exportSourceOtio(page, format = 'otio') {
  await page.locator('#extra-export-btn').click();
  await page.locator('[aria-controls="extra-otio-menu"]').hover();
  await page.locator(`#download-${format}`).click();
}

test('canceling the OTIO picker does not offer the companion SRT', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    window.pickerNames = [];
    window.showSaveFilePicker = async ({ suggestedName }) => {
      window.pickerNames.push(suggestedName);
      throw new DOMException('Canceled', 'AbortError');
    };
  });
  await page.goto(server.url);
  await page.evaluate(() => MaweSettings.updateEditorSettings({ otioExportIncludeSrt: true }));
  await exportSourceOtio(page);
  await expect.poll(() => page.evaluate(() => window.pickerNames)).toEqual(['project.otio']);
});

test('downloads the OTIO timeline alone when there is no save picker', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  await page.goto(server.url);
  await page.evaluate(() => MaweSettings.updateEditorSettings({ otioExportIncludeSrt: false }));
  const pending = page.waitForEvent('download', { timeout: 5000 });
  await exportSourceOtio(page);
  const download = await pending;
  expect(download.suggestedFilename()).toBe('project.otio');
  expect(JSON.parse(readFileSync(await download.path(), 'utf8')).OTIO_SCHEMA).toBe('Timeline.1');
});

for (const [format, gapRemoved] of [['otio', false], ['otio', true], ['otioz', false], ['otioz', true]]) {
  test(`downloads the ${gapRemoved ? 'gap-removed' : 'source'} ${format.toUpperCase()} and companion SRT without a save picker`, async ({ page }) => {
    await disableOnboarding(page);
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
    await page.goto(`${server.url}?lang=zh`);
    await page.evaluate(() => MaweSettings.updateEditorSettings({ otioExportIncludeSrt: true }));
    const downloads = new Map();
    page.on('download', download => downloads.set(download.suggestedFilename(), download));
    if (gapRemoved) {
      await page.evaluate(() => {
        MaweBoot.DATA.gap_remove = {
          schema: 'moy.asr.gap_remove.v1',
          gaps: [{ start: 1200, end: 1600, removed: true }],
        };
        MaweGapRemoveUi.updateGapRemoveUi();
      });
      await page.locator('#gap-export-checkbox').check();
    }
    await exportSourceOtio(page, format);
    const basename = gapRemoved ? 'project_去空隙' : 'project';
    const names = [`${basename}.${format}`, `${basename}.srt`];
    await expect.poll(() => [...downloads.keys()].sort()).toEqual(names);
    const timeline = readFileSync(await downloads.get(names[0]).path());
    if (format === 'otioz') {
      expect(timeline.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(timeline.includes('content.otio')).toBe(true);
    } else {
      expect(JSON.parse(timeline.toString('utf8')).OTIO_SCHEMA).toBe('Timeline.1');
    }
    expect(readFileSync(await downloads.get(names[1]).path(), 'utf8')).toContain('Alpha');
  });
}

test('exports source OTIO without media metadata and keeps its companion SRT in sync', async ({ page }) => {
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
            if (options.suggestedName.endsWith('.otio')) {
              await new Promise(resolve => { window.__finishOtioWrite = resolve; });
            }
          },
          async close() {},
        };
      },
    });
  });
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.media_metadata = null;
    MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt = true;
  });

  await exportSourceOtio(page);

  await expect.poll(() => page.evaluate(() => typeof window.__finishOtioWrite)).toBe('function');
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = 'Changed while the OTIO was being saved';
    window.__finishOtioWrite();
  });
  await expect.poll(() => page.evaluate(() => window.__exportSaves.map(save => save.suggestedName)))
    .toEqual(['project.otio', 'project.srt']);
  const [saved, srt] = await page.evaluate(() => window.__exportSaves);
  const timeline = JSON.parse(saved.content);
  expect(saved.suggestedName).toBe('project.otio');
  expect(srt.content).toContain('Alpha');
  expect(timeline.tracks.children.map((track) => ({
    kind: track.kind,
    name: track.name,
    clipCount: track.children.length,
  }))).toEqual([{ kind: 'Audio', name: '音频', clipCount: 1 }]);
  expect(pageErrors).toEqual([]);
});
