import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeTempDir, cleanupTempDir, generateProjectJson, startServer, findFreePort } from './helpers.mjs';

const source = fs.readFileSync(new URL('../../web/editor/io/editor-wiring-export-actions.js', import.meta.url), 'utf8');
const start = source.indexOf("document.getElementById('download-gap-removed-video')");
const end = source.indexOf("document.getElementById('download-gap-removed-regions-json')", start);
const handler = source.slice(start, end);

async function fixture(mode, run) {
  const jobs = new Map();
  const requests = [];
  const sockets = new Set();
  let generation = 0;
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    if (req.url === '/') { res.end('<button id="download-gap-removed-video">Export</button>'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/jobs') {
      let data = ''; for await (const chunk of req) data += chunk;
      const payload = JSON.parse(data);
      const jobId = String(++generation);
      jobs.set(jobId, { ok: true, jobId, state: 'running', stage: mode === 'prepare' ? 'preparing' : 'rebuilding', progress: .35,
        bindingGeneration: payload.bindingGeneration, sourceMediaId: payload.sourceMediaId,
        admissionToken: payload.admissionToken });
      if (mode.startsWith('timeline-')) jobs.get(jobId).videoTimeline = {
        keyframeExpansionMs: mode === 'timeline-all' ? 1000 : Number(mode.slice('timeline-'.length)),
        noGapsRemoved: mode === 'timeline-all',
        intervals: [{ sourceStartMs: 0, sourceEndMs: 2000, outputStartMs: 0, outputEndMs: 2000 }],
      };
      if (mode.startsWith('admission-')) {
        // The server has admitted real work, but JavaScript cannot parse its ID.
        if (mode === 'admission-body') { res.writeHead(202); res.write('{"ok":true,'); }
        return;
      }
      res.writeHead(202); res.end(JSON.stringify(jobs.get(jobId))); return;
    }
    if (req.method === 'POST' && req.url === '/jobs/cancel-admission') {
      let data = ''; for await (const chunk of req) data += chunk;
      const payload = JSON.parse(data);
      const job = [...jobs.values()].find(job => job.admissionToken === payload.admissionToken);
      if (!job) { res.writeHead(404); res.end('{}'); return; }
      job.state = 'cancelled'; job.cleanupComplete = true;
      res.end(JSON.stringify(job)); return;
    }
    const match = req.url.match(/^\/jobs\/(\d+)(\/cancel|\/download)?$/);
    const job = match && jobs.get(match[1]);
    if (!job) { res.writeHead(404); res.end('{}'); return; }
    if (match[2] === '/cancel') {
      if (mode.startsWith('cancel-')) {
        job.cancelRequested = true;
        if (mode === 'cancel-body') res.write('{"state":');
        return;
      }
      job.state = 'cancelled'; res.end(JSON.stringify(job)); return;
    }
    if (match[2] === '/download') {
      if (job.state !== 'ready') { res.writeHead(409); res.end('{}'); return; }
      job.state = 'downloading';
      res.setHeader('Content-Type', mode === 'mime-failure' ? 'text/plain' : 'video/mp4');
      res.setHeader('Content-Length', mode === 'transfer' ? '1000000000' : '4');
      res.writeHead(200);
      if (mode === 'transfer' || mode === 'mime-failure') {
        const timer = setInterval(() => res.write(Buffer.alloc(1024)), 10);
        res.on('close', () => { clearInterval(timer); job.state = 'cancelled'; });
      } else { res.end('test'); job.state = 'completed'; }
      return;
    }
    if (!['prepare', 'rebuild', 'cancel-headers', 'cancel-body'].includes(mode) && job.state === 'running') { job.state = 'ready'; job.stage = 'ready'; job.progress = 1; }
    res.end(JSON.stringify(job));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, { jobs, requests }); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}

