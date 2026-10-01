import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload,
  makeTempDir, startServer } from './helpers.mjs';

let tempDir;
let server;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

test.beforeAll(async () => {
  const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  test.skip(!/\bass\s+V->V/u.test(filters), 'Requires a libass-enabled FFmpeg');
  tempDir = makeTempDir('ass-frame');
  const media = join(tempDir, 'synthetic.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=s=640x360:d=4:r=30', '-c:v', 'libx264', '-crf', '10', '-y', media]);
  const project = join(tempDir, 'project.json');
  writeFileSync(project, JSON.stringify({ media: 'synthetic.mp4',
    segments: [{ start: 1000, end: 2800, text: '第二句字幕 包含**强调文字**语法' }],
    waveform: generateWaveformPayload(4000) }));
  server = await startServer(project, media, await findFreePort());
});

test.afterAll(async () => { await server?.stop(); if (tempDir) cleanupTempDir(tempDir); });

async function enableAss(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect.poll(() => page.evaluate(() => window.MaweCoreState?.player?.videoWidth)).toBe(640);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-subtitle-style').click();
  await page.locator('#ass-mode-toggle').check();
  await page.locator('#editor-settings-close').click();
}

async function enableStage(page) {
  // 暂停叠加实际帧是窗口内开关且默认关闭；舞台相关断言先打开它。
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#ass-frame-preview-open').click();
  await page.locator('#ass-frame-stage-toggle').check();
  await page.locator('#ass-frame-close-footer').click();
  await page.locator('#editor-settings-close').click();
}

async function seek(page, seconds) {
  await page.evaluate((time) => { window.MaweCoreState.player.currentTime = time; }, seconds);
  await expect.poll(() => page.evaluate(() => window.MaweCoreState.player.seeking)).toBe(false);
}

test('paused video uses native libass, updates after edits, and falls back immediately on play', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enableAss(page);
  await enableStage(page);
  await seek(page, 1.5);
  const frame = page.locator('#ass-stage-frame');
  await expect(frame).toBeVisible();
  await expect(page.locator('#ass-stage-status')).toHaveText('ASS 实际画面');
  expect(await frame.evaluate((el) => [el.naturalWidth, el.naturalHeight])).toEqual([640, 360]);
  await expect(page.locator('#overlay')).toHaveCSS('visibility', 'hidden');
  await page.evaluate(() => {
    window.MaweSettings.EDITOR_SETTINGS.exportStartAtZero = true;
    const preview = window.MaweExportSrt.buildAss({ preview: true });
    const exported = window.MaweExportSrt.buildAss();
    window.__assTimes = [preview.match(/Dialogue: 0,([^,]+)/u)?.[1], exported.match(/Dialogue: 0,([^,]+)/u)?.[1]];
  });
  expect(await page.evaluate(() => window.__assTimes[0])).toBe('0:00:01.00');
  expect(await page.evaluate(() => window.__assTimes[1])).toBe('0:00:00.00');
  const first = await frame.getAttribute('src');
  await page.evaluate(() => {
    window.MaweBoot.DATA.segments[0].text = '样式修改后的**强调**';
    window.MawePlaybackLoop.refreshSubtitlePreview();
  });
  await expect.poll(() => frame.getAttribute('src')).not.toBe(first);
  await expect(frame).toBeVisible();
  await page.evaluate(() => window.MaweCoreState.player.play());
  await expect(frame).toBeHidden();
  await expect(page.locator('#overlay')).toHaveCSS('visibility', 'visible');
  await expect(page.locator('#ass-stage-status')).toHaveText('ASS 即时预览');
  await page.evaluate(() => window.MaweCoreState.player.pause());
  await expect(frame).toBeVisible();
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-subtitle-style').click();
  await page.locator('#ass-frame-preview-open').click();
  await page.locator('#editor-settings-close').click();
  await expect(page.locator('#ass-frame-image')).toBeVisible();
  await expect(page.locator('#ass-frame-caption')).toContainText('640 × 360');
  const spacing = await page.evaluate(() => {
    const caption = document.getElementById('ass-frame-caption').getBoundingClientRect();
    const actions = document.querySelector('.ass-frame-actions').getBoundingClientRect();
    return actions.top - caption.bottom;
  });
  expect(spacing).toBeGreaterThanOrEqual(8);
  await expect(frame).toBeVisible();
  await expect(page.locator('#ass-stage-status')).toHaveText('ASS 实际画面');
  await page.screenshot({ path: test.info().outputPath('ass-preview.png') });
  await page.locator('#ass-frame-size').click();
  expect(await page.locator('#ass-frame-image').evaluate((el) => el.getBoundingClientRect().width)).toBe(640);
  expect(errors).toEqual([]);
});

