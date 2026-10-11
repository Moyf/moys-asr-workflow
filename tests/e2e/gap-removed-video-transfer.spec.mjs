import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';

// Exercise the production event handler with Chromium's real Fetch stream.
// The small page avoids ASR/media setup; the HTTP fixture holds the same export
// lease until its response closes, making missing body cancellation observable.
const source = fs.readFileSync(new URL('../../web/editor/io/editor-wiring-export-actions.js', import.meta.url), 'utf8');
const handlerStart = source.indexOf("document.getElementById('download-gap-removed-video')");
const handlerEnd = source.indexOf("document.getElementById('download-gap-removed-regions-json')", handlerStart);
if (handlerStart < 0 || handlerEnd <= handlerStart) throw new Error('Video export handler not found');
const handler = source.slice(handlerStart, handlerEnd);

async function withVideoServer(mode, run) {
  let active = false;
  let closed = 0;
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.url === '/') {
      response.end('<button id="download-gap-removed-video">Export</button>');
      return;
    }
    // Edge requests a favicon even for this tiny page. Unrelated requests must
    // not acquire the video lease or turn the intended failure into HTTP 409.
    if (request.url !== '/export' || request.method !== 'POST') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (active) {
      response.writeHead(409);
      response.end('{}');
      return;
    }
    active = true;
    const headers = { 'Content-Type': mode === 'content-type' ? 'text/plain' : 'video/mp4' };
    if (mode !== 'content-length') headers['Content-Length'] = '1000000000';
    response.writeHead(200, headers);
    const timer = setInterval(() => response.write(Buffer.alloc(16 * 1024)), 4);
    response.on('close', () => {
      clearInterval(timer);
      active = false;
      closed += 1;
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, () => ({ active, closed, requests }));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const mode of ['write', 'create-writable', 'content-type', 'content-length']) {
  test(`failed video ${mode} cancels HTTP and permits another export`, async ({ page }) => {
    await withVideoServer(mode, async (origin, state) => {
      await page.goto(origin);
      await page.evaluate(failure => {
        window.videoTransferHints = [];
        window.videoWritableAborted = false;
        window.MaweInlineEdit = {};
        window.MaweBoot = {
          FILENAME_BASE: 'test',
          SERVER_CONFIG: {
            canGapRemovedVideoExport: true,
            gapRemovedVideoSourceName: 'source.mp4',
            gapRemovedVideoExportUrl: '/export',
            requestToken: 'fixture',
          },
        };
        window.MaweExportSrt = { gapRemovedExportContext: () => ({ intervals: [{ start: 0, end: 1000 }] }) };
        window.MaweHint = { flashHint: text => window.videoTransferHints.push(text) };
        window.MaweHost = {
          server: { fetch: (...args) => fetch(...args) },
          files: {
            hasSavePicker: () => true,
            pickSaveFile: async () => ({
              name: 'result.mp4',
              createWritable: async () => {
                if (failure === 'create-writable') throw new Error('Disk full before create');
                return {
                  write: async () => { throw new Error('Disk full during write'); },
                  abort: async () => { window.videoWritableAborted = true; },
                };
              },
            }),
          },
        };
      }, mode);
      await page.addScriptTag({ content: handler });
      await page.click('#download-gap-removed-video');
      await expect.poll(() => page.evaluate(() => window.videoTransferHints.some(text => text.includes('导出失败')))).toBe(true);
      const expectedError = mode === 'write' ? 'Disk full during write'
        : mode === 'create-writable' ? 'Disk full before create'
          : mode === 'content-type' ? '服务器返回的视频格式与源视频不一致'
            : '服务器返回的视频大小无效';
      expect(await page.evaluate(() => window.videoTransferHints.at(-1))).toContain(expectedError);
      await expect.poll(() => state().closed, {
        message: JSON.stringify({ server: state(), hints: await page.evaluate(() => window.videoTransferHints) }),
      }).toBe(1);
      expect(state().active).toBe(false);
      expect(await page.evaluate(() => window.videoWritableAborted)).toBe(mode === 'write');
      // Keep the browser alive: closing the tab would hide the missing cancel.
      const retryStatus = await page.evaluate(async () => {
        const response = await fetch('/export', { method: 'POST' });
        await response.body.cancel();
        return response.status;
      });
      expect(retryStatus).toBe(200);
      await expect.poll(() => state().closed).toBe(2);
    });
  });
}
