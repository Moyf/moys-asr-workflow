// Diagnostic capability check, not a substitute for the product test matrix.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'maw-ci-media-'));
let browser;
try {
  const video = join(root, 'sample.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=160x90:rate=10:duration=2', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', video], { timeout: 30000 });
  browser = await chromium.launch({ timeout: 30000 });
  const page = await browser.newPage();
  await page.setContent('<video muted></video>');
  await page.evaluate(src => { document.querySelector('video').src = src; },
    `data:video/mp4;base64,${readFileSync(video).toString('base64')}`);
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    if (v.error) throw new Error(`H264 decode error ${v.error.code}: ${v.error.message}`);
    return v.readyState >= 2 && v.videoWidth === 160 && v.videoHeight === 90;
  }, null, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('video').play());
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.2,
    null, { timeout: 10000 });
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.pause();
    v.currentTime = 1;
  });
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 1) < 0.1;
  }, null, { timeout: 10000 });
  console.log(JSON.stringify({ browser: browser.version(), h264Decode: true,
    playbackAdvanced: true, seekToOneSecond: true }));
} finally {
  if (browser) await browser.close();
  rmSync(root, { recursive: true, force: true });
}
