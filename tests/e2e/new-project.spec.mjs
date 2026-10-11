// 方案 A（浏览器句柄保存）回归：新建工程走浏览器 showSaveFilePicker，
// 页面持有 FileSystemFileHandle；后续 Ctrl(Cmd)+S / 自动保存 / 导入保存
// 都写回同一句柄。服务器不再参与创建，也不得把浏览器工程写进服务器
// 绑定的旧工程文件。
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  findFreePort,
  buildPortableBlankEditor,
  generateWav,
  makeTempDir,
  startStaticServer,
} from './helpers.mjs';

let tempDir;
let server;       // 便携版（SERVER_CONFIG = null）
let blankServer;  // 服务器空白页形态（saveUrl 存在，canSave=false）
let boundServer;  // 服务器已绑定工程形态（saveUrl + canSave=true）
let mediaPath;

test.beforeAll(async () => {
  tempDir = makeTempDir('new-project');
  mediaPath = generateWav(join(tempDir, 'clip.wav'), 0.25);
  const portablePath = buildPortableBlankEditor(join(tempDir, 'blank.html'));
  server = await startStaticServer(portablePath, await findFreePort());
  const makeLocalhost = async (name, config) => {
    const path = join(tempDir, name);
    let html = readFileSync(portablePath, 'utf8');
    // The editor is bundled and minified, so the source-level const name is
    // no longer present. Resolve the captured variable through the boot
    // export and replace its adjacent null initializer in the same IIFE.
    const serverConfig = html.match(/SERVER_CONFIG:([A-Za-z_$][\w$]*)/);
    if (!serverConfig) throw new Error('Could not locate the bundled server config export');
    const initializer = `${serverConfig[1]}=null,`;
    const initializerIndex = html.lastIndexOf(initializer, serverConfig.index);
    if (initializerIndex < 0) throw new Error('Could not locate the bundled server config initializer');
    html = `${html.slice(0, initializerIndex)}${serverConfig[1]}=${config},${html.slice(initializerIndex + initializer.length)}`;
    writeFileSync(path, html);
    return startStaticServer(path, await findFreePort());
  };
  blankServer = await makeLocalhost(
    'localhost-blank.html',
    '{ "saveUrl": "/api/project", "requestToken": "request-token", "canSave": false }',
  );
  boundServer = await makeLocalhost(
    'localhost-bound.html',
    '{ "saveUrl": "/api/project", "requestToken": "request-token", "canSave": true, "canGapRemovedVideoExport": true, "gapRemovedVideoExportUrl": "/api/exports/gap-removed-video", "gapRemovedVideoSourceName": "old.mp4" }',
  );
});

test.afterAll(async () => {
  await server?.stop();
  await blankServer?.stop();
  await boundServer?.stop();
  cleanupTempDir(tempDir);
});

// 模拟浏览器保存对话框：句柄名默认取建议文件名，记录每次写回的内容。
async function installPicker(page) {
  await page.addInitScript(() => {
    window.__pickerCalls = 0;
    window.__handleWrites = [];
    window.showSaveFilePicker = async (options) => {
      window.__pickerCalls += 1;
      if (window.__pickerMode === 'cancel') {
        window.__pickerMode = null;
        throw new DOMException('cancelled', 'AbortError');
      }
      return {
        name: options?.suggestedName || 'untitled.mosp',
        async createWritable() {
          return {
            async write(blob) { window.__handleWrites.push(JSON.parse(await blob.text())); },
            async close() {},
          };
        },
      };
    };
  });
}

test('New Project binds a browser handle and later saves write the same file', async ({ page }) => {
  await installPicker(page);
  await page.goto(server.url);
  await page.evaluate(() => MaweBoot.DATA.segments.push({ start: 0, end: 1000, text: 'old' }));

  await page.locator('#new-project').click();

  await expect(page.locator('#json-name')).toHaveText('untitled.mosp');
  // 便携版最初隐藏保存控件；句柄绑定后出现并可用。
  await expect(page.locator('#save-project')).toBeVisible();
  await expect(page.locator('#save-project')).toBeEnabled();
  expect(await page.evaluate(() => MaweBoot.DATA.segments)).toEqual([]);
  expect(await page.evaluate(() => window.__handleWrites)).toHaveLength(1);
  expect((await page.evaluate(() => window.__handleWrites[0])).segments).toEqual([]);

  // 编辑后 Ctrl+S 必须写回同一个句柄文件（方案 A 的核心承诺）。
  await page.evaluate(() => MaweBoot.DATA.segments.push({ start: 0, end: 500, text: 'after', _dirty: true }));
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__handleWrites.length)).toBe(2);
  const secondWrite = await page.evaluate(() => window.__handleWrites[1]);
  expect(secondWrite.segments.map((segment) => segment.text)).toEqual(['after']);
});

test('server-bound page stops writing the old server project after browser New Project', async ({ page }) => {
  await installPicker(page);
  const apiSaves = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/project')) {
      apiSaves.push(request.url());
    }
  });
  await page.goto(boundServer.url);
  await expect(page.locator('#save-project')).toBeEnabled();

  await page.locator('#new-project').click();

  await expect(page.locator('#json-name')).toHaveText('untitled.mosp');
  await expect(page.locator('#save-project')).toBeEnabled();
  expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canSave)).toBe(false);

  await page.evaluate(() => MaweBoot.DATA.segments.push({ start: 0, end: 500, text: 'handle-save', _dirty: true }));
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.__handleWrites.length)).toBe(2);
  expect((await page.evaluate(() => window.__handleWrites[1])).segments[0].text).toBe('handle-save');
  // 服务器绑定的旧工程一次都不能被写。
  expect(apiSaves).toEqual([]);
});

