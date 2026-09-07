// Dev-only Playwright regression for speaker labels in the subtitle preview.
// Proves that labels are configurable, preview-only, persisted in the project,
// and independently included or omitted from exported SRT text.
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

let tempDir;
let projectPath;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('speaker-labels');
  const mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

async function revealSpeakerCue(page) {
  await page.evaluate(() => {
    const segment = DATA.segments[0];
    segment.color = { name: 'yellow' };
    const media = document.getElementById('player');
    media.currentTime = 1;
    media.dispatchEvent(new Event('seeked'));
    media.dispatchEvent(new Event('timeupdate'));
    refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay')).toBeVisible();
}

test('configures preview-only speaker labels and independently controls SRT export', async ({ page }) => {
  await page.goto(server.url);
  await revealSpeakerCue(page);

  await page.locator('#subtitle-preview-settings-toggle').click();
  const previewPanel = page.locator('#subtitle-preview-settings-panel');
  await expect(previewPanel).toBeVisible();
  await expect(page.locator('label.toggle.settings-panel-item:has(#subtitle-color-underline)'))
    .toHaveCount(1);
  await expect(page.locator('#subtitle-speaker-labels-enabled')).not.toBeChecked();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeHidden();
  await expect(page.locator('#subtitle-speaker-label-yellow')).toHaveValue('SP1');
  await expect(page.locator('#subtitle-speaker-label-blue')).toHaveValue('SP5');

  await page.locator('#subtitle-speaker-labels-enabled').check();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeVisible();
  await page.locator('#subtitle-speaker-label-yellow').fill('Host');
  await expect(page.locator('#overlay-main-text')).toHaveText('Host: Alpha');
  expect(await page.evaluate(() => DATA.segments[0].text)).toBe('Alpha');

  await page.locator('#subtitle-speaker-labels-enabled').uncheck();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeHidden();
  await expect(page.locator('#export-speaker-labels')).not.toBeChecked();
  await expect(page.locator('#overlay-main-text')).toHaveText('Alpha');
  await page.locator('#subtitle-speaker-labels-enabled').check();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeVisible();
  await expect(page.locator('#export-speaker-labels')).toBeChecked();
  await expect(page.locator('#overlay-main-text')).toHaveText('Host: Alpha');

  await page.locator('#editor-settings-toggle').click();
  await expect(page.locator('#editor-settings-panel')).toBeVisible();
  await page.locator('#editor-settings-tab-export').click();
  const exportToggle = page.locator('#export-speaker-labels');
  await expect(exportToggle).toBeChecked();
  expect(await page.evaluate(() => buildSrt())).toContain('Host: Alpha');

  await exportToggle.uncheck();
  await expect(exportToggle).not.toBeChecked();
  expect(await page.evaluate(() => buildSrt())).not.toContain('Host: Alpha');
  expect(await page.evaluate(() => buildSrt())).toContain('Alpha');

  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(() => page.evaluate(() => previewGeometryDirty)).toBe(false);

  const onDisk = JSON.parse(readFileSync(projectPath, 'utf-8'));
  expect(onDisk.preview.subtitle.speaker_labels).toEqual({
    enabled: true,
    names: {
      yellow: 'Host',
      green: 'SP2',
      red: 'SP3',
      purple: 'SP4',
      blue: 'SP5',
    },
  });
  expect(onDisk.segments[0].text).toBe('Alpha');

  await page.reload();
  await revealSpeakerCue(page);
  await expect(page.locator('#overlay-main-text')).toHaveText('Host: Alpha');
  await page.locator('#subtitle-preview-settings-toggle').click();
  await expect(page.locator('#subtitle-speaker-label-yellow')).toHaveValue('Host');
});
