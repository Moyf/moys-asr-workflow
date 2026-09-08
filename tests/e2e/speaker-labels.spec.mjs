// Dev-only Playwright regression for speaker labels in the subtitle preview.
// Proves that labels are configurable, preview-only, rendered as a separate
// colored element, persisted in the project, and independently included or
// omitted from exported SRT text.
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
  await expect(page.locator('#subtitle-color-underline')).toBeChecked();
  await expect(page.locator('#subtitle-color-style-control')).toBeVisible();
  await expect(page.locator('#subtitle-color-style')).toHaveValue('underline');
  await expect(page.locator('#subtitle-speaker-labels-enabled')).not.toBeChecked();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeHidden();
  await expect(page.locator('#subtitle-speaker-label-separator')).toBeHidden();
  await expect(page.locator('#subtitle-speaker-label-yellow')).toHaveValue('SP1');
  await expect(page.locator('#subtitle-speaker-label-blue')).toHaveValue('SP5');

  await page.locator('#subtitle-speaker-labels-enabled').check();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeVisible();
  await expect(page.locator('#subtitle-speaker-label-separator')).toBeVisible();
  const speakerLabelGrid = await page.locator('.subtitle-speaker-label-list').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      inputIds: [...element.querySelectorAll('input')].map((input) => input.id),
      columns: style.gridTemplateColumns.trim().split(/\s+/).length,
      rows: style.gridTemplateRows.trim().split(/\s+/).length,
    };
  });
  expect(speakerLabelGrid).toEqual({
    inputIds: [
      'subtitle-speaker-label-yellow',
      'subtitle-speaker-label-green',
      'subtitle-speaker-label-red',
      'subtitle-speaker-label-purple',
      'subtitle-speaker-label-blue',
      'subtitle-speaker-label-separator',
    ],
    columns: 2,
    rows: 3,
  });
  await page.locator('#subtitle-speaker-label-yellow').fill('Host');
  await expect(page.locator('#subtitle-speaker-label-separator')).toHaveValue('：');
  const previewStructure = await page.evaluate(() => {
    const label = document.getElementById('overlay-main-speaker-label');
    const parent = label.parentElement;
    return {
      color: getComputedStyle(label).color,
      fontFamily: getComputedStyle(label).fontFamily,
      parentFontFamily: getComputedStyle(parent).fontFamily,
      childNodes: [...parent.childNodes].map((node) => (
        node.nodeType === Node.ELEMENT_NODE ? node.id : node.textContent
      )),
    };
  });
  expect(previewStructure).toEqual({
    color: 'rgb(196, 160, 25)',
    fontFamily: previewStructure.parentFontFamily,
    parentFontFamily: previewStructure.parentFontFamily,
    childNodes: ['overlay-main-speaker-label', 'Alpha'],
  });
  await expect(page.locator('#overlay-main-speaker-label')).toHaveText('Host：');
  await expect(page.locator('#overlay-main-speaker-label')).toBeVisible();
  await expect(page.locator('#overlay-main-text')).toHaveText('Host：Alpha');
  expect(await page.evaluate(() => DATA.segments[0].text)).toBe('Alpha');

  await page.locator('#subtitle-color-style').selectOption('text');
  await expect(page.locator('#subtitle-color-style')).toHaveValue('text');
  let colorStylePreview = await page.locator('#overlay-main-text').evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, textDecorationLine: style.textDecorationLine };
  });
  expect(colorStylePreview).toEqual({ color: 'rgb(196, 160, 25)', textDecorationLine: 'none' });
  await page.locator('#subtitle-color-style').selectOption('both');
  colorStylePreview = await page.locator('#overlay-main-text').evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, textDecorationLine: style.textDecorationLine };
  });
  expect(colorStylePreview).toEqual({ color: 'rgb(196, 160, 25)', textDecorationLine: 'underline' });
  await page.locator('#subtitle-color-underline').uncheck();
  await expect(page.locator('#subtitle-color-style-control')).toBeHidden();
  await page.locator('#subtitle-color-underline').check();
  await expect(page.locator('#subtitle-color-style-control')).toBeVisible();
  await expect(page.locator('#subtitle-color-style')).toHaveValue('both');

  await page.locator('#subtitle-speaker-label-separator').fill('"');
  await expect(page.locator('#overlay-main-speaker-label')).toHaveText('Host"');
  await expect(page.locator('#overlay-main-text')).toHaveText('Host"Alpha');
  await page.locator('#subtitle-speaker-label-separator').fill(' ');
  expect(await page.evaluate(() => ({
    label: document.getElementById('overlay-main-speaker-label').textContent,
    text: document.getElementById('overlay-main-text').textContent,
  }))).toEqual({ label: 'Host ', text: 'Host Alpha' });
  await page.locator('#subtitle-speaker-label-separator').fill('"');

  await page.locator('#subtitle-speaker-labels-enabled').uncheck();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeHidden();
  await expect(page.locator('#export-speaker-labels')).not.toBeChecked();
  await expect(page.locator('#overlay-main-speaker-label')).toBeHidden();
  await expect(page.locator('#overlay-main-text')).toHaveText('Alpha');
  await page.locator('#subtitle-speaker-labels-enabled').check();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeVisible();
  await expect(page.locator('#export-speaker-labels')).toBeChecked();
  await expect(page.locator('#overlay-main-text')).toHaveText('Host"Alpha');

  await page.locator('#editor-settings-toggle').click();
  await expect(page.locator('#editor-settings-panel')).toBeVisible();
  await page.locator('#editor-settings-tab-export').click();
  const exportToggle = page.locator('#export-speaker-labels');
  await expect(exportToggle).toBeChecked();
  expect(await page.evaluate(() => buildSrt())).toContain('Host"Alpha');

  await exportToggle.uncheck();
  await expect(exportToggle).not.toBeChecked();
  expect(await page.evaluate(() => buildSrt())).not.toContain('Host"Alpha');
  expect(await page.evaluate(() => buildSrt())).toContain('Alpha');

  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(() => page.evaluate(() => previewGeometryDirty)).toBe(false);

  const onDisk = JSON.parse(readFileSync(projectPath, 'utf-8'));
  expect(onDisk.preview.subtitle.speaker_labels).toEqual({
    enabled: true,
    separator: '"',
    names: {
      yellow: 'Host',
      green: 'SP2',
      red: 'SP3',
      purple: 'SP4',
      blue: 'SP5',
    },
  });
  expect(onDisk.preview.subtitle.color_style).toBe('both');
  expect(onDisk.segments[0].text).toBe('Alpha');

  await page.reload();
  await revealSpeakerCue(page);
  await expect(page.locator('#overlay-main-text')).toHaveText('Host"Alpha');
  await page.locator('#subtitle-preview-settings-toggle').click();
  await expect(page.locator('#subtitle-speaker-label-yellow')).toHaveValue('Host');
  await expect(page.locator('#subtitle-speaker-label-separator')).toHaveValue('"');
  await expect(page.locator('#subtitle-color-style')).toHaveValue('both');
});
