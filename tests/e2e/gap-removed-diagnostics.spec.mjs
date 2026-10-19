import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';

const source = fs.readFileSync(new URL('../../web/editor/io/editor-wiring-export-actions.js', import.meta.url), 'utf8');
const first = source.indexOf("document.getElementById('download-gap-removed-video')");
const last = source.indexOf("document.getElementById('download-gap-removed-regions-json')", first);
const handler = source.slice(first, last);
const css = fs.readFileSync(new URL('../../web/editor.css', import.meta.url), 'utf8');
const i18n = fs.readFileSync(new URL('../../web/shared/editor-i18n.js', import.meta.url), 'utf8');

async function fixture(timeline, run, { noOutput = false, cleanupComplete = true } = {}) {
  const control = { ready: noOutput, cleanupComplete, requests: [], diagnosticsSentAt: 0, generation: 0 };
  const sockets = new Set();
  let job;
  const server = http.createServer(async (request, response) => {
    control.requests.push(`${request.method} ${request.url}`);
    if (request.url === '/') return response.end('<button id="download-gap-removed-video">Export</button>');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/jobs') {
      let body = ''; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      job = { ok: true, jobId: String(++control.generation), bindingGeneration: payload.bindingGeneration,
        sourceMediaId: payload.sourceMediaId, state: 'running', stage: 'preparing' };
      response.writeHead(202); return response.end(JSON.stringify(job));
    }
    if (/^\/jobs\/\d+\/cancel$/.test(request.url)) {
      return response.end(JSON.stringify({ ...job, state: 'cancelled', cleanupComplete: true }));
    }
    if (/^\/jobs\/\d+\/download$/.test(request.url)) {
      if (noOutput) { response.writeHead(500); return response.end('{}'); }
      job.state = 'completed'; job.cleanupComplete = true;
      response.setHeader('Content-Type', 'video/mp4'); response.setHeader('Content-Length', '4');
      return response.end('test');
    }
    if (/^\/jobs\/\d+$/.test(request.url)) {
      if (!control.diagnosticsSentAt) control.diagnosticsSentAt = Date.now();
      if (job.state !== 'completed') Object.assign(job, { videoTimeline: timeline,
        state: control.ready ? noOutput ? 'completed' : 'ready' : 'running',
        stage: control.ready ? noOutput ? 'no-output' : 'ready' : 'rebuilding',
        noOutput, cleanupComplete: noOutput ? control.cleanupComplete : undefined });
      else if (noOutput) job.cleanupComplete = control.cleanupComplete;
      return response.end(JSON.stringify(job));
    }
    response.writeHead(404); response.end('{}');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, control); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}

async function install(page, origin) {
  await page.goto(origin);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: i18n });
  await page.evaluate(() => {
    window.hints = []; window.writes = 0; window.saved = false; window.savedSrts = [];
    window.MaweInlineEdit = {};
    window.MaweProjectLoad = { projectBindingEpoch: 1 };
    window.MaweBoot = { FILENAME_BASE: 'fixture', SERVER_CONFIG: { canGapRemovedVideoExport: true,
      gapRemovedVideoSourceName: 'source.mp4', gapRemovedVideoExportUrl: '/legacy', gapRemovedVideoJobsUrl: '/jobs',
      requestToken: 'fixture', bindingGeneration: 1, sourceMediaId: 'opaque-source' } };
    window.MaweExportSrt = { gapRemovedExportContext: () => ({ intervals: [{ start: 0, end: 1000 }] }),
      captureVideoSrt: () => () => 'matching subtitles' };
    window.MaweExportTimeline = { downloadFile: async (...args) => window.savedSrts.push(args) };
    window.MaweHint = { flashHint: (...args) => window.hints.push(args) };
    window.MaweHost = { server: { fetch: (...args) => fetch(...args) }, files: {
      hasSavePicker: () => true, pickSaveFile: async () => ({ name: 'result.mp4', createWritable: async () => {
        window.writes++; return { write: async () => {}, close: async () => { window.saved = true; }, abort: async () => {} };
      } }),
    } };
  });
  await page.addScriptTag({ content: handler });
}
const value = (page, field) => page.locator(`[data-removal-value="${field}"]`);
const timeline = { requestedRemovedMs: 10000, actualRemovedMs: 5000, retainedGapMs: 3000,
  keyframeExpansionMs: 2500, unremovedGapCount: 2, internalUnremovedGapCount: 1,
  gaps: [{ sourceStartMs: 4000, sourceEndMs: 9000, position: 'internal',
    requestedRemovedMs: 5000, actualRemovedMs: 2000, retainedGapMs: 3000, reasons: ['keyframe_alignment'] }],
  intervals: [{ sourceStartMs: 0, sourceEndMs: 2000, outputStartMs: 0, outputEndMs: 2000 }] };