async function install(page, origin, mode) {
  await page.goto(origin);
  await page.evaluate(mode => {
    window.hints = []; window.aborted = false; window.saved = false; window.writeStarted = false; window.closeStarted = false;
    window.MaweInlineEdit = {};
    window.MaweProjectLoad = { projectBindingEpoch: 1 };
    window.MaweBoot = { FILENAME_BASE: 'fixture', SERVER_CONFIG: { canGapRemovedVideoExport: true,
      gapRemovedVideoSourceName: 'source.mp4', gapRemovedVideoExportUrl: '/legacy', gapRemovedVideoJobsUrl: '/jobs',
      requestToken: 'fixture', bindingGeneration: 1, sourceMediaId: 'opaque-source' } };
    window.MaweExportSrt = { gapRemovedExportContext: () => ({ intervals: [{ start: 0, end: 1000 }] }) };
    window.MaweHint = { flashHint: text => window.hints.push(text) };
    window.MaweHost = { server: { fetch: (...args) => fetch(...args) }, files: {
      hasSavePicker: () => true, pickSaveFile: async () => ({ name: 'result.mp4', createWritable: async () => ({
        write: async () => { window.writeStarted = true; if (mode === 'write') await new Promise(resolve => { window.releaseWrite = resolve; }); if (mode === 'disk-failure') throw new Error('Disk full'); },
        close: async () => { window.closeStarted = true; if (mode === 'close') await new Promise(resolve => { window.releaseClose = resolve; }); if (mode === 'close-failure') throw new Error('Disk full at commit'); window.saved = true; },
        abort: async () => { window.aborted = true; window.releaseWrite?.(); window.releaseClose?.(); },
      }) }),
    } };
  }, mode);
  await page.addScriptTag({ content: handler });
}

for (const mode of ['prepare', 'rebuild', 'transfer', 'write']) {
  test(`stop during ${mode} cancels task and permits retry`, async ({ page }) => {
    await fixture(mode, async (origin, state) => {
      await install(page, origin, mode);
      await page.click('#download-gap-removed-video');
      await expect(page.locator('#gap-video-job-stop')).toBeVisible();
      if (mode === 'write') await expect.poll(() => page.evaluate(() => window.writeStarted)).toBe(true);
      if (mode === 'transfer') await expect.poll(() => [...state.jobs.values()].at(-1)?.state).toBe('downloading');
      await page.click('#gap-video-job-stop');
      await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('已停止')))).toBe(true);
      expect([...state.jobs.values()][0].state).toBe('cancelled');
      if (mode === 'write') expect(await page.evaluate(() => window.aborted)).toBe(true);
      expect(await page.evaluate(() => window.hints.some(text => text.includes('已重组并保存')))).toBe(false);
      await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
      await page.click('#download-gap-removed-video');
      await expect.poll(() => state.jobs.size).toBe(2);
      await page.click('#gap-video-job-stop');
      await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
    });
  });
}

for (const delay of ['headers', 'body']) for (const action of ['stop', 'pagehide']) {
  test(`${action} cancels admitted work before delayed admission ${delay} delivers jobId`, async ({ page }) => {
    await fixture(`admission-${delay}`, async (origin, state) => {
      await install(page, origin, `admission-${delay}`);
      await page.click('#download-gap-removed-video');
      await expect.poll(() => state.jobs.size).toBe(1);
      expect(await page.evaluate(() => window.__maweGapRemovedVideoTask.id)).toBeNull();
      const job = [...state.jobs.values()][0];
      expect(job.admissionToken).toMatch(/^[a-f0-9]{64}$/);
      if (action === 'pagehide') await page.goto('about:blank');
      else await page.click('#gap-video-job-stop');
      await expect.poll(() => job.state).toBe('cancelled');
      expect(state.requests).toContain('/jobs/cancel-admission');
      expect(state.requests.some(path => path.endsWith('/download'))).toBe(false);
      if (action === 'stop') {
        await expect.poll(() => page.evaluate(() => window.hints.includes('视频导出已停止'))).toBe(true);
        await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
        expect(await page.evaluate(() => window.__maweGapRemovedVideoTask)).toBeNull();
      }
    });
  });
}

for (const mode of ['disk-failure', 'mime-failure', 'close-failure']) {
  test(`${mode} clears download and task`, async ({ page }) => {
    await fixture(mode, async (origin, state) => {
      await install(page, origin, mode);
      await page.click('#download-gap-removed-video');
      await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('导出失败')))).toBe(true);
      await expect.poll(() => [...state.jobs.values()][0]?.state).toBe('cancelled');
      await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
    });
  });
}

