import { test, expect } from '@playwright/test';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload,
  generateWav, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server;
test.beforeAll(async () => {
  tempDir = makeTempDir('fcp7-png');
  const media = join(tempDir, 'source.wav');
  generateWav(media, 3);
  const project = join(tempDir, 'project.json');
  writeFileSync(project, JSON.stringify({ media: 'source.wav',
    media_metadata: { video_width: 640, video_height: 360 },
    gap_remove: { detector: 'audio_gate', gaps: [{ start: 1000, end: 1400, removed: true }] },
    segments: [{ start: 200, end: 2400, text: '>>PNG TEST<<', items: [{ start: 200, end: 2400, text: '>>PNG TEST<<' }] }],
    waveform: generateWaveformPayload(3000) }));
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

async function open(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.locator('#extra-export-btn').click();
  await page.locator('#download-fcp7-export').click();
  await page.locator('#fcp7-export-format').selectOption('png');
  await expect(page.locator('#fcp7-export-native-text')).toBeHidden();
  await page.locator('#fcp7-export-timeline-mode').selectOption('source');
  await page.locator('#fcp7-export-fps').selectOption('25');
}

test('real PNG job publishes subtitle-only XML and preserves a static hold', async ({ page }) => {
  test.setTimeout(120000);
  await open(page);
  await page.locator('#fcp7-png-size').selectOption('custom');
  await page.locator('#fcp7-png-width').fill('480');
  await page.locator('#fcp7-png-height').fill('270');
  const spacing = await page.locator('[for="fcp7-export-timeline-mode"]').evaluate(el => {
    const previous = el.previousElementSibling;
    return el.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
  });
  expect(spacing).toBeGreaterThanOrEqual(8);
  const shotDir = resolve('.artifacts/fcp7-png');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'png-export-options.png') });
  const published = page.waitForResponse(r => r.url().includes('/fcp7-png/jobs/') && r.url().endsWith('/publish'));
  await page.locator('#fcp7-export-confirm').click();
  const response = await published;
  expect(response.status()).toBe(200);
  const result = await response.json();
  await expect(page.locator('#fcp7-export-status')).toContainText('已保存');
  expect(existsSync(result.xmlPath)).toBeTruthy();
  expect(existsSync(result.vegasXmlPath)).toBeTruthy();
  await expect(page.locator('#fcp7-export-status')).toContainText(result.vegasXmlPath);
  expect(readFileSync(result.vegasXmlPath, 'utf8')).not.toContain('file://');
  const manifest = JSON.parse(readFileSync(join(result.packagePath, 'manifest.json'), 'utf8'));
  expect([manifest.width, manifest.height]).toEqual([480, 270]);
  const png = readFileSync(manifest.tracks[0].clips[0].path);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([480, 270]);
  expect(manifest.tracks.flatMap(t => t.clips).some(c => c.endFrame - c.startFrame > 1)).toBeTruthy();
  const xml = readFileSync(result.xmlPath, 'utf8');
  expect(xml).toContain('<width>480</width><height>270</height>');
  expect(xml).toContain('<stillframe>TRUE</stillframe>');
  expect(xml).not.toContain('source.wav');
  expect(xml).not.toContain('GraphicAndType');
  await page.screenshot({ path: join(shotDir, 'png-export-complete.png') });
});

test('media scope includes the bound source and cancellation cleans an admitted job', async ({ page }) => {
  test.setTimeout(120000);
  await open(page);
  await page.locator('#fcp7-export-scope').selectOption('media');
  const published = page.waitForResponse(r => r.url().endsWith('/publish'));
  await page.locator('#fcp7-export-confirm').click();
  const response = await published;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(readFileSync(result.xmlPath, 'utf8')).toContain('source.wav');
  await expect(page.locator('#fcp7-export-confirm')).toBeEnabled();
  await page.locator('#fcp7-export-confirm').click();
  await expect(page.locator('#fcp7-export-stop')).toBeVisible();
  await page.locator('#fcp7-export-stop').click();
  await expect(page.locator('#fcp7-export-status')).toContainText('已停止');
  await expect(page.locator('#fcp7-export-confirm')).toBeEnabled();
});

test('PNG options and completed status translate in the English interface', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await open(page);
  await expect(page.locator('#fcp7-export-title')).toHaveText('PNG subtitles · FCP 7 XML');
  await expect(page.locator('#fcp7-export-scope option:checked')).toHaveText('Subtitles only');
  await expect(page.locator('#fcp7-export-description')).toContainText('transparent images');
  await expect(page.locator('#fcp7-export-stop')).toHaveText('Stop export');
  await page.locator('#fcp7-export-confirm').click();
  await expect(page.locator('#fcp7-export-status')).toContainText('images and XML:', { timeout: 30000 });
  await expect(page.locator('#fcp7-export-status')).toContainText('VEGAS compatible XML:');
});

test('gap-removed PNG and source media share the compressed frame clock', async ({ page }) => {
  await open(page);
  await page.locator('#fcp7-export-timeline-mode').selectOption('gap_removed');
  await page.locator('#fcp7-export-scope').selectOption('media');
  const published = page.waitForResponse(r => r.url().endsWith('/publish'));
  await page.locator('#fcp7-export-confirm').click();
  const response = await published;
  expect(response.status()).toBe(200);
  const result = await response.json();
  const manifest = JSON.parse(readFileSync(join(result.packagePath, 'manifest.json'), 'utf8'));
  expect(manifest.durationFrames).toBe(65);
  expect(Math.max(...manifest.tracks.flatMap(t => t.clips.map(c => c.endFrame)))).toBe(50);
  const xml = readFileSync(result.xmlPath, 'utf8');
  expect(xml).toContain('<start>25</start><end>65</end>');
  expect(xml).toContain('<in>35</in><out>75</out>');
});
