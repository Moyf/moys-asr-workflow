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
  tempDir = makeTempDir('keyboardtiming');
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

async function loadAttachedCues(page, autoSnapAdjacentCues) {
  if (typeof autoSnapAdjacentCues === 'boolean') {
    await page.addInitScript((enabled) => {
      localStorage.setItem(
        'moy.asr.editor.settings.v1',
        JSON.stringify({ autoSnapAdjacentCues: enabled }),
      );
    }, autoSnapAdjacentCues);
  }
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.segments.splice(
      0,
      DATA.segments.length,
      { start: 5000, end: 10000, text: 'First', items: [{ start: 5000, end: 10000, text: 'First' }] },
      { start: 10000, end: 18000, text: 'Second', items: [{ start: 10000, end: 18000, text: 'Second' }] },
      { start: 25000, end: 30000, text: 'Third', items: [{ start: 25000, end: 30000, text: 'Third' }] },
    );
    renderAll();
  });
}

function readTimings(page) {
  return page.evaluate(() => DATA.segments.map(({ start, end }) => ({ start, end })));
}

async function selectedCueIndex(page) {
  return page.locator('.cue.selected').getAttribute('data-idx');
}

async function stableVisibleBoundingBox(page, locator) {
  let box = null;
  await expect.poll(async () => {
    try {
      await locator.scrollIntoViewIfNeeded();
      box = await locator.boundingBox();
    } catch (_) {
      box = null;
    }
    if (!box || box.width <= 0 || box.height <= 0) return false;
    return page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit?.closest('.waveform-cue-block'));
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }).toBe(true);
  return box;
}

async function moveWaveformPointerToTime(page, blockLocator, timeMs) {
  const blockBox = await stableVisibleBoundingBox(page, blockLocator);
  const row = blockLocator.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " waveform-row ")][1]');
  const rowBox = await row.boundingBox();
  const rowStart = Number(await row.getAttribute('data-start-ms'));
  const rowEnd = Number(await row.getAttribute('data-end-ms'));
  expect(rowBox).not.toBeNull();
  expect(rowEnd).toBeGreaterThan(rowStart);
  const ratio = (timeMs - rowStart) / (rowEnd - rowStart);
  await page.mouse.move(
    rowBox.x + rowBox.width * Math.max(0, Math.min(1, ratio)),
    blockBox.y + blockBox.height / 2,
  );
}

test('WASD during playback follows the playhead instead of the last selected cue', async ({ page }) => {
  await loadAttachedCues(page);
  await page.evaluate(() => {
    DATA.segments[2].start = 100000;
    DATA.segments[2].end = 110000;
    DATA.segments[2].items = [{ start: 100000, end: 110000, text: 'Third' }];
    renderAll();
  });
  await page.locator('.cue[data-idx="0"]').click();
  await page.evaluate(() => { player.currentTime = 101; });
  await page.locator('#media-play-toggle').click();
  await expect(page.locator('#media-play-toggle')).toHaveText('⏸');

  await page.keyboard.press('a');
  await expect.poll(() => selectedCueIndex(page)).toBe('1');
  await expect.poll(() => page.evaluate(() => player.currentTime)).toBeLessThan(11);

  await page.locator('#media-play-toggle').click();
  await page.locator('.cue[data-idx="0"]').click();
  await page.evaluate(() => { player.currentTime = 20; });
  await page.locator('#media-play-toggle').click();
  await expect(page.locator('#media-play-toggle')).toHaveText('⏸');

  await page.keyboard.press('d');
  await expect.poll(() => selectedCueIndex(page)).toBe('2');
  await expect.poll(() => page.evaluate(() => player.currentTime)).toBeGreaterThan(24);
});

test('A/D at the outer cue boundaries still seeks the boundary cue', async ({ page }) => {
  await loadAttachedCues(page);

  await page.locator('.cue[data-idx="0"]').click();
  await page.evaluate(() => { player.currentTime = 20; });
  await page.keyboard.press('a');
  await expect.poll(() => page.evaluate(() => player.currentTime)).toBeLessThan(6);

  await page.locator('.cue[data-idx="2"]').click();
  await page.evaluate(() => { player.currentTime = 1; });
  await page.keyboard.press('d');
  await expect.poll(() => page.evaluate(() => player.currentTime)).toBeGreaterThan(24);
});

test('F seeks and plays a selected extension cue', async ({ page }) => {
  await loadAttachedCues(page);
  await page.evaluate(() => {
    DATA.multi_subtitle = {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1',
        role: 'extension',
        name: 'English',
        language: 'English',
        split_mode: 'word',
        segments: [{ id: 'extension-001', start: 12000, end: 16000, text: 'Extension' }],
      }],
      bindings: [],
    };
    renderAll({ waveform: 'full' });
  });

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"]').first();
  await expect(extensionBlock).toBeVisible();
  await extensionBlock.click();
  await page.evaluate(() => { player.currentTime = 1; });
  await page.keyboard.press('f');
  await page.waitForFunction(() => {
    const media = document.getElementById('player');
    return media.currentTime >= 12 && media.currentTime < 13 && !media.paused;
  });
});