test('precheck summary arrives before encoding and keeps authoritative durations distinct', async ({ page }, testInfo) => {
  await fixture(timeline, async (origin, control) => {
    await install(page, origin);
    await page.click('#download-gap-removed-video');
    await expect(value(page, 'actualRemovedMs')).toHaveText('5.000 秒');
    await expect(value(page, 'requestedRemovedMs')).toHaveText('10.000 秒');
    await expect(value(page, 'retainedGapMs')).toHaveText('3.000 秒');
    await expect(page.locator('#gap-video-job-expansion')).toHaveText('累积偏移时长：2.500 秒');
    expect(await page.evaluate(() => window.writes)).toBe(0);
    expect(control.ready).toBe(false);
    expect(control.requests.some(request => /preflight|precheck/.test(request))).toBe(false);
    const latency = Date.now() - control.diagnosticsSentAt;
    fs.writeFileSync(testInfo.outputPath('diagnostic-latency.json'), JSON.stringify({ diagnosticResponseToVisibleMs: latency }));
    const details = page.locator('#gap-video-job-removal-details');
    await expect(details).not.toHaveAttribute('open', '');
    await expect(details.locator('li')).toHaveCount(0);
    await expect(details.locator('summary')).toContainText('2 段，内部 1 段');
    await details.locator('summary').click();
    await expect(details).toContainText('源区间：4.000 秒 — 9.000 秒');
    await expect(details).toContainText('对齐安全关键帧后仍保留部分空隙');
    await page.waitForTimeout(350);
    await expect(details).toHaveAttribute('open', '');
    control.ready = true;
    await expect(page.locator('#gap-video-job-close')).toBeVisible();
    await expect(value(page, 'retainedGapMs')).toHaveText('3.000 秒');
    await expect(page.locator('#gap-video-job-save-srt')).toBeVisible();
    expect(await page.evaluate(() => window.savedSrts.length)).toBe(0);
  });
});

for (const reason of ['budget_exhausted', 'point_budget_exhausted', 'future_unknown_reason']) {
  test(`unknown diagnostic values remain unknown for ${reason}`, async ({ page }) => {
    await fixture({ ...timeline, actualRemovedMs: null, retainedGapMs: null, keyframeExpansionMs: null,
      gaps: [{ sourceStartMs: 1000, sourceEndMs: 4000, actualRemovedMs: null, retainedGapMs: null, reasons: [reason] }] }, async (origin) => {
      await install(page, origin);
      await page.click('#download-gap-removed-video');
      await expect(value(page, 'actualRemovedMs')).toHaveText('未知');
      await expect(value(page, 'retainedGapMs')).toHaveText('未知');
      await page.locator('#gap-video-job-removal-details summary').click();
      await expect(page.locator('#gap-video-job-removal-details')).toContainText(reason.includes('budget')
        ? '已达到分析预算，部分切点尚未确认' : '未提供具体原因');
      await expect(page.locator('#gap-video-job-removal-details')).not.toContainText(reason);
      await page.click('#gap-video-job-stop');
      await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
    });
  });
}

test('missing summary values become unknown after precheck instead of staying calculating', async ({ page }) => {
  await fixture(null, async (origin, control) => {
    await install(page, origin);
    await page.click('#download-gap-removed-video');
    await expect(value(page, 'requestedRemovedMs')).toHaveText('未知');
    await expect(value(page, 'actualRemovedMs')).toHaveText('未知');
    await expect(value(page, 'retainedGapMs')).toHaveText('未知');
    control.ready = true;
    await expect(page.locator('#gap-video-job-close')).toBeVisible();
    await expect(value(page, 'retainedGapMs')).toHaveText('未知');
  });
});