test('native save commit disables stop and reports success only after close', async ({ page }, testInfo) => {
  await fixture('close', async (origin) => {
    await install(page, origin, 'close');
    await page.click('#download-gap-removed-video');
    await expect.poll(() => page.evaluate(() => window.closeStarted)).toBe(true);
    await expect(page.locator('#gap-video-job-stop')).toBeDisabled();
    await expect(page.locator('#gap-video-job-status')).toContainText('正在完成保存');
    expect(await page.evaluate(() => window.hints.some(text => text.includes('已重组并保存')))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('media-job-commit.png') });
    await page.evaluate(() => window.releaseClose());
    await expect.poll(() => page.evaluate(() => window.saved)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('已重组并保存')))).toBe(true);
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
  });
});

test('binding changed during processing stops old job before download', async ({ page }) => {
  await fixture('rebuild', async (origin, state) => {
    await install(page, origin, 'rebuild');
    await page.click('#download-gap-removed-video');
    await expect.poll(() => state.jobs.size).toBe(1);
    await page.evaluate(() => { window.MaweProjectLoad.projectBindingEpoch += 1; });
    await expect.poll(() => [...state.jobs.values()][0]?.state).toBe('cancelled');
    expect(state.requests.some(path => path.endsWith('/download'))).toBe(false);
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
  });
});

test('completed result stays closable after task cleanup and does not block another export', async ({ page }) => {
  await fixture('success', async (origin, state) => {
    await install(page, origin, 'success');
    await page.click('#download-gap-removed-video');
    await expect(page.locator('#gap-video-job-close')).toBeVisible();
    await expect(page.locator('#gap-video-job-status')).toContainText('已重组并保存');
    await expect(page.locator('#gap-video-job-expansion')).toContainText('不可用');
    await expect.poll(() => page.evaluate(() => window.__maweGapRemovedVideoTask)).toBeNull();
    await expect(page.locator('#gap-video-job-stop')).toHaveCount(0);
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
    await page.click('#download-gap-removed-video');
    await expect.poll(() => state.jobs.size).toBe(2);
    await expect(page.locator('#gap-video-job-close')).toBeVisible();
    await expect(page.locator('.gap-video-job')).toHaveCount(1);
    await page.click('#gap-video-job-close');
    await expect(page.locator('.gap-video-job')).toHaveCount(0);
  });
});

for (const expansion of [0, 2500]) {
  test(`completed result reports known ${expansion}ms expansion and saves SRT only on a second gesture`, async ({ page }) => {
    await fixture(`timeline-${expansion}`, async origin => {
      await install(page, origin, `timeline-${expansion}`);
      await page.evaluate(() => {
        window.currentSubtitle = 'captured source subtitle';
        window.MaweExportSrt.captureVideoSrt = () => {
          const captured = window.currentSubtitle;
          return () => captured;
        };
        window.savedSrts = [];
        window.MaweExportTimeline = { downloadFile: async (content, name) => window.savedSrts.push({ content, name }) };
      });
      await page.click('#download-gap-removed-video');
      await expect(page.locator('#gap-video-job-expansion')).toHaveText(`累积偏移时长：${(expansion / 1000).toFixed(3)} 秒`);
      await expect(page.locator('#gap-video-job-save-srt')).toBeVisible();
      expect(await page.evaluate(() => window.savedSrts.length)).toBe(0);
      await page.evaluate(() => { window.currentSubtitle = 'another project'; });
      await page.click('#gap-video-job-save-srt');
      expect(await page.evaluate(() => window.savedSrts)).toEqual([{ content: 'captured source subtitle', name: 'result.srt' }]);
    });
  });
}

test('safe expansion that retains the whole source explicitly says no gaps were removed', async ({ page }) => {
  await fixture('timeline-all', async origin => {
    await install(page, origin, 'timeline-all');
    await page.click('#download-gap-removed-video');
    await expect(page.locator('#gap-video-job-close')).toBeVisible();
    await expect(page.locator('.gap-video-job')).toContainText('未移除空隙，将保留完整媒体');
  });
});

