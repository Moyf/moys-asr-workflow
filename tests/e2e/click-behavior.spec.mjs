// 「选中并跳转」单击行为回归：播放过程中点击字幕列表，
// 播放头必须跳到该条开头并继续播放（等价于 F 键操作）。
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('clickseek');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('list click with select-and-seek seeks to cue start and keeps playing', async ({ page }) => {
  await page.goto(server.url);
  // 通过设置 UI 的真实 change 事件切换到「选中并跳转」
  await page.evaluate(() => {
    const sel = document.getElementById('click-behavior');
    sel.value = 'select-and-seek';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });
  // 从 1s 开始播放，模拟「播放过程中点击」（空格键是真实用户手势，evaluate 直接 play() 会被自动播放策略拦截）
  await page.evaluate(() => { document.getElementById('player').currentTime = 1; });
  await page.keyboard.press(' ');
  await page.waitForFunction(() => !document.getElementById('player').paused);

  await page.locator('.cue[data-idx="4"]').click();

  // 普通单击有 220ms 双击判定延迟；寻址后播放继续，currentTime 会前进，给 1s 容差
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    const seg = DATA.segments[4];
    const delta = player.currentTime - seg.start / 1000;
    return delta > -0.1 && delta < 1;
  }, undefined, { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById('player').paused);
});

test('list click with select-and-seek seeks to cue start but stays paused', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    const sel = document.getElementById('click-behavior');
    sel.value = 'select-and-seek';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });
  // 暂停状态下点击：应跳转到句首且保持暂停（不主动开始播放）
  await page.evaluate(() => { document.getElementById('player').currentTime = 1; });

  await page.locator('.cue[data-idx="4"]').click();

  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    const seg = DATA.segments[4];
    return Math.abs(player.currentTime - seg.start / 1000) < 0.25;
  }, undefined, { timeout: 5000 });
  const paused = await page.evaluate(() => document.getElementById('player').paused);
  expect(paused).toBe(true);
});
