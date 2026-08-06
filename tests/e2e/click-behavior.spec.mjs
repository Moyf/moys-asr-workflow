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

test('jump target is shown for both jump behaviors and hidden for select-only', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  const behavior = page.locator('#click-behavior');
  const targetField = page.locator('#click-target-field');
  await expect(targetField).toBeVisible();
  await expect(page.locator('#click-target')).toHaveValue('cue-start');

  await behavior.selectOption('select-only');
  await expect(targetField).toBeHidden();

  await behavior.selectOption('select-and-play');
  await expect(targetField).toBeVisible();
  await expect(behavior).toHaveValue('select-and-play');
});

test('context menu closes on pointerdown over blank waveform', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    document.getElementById('waveform-scroll').scrollTop = 1 * (120 + 10);
  });

  const cue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await expect(cue).toBeVisible();
  await cue.click({ button: 'right' });
  const contextMenu = page.locator('#ctxmenu');
  await expect(contextMenu).toHaveClass(/show/);

  const row = page.locator('.waveform-row[data-row-index="1"]');
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const blankX = box.x + box.width * 0.95;
  const blankY = box.y + box.height / 2;
  await page.mouse.move(blankX, blankY);
  await page.mouse.down();
  await expect(contextMenu).not.toHaveClass(/show/);
  await page.mouse.up();
});

test('list click auto-scroll can be disabled without disabling seek', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  const autoScroll = page.locator('#cue-list-auto-scroll-on-click');
  await expect(autoScroll).toBeChecked();
  await autoScroll.uncheck();

  await page.evaluate(() => {
    DATA.segments.push(...Array.from({ length: 34 }, (_, offset) => {
      const index = DATA.segments.length + offset;
      const start = index * 5000;
      return { start, end: start + 1000, text: `Extra ${index}`, items: [] };
    }));
    renderAll();
    document.getElementById('cues-container').scrollTop = 0;
  });
  const target = page.locator('.cue[data-idx="30"]');
  await expect(target).toHaveCount(1);
  await page.evaluate(() => {
    const cue = document.querySelector('.cue[data-idx="30"]');
    cue.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, buttons: 1, pointerId: 1,
    }));
    cue.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
  await expect(target).toHaveClass(/selected/);
  await expect.poll(() => page.evaluate(() => document.getElementById('cues-container').scrollTop)).toBe(0);
  await expect.poll(() => page.evaluate(() => document.getElementById('player').currentTime)).toBeGreaterThan(140);
});

test('default list click keeps a cue already in the middle in place', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.segments.push(...Array.from({ length: 34 }, (_, offset) => {
      const index = DATA.segments.length + offset;
      const start = index * 5000;
      return { start, end: start + 1000, text: `Extra ${index}`, items: [] };
    }));
    renderAll();
    const list = document.getElementById('cues-container');
    const cue = document.querySelector('.cue[data-idx="30"]');
    list.scrollTop = Math.max(0, cue.offsetTop - list.clientHeight / 2 + cue.offsetHeight / 2);
  });
  const before = await page.evaluate(() => document.getElementById('cues-container').scrollTop);
  await page.evaluate(() => {
    const cue = document.querySelector('.cue[data-idx="30"]');
    cue.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, buttons: 1, pointerId: 1,
    }));
    cue.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
  await expect(page.locator('.cue[data-idx="30"]')).toHaveClass(/selected/);
  await expect.poll(() => page.evaluate(() => document.getElementById('cues-container').scrollTop)).toBe(before);
});

test('default list click selects and seeks to cue start while keeping playback', async ({ page }) => {
  await page.goto(server.url);
  await expect(page.locator('#click-behavior')).toHaveValue('select-and-seek');
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });
  // 从 1s 开始播放，模拟「播放过程中点击」（空格键是真实用户手势，evaluate 直接 play() 会被自动播放策略拦截）
  await page.evaluate(() => { document.getElementById('player').currentTime = 1; });
  await page.keyboard.press(' ');
  await page.waitForFunction(() => !document.getElementById('player').paused);

  await page.locator('.cue[data-idx="4"]').click();

  // 列表单击应立即选中；寻址后播放继续，currentTime 会前进，给 1s 容差
  await expect(page.locator('.cue[data-idx="4"]')).toHaveClass(/selected/, { timeout: 150 });
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    const seg = DATA.segments[4];
    const delta = player.currentTime - seg.start / 1000;
    return delta > -0.1 && delta < 1;
  }, undefined, { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById('player').paused);
});