for (const mode of ['cancel-headers', 'cancel-body']) {
  test(`${mode} uses a bounded cleanup deadline without claiming stopped`, async ({ page }) => {
    await fixture(mode, async (origin, state) => {
      await install(page, origin, mode);
      await page.clock.install();
      await page.click('#download-gap-removed-video');
      await expect.poll(() => page.evaluate(() => window.__maweGapRemovedVideoTask?.id)).toBe('1');
      await page.click('#gap-video-job-stop');
      await expect.poll(() => [...state.jobs.values()][0]?.cancelRequested).toBe(true);
      await page.clock.fastForward(31000);
      await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('无法确认导出已停止')))).toBe(true);
      await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
      expect(await page.evaluate(() => window.__maweGapRemovedVideoTask)).toBeNull();
      expect(await page.evaluate(() => window.hints.some(text => text === '视频导出已停止'))).toBe(false);
    });
  });
}

test('rendered editor reconstructs real video and shows native commit boundary', async ({ page }, testInfo) => {
  const dir = makeTempDir('media-jobs-real');
  let server;
  try {
    const video = join(dir, 'source.mp4');
    execFileSync('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-g', '1', '-c:a', 'aac', video], { timeout: 15000 });
    const original = fs.readFileSync(video);
    const project = generateProjectJson(join(dir, 'source.mosp'));
    server = await startServer(project, video, await findFreePort());
    await page.goto(server.url);
    await page.waitForFunction(() => window.MaweProjectLoad && window.MaweExportSrt && MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport);
    await page.evaluate(() => {
      window.realVideoHints = []; window.realVideoBytes = 0; window.realVideoClosed = false; window.realVideoCommitting = false;
      const originalHint = window.MaweHint;
      window.MaweHint = { ...originalHint, flashHint: text => window.realVideoHints.push(text) };
      window.MaweExportSrt = { ...window.MaweExportSrt, gapRemovedExportContext: () => ({ intervals: [{ start: 0, end: 500 }, { start: 1000, end: 1500 }] }) };
      window.showSaveFilePicker = async () => ({ name: 'result.mp4', createWritable: async () => ({
        write: async bytes => { window.realVideoBytes += bytes.byteLength; },
        close: async () => { window.realVideoCommitting = true; await new Promise(resolve => { window.realVideoFinishCommit = resolve; }); window.realVideoClosed = true; },
        abort: async () => { window.realVideoAborted = true; },
      }) });
      document.getElementById('download-gap-removed-video').click();
    });
    await expect.poll(() => page.evaluate(() => window.realVideoCommitting || window.realVideoHints.join(' | ')), { timeout: 15000 }).toBe(true);
    await expect(page.locator('#gap-video-job-stop')).toBeDisabled();
    await expect(page.locator('#gap-video-job-status')).toContainText('正在完成保存');
    expect(await page.evaluate(() => window.realVideoBytes)).toBeGreaterThan(0);
    const spacing = await page.evaluate(() => {
      const panel = document.querySelector('.gap-video-job');
      const status = panel.querySelector('#gap-video-job-status').getBoundingClientRect();
      const progress = panel.querySelector('progress');
      const bar = progress.getBoundingClientRect();
      const stop = panel.querySelector('#gap-video-job-stop').getBoundingClientRect();
      const style = getComputedStyle(progress);
      return { statusToProgressPx: bar.top - status.bottom, progressToStopPx: stop.top - bar.bottom,
        progressMarginTop: style.marginTop, progressMarginBottom: style.marginBottom,
        panelPadding: getComputedStyle(panel).padding };
    });
    expect(spacing.statusToProgressPx).toBeGreaterThanOrEqual(8);
    expect(spacing.progressToStopPx).toBeGreaterThanOrEqual(8);
    const spacingPath = testInfo.outputPath('media-job-panel-spacing.json');
    fs.writeFileSync(spacingPath, JSON.stringify(spacing, null, 2));
    await testInfo.attach('media-job-panel-spacing', { path: spacingPath, contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('real-editor-media-job-commit.png') });
    await page.evaluate(() => window.realVideoFinishCommit());
    await expect.poll(() => page.evaluate(() => window.realVideoHints.some(text => text.includes('已重组并保存')))).toBe(true);
    await expect(page.locator('#gap-video-job-close')).toBeVisible();
    await expect(page.locator('#gap-video-job-save-srt')).toBeVisible();
    await expect(page.locator('#gap-video-job-expansion')).not.toContainText('不可用');
    const resultSpacing = await page.evaluate(() => {
      const actions = document.querySelector('.gap-video-job-actions').getBoundingClientRect();
      const bar = document.querySelector('.gap-video-job progress').getBoundingClientRect();
      return actions.top - bar.bottom;
    });
    expect(resultSpacing).toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: testInfo.outputPath('real-editor-media-job-result-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: testInfo.outputPath('real-editor-media-job-result-light.png') });
    expect(fs.readFileSync(video).equals(original)).toBe(true);
  } finally {
    await server?.stop();
    cleanupTempDir(dir);
  }
});

