import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';

const source = fs.readFileSync(new URL('../../web/editor/io/editor-wiring-export-actions.js', import.meta.url), 'utf8');
const first = source.indexOf("document.getElementById('download-gap-removed-video')");
const last = source.indexOf("document.getElementById('download-gap-removed-regions-json')", first);
const handler = source.slice(first, last);

for (const mode of ['headers', 'json-body']) {
test(`cancel endpoint pending ${mode} obeys the declared cleanup deadline`, async ({ page }) => {
  const sockets = new Set();
  let cancelRequested = false;
  const job = { ok: true, jobId: 'q-fixture', state: 'running', stage: 'rebuilding',
    progress: .1, bindingGeneration: 1, sourceMediaId: 'source-q' };
  const server = http.createServer(async (request, response) => {
    if (request.url === '/') return response.end('<button id="download-gap-removed-video">Export</button>');
    response.setHeader('Content-Type', 'application/json');
    if (request.url.endsWith('/cancel')) {
      cancelRequested = true;
      if (mode === 'json-body') { response.writeHead(200); response.write('{"ok":'); }
      return;
    }
    if (request.method === 'POST') {
      for await (const _ of request) { /* consume admission */ }
      response.writeHead(202);
    }
    response.end(JSON.stringify(job));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.clock.install();
    await page.evaluate(() => {
      window.hints = [];
      window.MaweInlineEdit = {};
      window.MaweProjectLoad = { projectBindingEpoch: 1 };
      window.MaweBoot = { FILENAME_BASE: 'q', SERVER_CONFIG: { canGapRemovedVideoExport: true,
        gapRemovedVideoSourceName: 'source.mp4', gapRemovedVideoExportUrl: '/legacy',
        gapRemovedVideoJobsUrl: '/jobs', requestToken: 'q-token', bindingGeneration: 1, sourceMediaId: 'source-q' } };
      window.MaweExportSrt = { gapRemovedExportContext: () => ({ intervals: [{ start: 0, end: 1000 }] }) };
      window.MaweHint = { flashHint: text => window.hints.push(text) };
      window.MaweHost = { server: { fetch: (...args) => fetch(...args) }, files: {
        hasSavePicker: () => true, pickSaveFile: async () => ({ name: 'result.mp4' }),
      } };
    });
    await page.addScriptTag({ content: handler });
    await page.click('#download-gap-removed-video');
    await expect.poll(() => page.evaluate(() => window.__maweGapRemovedVideoTask?.id)).toBe('q-fixture');
    await page.click('#gap-video-job-stop');
    await expect.poll(() => cancelRequested).toBe(true);
    await page.clock.fastForward(31_000);
    await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('无法确认导出已停止'))),
      { timeout: 3000 }).toBe(true);
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
}