test('old responses cannot overwrite a new seek and failures keep CSS usable', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let intercepted = false;
  await page.route('**/api/ass-frame', async (route) => {
    if (!intercepted) { intercepted = true; await gate; }
    await route.continue();
  });
  await enableAss(page);
  await enableStage(page);
  await expect.poll(() => intercepted).toBe(true);
  await seek(page, 1.5);
  release();
  await expect(page.locator('#ass-stage-frame')).toBeVisible();
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#ass-frame-preview-open').click();
  await expect(page.locator('#ass-frame-caption')).toContainText('00:01.500');
  await page.unroute('**/api/ass-frame');
  await page.route('**/api/ass-frame', (route) => route.fulfill({ status: 400,
    json: { ok: false, error: 'FFmpeg lacks libass' } }));
  await seek(page, 2);
  await expect(page.locator('#ass-stage-frame')).toBeHidden();
  await expect(page.locator('#ass-stage-status')).toHaveText('ASS 即时预览 · 实际渲染不可用');
  await expect(page.locator('#overlay')).toHaveCSS('visibility', 'visible');
});

test('preview visibility and speaker labels remain independent from exports and browser-only media', async ({ page }) => {
  await enableAss(page);
  await enableStage(page);
  await seek(page, 1.5);
  await expect(page.locator('#ass-stage-frame')).toBeVisible();
  const options = await page.evaluate(() => {
    window.MaweBoot.DATA.segments[0].color = { name: 'yellow' };
    window.MaweBoot.DATA.preview.subtitle.speaker_labels = {
      mapping_enabled: true, enabled: true, separator: '：', names: { yellow: 'Host' },
    };
    window.MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels = false;
    const labelled = window.MaweExportSrt.buildAss({ preview: true });
    const exported = window.MaweExportSrt.buildAss();
    window.MaweDom.overlayToggle.checked = false;
    const hidden = window.MaweExportSrt.buildAss({ preview: true });
    window.MawePlaybackLoop.refreshSubtitlePreview();
    return { labelled, exported, hidden };
  });
  expect(options.labelled).toContain('Host：');
  expect(options.exported).not.toContain('Host：');
  expect(options.exported).toContain('Dialogue:');
  expect(options.hidden).not.toContain('Dialogue:');
  await page.evaluate(() => {
    window.MaweCoreState.player.src = URL.createObjectURL(new Blob([], { type: 'video/mp4' }));
    window.MaweCoreState.player.load();
  });
  await expect(page.locator('#ass-stage-frame')).toBeHidden();
  await expect(page.locator('#ass-stage-status')).toBeHidden();
});

test('coalesces ASS serialization and avoids reloading an unchanged cached image', async ({ page }) => {
  await enableAss(page);
  await enableStage(page);
  await seek(page, 1.5);
  await expect(page.locator('#ass-stage-frame')).toBeVisible();
  await page.evaluate(() => {
    window.__buildCount = 0;
    window.__srcChanges = 0;
    const previous = window.MaweExportSrt;
    window.MaweExportSrt = { ...previous, buildAss(options) {
      window.__buildCount += 1;
      return previous.buildAss(options);
    } };
    new MutationObserver((records) => { window.__srcChanges += records.length; })
      .observe(document.getElementById('ass-stage-frame'), { attributes: true, attributeFilter: ['src'] });
    for (let i = 0; i < 30; i += 1) window.MaweAssFrame.syncPreview();
  });
  expect(await page.evaluate(() => window.__buildCount)).toBe(0);
  await expect(page.locator('#ass-stage-frame')).toBeVisible();
  expect(await page.evaluate(() => window.__buildCount)).toBe(1);
  expect(await page.evaluate(() => window.__srcChanges)).toBe(0);
});

test('does not retry missing libass on every seek and allows explicit recovery', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/ass-frame', (route) => {
    requests += 1;
    return route.fulfill({ status: 400, json: { ok: false, error: 'libass unavailable',
      code: 'ASS_FRAME_LIBASS_UNAVAILABLE' } });
  });
  await enableAss(page);
  await enableStage(page);
  // 打开窗口本身算一次显式渲染尝试（会清除能力失败并重试）；此后 seek
  // 不允许再发起任何请求，直到用户手动恢复。
  const requestsAfterSetup = requests;
  await expect(page.locator('#ass-stage-status')).toHaveText('ASS 即时预览 · 实际渲染不可用');
  await seek(page, 1.5);
  await expect(page.locator('#ass-stage-status')).toHaveText('ASS 即时预览 · 实际渲染不可用');
  // 覆盖 seek 后的渲染防抖窗口，确认没有隐藏的重试。
  await page.waitForTimeout(350);
  expect(requests).toBe(requestsAfterSetup);
  await page.unroute('**/api/ass-frame');
  await page.evaluate(() => window.MaweAssFrame.renderAssFrame());
  await expect(page.locator('#ass-stage-frame')).toBeVisible();
});

