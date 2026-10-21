import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { disableOnboarding, findFreePort, generateWaveformPayload, openSettingsPage, startServer } from './helpers.mjs';

// Real Chromium + Server + ffprobe, with synthetic media retained as local evidence.
const root = resolve('.artifacts/fps-source/browser');
let server, project, media25, media24;
test.beforeAll(() => {
  mkdirSync(root, { recursive: true });
  for (const fps of [25, 24]) {
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
      `color=c=blue:size=160x90:rate=${fps}:duration=2`, '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-y', join(root, `media-${fps}.mp4`)],
      { timeout: 30000, windowsHide: true, stdio: 'pipe' });
  }
  media25 = join(root, 'media-25.mp4'); media24 = join(root, 'media-24.mp4');
});
test.afterEach(async () => { await server?.stop(); server = null; });

async function open(page, name, timebase) {
  project = join(root, `${name}.mosp`);
  writeFileSync(project, JSON.stringify({ media: media25, timebase,
    waveform: generateWaveformPayload(2000), segments: [{ id: 's', start: 200, end: 1200,
      text: 'hello', items: [{ start: 200, end: 1200, text: 'hello' }] }] }));
  server = await startServer(project, media25, await findFreePort());
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(server.url);
  await expect(page.locator('.cue').first()).toBeVisible();
  await openSettingsPage(page, 'timebase');
}
async function saveReload(page) {
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
  const saved = JSON.parse(readFileSync(project, 'utf8'));
  await page.reload();
  await expect(page.locator('.cue').first()).toBeVisible();
  expect(await page.evaluate(() => MaweBoot.DATA.timebase)).toEqual(saved.timebase);
  await openSettingsPage(page, 'timebase');
  return saved;
}

for (const fps of [30, 23.976]) {
  test(`explicit ${fps} survives actual save reload and local media replacement`, async ({ page }, testInfo) => {
    await open(page, `user-${fps}`, { unit: 'milliseconds', fps: 30 });
    const before = await page.evaluate(() => JSON.stringify(MaweBoot.DATA.segments));
    await page.locator('#timeline-fps').fill(String(fps));
    await page.locator('#timeline-fps').press('Enter');
    expect(await page.evaluate(() => MaweBoot.DATA.timebase)).toEqual({ unit: 'milliseconds', fps, fps_source: 'user' });
    if (fps === 30) expect(await page.evaluate(() => JSON.stringify(MaweBoot.DATA.segments))).toBe(before);
    const saved = await saveReload(page);
    expect(saved.timebase.fps_source).toBe('user');
    await page.setInputFiles('#load-media-file', media24);
    await expect.poll(() => page.evaluate(() => MaweCoreState.player.currentSrc.startsWith('blob:'))).toBe(true);
    await page.locator('#timeline-timebase').selectOption('frames');
    expect(await page.evaluate(() => MaweBoot.DATA.timebase)).toEqual({ unit: 'frames', fps, fps_source: 'user' });
    await page.screenshot({ path: testInfo.outputPath(`user-${fps}.png`) });
    await saveReload(page);
  });
}

test('auto source survives save reopen and adopts replacement server media on the next frame entry', async ({ page }, testInfo) => {
  await open(page, 'auto', { unit: 'milliseconds', fps: 30 });
  expect(await page.evaluate(() => MaweBoot.DATA.media_metadata.video_fps)).toBe(25);
  await page.locator('#timeline-timebase').selectOption('frames');
  const saved = await saveReload(page);
  expect(saved.timebase).toEqual({ unit: 'frames', fps: 25, fps_source: 'auto' });
  // Rebind the saved fixture to another real media file; omit old media metadata
  // so Server probes that file (the ordinary file picker cannot probe FPS).
  await server.stop(); server = null;
  saved.media = media24; delete saved.media_metadata;
  writeFileSync(project, JSON.stringify(saved));
  server = await startServer(project, media24, await findFreePort());
  await page.goto(server.url); await expect(page.locator('.cue').first()).toBeVisible();
  expect(await page.evaluate(() => MaweBoot.DATA.media_metadata.video_fps)).toBe(24);
  expect(await page.evaluate(() => MaweBoot.DATA.timebase.fps)).toBe(25);
  await openSettingsPage(page, 'timebase');
  await page.locator('#timeline-timebase').selectOption('milliseconds');
  await page.locator('#timeline-timebase').selectOption('frames');
  expect(await page.evaluate(() => MaweBoot.DATA.timebase)).toEqual({ unit: 'frames', fps: 24, fps_source: 'auto' });
  await page.screenshot({ path: testInfo.outputPath('auto-24.png') });
  await saveReload(page);
});

test('browser rejects invalid source and preserves legacy inference across loading', async ({ page }) => {
  await open(page, 'legacy', { unit: 'milliseconds', fps: 30 });
  const results = await page.evaluate(() => {
    const result = [];
    for (const timebase of [{unit:'milliseconds',fps:30}, {unit:'milliseconds',fps:25}, {unit:'frames',fps:30}]) {
      const source = { timebase, segments: [{id:'s',start:200,end:1200,text:'hello',items:[{start:200,end:1200,text:'hello'}]}] };
      MaweProjectLoad.applyCanonicalProject(source, 'legacy.mosp');
      result.push({ timebase: MaweBoot.DATA.timebase, manual: MaweTimeline.timelineFpsManuallySet });
    }
    MaweTimeline.setTimelineTimebase({ unit: 'milliseconds' });
    MaweTimeline.setTimelineTimebase({ unit: 'frames' });
    const legacyModeRoundTrip = MaweBoot.DATA.timebase;
    const before = JSON.stringify(MaweBoot.DATA);
    let rejected = false;
    try { MaweProjectLoad.applyCanonicalProject({timebase:{unit:'milliseconds',fps:30,fps_source:'bad'},segments:[]}, 'bad.mosp'); }
    catch (_) { rejected = true; }
    return {result, legacyModeRoundTrip, rejected, unchanged: before === JSON.stringify(MaweBoot.DATA)};
  });
  expect(results.result.map(item => item.manual)).toEqual([false,true,true]);
  expect(results.result.every(item => !('fps_source' in item.timebase))).toBe(true);
  expect(results.legacyModeRoundTrip).toEqual({ unit: 'frames', fps: 30 });
  expect(results.rejected).toBe(true); expect(results.unchanged).toBe(true);
});