test('selected arrow keys move cues, adjust boundaries, and honor the configured step', async ({ page }) => {
  await loadAttachedCues(page, true);
  await page.locator('#waveform-settings-toggle').click();
  const step = page.locator('#cue-move-step');
  await expect(step).toHaveValue('50');
  await step.fill('250');
  await step.press('Tab');
  await page.keyboard.press('Escape');
  await page.locator('.cue[data-idx="0"]').click();

  await page.keyboard.press('ArrowRight');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5250, end: 10250 },
    { start: 10250, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  // Alt leaves the following cue fixed while the selected cue moves away.
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10000 },
    { start: 10250, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
  // Moving back toward it still closes the gap, without moving the follower.
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5250, end: 10250 },
    { start: 10250, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  await page.keyboard.press('Control+ArrowLeft');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10250 },
    { start: 10250, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10500 },
    { start: 10500, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});

test('automatic adjacent snapping is on by default and Alt temporarily disables it', async ({ page }) => {
  await loadAttachedCues(page);
  await expect(page.locator('#auto-snap-adjacent-cues')).toBeChecked();
  await page.locator('.cue[data-idx="0"]').click();
  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10050 },
    { start: 10050, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  await page.keyboard.press('Alt+Control+Shift+ArrowLeft');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10000 },
    { start: 10050, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});

test('automatic adjacent snapping links shared-boundary dragging by default and Alt reverses it', async ({ page }) => {
  await loadAttachedCues(page);
  const dragSharedBoundary = async (altKey = false) => {
    const handle = page.locator('.waveform-cue-block[data-idx="0"] .waveform-cue-handle.right').first();
    const handleBox = await stableVisibleBoundingBox(page, handle);
    const row = handle.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " waveform-row ")][1]');
    const rowBox = await row.boundingBox();
    const rowStart = Number(await row.getAttribute('data-start-ms'));
    const rowEnd = Number(await row.getAttribute('data-end-ms'));
    expect(rowBox).not.toBeNull();
    expect(rowEnd).toBeGreaterThan(rowStart);
    const deltaMs = -500;
    const deltaX = (rowBox.width * deltaMs) / (rowEnd - rowStart);
    const startX = handleBox.x + handleBox.width / 2;
    const y = handleBox.y + handleBox.height / 2;
    if (altKey) await page.keyboard.down('Alt');
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
    await page.mouse.move(startX + deltaX, y, { steps: 5 });
    await page.mouse.up();
    if (altKey) await page.keyboard.up('Alt');
  };

  // 默认开启：共享边界拖动联动相邻字幕；拖动期间状态栏提示当前吸附模式。
  await dragSharedBoundary();
  await expect(page.locator('#waveform-status'))
    .toContainText('当前为相邻字幕自动吸附模式，按住 Alt 可以临时解除吸附');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9500 },
    { start: 9500, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  await page.evaluate(() => {
    DATA.segments[0].end = 10000;
    DATA.segments[1].start = 10000;
    renderAll();
  });
  // Alt 临时反转：只移动当前字幕的边界，相邻字幕保持不动。
  await dragSharedBoundary(true);
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9500 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});

test('an independent shared-boundary drag can reverse before release', async ({ page }) => {
  // 该测试验证“自动吸附关闭”时的独立拖动路径，显式关闭开关。
  await loadAttachedCues(page, false);
  const handle = page.locator('.waveform-cue-block[data-idx="0"] .waveform-cue-handle.right').first();
  const handleBox = await stableVisibleBoundingBox(page, handle);
  const row = handle.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " waveform-row ")][1]');
  const rowBox = await row.boundingBox();
  const rowStart = Number(await row.getAttribute('data-start-ms'));
  const rowEnd = Number(await row.getAttribute('data-end-ms'));
  expect(rowBox).not.toBeNull();
  expect(rowEnd).toBeGreaterThan(rowStart);

  const startX = handleBox.x + handleBox.width / 2;
  const y = handleBox.y + handleBox.height / 2;
  const deltaX = (rowBox.width * -500) / (rowEnd - rowStart);
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
  await page.mouse.move(startX + deltaX, y, { steps: 5 });
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).toBe(9500);

  // 回到按下时的共享边界；旧逻辑会把 9500 当成单向上限，无法回到 10000。
  await page.mouse.move(startX, y, { steps: 5 });
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).toBe(10000);
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10000 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  // 关闭自动吸附时按住 Alt：共享边界临时联动拖动，状态栏在「共享边界」
  // 文本旁提示未启用自动吸附及 Alt 临时启用方式。
  await page.keyboard.down('Alt');
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
  await page.mouse.move(startX + deltaX, y, { steps: 4 });
  await expect(page.locator('#waveform-status'))
    .toContainText('当前未启用相邻字幕自动吸附，按住 Alt 可以临时启用');
  await page.mouse.up();
  await page.keyboard.up('Alt');
});

