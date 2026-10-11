import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { makeTempDir, cleanupTempDir, generateWav, generateProjectJson, startServer, findFreePort } from './helpers.mjs';

const source = fs.readFileSync(new URL('../../web/editor/io/editor-wiring-export-actions.js', import.meta.url), 'utf8');
const start = source.indexOf("document.getElementById('download-gap-removed-video')");
const end = source.indexOf("document.getElementById('download-gap-removed-regions-json')", start);
if (start < 0 || end <= start) throw new Error('Video handler not found');
const handler = source.slice(start, end);
const projectLoad = fs.readFileSync(new URL('../../web/editor/io/editor-project-load.js', import.meta.url), 'utf8');

async function withFixture(page, run) {
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/export') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '4' });
        response.end('data');
      });
    } else response.end('<button id="download-gap-removed-video">Export</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.hints = [];
      window.writes = 0;
      window.outputClosed = false;
      window.MaweInlineEdit = {};
      window.MaweBoot = { FILENAME_BASE: 'test', SERVER_CONFIG: {
        canGapRemovedVideoExport: true, gapRemovedVideoSourceName: 'source.mp4',
        gapRemovedVideoExportUrl: '/export', requestToken: 'fixture',
        bindingGeneration: 1, sourceMediaId: 'source-1',
      } };
      window.context = { intervals: [{ start: 0, end: 1000 }] };
      window.MaweExportSrt = { gapRemovedExportContext: () => window.context };
      window.MaweHint = { flashHint: text => window.hints.push(text) };
      window.MaweServerSave = { configureServerSaveControls() {}, scheduleAutoSave() {} };
      window.MaweDynamicExports = { updateLottieExportButton() {}, updateOgrafExportButton() {} };
      window.MaweHost = {
        server: { fetch: (...args) => fetch(...args) },
        files: { hasSavePicker: () => true, pickSaveFile: () => new Promise((resolve, reject) => {
          window.pickerPending = true;
          window.cancelPicker = () => reject(new DOMException('cancel', 'AbortError'));
          window.resolvePicker = () => resolve({ name: 'result.mp4', createWritable: async () => ({
            write: async () => { window.writes += 1; }, close: async () => { window.outputClosed = true; }, abort: async () => {},
          }) });
        }) },
      };
    });
    await page.addScriptTag({ content: projectLoad });
    await page.addScriptTag({ content: handler });
    await page.click('#download-gap-removed-video');
    await expect.poll(() => page.evaluate(() => window.pickerPending)).toBe(true);
    await run(requests);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const mutation of ['detach', 'replace-config', 'generation', 'source-id', 'capability']) {
  test(`picker resume rejects ${mutation} without POST or output`, async ({ page }) => {
    await withFixture(page, async requests => {
      await page.evaluate(mode => {
        if (mode === 'detach') MaweProjectLoad.detachServerProjectSaving();
        if (mode === 'replace-config') MaweBoot.SERVER_CONFIG = { ...MaweBoot.SERVER_CONFIG };
        if (mode === 'generation') MaweBoot.SERVER_CONFIG.bindingGeneration += 1;
        if (mode === 'source-id') MaweBoot.SERVER_CONFIG.sourceMediaId = 'source-2';
        if (mode === 'capability') MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport = false;
        window.resolvePicker();
      }, mutation);
      await expect.poll(() => page.evaluate(() => window.hints.at(-1))).toContain('绑定已变更');
      expect(requests).toEqual([]);
      expect(await page.evaluate(() => window.writes)).toBe(0);
    });
  });
}

test('normal resume sends fixed identity and interval snapshot and saves fully', async ({ page }) => {
  await withFixture(page, async requests => {
    await page.evaluate(() => { window.context.intervals[0].end = 9000; window.resolvePicker(); });
    await expect.poll(() => page.evaluate(() => window.outputClosed)).toBe(true);
    expect(requests).toEqual([{ requestToken: 'fixture', bindingGeneration: 1, sourceMediaId: 'source-1',
      intervals: [{ startMs: 0, endMs: 1000 }] }]);
    expect(await page.evaluate(() => window.hints.at(-1))).toContain('已重组并保存');
  });
});

test('cancelled picker submits nothing and keeps binding intact', async ({ page }) => {
  await withFixture(page, async requests => {
    await page.evaluate(() => window.cancelPicker());
    // A browser round trip lets the handler catch the rejection.
    expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.sourceMediaId)).toBe('source-1');
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => window.writes)).toBe(0);
  });
});

for (const change of ['canonical-reload', 'server-rebind']) {
test(`rendered editor rejects waiting video picker after ${change}`, async ({ page }) => {
  const dir = makeTempDir('gap-binding-editor');
  let server;
  try {
    const wav = generateWav(join(dir, 'synthetic.wav'), 60);
    const project = join(dir, 'source.mosp');
    generateProjectJson(project);
    server = await startServer(project, wav, await findFreePort());
    await page.goto(server.url);
    await page.waitForFunction(() => window.MaweProjectLoad && window.MaweExportSrt);
    let posts = 0;
    page.on('request', request => {
      if (request.url().endsWith('/api/exports/gap-removed-video')
          || request.url().endsWith('/api/exports/gap-removed-video/jobs')) posts += 1;
    });
    await page.evaluate(() => {
      window.bindingHints = [];
      const original = window.MaweHint;
      window.MaweHint = { ...original, flashHint: text => window.bindingHints.push(text) };
      Object.assign(MaweBoot.SERVER_CONFIG, { canGapRemovedVideoExport: true, gapRemovedVideoSourceName: 'source.mp4' });
      window.MaweExportSrt = { ...window.MaweExportSrt, gapRemovedExportContext: () => ({ intervals: [{ start: 0, end: 1000 }] }) };
      window.showSaveFilePicker = () => new Promise(resolve => {
        window.bindingPickerPending = true;
        window.bindingPickerResolve = () => resolve({ name: 'result.mp4', createWritable: async () => { throw new Error('must not create'); } });
      });
      document.getElementById('download-gap-removed-video').click();
    });
    await expect.poll(() => page.evaluate(() => window.bindingPickerPending)).toBe(true);
    const before = await page.evaluate(() => MaweProjectLoad.projectBindingEpoch);
    if (change === 'canonical-reload') {
      await page.evaluate(() => {
        MaweProjectLoad.applyCanonicalProject(JSON.parse(JSON.stringify(MaweBoot.DATA)), 'reloaded.mosp');
      });
    } else {
      // Simulate another tab reopening the same on-disk project. This page
      // retains its old IDs; the actual Python endpoint must reject its POST.
      const response = await page.request.post(`${server.url}api/recent-projects/open`, { data: { path: project } });
      expect(response.status()).toBe(200);
    }
    await page.evaluate(() => {
      window.bindingPickerResolve();
    });
    await expect.poll(() => page.evaluate(() => window.bindingHints.at(-1))).toContain('绑定已变更');
    expect(await page.evaluate(() => MaweProjectLoad.projectBindingEpoch)).toBe(before + (change === 'canonical-reload' ? 1 : 0));
    expect(posts).toBe(change === 'canonical-reload' ? 0 : 1);
    if (change === 'server-rebind') {
      expect(await page.evaluate(() => window.bindingHints.at(-1))).toContain('导出失败');
    }
  } finally {
    await server?.stop();
    cleanupTempDir(dir);
  }
});
}