test('opening a browser project detaches the previous server-bound video export', async ({ page }) => {
  await page.addInitScript(() => {
    window.__savePickerCalls = 0;
    window.showSaveFilePicker = async () => {
      window.__savePickerCalls += 1;
      return { name: 'unexpected.mp4' };
    };
  });
  const exportRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/exports/gap-removed-video')) exportRequests.push(request.url());
  });
  await page.goto(boundServer.url);
  expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport)).toBe(true);

  await page.locator('#open-project-file').setInputFiles({
    name: 'browser-project.mosp',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ media: '', segments: [{ start: 0, end: 1000, text: 'Browser project' }] })),
  });

  await expect(page.locator('#json-name')).toHaveText('browser-project.mosp');
  expect(await page.evaluate(() => ({
    canSave: MaweBoot.SERVER_CONFIG.canSave,
    canExportVideo: MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport,
    sourceName: MaweBoot.SERVER_CONFIG.gapRemovedVideoSourceName,
  }))).toEqual({ canSave: false, canExportVideo: false, sourceName: null });
  await page.evaluate(() => document.getElementById('download-gap-removed-video').click());
  expect(await page.evaluate(() => window.__savePickerCalls)).toBe(0);
  expect(exportRequests).toEqual([]);
});

test('replacing media detaches the previous server-bound video export', async ({ page }) => {
  await page.addInitScript(() => {
    window.__savePickerCalls = 0;
    window.showSaveFilePicker = async () => {
      window.__savePickerCalls += 1;
      return { name: 'unexpected.mp4' };
    };
  });
  const exportRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/exports/gap-removed-video')) exportRequests.push(request.url());
  });
  await page.goto(boundServer.url);
  expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport)).toBe(true);

  await page.locator('#load-media-file').setInputFiles(mediaPath);

  await expect(page.locator('#media-name')).toHaveText('clip.wav');
  expect(await page.evaluate(() => ({
    canExportVideo: MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport,
    sourceName: MaweBoot.SERVER_CONFIG.gapRemovedVideoSourceName,
  }))).toEqual({ canExportVideo: false, sourceName: null });
  await page.evaluate(() => document.getElementById('download-gap-removed-video').click());
  expect(await page.evaluate(() => window.__savePickerCalls)).toBe(0);
  expect(exportRequests).toEqual([]);
});

test('picker cancel preserves the current project and keeps save disabled', async ({ page }) => {
  await installPicker(page);
  await page.goto(blankServer.url);
  await page.evaluate(() => MaweBoot.DATA.segments.push({ start: 0, end: 1000, text: 'keep' }));
  await page.evaluate(() => { window.__pickerMode = 'cancel'; });

  await page.locator('#new-project').click();

  expect(await page.evaluate(() => MaweBoot.DATA.segments.map((segment) => segment.text))).toEqual(['keep']);
  await expect(page.locator('#save-project')).toBeDisabled();
  expect(await page.evaluate(() => window.__handleWrites)).toEqual([]);
});

test('English locale translates the New Project confirmation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await installPicker(page);
  await page.goto(blankServer.url);
  await page.evaluate(() => {
    MaweBoot.DATA.segments.push({ start: 0, end: 1000, text: 'dirty', _dirty: true });
  });
  const dialogMessage = new Promise((resolve) => {
    page.once('dialog', async (dialog) => {
      resolve(dialog.message());
      await dialog.dismiss();
    });
  });

  await page.locator('#new-project').click();

  expect(await dialogMessage).toBe('There are unsaved changes. Create a new project and discard them?');
  expect(await page.evaluate(() => window.__pickerCalls)).toBe(0);
});

test('SRT import creates its checkpoint before mutation and saves imported state to the handle', async ({ page }) => {
  await installPicker(page);
  await page.goto(blankServer.url);

  await page.locator('#load-srt-file').setInputFiles({
    name: 'clip.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nImported\n'),
  });

  await expect.poll(() => page.evaluate(() => window.__handleWrites.length)).toBe(2);
  const firstWrite = await page.evaluate(() => window.__handleWrites[0]);
  const secondWrite = await page.evaluate(() => window.__handleWrites[1]);
  expect(firstWrite.segments).toEqual([]);
  expect(firstWrite.media).toBe('');
  expect(secondWrite.segments.map((segment) => segment.text)).toEqual(['Imported']);
  expect(await page.evaluate(() => MaweBoot.DATA.segments.map((segment) => segment.text))).toEqual(['Imported']);
  await expect(page.locator('#json-name')).toHaveText('clip.mosp');
});

test('media import creates its checkpoint before mutation and saves imported state to the handle', async ({ page }) => {
  await installPicker(page);
  await page.goto(blankServer.url);

  await page.locator('#load-media-file').setInputFiles(mediaPath);

  await expect.poll(() => page.evaluate(() => window.__handleWrites.length)).toBe(2);
  const firstWrite = await page.evaluate(() => window.__handleWrites[0]);
  const secondWrite = await page.evaluate(() => window.__handleWrites[1]);
  expect(firstWrite.media).toBe('');
  expect(secondWrite.media).toBe('clip.wav');
  expect(await page.evaluate(() => MaweBoot.DATA.media)).toBe('clip.wav');
  await expect(page.locator('#media-name')).toHaveText('clip.wav');
});

test('project open bypasses checkpoint creation', async ({ page }) => {
  await installPicker(page);
  await page.goto(blankServer.url);

  await page.locator('#open-project-file').setInputFiles({
    name: 'existing.mosp',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ media: '', segments: [{ start: 0, end: 1000, text: 'Existing' }] })),
  });

  expect(await page.evaluate(() => window.__pickerCalls)).toBe(0);
  expect(await page.evaluate(() => MaweBoot.DATA.segments.map((segment) => segment.text))).toEqual(['Existing']);
});
