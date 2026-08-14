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
  makeFirstCueWordSplittable,
  makeTempDir,
  disableOnboarding,
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

test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
});

test('jump target is shown for both jump behaviors and hidden for select-only', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  const behavior = page.locator('#click-behavior');
  const targetField = page.locator('#click-target-field');
  await expect(targetField).toBeVisible();
  await expect(page.locator('#click-target')).toHaveValue('pointer');

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

test('waveform cue double-click activates its subtitle editor while blank double-click still toggles playback', async ({ page }) => {
  await page.goto(server.url);
  const cue = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  await cue.scrollIntoViewIfNeeded();
  await cue.dblclick();
  await expect(page.locator('#cue-panel-target')).toHaveText('主字幕');
  expect(await page.locator('#player').evaluate((element) => element.paused)).toBe(true);

  const blankRow = page.locator('.waveform-row:not(:has(.waveform-cue-block))').first();
  const rowBox = await blankRow.boundingBox();
  if (!rowBox) throw new Error('波形行没有布局');
  await page.mouse.dblclick(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await expect.poll(() => page.locator('#player').evaluate((element) => element.paused)).toBe(false);
});

test('cue-panel Enter split falls back to a waveform split marker', async ({ page }) => {
  await page.goto(server.url);
  await makeFirstCueWordSplittable(page);
  await page.locator('.cue[data-idx="0"]').click();
  const panel = page.locator('#cue-panel-text');
  await expect(panel).toHaveValue('Alpha Bravo');
  await panel.focus();
  await panel.evaluate((element) => element.setSelectionRange(5, 5));
  await panel.press('Enter');

  await expect(page.locator('.waveform-split-flash.is-active')).toHaveCount(1);
  await expect(page.locator('.cue')).toHaveCount(7);
  await expect(page.locator('.cue-split-flash')).toHaveCount(0);
});

test('double-click places the inline caret at the pointer text position', async ({ page }) => {
  await page.goto(server.url);
  const cue = page.locator('.cue[data-idx="0"]');
  const text = cue.locator('.text');
  const point = await text.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 3);
    const rect = range.getBoundingClientRect();
    return { x: (rect.left + rect.right) / 2, y: rect.top + rect.height / 2 };
  });
  const expectedOffset = await page.evaluate(({ x, y }) => {
    const range = document.caretRangeFromPoint(x, y);
    return range?.startOffset ?? null;
  }, point);
  expect(expectedOffset).not.toBeNull();

  await page.mouse.dblclick(point.x, point.y);
  await expect(cue).toHaveClass(/editing/);
  const caret = await page.evaluate(() => {
    const selection = window.getSelection();
    return {
      collapsed: selection?.isCollapsed ?? false,
      offset: selection?.anchorOffset ?? null,
      text: selection?.anchorNode?.textContent ?? null,
    };
  });
  expect(caret.collapsed).toBe(true);
  expect(caret.text).toBe('Alpha');
  expect(caret.offset).toBe(expectedOffset);
});

test('current cue panel keeps the same height before and after selection', async ({ page }) => {
  // 高视口让 --layout-row-middle 的百分比下限超过面板内容高度，
  // 才能覆盖「选中后面板被拖到布局高度、空态又缩回内容高度」的跳变回归。
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(server.url);
  const panel = page.locator('#current-cue-panel');
  const before = await panel.evaluate((element) => element.getBoundingClientRect().height);

  await page.locator('.cue[data-idx="0"]').click();

  const after = await panel.evaluate((element) => element.getBoundingClientRect().height);
  expect(after).toBe(before);
});

test('dragging the panel divider resizes the panel and stays consistent across selection', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(server.url);
  const panel = page.locator('#current-cue-panel');
  const textarea = page.locator('#cue-panel-text');
  const measure = () => panel.evaluate((element) => element.getBoundingClientRect().height);
  const measureText = () => textarea.evaluate((element) => element.getBoundingClientRect().height);

  const panelBefore = await measure();
  const textBefore = await measureText();

  const resizer = page.locator('#layout-resizer-h2');
  const box = await resizer.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 100, { steps: 5 });
  await page.mouse.up();

  const panelAfter = await measure();
  expect(panelAfter).toBeGreaterThan(panelBefore + 50);
  // 文本域保持默认高度（不做自动增高）
  expect(await measureText()).toBe(textBefore);
  // 选中后面板高度与拖拽后的空态保持一致
  await page.locator('.cue[data-idx="0"]').click();
  expect(await measure()).toBe(panelAfter);
});

test('list context menu leads with text-position split', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#click-behavior').selectOption('select-only');
  await page.locator('.cue[data-idx="0"]').click({ button: 'right' });

  await expect(page.locator('#ctxmenu .item').first()).toContainText('按文字位置拆分');
});