test('times out a stalled frame request without disabling manual retry', async ({ page }) => {
  await page.addInitScript(() => {
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => originalTimeout(callback,
      delay === 165000 ? 150 : delay, ...args);
    const originalFetch = window.fetch.bind(window);
    window.fetch = (url, options) => String(url).includes('/api/ass-frame')
      ? new Promise((resolve, reject) => options.signal.addEventListener('abort',
        () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
      : originalFetch(url, options);
  });
  await enableAss(page);
  await enableStage(page);
  await expect(page.locator('#ass-stage-status')).toHaveText('ASS 即时预览 · 实际渲染不可用');
  await expect(page.locator('#ass-frame-render')).toBeEnabled();
  await expect(page.locator('#ass-stage-frame')).toBeHidden();
});

test('drops an in-flight response after reloading the same media URL', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let count = 0;
  await page.route('**/api/ass-frame', async (route) => {
    count += 1;
    if (count === 1) {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await enableAss(page);
  await enableStage(page);
  await expect.poll(() => count).toBe(1);
  await page.evaluate(() => window.MaweCoreState.player.load());
  await expect.poll(() => page.evaluate(() => window.MaweCoreState.player.readyState)).toBeGreaterThan(0);
  release();
  await expect.poll(() => count).toBe(2);
  await expect(page.locator('#ass-stage-frame')).toBeVisible();
});

test('renders the displayed frame instead of the next frame at fractional seek times', async ({ page }) => {
  await enableAss(page);
  await enableStage(page);
  for (const position of [1.505, 1.367]) {
    const pts = await page.evaluate((seconds) => {
      const video = window.MaweCoreState.player;
      const frame = new Promise((resolve) => video.requestVideoFrameCallback((now, metadata) => resolve(metadata.mediaTime)));
      video.currentTime = seconds;
      return frame;
    }, position);
    expect(pts).toBeLessThanOrEqual(position);
    await expect(page.locator('#ass-stage-status')).toHaveText('ASS 实际画面');
    const difference = await page.evaluate(async (seconds) => {
      const video = window.MaweCoreState.player;
      const frame = document.getElementById('ass-stage-frame');
      const canvas = document.createElement('canvas');
      canvas.width = 100; canvas.height = 40;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      const source = ctx.getImageData(0, 0, 100, 40).data;
      const response = await fetch(window.MaweBoot.SERVER_CONFIG.assFrameUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestToken: window.MaweBoot.SERVER_CONFIG.requestToken,
          ass: window.MaweExportSrt.buildAss({ preview: true }), timeMs: Math.round(seconds * 1000) }),
      });
      const wrong = new Image();
      wrong.src = `data:image/png;base64,${(await response.json()).image}`;
      await wrong.decode();
      // The generated clip has a timecode and frame counter here. Compare its
      // orange glyph mask, excluding tiny YUV-to-RGB decoder rounding changes.
      const glyph = (pixels, offset) => pixels[offset] > 100 && pixels[offset + 1] > 50 && pixels[offset + 2] < 70;
      const mismatch = (image) => {
        ctx.clearRect(0, 0, 100, 40);
        ctx.drawImage(image, 0, 0);
        const rendered = ctx.getImageData(0, 0, 100, 40).data;
        let count = 0;
        for (let i = 0; i < source.length; i += 4) if (glyph(source, i) !== glyph(rendered, i)) count += 1;
        return count;
      };
      return { aligned: mismatch(frame), next: mismatch(wrong), actual: Number(frame.dataset.timeMs) };
    }, position);
    expect(difference.actual).toBeCloseTo(pts * 1000, 2);
    // RGB conversion differs slightly between browser and FFmpeg. The correct
    // frame must match the timecode substantially better than the next frame.
    expect(difference.aligned, JSON.stringify({ position, pts, difference })).toBeLessThan(difference.next * 0.8);
  }
});

test('renders the final presented frame at the media duration', async ({ page }) => {
  await enableAss(page);
  await enableStage(page);
  const pts = await page.evaluate(() => {
    const video = window.MaweCoreState.player;
    const frame = new Promise((resolve) => video.requestVideoFrameCallback((now, metadata) => resolve(metadata.mediaTime)));
    video.currentTime = video.duration;
    return frame;
  });
  expect(pts).toBeLessThan(4);
  await expect(page.locator('#ass-stage-status')).toHaveText('ASS 实际画面');
  await expect(page.locator('#ass-stage-frame')).toBeVisible();
  expect(await page.locator('#ass-stage-frame').evaluate((element) => Number(element.dataset.timeMs)))
    .toBeCloseTo(pts * 1000, 2);
});

test('manual capture during playback keeps the clicked frame and marks it stale', async ({ page }) => {
  await enableAss(page);
  await enableStage(page);
  await seek(page, 1.5);
  await expect(page.locator('#ass-stage-frame')).toBeVisible();
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-subtitle-style').click();
  await page.locator('#ass-frame-preview-open').click();
  await expect(page.locator('#ass-frame-image')).toBeVisible();
  // 手动模式：关闭自动渲染，让「渲染当前帧」成为唯一更新入口。
  await page.locator('#ass-frame-auto-toggle').uncheck();
  await expect(page.locator('#ass-frame-render')).toBeVisible();
  await page.locator('#editor-settings-close').click();
  await page.evaluate(() => window.MaweCoreState.player.play());
  await expect(page.locator('#ass-stage-frame')).toBeHidden();
  let clickedTime;
  await page.route('**/api/ass-frame', async (route) => {
    clickedTime = route.request().postDataJSON().timeMs;
    const response = await route.fetch();
    await expect.poll(() => page.evaluate(() => window.MaweCoreState.player.currentTime * 1000))
      .toBeGreaterThan(clickedTime + 150);
    await route.fulfill({ response });
  });
  await page.locator('#ass-frame-render').click();
  await expect(page.locator('#ass-frame-render')).toBeEnabled();
  expect(clickedTime).toBeGreaterThanOrEqual(1500);
  await expect(page.locator('#ass-frame-window-status')).toHaveText('渲染完成');
  await expect(page.locator('#ass-frame-stale')).toBeVisible();
  await expect(page.locator('#ass-frame-stale')).toContainText('暂停后重新渲染');
  await expect(page.locator('#ass-stage-frame')).toBeHidden();
});

test('stage overlay defaults to off while auto rendering defaults to on', async ({ page }) => {
  await enableAss(page);
  await seek(page, 1.5);
  // 默认关闭舞台叠加：暂停时仍是 CSS 预览，也没有舞台角标。
  await expect(page.locator('#ass-stage-frame')).toBeHidden();
  await expect(page.locator('#ass-stage-status')).toBeHidden();
  await expect(page.locator('#overlay')).toHaveCSS('visibility', 'visible');
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#ass-frame-preview-open').click();
  await expect(page.locator('#ass-frame-stage-toggle')).toBeVisible();
  await expect(page.locator('#ass-frame-auto-toggle')).toBeChecked();
  // 自动渲染开启时「渲染当前帧」没有意义，隐藏。
  await expect(page.locator('#ass-frame-render')).toBeHidden();
  // 关闭自动渲染：按钮显示；开启舞台叠加：手动渲染一帧后叠到播放器画面。
  await page.locator('#ass-frame-auto-toggle').uncheck();
  await expect(page.locator('#ass-frame-render')).toBeVisible();
  await page.locator('#ass-frame-stage-toggle').check();
  await page.locator('#ass-frame-render').click();
  await expect(page.locator('#ass-stage-frame')).toBeVisible();
  await expect(page.locator('#overlay')).toHaveCSS('visibility', 'hidden');
  // 自动渲染已关：seek 后舞台回到 CSS 预览，窗口帧标记过期。
  await seek(page, 2);
  await expect(page.locator('#ass-stage-frame')).toBeHidden();
  await expect(page.locator('#overlay')).toHaveCSS('visibility', 'visible');
  await expect(page.locator('#ass-frame-stale')).toBeVisible();
  await expect(page.locator('#ass-frame-stale')).toContainText('画面已过期');
  // 开关状态持久化到编辑器设置。
  const persisted = await page.evaluate(() => ({
    stage: window.MaweSettings.EDITOR_SETTINGS.assFrameStagePreview,
    auto: window.MaweSettings.EDITOR_SETTINGS.assFrameAutoRender,
  }));
  expect(persisted).toEqual({ stage: true, auto: false });
});