test('list cue selects on pointerdown and double-click still enters edit', async ({ page }) => {
  await page.goto(server.url);
  const cue = page.locator('.cue[data-idx="4"]');
  await cue.scrollIntoViewIfNeeded();
  const box = await cue.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(cue).toHaveClass(/selected/, { timeout: 150 });
  await page.mouse.up();

  await cue.dblclick();
  await expect(cue).toHaveClass(/editing/);
});

test('current cue panel keeps the same height before and after selection', async ({ page }) => {
  await page.goto(server.url);
  const panel = page.locator('#current-cue-panel');
  const before = await panel.evaluate((element) => element.getBoundingClientRect().height);

  await page.locator('.cue[data-idx="0"]').click();

  const after = await panel.evaluate((element) => element.getBoundingClientRect().height);
  expect(after).toBe(before);
});

test('list context menu leads with text-position split', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#click-behavior').selectOption('select-only');
  await page.locator('.cue[data-idx="0"]').click({ button: 'right' });

  await expect(page.locator('#ctxmenu .item').first()).toContainText('按文字位置拆分');
});

test('Enter starts inline editing only while the selected cue list is hovered', async ({ page }) => {
  await page.goto(server.url);
  const cue = page.locator('.cue[data-idx="0"]');
  await cue.click();
  await page.locator('#media-controls').hover();
  await page.keyboard.press('Enter');
  await expect(cue).not.toHaveClass(/editing/);

  await cue.hover();
  await page.keyboard.press('Enter');

  await expect(cue).toHaveClass(/editing/);
  await expect(page.locator('#cue-panel-text')).not.toBeFocused();
});

test('B splits the selected cue at the pointer only while the cue list is hovered', async ({ page }) => {
  await page.goto(server.url);
  const cue = page.locator('.cue[data-idx="0"]');
  await cue.click();
  await page.locator('#media-controls').hover();
  await page.keyboard.press('b');
  await expect(page.locator('.cue')).toHaveCount(6);

  const text = cue.locator('.text');
  const splitPoint = await text.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 2);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);
  await page.keyboard.press('b');

  await expect(page.locator('.cue')).toHaveCount(7);
  await expect(page.locator('.cue .text').nth(0)).not.toHaveText('Alpha');
});

test('space owns playback in media controls but remains text input in the cue editor', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });

  await page.locator('#media-play-toggle').focus();
  await page.keyboard.press(' ');
  await page.waitForFunction(() => !document.getElementById('player').paused);

  await page.evaluate(() => document.getElementById('player').pause());
  await page.locator('#media-seek').focus();
  await page.keyboard.press(' ');
  await page.waitForFunction(() => !document.getElementById('player').paused);

  await page.evaluate(() => document.getElementById('player').pause());
  const cuePanelText = page.locator('#cue-panel-text');
  await page.locator('.cue[data-idx="0"]').click();
  await expect(cuePanelText).toBeEnabled();
  await cuePanelText.fill('hello');
  await cuePanelText.press(' ');
  await expect(cuePanelText).toHaveValue('hello ');
  await expect.poll(() => page.evaluate(() => document.getElementById('player').paused)).toBe(true);
});

test('left and right arrows seek like the media step buttons', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.pause();
    player.currentTime = 10;
  });

  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => page.evaluate(() => document.getElementById('player').currentTime)).toBeCloseTo(5, 1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => document.getElementById('player').currentTime)).toBeCloseTo(10, 1);
  await expect.poll(() => page.evaluate(() => document.getElementById('player').paused)).toBe(true);
});

test('list click with select-only selects without seeking', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    const sel = document.getElementById('click-behavior');
    sel.value = 'select-only';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });
  await page.evaluate(() => { document.getElementById('player').currentTime = 1; });

  await page.locator('.cue[data-idx="4"]').click();

  await expect(page.locator('.cue[data-idx="4"]')).toHaveClass(/selected/);
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => {
    const player = document.getElementById('player');
    return { currentTime: player.currentTime, paused: player.paused };
  });
  expect(state.currentTime).toBeLessThan(2);
  expect(state.paused).toBe(true);
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

test('list click with select-and-play seeks to cue start and starts playback', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => {
    const sel = document.getElementById('click-behavior');
    sel.value = 'select-and-play';
    sel.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
  });
  await page.evaluate(() => { document.getElementById('player').currentTime = 1; });

  await page.locator('.cue[data-idx="4"]').click();

  await page.waitForFunction(() => {
    const player = document.getElementById('player');
    const seg = DATA.segments[4];
    return Math.abs(player.currentTime - seg.start / 1000) < 0.5 && !player.paused;
  }, undefined, { timeout: 5000 });
});
