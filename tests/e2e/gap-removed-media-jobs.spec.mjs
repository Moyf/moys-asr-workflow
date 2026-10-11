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
        bindingGeneration: payload.bindingGeneration, sourceMediaId: payload.sourceMediaId });
      res.writeHead(202); res.end(JSON.stringify(jobs.get(jobId))); return;
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
      await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('无法确认视频任务已停止')))).toBe(true);
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
    await expect.poll(() => page.evaluate(() => window.realVideoCommitting), { timeout: 15000 }).toBe(true);
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
    expect(fs.readFileSync(video).equals(original)).toBe(true);
  } finally {
    await server?.stop();
    cleanupTempDir(dir);
  }
});