test('explicit Shift snapping remains available when automatic adjacent snapping is off', async ({ page }) => {
  // Shift 贴合是显式命令；这里显式关闭自动吸附，验证其不受开关影响。
  await loadAttachedCues(page, false);
  await page.evaluate(() => {
    DATA.segments[0].end = 9000;
    DATA.segments[1].start = 10000;
    renderAll();
  });
  await page.locator('.cue[data-idx="1"]').click();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9000 },
    { start: 9000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});

test('Shift+arrow keys snap selected subtitle boundaries to neighbors', async ({ page }) => {
  await loadAttachedCues(page);
  await page.evaluate(() => {
    DATA.segments[0].end = 9000;
    DATA.segments[1].start = 10000;
    DATA.segments[1].end = 18000;
    DATA.segments[2].start = 20000;
    renderAll();
  });
  await page.locator('.cue[data-idx="1"]').click();

  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9000 },
    { start: 9000, end: 18000 },
    { start: 20000, end: 30000 },
  ]);

  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9000 },
    { start: 9000, end: 20000 },
    { start: 20000, end: 30000 },
  ]);
});

test('A/D adjusts a held subtitle block and a held shared boundary', async ({ page }) => {
  await loadAttachedCues(page, true);
  await page.locator('#waveform-settings-toggle').click();
  const step = page.locator('#cue-move-step');
  await step.fill('100');
  await step.press('Tab');
  await page.keyboard.press('Escape');

  const block = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await expect(block).toBeVisible();
  const blockBox = await stableVisibleBoundingBox(page, block);
  await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
  await page.mouse.down();
  await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
  await page.keyboard.press('d');
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5100, end: 10100 },
    { start: 10100, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  const boundary = page.locator('.waveform-cue-block[data-idx="0"] .waveform-cue-handle.right').first();
  await expect(boundary).toBeVisible();
  const boundaryBox = await stableVisibleBoundingBox(page, boundary);
  await page.mouse.move(boundaryBox.x + boundaryBox.width / 2, boundaryBox.y + boundaryBox.height / 2);
  await page.mouse.down();
  await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
  await page.keyboard.press('d');
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5100, end: 10200 },
    { start: 10200, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});

test('A also compresses an attached preceding cue', async ({ page }) => {
  await loadAttachedCues(page, true);
  await page.locator('#waveform-settings-toggle').click();
  const step = page.locator('#cue-move-step');
  await step.fill('100');
  await step.press('Tab');
  await page.keyboard.press('Escape');

  const block = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(block).toBeVisible();
  const blockBox = await stableVisibleBoundingBox(page, block);
  await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
  await page.mouse.down();
  await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
  await page.keyboard.press('a');
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9900 },
    { start: 9900, end: 17900 },
    { start: 25000, end: 30000 },
  ]);
});

test('Shift+A/D on a held subtitle snaps its outer boundaries to neighbors', async ({ page }) => {
  await loadAttachedCues(page);
  await page.evaluate(() => {
    DATA.segments[0].end = 9000;
    DATA.segments[1].start = 10000;
    DATA.segments[1].end = 18000;
    DATA.segments[2].start = 20000;
    renderAll();
  });
  await page.locator('#editor-settings-toggle').click();
  const block = page.locator('.waveform-cue-block[data-idx="1"]').first();
  await expect(block).toBeVisible();
  const blockBox = await stableVisibleBoundingBox(page, block);
  await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
  await page.mouse.down();
  await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
  await page.keyboard.press('Shift+a');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9000 },
    { start: 9000, end: 18000 },
    { start: 20000, end: 30000 },
  ]);
  await page.keyboard.press('Shift+d');
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9000 },
    { start: 9000, end: 20000 },
    { start: 20000, end: 30000 },
  ]);
});

test('Z/X place selected or pointer-hit subtitle boundaries at the waveform pointer', async ({ page }) => {
  await loadAttachedCues(page);
  const block = page.locator('.waveform-cue-block[data-idx="0"]').first();

  await page.locator('.cue[data-idx="0"]').click();
  await moveWaveformPointerToTime(page, block, 7000);
  await page.keyboard.press('z');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 7000, end: 10000 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  await moveWaveformPointerToTime(page, block, 9000);
  await page.keyboard.press('x');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 7000, end: 9000 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  await page.evaluate(() => clearSelection());
  await moveWaveformPointerToTime(page, block, 7500);
  await page.keyboard.press('z');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 7500, end: 9000 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);

  await moveWaveformPointerToTime(page, block, 8500);
  await page.keyboard.press('x');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 7500, end: 8500 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});
