// 服务器接管回归：空白服务器里打开/拖入工程时，服务器应按工程记录的媒体
// 绝对路径定位同目录同名工程并接管——媒体自动加载、保存按钮可用、
// Ctrl(Cmd)+S 直接写回工程文件；内容不一致的同名文件不得掉包接管。
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateWaveformPayload,
  generateWav,
  makeTempDir,
  startBlankServer,
  testSegments,
} from './helpers.mjs';

let tempDir;
let server;
let projectPath;
let mediaPath;

test.beforeAll(async () => {
  tempDir = makeTempDir('attach');
  mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, 5);
  // 工程必须记录媒体的绝对路径，服务器才能按它定位同目录同名工程。
  const project = {
    media: mediaPath,
    segments: testSegments(),
    waveform: generateWaveformPayload(DURATION_MS),
  };
  writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf-8');
  server = await startBlankServer(await findFreePort(), join(tempDir, '.settings'));
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

function dropProject(page, name, content) {
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  return page.evaluateHandle(({ base64: data, name: fileName }) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    dt.items.add(new File([bytes], fileName, { type: 'application/json' }));
    return dt;
  }, { base64, name }).then((dataTransfer) => page.dispatchEvent('body', 'drop', { dataTransfer }));
}

// 先跑掉包拒绝：此时服务器仍是空白状态，保存按钮必须保持禁用。
test('a same-named project with different content is not swapped in', async ({ page }) => {
  await page.goto(server.url);
  const tampered = JSON.parse(readFileSync(projectPath, 'utf-8'));
  tampered.segments = [{ start: 0, end: 1000, text: '不是磁盘上的内容', items: [] }];
  await dropProject(page, 'project.json', JSON.stringify(tampered));

  // 接管被拒绝：回退为手动选择媒体，保存保持禁用。
  await expect(page.locator('#project-media-modal')).toHaveClass(/show/);
  await expect(page.locator('#save-project')).toBeDisabled();
});

test('dropping a project lets the blank server take over media loading and saving', async ({ page }) => {
  await page.goto(server.url);
  await dropProject(page, 'project.json', readFileSync(projectPath, 'utf-8'));

  // 接管成功：整页刷新为服务器渲染状态，媒体与保存同时恢复。
  await expect(page.locator('#media-name')).toHaveText('synthetic.wav');
  await expect(page.locator('#project-media-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#save-project')).toBeEnabled();
  const playerSrc = await page.evaluate(() => document.getElementById('player').currentSrc);
  expect(playerSrc).toContain('/media');

  await page.evaluate(() => {
    DATA.segments[0].text = 'AttachedSave';
    DATA.segments[0]._dirty = true;
  });
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFileSync(projectPath, 'utf-8')).toContain('AttachedSave');
});
