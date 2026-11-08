import { test, expect } from '@playwright/test';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

async function open(page, format = 'png') {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.locator('#extra-export-btn').click();
  await page.locator('#download-fcp7-export').click();
  await page.locator('#fcp7-export-format').selectOption(format);
  await expect(page.locator('#fcp7-export-native-text')).toBeHidden();
  await page.locator('input[name="fcp7-export-timeline-mode"][value="source"]').check();
  await page.locator('#fcp7-export-fps').selectOption('25');
}

test('image dimensions stay within the open project session', async ({ page }) => {
  await open(page, 'webp');
  await page.locator('#fcp7-export-custom-width').fill('1280');
  await page.locator('#fcp7-export-custom-height').fill('720');
  await page.locator('#fcp7-export-cancel').click();
  await page.evaluate(() => MaweDynamicExports.openFcp7ExportModal());
  await expect(page.locator('#fcp7-export-resolution')).toHaveValue('custom');
  await expect(page.locator('#fcp7-export-custom-width')).toHaveValue('1280');
  await expect(page.locator('#fcp7-export-custom-height')).toHaveValue('720');
  await page.locator('#fcp7-export-resolution').selectOption('3840x2160');
  await page.locator('#fcp7-export-cancel').click();
  await page.evaluate(() => MaweDynamicExports.openFcp7ExportModal());
  await expect(page.locator('#fcp7-export-resolution')).toHaveValue('3840x2160');
  await page.locator('#fcp7-export-cancel').click();
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ media: '', media_metadata: { video_width: 800, video_height: 600 },
      segments: [{ start: 0, end: 1000, text: '新工程' }] }, 'other.mosp');
    MaweDynamicExports.openFcp7ExportModal();
  });
  await expect(page.locator('#fcp7-export-resolution')).toHaveValue('custom');
  await expect(page.locator('#fcp7-export-custom-width')).toHaveValue('800');
  await expect(page.locator('#fcp7-export-custom-height')).toHaveValue('600');
  await page.locator('#fcp7-export-cancel').click();
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ media: '', segments: [] }, 'no-size.mosp');
    MaweDynamicExports.openFcp7ExportModal();
  });
  await expect(page.locator('#fcp7-export-resolution')).toHaveValue('1920x1080');
  await page.locator('#fcp7-export-resolution').selectOption('custom');
  await expect(page.locator('#fcp7-export-custom-width')).toHaveValue('1920');
  await expect(page.locator('#fcp7-export-custom-height')).toHaveValue('1080');
});

test('aspect ratio changes show a warning', async ({ page }) => {
  await open(page, 'png');
  const warning = page.locator('#fcp7-export-ratio-warning');
  await expect(warning).toBeHidden();
  await page.locator('#fcp7-export-resolution').selectOption('1080x1920');
  await expect(warning).toBeVisible();
  await page.locator('#fcp7-export-resolution').selectOption('custom');
  await page.locator('#fcp7-export-custom-width').fill('900');
  await page.locator('#fcp7-export-custom-height').fill('900');
  await expect(warning).toBeVisible();
  const spacing = await page.evaluate(() => {
    const warning = document.getElementById('fcp7-export-ratio-warning');
    const controls = document.getElementById('fcp7-export-custom-size');
    return warning.getBoundingClientRect().top - controls.getBoundingClientRect().bottom;
  });
  expect(spacing).toBeGreaterThanOrEqual(8);
  const shotDir = resolve('.artifacts/fcp7-png');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'ratio-warning.png') });
  await page.locator('#fcp7-export-custom-width').fill('1280');
  await page.locator('#fcp7-export-custom-height').fill('720');
  await expect(warning).toBeHidden();
});