test('Enter focuses the current subtitle editor after list or waveform clicks', async ({ page }) => {
  await page.goto(server.url);
  const cue = page.locator('.cue[data-idx="0"]');
  const panelText = page.locator('#cue-panel-text');
  await cue.click();
  // 最后点击在列表：即使鼠标已移出列表，Enter 仍聚焦当前字幕编辑区
  await page.locator('#media-controls').hover();
  await page.keyboard.press('Enter');
  await expect(cue).not.toHaveClass(/editing/);
  await expect(panelText).toBeFocused();
  await page.keyboard.press('Escape');

  // 最后点击在波形背景：仍聚焦当前字幕编辑区
  const rowBox = await page.locator('.waveform-row').nth(1).boundingBox();
  await page.mouse.click(rowBox.x + rowBox.width * 0.95, rowBox.y + rowBox.height / 2);
  // 空白处点击会清除选择；不经过列表重新选中第一条（区域仍停留在波形）
  await page.evaluate(() => selectOnly(0));
  await page.keyboard.press('Enter');
  await expect(cue).not.toHaveClass(/editing/);
  await expect(panelText).toBeFocused();
});

test('B splits at the pointer inside the cue list and at the playhead outside it', async ({ page }) => {
  await page.goto(server.url);
  await makeFirstCueWordSplittable(page);
  const cue = page.locator('.cue[data-idx="0"]');
  await cue.click();
  // 列表外：播放头位于空隙（20s）时不拆分
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 20;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await page.locator('#media-controls').hover();
  await page.keyboard.press('b');
  await expect(page.locator('.cue')).toHaveCount(6);

  // 列表外：播放头位于字幕内（5s）时按播放头拆分
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 5;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await page.keyboard.press('b');
  await expect(page.locator('.cue')).toHaveCount(7);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.cue')).toHaveCount(6);

  // 列表内悬停：按鼠标所指文字位置拆分
  const text = cue.locator('.text');
  const splitPoint = await text.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 6);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);
  await expect(page.locator('.cue-split-preview')).toHaveCount(1);
  const previewBox = await page.locator('.cue-split-preview').boundingBox();
  expect(previewBox).not.toBeNull();
  expect(Math.abs(previewBox.x + previewBox.width / 2 - splitPoint.x)).toBeLessThan(1.5);
  await page.keyboard.press('b');

  await expect(page.locator('.cue')).toHaveCount(7);
  await expect(page.locator('.cue .text').nth(0)).toHaveText('Alpha');
  await expect(page.locator('.cue .text').nth(1)).toHaveText('Bravo');
  await expect(page.locator('.cue-split-flash.is-active')).toHaveCount(1);
  await expect(page.locator('.cue-split-flash.is-active')).toHaveCount(0);
});

test('B flashes a yellow marker after splitting at the waveform pointer without a selection', async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => clearSelection());
  await expect(page.locator('.cue.selected')).toHaveCount(0);

  const waveformCue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await waveformCue.scrollIntoViewIfNeeded();
  const box = await waveformCue.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('b');

  await expect(page.locator('.waveform-split-flash.is-active')).toHaveCount(1);
  await expect(page.locator('.waveform-split-flash.is-active')).toHaveCount(0);
});

test('waveform hover mirrors the pointer position in the row', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').first();
  await row.scrollIntoViewIfNeeded();

  const rowBox = await row.boundingBox();
  expect(rowBox).not.toBeNull();

  const pointerX = rowBox.x + rowBox.width * 0.65;
  await page.mouse.move(pointerX, rowBox.y + rowBox.height / 2);

  const indicator = row.locator('.waveform-pointer-line');
  await expect(indicator).toBeVisible();
  const indicatorBox = await indicator.boundingBox();
  expect(indicatorBox).not.toBeNull();
  expect(Math.abs(indicatorBox.x + indicatorBox.width / 2 - pointerX)).toBeLessThan(1.5);

  await page.locator('#media-controls').hover();
  await expect(indicator).toBeHidden();
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

test('mouse-clicked utility buttons release focus for the space playback shortcut', async ({ page }) => {
  for (const id of ['help-toggle', 'editor-settings-toggle']) {
    await page.goto(server.url);
    await page.waitForFunction(() => {
      const player = document.getElementById('player');
      return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
    });
    await page.locator(`#${id}`).click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id || '')).not.toBe(id);
    await page.keyboard.press(' ');
    await page.waitForFunction(() => !document.getElementById('player').paused);
    await page.evaluate(() => document.getElementById('player').pause());
  }
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
