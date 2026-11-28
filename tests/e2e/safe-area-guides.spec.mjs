// 安全区参考线回归：默认关闭、开关立即生效并记忆、几何 = 视频实际绘制矩形的
// 5% / 10% 双框（含内框中点刻线）、不拦截指针、横竖屏与留黑场景、全屏跟随、
// 无视频（纯音频）隐藏，以及暂停叠加 ASS 实际帧时仍可见。
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload, generateWav,
  makeTempDir, startServer, closeSettingsPanels, openSettingsPage } from './helpers.mjs';

let tempDir;
let server;
let portraitServer;
let audioServer;
let changeServer;
let hasVp9Encoder = false;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

test.beforeAll(async () => {
  tempDir = makeTempDir('safe-area-guides');
  const media = join(tempDir, 'landscape.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=4:r=10', '-c:v', 'libx264', '-y', media]);
  const project = join(tempDir, 'landscape.json');
  writeFileSync(project, JSON.stringify({ media: 'landscape.mp4',
    segments: [{ start: 0, end: 4000, text: '横屏字幕 OwO' }],
    waveform: generateWaveformPayload(4000) }));
  server = await startServer(project, media, await findFreePort());
  const portraitMedia = join(tempDir, 'portrait.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=360x640:d=4:r=10', '-c:v', 'libx264', '-y', portraitMedia]);
  const portraitProject = join(tempDir, 'portrait.json');
  writeFileSync(portraitProject, JSON.stringify({ media: 'portrait.mp4',
    segments: [{ start: 0, end: 4000, text: '竖屏字幕 OwO' }],
    waveform: generateWaveformPayload(4000) }));
  portraitServer = await startServer(portraitProject, portraitMedia, await findFreePort());
  const audioProject = join(tempDir, 'audio.json');
  writeFileSync(audioProject, JSON.stringify({ media: 'synthetic.wav',
    segments: [{ start: 0, end: 4000, text: '纯音频 OwO' }],
    waveform: generateWaveformPayload(4000) }));
  const audioMedia = join(tempDir, 'synthetic.wav');
  generateWav(audioMedia, 4);
  audioServer = await startServer(audioProject, audioMedia, await findFreePort());
  // 变画幅素材：两段不同分辨率 VP9 WebM 拼接（Chromium 解码到切换点会触发
  // <video> 的 resize 事件）；无 libvpx-vp9 编码器时跳过对应用例。
  hasVp9Encoder = /\blibvpx-vp9\b/.test(execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }));
  if (hasVp9Encoder) {
    const encode = (size, name) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=s=${size}:d=2:r=10`, '-c:v', 'libvpx-vp9',
      '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '500k', '-y', join(tempDir, name)]);
    encode('640x360', 'resize-landscape.webm');
    encode('360x640', 'resize-portrait.webm');
    writeFileSync(join(tempDir, 'resize-list.txt'),
      `file '${join(tempDir, 'resize-landscape.webm')}'\nfile '${join(tempDir, 'resize-portrait.webm')}'\n`);
    const changeMedia = join(tempDir, 'change.webm');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
      '-i', join(tempDir, 'resize-list.txt'), '-c', 'copy', '-y', changeMedia]);
    const changeProject = join(tempDir, 'change.json');
    writeFileSync(changeProject, JSON.stringify({ media: 'change.webm',
      segments: [{ start: 0, end: 4000, text: '变画幅 OwO' }],
      waveform: generateWaveformPayload(4000) }));
    changeServer = await startServer(changeProject, changeMedia, await findFreePort());
  }
});

test.afterAll(async () => {
  await changeServer?.stop();
  await audioServer?.stop();
  await portraitServer?.stop();
  await server?.stop();
  if (tempDir) cleanupTempDir(tempDir);
});

async function gotoEditor(page, url) {
  await disableOnboarding(page);
  await page.goto(url);
  await page.waitForFunction(() => {
    const media = document.getElementById('player');
    return media && (media.tagName !== 'VIDEO' || media.videoWidth > 0);
  });
}

async function toggleGuides(page, checked) {
  await openSettingsPage(page, 'subtitle-preview');
  await page.locator('#safe-area-guides-toggle').setChecked(checked);
  await closeSettingsPanels(page);
}

// 视频实际绘制矩形（object-fit: contain 的 contain 数学），与被测实现同一公式。
async function expectedDisplayRect(page) {
  return page.evaluate(() => {
    const player = document.getElementById('player');
    const stage = document.querySelector('.player-stage');
    const elementRect = player.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const scale = Math.min(elementRect.width / player.videoWidth, elementRect.height / player.videoHeight);
    const width = player.videoWidth * scale;
    const height = player.videoHeight * scale;
    return {
      left: elementRect.left - stageRect.left + (elementRect.width - width) / 2,
      top: elementRect.top - stageRect.top + (elementRect.height - height) / 2,
      width, height,
    };
  });
}

async function guidesGeometry(page) {
  return page.evaluate(() => {
    const layer = document.getElementById('safe-area-guides');
    const stageRect = document.querySelector('.player-stage').getBoundingClientRect();
    // 层的定位坐标系是 stage（与 expectedDisplayRect 同系）；换算后再比较。
    const relative = (rect) => ({ left: rect.left - stageRect.left, top: rect.top - stageRect.top,
      width: rect.width, height: rect.height, x: rect.left - stageRect.left, y: rect.top - stageRect.top });
    const rectOf = (selector) => {
      const rect = layer.querySelector(selector)?.getBoundingClientRect();
      return rect ? relative(rect) : null;
    };
    return {
      hidden: layer.hidden,
      layer: relative(layer.getBoundingClientRect()),
      outer: rectOf('.safe-area-outer'),
      inner: rectOf('.safe-area-inner'),
      ticks: [...layer.querySelectorAll('.safe-area-tick')]
        .map(tick => relative(tick.getBoundingClientRect())),
      pointerEvents: getComputedStyle(layer).pointerEvents,
      zIndex: getComputedStyle(layer).zIndex,
    };
  });
}

function closeTo(actual, expected, tolerance = 1.5) {
  return Math.abs(actual - expected) <= tolerance;
}

// 轮询到布局过渡（全屏切换）后的稳定几何，再做结构断言。
async function expectGuidesMatchDisplayRect(page) {
  const display = await expectedDisplayRect(page);
  await expect.poll(async () => {
    const guides = await guidesGeometry(page);
    if (guides.hidden) return Number.POSITIVE_INFINITY;
    return Math.max(...['left', 'top', 'width', 'height'].map(key => Math.abs(guides.layer[key] - display[key])));
  }, { timeout: 10_000 }).toBeLessThanOrEqual(1.5);
  const guides = await guidesGeometry(page);
  expect(guides.hidden).toBe(false);
  expect(guides.pointerEvents).toBe('none');
  // 外框 = 层盒四边内缩 5%（左右按宽度、上下按高度）；内框 10%。
  expect(closeTo(guides.outer.x - guides.layer.x, display.width * 0.05)).toBe(true);
  expect(closeTo(guides.outer.y - guides.layer.y, display.height * 0.05)).toBe(true);
  expect(closeTo(guides.outer.width, display.width * 0.9)).toBe(true);
  expect(closeTo(guides.outer.height, display.height * 0.9)).toBe(true);
  expect(closeTo(guides.inner.x - guides.layer.x, display.width * 0.1)).toBe(true);
  expect(closeTo(guides.inner.y - guides.layer.y, display.height * 0.1)).toBe(true);
  expect(closeTo(guides.inner.width, display.width * 0.8)).toBe(true);
  expect(closeTo(guides.inner.height, display.height * 0.8)).toBe(true);
  // 内框四边中点各一条刻线：短刻线（约 14px 屏幕像素）横跨内框边线，
  // 垂直刻线的中点落在水平中线，水平刻线的中点落在垂直中线。
  expect(guides.ticks).toHaveLength(4);
  for (const tick of guides.ticks) {
    if (tick.height > tick.width) {
      expect(closeTo(tick.x + tick.width / 2 - guides.layer.x, guides.layer.width / 2)).toBe(true);
      expect(tick.height).toBeGreaterThanOrEqual(12);
      expect(tick.height).toBeLessThanOrEqual(18);
    } else {
      expect(closeTo(tick.y + tick.height / 2 - guides.layer.y, guides.layer.height / 2)).toBe(true);
      expect(tick.width).toBeGreaterThanOrEqual(12);
      expect(tick.width).toBeLessThanOrEqual(18);
    }
  }
  return guides;
}

test('defaults to off, enables in place, and matches the displayed video rect', async ({ page }) => {
  await gotoEditor(page, server.url);
  await expect(page.locator('#safe-area-guides-toggle')).not.toBeChecked();
  await expect(page.locator('#safe-area-guides')).toBeHidden();

  await toggleGuides(page, true);
  await expectGuidesMatchDisplayRect(page);

  // 参考线不拦截指针：视频画面中心命中的仍是视频元素，点击可切换播放/暂停。
  const center = await page.evaluate(() => {
    const rect = document.getElementById('safe-area-guides').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return { id: element?.id, tag: element?.tagName };
  }, center);
  expect(hit).toEqual({ id: 'player', tag: 'VIDEO' });
  const pausedBefore = await page.evaluate(() => document.getElementById('player').paused);
  await page.mouse.click(center.x, center.y);
  await expect.poll(() => page.evaluate(() => document.getElementById('player').paused))
    .toBe(!pausedBefore);

  await toggleGuides(page, false);
  await expect(page.locator('#safe-area-guides')).toBeHidden();
  await toggleGuides(page, true);
  await expect(page.locator('#safe-area-guides')).toBeVisible();
});

test('remembers the choice across reloads', async ({ page }) => {
  await gotoEditor(page, server.url);
  await toggleGuides(page, true);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('player')?.videoWidth > 0);
  await expect(page.locator('#safe-area-guides-toggle')).toBeChecked();
  await expectGuidesMatchDisplayRect(page);
});

test('portrait media with pillarboxing follows the displayed rect', async ({ page }) => {
  await gotoEditor(page, portraitServer.url);
  await toggleGuides(page, true);
  const guides = await expectGuidesMatchDisplayRect(page);
  // 竖屏画面在横向播放器单元里留黑在左右：层盒窄于视频元素盒且高大于宽。
  expect(guides.layer.height).toBeGreaterThan(guides.layer.width);
  const elementWidth = await page.evaluate(() => document.getElementById('player').getBoundingClientRect().width);
  expect(guides.layer.width).toBeLessThan(elementWidth - 1);
});

test('audio-only media keeps the guides hidden', async ({ page }) => {
  await gotoEditor(page, audioServer.url);
  await toggleGuides(page, true);
  await expect(page.locator('#safe-area-guides')).toBeHidden();
});

test('fullscreen keeps following the displayed rect', async ({ page }) => {
  await gotoEditor(page, server.url);
  await toggleGuides(page, true);
  await page.locator('#media-fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expectGuidesMatchDisplayRect(page);
  await page.locator('#media-fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expectGuidesMatchDisplayRect(page);
});

test('switching media re-anchors the guides to the new player element', async ({ page }) => {
  await gotoEditor(page, server.url);
  await toggleGuides(page, true);
  await expectGuidesMatchDisplayRect(page);
  // 走真实加载路径（#load-media-file change → loadMediaFile）：播放器元素会被
  // 替换，参考线必须重新挂到新元素并跟随新画幅（竖屏）。
  await page.locator('#load-media-file').setInputFiles(join(tempDir, 'portrait.mp4'));
  await page.waitForFunction(() => document.getElementById('player')?.videoWidth === 360);
  await expectGuidesMatchDisplayRect(page);
  const swapped = await page.evaluate(() => ({
    tag: document.getElementById('player').tagName,
    guidesParent: document.getElementById('safe-area-guides').parentElement.className,
    layerRatio: (() => {
      const layer = document.getElementById('safe-area-guides').getBoundingClientRect();
      return Math.round((layer.width / layer.height) * 100) / 100;
    })(),
  }));
  expect(swapped.tag).toBe('VIDEO');
  expect(swapped.guidesParent).toContain('player-stage');
  expect(swapped.layerRatio).toBeCloseTo(9 / 16, 1);
});

test('follows a mid-stream resolution change via the video element resize event', async ({ page }) => {
  test.skip(!hasVp9Encoder, 'Requires a libvpx-vp9 FFmpeg to build a resolution-changing WebM');
  await gotoEditor(page, changeServer.url);
  await toggleGuides(page, true);
  await expectGuidesMatchDisplayRect(page);
  // 固定视频元素盒：默认布局下固有尺寸变化会连带轻微重排（实测 377x186→377x190），
  // ResizeObserver 会掩盖缺失的监听；钉住盒子才是「盒不变而固有尺寸变化」的
  // 纯 resize 事件场景，事件仍由浏览器真实触发（不做事件 mock）。
  await page.evaluate(() => {
    const player = document.getElementById('player');
    const rect = player.getBoundingClientRect();
    player.style.height = `${rect.height}px`;
  });
  // 播放跨过 2s 画幅切换点：loadedmetadata 不再触发、布局盒未变，只有
  // <video> 的 resize 事件能触发刷新。
  await page.evaluate(() => { document.getElementById('player').currentTime = 1; });
  await page.locator('#media-play-toggle').click();
  await page.waitForFunction(() => document.getElementById('player')?.videoWidth === 360, null, { timeout: 15000 });
  await expectGuidesMatchDisplayRect(page);
  const ratio = await page.evaluate(() => {
    const layer = document.getElementById('safe-area-guides').getBoundingClientRect();
    return Math.round((layer.width / layer.height) * 100) / 100;
  });
  expect(ratio).toBeCloseTo(9 / 16, 1);
  await page.locator('#media-play-toggle').click();
});

test('guides stay visible while the paused ASS actual frame overlays the stage', async ({ page }) => {
  await gotoEditor(page, server.url);
  await toggleGuides(page, true);
  // ass-stage-ready 是「暂停实际帧叠加在播放器画面」状态：该状态隐藏 #overlay，
  // 参考线必须保持可见且仍压在实际帧（无 z-index）之上。
  await page.evaluate(() => document.querySelector('.player-stage').classList.add('ass-stage-ready'));
  await expect(page.locator('#overlay')).toBeHidden();
  await expectGuidesMatchDisplayRect(page);
  const stacking = await page.evaluate(() => {
    const guides = document.getElementById('safe-area-guides');
    const frame = document.getElementById('ass-stage-frame');
    // 无 z-index 时 getComputedStyle 返回 "auto"：参与比较前按 0 处理。
    const zOf = (element) => {
      const value = Number(getComputedStyle(element).zIndex);
      return Number.isFinite(value) ? value : 0;
    };
    return {
      guidesZ: zOf(guides),
      frameZ: zOf(frame),
      guidesAfterFrame: !!(frame.compareDocumentPosition(guides) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  });
  expect(stacking.guidesZ).toBeGreaterThan(stacking.frameZ);
  expect(stacking.guidesAfterFrame).toBe(true);
  await page.evaluate(() => document.querySelector('.player-stage').classList.remove('ass-stage-ready'));
});