test('font notices keep the published folder action available', async ({ page }) => {
  await open(page);
  await page.route('**/api/exports/fcp7-png/jobs/*/publish', async route => {
    const response = await route.fetch();
    const result = await response.json();
    await route.fulfill({ response, json: { ...result, fontNotices: ['字体已替换'] } });
  });
  let opened = false;
  await page.route('**/api/exports/fcp7-png/jobs/*/open-folder', async route => {
    opened = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.locator('#fcp7-export-confirm').click();
  await expect(page.locator('#fcp7-export-status')).toContainText('字体已替换', { timeout: 30000 });
  await page.locator('.fcp7-export-folder').click();
  expect(opened).toBe(true);
});

for (const format of ['png', 'webp']) test(`real ${format} job publishes subtitle-only XML and preserves a static hold`, async ({ page }) => {
  test.setTimeout(120000);
  await open(page, format);
  await expect(page.locator('#fcp7-export-confirm')).toHaveText('导出 XML + 图片');
  await expect(page.locator('#fcp7-export-custom-size')).toBeVisible();
  await page.locator('#fcp7-export-custom-width').fill('320');
  await page.locator('#fcp7-export-custom-height').fill('180');
  const spacing = await page.evaluate(() => {
    const form = document.getElementById('fcp7-export-format').closest('.modal');
    const fieldset = [...form.querySelectorAll('fieldset')]
      .find(el => el.querySelector('legend')?.textContent.includes('导出时间线模式'));
    const columns = form.querySelector('.fcp7-columns');
    return {
      beforeTimeline: fieldset.getBoundingClientRect().top - fieldset.previousElementSibling.getBoundingClientRect().bottom,
      beforeColumns: columns.getBoundingClientRect().top - fieldset.getBoundingClientRect().bottom,
    };
  });
  expect(spacing.beforeTimeline).toBeGreaterThanOrEqual(8);
  expect(spacing.beforeColumns).toBeGreaterThanOrEqual(8);
  const columns = await page.locator('#fcp7-export-fps').evaluate(el => {
    const left = el.getBoundingClientRect();
    const right = document.getElementById('fcp7-export-subtitle-tracks').getBoundingClientRect();
    return { gap: right.left - left.right, topDifference: Math.abs(right.top - left.top) };
  });
  expect(columns.gap).toBeGreaterThanOrEqual(8);
  expect(columns.topDifference).toBeLessThanOrEqual(1);
  const shotDir = resolve('.artifacts/fcp7-png');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, `${format}-export-options.png`) });
  const admitted = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/fcp7-png/jobs'));
  const published = page.waitForResponse(r => r.url().includes('/fcp7-png/jobs/') && r.url().endsWith('/publish'));
  await page.locator('#fcp7-export-confirm').click();
  expect((await admitted).postDataJSON().imageFormat).toBe(format);
  const response = await published;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(resolve(dirname(result.packagePath))).toBe(resolve(tempDir));
  await expect(page.locator('#fcp7-export-status')).toContainText('已保存');
  expect(existsSync(result.xmlPath)).toBeTruthy();
  expect(existsSync(result.vegasXmlPath)).toBeTruthy();
  await expect(page.locator('#fcp7-export-status')).toContainText('张字幕图片与对应工程 XML 文件');
  await expect(page.locator('.fcp7-export-folder')).toHaveText(result.packagePath);
  expect(readFileSync(result.vegasXmlPath, 'utf8')).not.toContain('file://');
  const manifest = JSON.parse(readFileSync(join(result.packagePath, 'manifest.json'), 'utf8'));
  expect([manifest.width, manifest.height]).toEqual([320, 180]);
  expect(manifest.imageFormat).toBe(format);
  expect(manifest.renderer.encoding).toBe('lossless');
  const images = manifest.tracks.flatMap(t => t.clips.map(c => c.path));
  expect(images.every(path => path.endsWith('.' + format))).toBeTruthy();
  const firstImage = readFileSync(images[0]);
  if (format === 'webp') {
    expect(firstImage.subarray(0, 4).toString()).toBe('RIFF');
    expect(firstImage.subarray(8, 12).toString()).toBe('WEBP');
    const chunk = firstImage.indexOf(Buffer.from('VP8L'));
    expect(chunk).toBeGreaterThanOrEqual(0);
    expect(firstImage[chunk + 8]).toBe(0x2f);
    const dimensions = firstImage.readUInt32LE(chunk + 9);
    expect([(dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1]).toEqual([320, 180]);
  } else {
    expect(firstImage.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([firstImage.readUInt32BE(16), firstImage.readUInt32BE(20)]).toEqual([320, 180]);
  }
  expect(manifest.tracks.flatMap(t => t.clips).some(c => c.endFrame - c.startFrame > 1)).toBeTruthy();
  const xml = readFileSync(result.xmlPath, 'utf8');
  expect(xml).toContain('<width>320</width><height>180</height>');
  expect(xml).toContain('<stillframe>TRUE</stillframe>');
  expect(xml).not.toContain('source.wav');
  expect(xml).not.toContain('GraphicAndType');
  await page.screenshot({ path: join(shotDir, `${format}-export-complete.png`) });
});

test('media scope includes the bound source and cancellation cleans an admitted job', async ({ page }) => {
  test.setTimeout(120000);
  await open(page);
  await page.locator('input[name="fcp7-export-scope"][value="media"]').check();
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

for (const format of ['png', 'webp']) test(`${format} options and completed status translate in the English interface`, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await open(page, format);
  await expect(page.locator('#fcp7-export-title')).toHaveText('Export FCP 7 XML project and subtitles');
  await expect(page.locator('input[name="fcp7-export-scope"][value="subtitles"]').locator('..')).toContainText('Subtitles only');
  await expect(page.locator('#fcp7-export-description')).toContainText('Premiere, Vegas');
  await expect(page.locator('#fcp7-export-stop')).toHaveText('Stop export');
  await page.locator('#fcp7-export-confirm').click();
  await expect(page.locator('#fcp7-export-status')).toContainText('subtitle images and the corresponding XML project files', { timeout: 30000 });
  await expect(page.locator('.fcp7-export-folder')).toBeVisible();
});

test('gap-removed PNG and source media share the compressed frame clock', async ({ page }) => {
  await open(page);
  await page.locator('input[name="fcp7-export-timeline-mode"][value="gap_removed"]').check();
  await page.locator('input[name="fcp7-export-scope"][value="media"]').check();
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

test('image and dynamic caption custom dimensions are conditionally visible', async ({ page }) => {
  await open(page);
  const custom = page.locator('#fcp7-export-custom-size');
  await expect(custom).toBeVisible();
  await page.locator('#fcp7-export-resolution').selectOption('1920x1080');
  await expect(custom).toBeHidden();
  await page.locator('#fcp7-export-resolution').selectOption('custom');
  await expect(custom).toBeVisible();
  await page.locator('#fcp7-export-cancel').click();
  for (const prefix of ['lottie', 'ograf']) {
    const modal = page.locator(`#${prefix}-export-modal`);
    await modal.evaluate(el => el.classList.add('show'));
    const select = page.locator(`#${prefix}-export-resolution`);
    const row = page.locator(`#${prefix}-export-custom-size`);
    await select.selectOption('1920x1080');
    await expect(row).toBeHidden();
    await select.selectOption('custom');
    await expect(row).toBeVisible();
    const spacing = await row.evaluate(el => el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom);
    expect(spacing).toBeGreaterThanOrEqual(8);
    const shotDir = resolve('.artifacts/fcp7-png');
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, `${prefix}-custom-size.png`) });
    await modal.evaluate(el => el.classList.remove('show'));
  }
});

test('image dimensions accept 8K limits, reset without media metadata and clear stale status on invalid input', async ({ page }) => {
  await open(page);
  await page.locator('#fcp7-export-custom-width').fill('8192');
  await page.locator('#fcp7-export-custom-height').fill('4096');
  expect(await page.evaluate(() => window.MaweGapRemovedMediaExport.dynamicExportCanvasSize(
    document.getElementById('fcp7-export-resolution'), document.getElementById('fcp7-export-custom-width'),
    document.getElementById('fcp7-export-custom-height'), 8192))).toEqual({ width: 8192, height: 4096 });
  await page.locator('#fcp7-export-custom-width').fill('1');
  await page.locator('#fcp7-export-custom-height').fill('1');
  expect(await page.evaluate(() => window.MaweGapRemovedMediaExport.dynamicExportCanvasSize(
    document.getElementById('fcp7-export-resolution'), document.getElementById('fcp7-export-custom-width'),
    document.getElementById('fcp7-export-custom-height'), 8192, 1))).toEqual({ width: 1, height: 1 });
  await page.locator('#fcp7-export-custom-width').fill('8193');
  await page.locator('#fcp7-export-status').evaluate(el => { el.textContent = 'old successful export'; });
  await page.locator('#fcp7-export-confirm').click();
  await expect(page.locator('#fcp7-export-status')).toBeEmpty();
  await expect(page.locator('.hint-card.hint-warning').last()).toContainText('1–8192');
  await page.locator('#fcp7-export-cancel').click();
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({ media: '', segments: [] }, 'no-size.mosp');
    MaweDynamicExports.openFcp7ExportModal();
  });
  await expect(page.locator('#fcp7-export-resolution')).toHaveValue('1920x1080');
  await expect(page.locator('#fcp7-export-custom-size')).toBeHidden();
});

test('image generation progress bar displays real task progress and disappears on stop', async ({ page }) => {
  await open(page);
  await page.route('**/api/exports/fcp7-png/jobs**', async route => {
    const url = new URL(route.request().url());
    const response = url.pathname.endsWith('/cancel') || url.pathname.endsWith('/cancel-admission')
      ? { cleanupComplete: true } : { jobId: 'fake-job', state: 'rendering', progress: 0.42 };
    await route.fulfill({ json: response });
  });
  await page.locator('#fcp7-export-confirm').click();
  const progress = page.locator('#fcp7-export-progress');
  await expect(progress).toBeVisible();
  await expect.poll(() => progress.evaluate(el => el.value)).toBe(0.42);
  await expect(page.locator('#fcp7-export-status')).toContainText('42%');
  const shotDir = resolve('.artifacts/fcp7-png');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'export-progress.png') });
  await page.locator('#fcp7-export-stop').click();
  await expect(progress).toBeHidden();
  await expect(page.locator('#fcp7-export-status')).toContainText('已停止');
});