test('no-output result is closable without creating video or SRT and waits for cleanup acknowledgement', async ({ page }) => {
  await fixture({ ...timeline, actualRemovedMs: 0, retainedGapMs: 10000, noGapsRemoved: true,
    gaps: [{ sourceStartMs: 2000, sourceEndMs: 12000, actualRemovedMs: 0,
      retainedGapMs: 10000, reasons: ['hevc_cra'] }] }, async (origin, control) => {
    await install(page, origin);
    await page.click('#download-gap-removed-video');
    await expect(page.locator('#gap-video-job-status')).toHaveText('未能安全移除空隙，未生成视频');
    await expect(page.locator('#gap-video-job-save-srt')).toHaveCount(0);
    await expect(page.locator('#gap-video-job-stop')).toHaveCount(0);
    await expect(page.locator('#gap-video-job-close')).toBeVisible();
    await expect(page.locator('#download-gap-removed-video')).toBeDisabled();
    control.cleanupComplete = true;
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
    expect(await page.evaluate(() => ({ writes: window.writes, saved: window.saved,
      task: window.__maweGapRemovedVideoTask, savedSrts: window.savedSrts.length,
      success: window.hints.some(([, kind]) => kind === 'success') })))
      .toEqual({ writes: 0, saved: false, task: null, savedSrts: 0, success: false });
    expect(control.requests.some(request => request.includes('/download'))).toBe(false);
    await expect(page.locator('.gap-video-job')).not.toContainText('将保留完整媒体');
    await page.locator('#gap-video-job-removal-details summary').click();
    await expect(page.locator('#gap-video-job-removal-details')).toContainText('CRA 切点');
    await page.screenshot({ path: test.info().outputPath('no-output-result.png') });
    await page.click('#gap-video-job-close');
    await expect(page.locator('.gap-video-job')).toHaveCount(0);
    await page.click('#download-gap-removed-video');
    await expect.poll(() => control.generation).toBe(2);
    await expect(page.locator('#gap-video-job-close')).toBeVisible();
  }, { noOutput: true, cleanupComplete: false });
});

for (const theme of ['dark', 'light']) {
  test(`${theme} narrow progress and retained result fit the viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await fixture({ ...timeline, gaps: Array.from({ length: 8 }, (_, i) => ({ sourceStartMs: i * 10000,
      sourceEndMs: i * 10000 + 9000, actualRemovedMs: 0, retainedGapMs: 9000,
      reasons: ['budget_exhausted', 'no_common_video_boundary'] })) }, async (origin, control) => {
      await install(page, origin);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.click('#download-gap-removed-video');
      await expect(value(page, 'retainedGapMs')).toHaveText('3.000 秒');
      await page.locator('#gap-video-job-removal-details summary').click();
      const geometry = await page.locator('.gap-video-job').evaluate(panel => {
        const r = panel.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          width: innerWidth, height: innerHeight, overflow: panel.scrollWidth > panel.clientWidth,
          bg: getComputedStyle(panel).backgroundColor, text: getComputedStyle(panel).color };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.width);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
      expect(geometry.overflow).toBe(false);
      fs.writeFileSync(testInfo.outputPath('panel-geometry.json'), JSON.stringify(geometry));
      await page.screenshot({ path: testInfo.outputPath(`diagnostics-${theme}.png`) });
      control.ready = true;
      await expect(page.locator('#gap-video-job-close')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`diagnostics-result-${theme}.png`) });
    });
  });
}

test('English diagnostics translate confirmed reasons without leaking backend codes', async ({ page }) => {
  await fixture({ ...timeline, gaps: [{ sourceStartMs: 1000, sourceEndMs: 4000,
    retainedGapMs: 3000, reasons: ['h264_recovery', 'no_common_video_boundary'] }] }, async origin => {
    await install(page, origin);
    await page.evaluate(() => window.MAWE_I18N.applyLanguage('en'));
    await page.click('#download-gap-removed-video');
    await expect(value(page, 'retainedGapMs')).toHaveText('3.000 seconds');
    await expect(page.locator('#gap-video-job-removal-summary')).toContainText('Planned removal');
    await page.locator('#gap-video-job-removal-details summary').click();
    await expect(page.locator('#gap-video-job-removal-details')).toContainText('open GOP or recovery entry');
    await expect(page.locator('#gap-video-job-removal-details')).toContainText('No usable safe cut point was found');
    await expect(page.locator('#gap-video-job-removal-details')).not.toContainText('no_common_video_boundary');
    await expect(page.locator('#gap-video-job-removal-details')).not.toContainText('h264_recovery');
    await page.click('#gap-video-job-stop');
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
  });
});

test('truncated backend details explicitly preserve the total count and disclose the limited list', async ({ page }) => {
  await fixture({ ...timeline, unremovedGapCount: 200, internalUnremovedGapCount: 190,
    gapDetailsTruncated: true, gaps: timeline.gaps }, async origin => {
    await install(page, origin);
    await page.click('#download-gap-removed-video');
    await expect(page.locator('#gap-video-job-removal-details summary')).toContainText('200 段，内部 190 段');
    await page.locator('#gap-video-job-removal-details summary').click();
    await expect(page.locator('#gap-video-job-removal-details')).toContainText('仅展示部分明细，计数包含全部空隙。');
    await expect(page.locator('#gap-video-job-removal-details li')).toHaveCount(1);
    await page.click('#gap-video-job-stop');
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
  });
});