test('rendered editor real open GOP completes without output and releases its task', async ({ page }, testInfo) => {
  const dir = makeTempDir('media-jobs-real-no-output');
  let server;
  try {
    const video = join(dir, 'open-gop.mp4');
    execFileSync('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=25',
      '-f', 'lavfi', '-i', 'sine=sample_rate=48000', '-t', '12', '-c:v', 'libx264', '-g', '100',
      '-keyint_min', '100', '-sc_threshold', '0', '-bf', '1', '-x264-params', 'open-gop=1:b-pyramid=none',
      '-c:a', 'aac', video], { timeout: 15000 });
    const original = fs.readFileSync(video);
    server = await startServer(generateProjectJson(join(dir, 'source.mosp')), video, await findFreePort());
    let downloads = 0;
    page.on('request', request => { if (/\/jobs\/[^/]+\/download(?:\?|$)/.test(request.url())) downloads++; });
    await page.goto(server.url);
    await page.waitForFunction(() => window.MaweProjectLoad && window.MaweExportSrt && MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport);
    await page.evaluate(() => {
      window.realNoOutputWrites = 0; window.realNoOutputSrts = 0;
      window.MaweExportSrt = { ...window.MaweExportSrt, gapRemovedExportContext: () => ({
        intervals: [{ start: 1000, end: 2000 }, { start: 8500, end: 9500 }],
      }) };
      window.MaweExportTimeline = { ...window.MaweExportTimeline, downloadFile: async () => { window.realNoOutputSrts++; } };
      window.showSaveFilePicker = async () => ({ name: 'result.mp4', createWritable: async () => {
        window.realNoOutputWrites++;
        return { write: async () => {}, close: async () => {}, abort: async () => {} };
      } });
    });
    const admission = page.waitForResponse(response => response.request().method() === 'POST'
      && /\/gap-removed-video\/jobs$/.test(response.url()) && response.status() === 202);
    await page.evaluate(() => document.getElementById('download-gap-removed-video').click());
    const { jobId } = await (await admission).json();
    await expect(page.locator('.gap-video-job[data-no-output="true"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#gap-video-job-status')).toContainText('未生成视频');
    await expect(page.locator('#gap-video-job-close')).toBeVisible();
    await expect(page.locator('#gap-video-job-save-srt')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__maweGapRemovedVideoTask)).toBeNull();
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
    const snapshot = await page.evaluate(async id => {
      const config = MaweBoot.SERVER_CONFIG;
      return (await fetch(`${config.gapRemovedVideoJobsUrl}/${encodeURIComponent(id)}`, {
        headers: { 'X-MAW-Request-Token': config.requestToken },
      })).json();
    }, jobId);
    expect(snapshot).toMatchObject({ state: 'completed', stage: 'no-output', noOutput: true, cleanupComplete: true });
    expect(snapshot.videoTimeline.actualRemovedMs).toBe(0);
    expect(snapshot.videoTimeline.gaps.some(gap => gap.reasons.includes('h264_recovery'))).toBe(true);
    expect(await page.evaluate(() => [window.realNoOutputWrites, window.realNoOutputSrts])).toEqual([0, 0]);
    expect(downloads).toBe(0);
    expect(fs.readFileSync(video).equals(original)).toBe(true);
    fs.writeFileSync(testInfo.outputPath('real-no-output-snapshot.json'), JSON.stringify(snapshot, null, 2));
    const onboardingSkip = page.getByRole('button', { name: '跳过 (ESC)', exact: true });
    if (await onboardingSkip.isVisible()) await onboardingSkip.click();
    await page.screenshot({ path: testInfo.outputPath('real-no-output-result.png') });
    await page.click('#gap-video-job-close');
    await expect(page.locator('.gap-video-job')).toHaveCount(0);
  } finally {
    await server?.stop();
    cleanupTempDir(dir);
  }
});
