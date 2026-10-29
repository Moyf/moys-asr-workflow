import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { buildBrowserEditorFixture, cleanupTempDir, disableOnboarding, findFreePort,
  generateWaveformPayload, makeTempDir, startStaticServer } from './helpers.mjs';

let tempDir;
let server;
test.beforeAll(async () => {
  tempDir = makeTempDir('marker-editing-gate');
  server = await startStaticServer(buildBrowserEditorFixture(join(tempDir, 'blank.html')), await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

test('automatic project markers never persist through unrelated settings or an unmarked project', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1',
    JSON.stringify({ markerEditingEnabled: false, autoSaveProject: false })));
  await page.goto(server.url);
  await page.evaluate(waveform => {
    MaweProjectLoad.applyCanonicalProject({ segments: [], markers: [{ id: 'review', start: 100 }], waveform }, 'marked.mosp');
    MaweSettings.updateEditorSettings({ toastPosition: 'bottom-right' });
  }, generateWaveformPayload(6000));
  await expect(page.locator('#markers-quick-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem(MaweSettings.EDITOR_SETTINGS_KEY)).markerEditingEnabled)).toBe(false);
  await page.locator('#project-settings-toggle').click();
  await expect(page.locator('#project-marker-track-toggle')).toBeChecked();
  await page.locator('#project-settings-close').click();
  await page.locator('#markers-quick-toggle').click();
  await expect(page.locator('#markers-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(waveform => {
    MaweProjectLoad.applyCanonicalProject({ segments: [], markers: [{ id: 'review', start: 100 }], waveform }, 'marked.mosp');
  }, generateWaveformPayload(6000));
  await expect(page.locator('#markers-quick-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(waveform => MaweProjectLoad.applyCanonicalProject({ segments: [], waveform }, 'empty.mosp'), generateWaveformPayload(6000));
  await expect(page.locator('#markers-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.waveform-marker-track')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem(MaweSettings.EDITOR_SETTINGS_KEY)).markerEditingEnabled)).toBe(false);
});

async function seed(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(project => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(project)], 'marker-gate.mosp', { type: 'application/json' }));
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, {
    segments: [{ id: 'main', start: 0, end: 4200, text: 'main cue' }],
    overlay_track: { enabled: true, segments: [{ id: 'overlay', start: 500, end: 1500, text: 'overlay cue' }] },
    markers: [{ id: 'original', start: 100, name: 'keep this marker' }],
    waveform: generateWaveformPayload(6000),
  });
  await expect(page.locator('.overlay-track-cue')).toHaveCount(1);
  // 带标记的工程导入后自动开启；这些用例从用户手动关闭后的状态验证门控。
  await expect(page.locator('#markers-quick-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#markers-quick-toggle').click();
  await page.locator('[data-waveform-mode="multi"]').click();
}

async function point(page, timeMs) {
  return page.locator('.waveform-row').first().evaluate((row, time) => {
    const rect = row.getBoundingClientRect();
    return { x: rect.left + (time - Number(row.dataset.startMs)) / (Number(row.dataset.endMs) - Number(row.dataset.startMs)) * rect.width,
      y: rect.top + 8 };
  }, timeMs);
}
async function markerData(page) {
  return page.evaluate(() => MaweBoot.DATA.markers.map(marker => ({ ...marker })));
}

test('disabling auto-enabled markers leaves imported and rebuilt waveforms free for cue gestures', async ({ page }) => {
  await seed(page);
  const original = await markerData(page);
  await expect(page.locator('#markers-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.waveform-marker-track')).toHaveCount(0);
  const click = await point(page, 2600);
  await page.mouse.click(click.x, click.y);
  expect(await markerData(page)).toEqual(original);
  for (const mode of ['basic', 'multi']) {
    await page.locator(`[data-waveform-mode="${mode}"]`).click();
    await expect(page.locator('.waveform-marker-track')).toHaveCount(0);
  }
  const start = await point(page, 2600);
  const end = await point(page, 3800);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await expect(page.locator('.waveform-create-preview.waveform-overlay-block')).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');
  await expect(page.locator('.waveform-overlay-block')).toHaveCount(2);
  expect(await markerData(page)).toEqual(original);
  expect(await page.evaluate(() => AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments[1])).toMatchObject({ start: 2600, end: 3800 });
});

test('enabling marker editing creates markers and regions; disabling preserves them through redraw', async ({ page }) => {
  await seed(page);
  await page.locator('#markers-quick-toggle').click();
  await expect(page.locator('.waveform-marker-track')).toHaveCount(1);
  const click = await point(page, 2600);
  await page.mouse.click(click.x, click.y);
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.markers.length)).toBe(2);
  const start = await point(page, 4600);
  const end = await point(page, 4900);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.markers.length)).toBe(3);
  const created = (await markerData(page)).filter(marker => marker.id !== 'original');
  expect(Math.abs(created[0].start - 2600)).toBeLessThanOrEqual(20);
  expect(Math.abs(created[1].start - 4600)).toBeLessThanOrEqual(20);
  expect(Math.abs(created[1].end - 4900)).toBeLessThanOrEqual(20);
  const saved = await markerData(page);
  await page.locator('#markers-quick-toggle').click();
  for (const mode of ['basic', 'multi']) {
    await page.locator(`[data-waveform-mode="${mode}"]`).click();
    await expect(page.locator('.waveform-marker-track')).toHaveCount(0);
  }
  await page.mouse.click(click.x, click.y);
  expect(await markerData(page)).toEqual(saved);
  await page.locator('#markers-quick-toggle').click();
  await expect(page.locator('.waveform-marker-item:not(.drag-preview)')).toHaveCount(3);
  expect(await markerData(page)).toEqual(saved);
});

test('turning marker editing off during a drag cancels the pending region', async ({ page }) => {
  await seed(page);
  const original = await markerData(page);
  await page.locator('#markers-quick-toggle').click();
  const start = await point(page, 4600);
  const end = await point(page, 4900);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.locator('.waveform-marker-item.drag-preview')).toBeVisible();
  await page.keyboard.press('m');
  await expect(page.locator('#markers-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.waveform-marker-track')).toHaveCount(0);
  await page.mouse.up();
  expect(await markerData(page)).toEqual(original);
  await page.locator('#markers-quick-toggle').click();
  const click = await point(page, 2600);
  await page.mouse.click(click.x, click.y);
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.markers.length)).toBe(2);
});
