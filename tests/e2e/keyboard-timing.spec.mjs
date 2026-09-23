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

async function loadAttachedCues(page, autoSnapAdjacentCues, adjacentBoundaryMode) {
  if (typeof autoSnapAdjacentCues === 'boolean' || typeof adjacentBoundaryMode === 'string') {
    await page.addInitScript(({ autoSnap, boundaryMode }) => {
      const settings = {};
      if (typeof autoSnap === 'boolean') settings.autoSnapAdjacentCues = autoSnap;
      if (typeof boundaryMode === 'string') settings.adjacentBoundaryMode = boundaryMode;
      localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify(settings));
    }, { autoSnap: autoSnapAdjacentCues, boundaryMode: adjacentBoundaryMode });
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
  // 波形行有 1px 边框；指针→时间映射与覆盖层一致使用 content-box，
  // 这里同样按 clientLeft/clientWidth 定位，保证与实际渲染边界对齐。
  const content = await row.evaluate((element) => ({ clientLeft: element.clientLeft, clientWidth: element.clientWidth }));
  await page.mouse.move(
    rowBox.x + content.clientLeft + content.clientWidth * Math.max(0, Math.min(1, ratio)),
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

test('I/O seeks the current cue boundaries and stays paused', async ({ page }) => {
  await loadAttachedCues(page);
  await page.locator('.cue[data-idx="1"]').click();
  await page.evaluate(() => { player.currentTime = 1; });
  await page.locator('#media-play-toggle').click();
  await page.waitForFunction(() => !document.getElementById('player').paused);

  await page.keyboard.press('i');
  await page.waitForFunction(() => {
    const media = document.getElementById('player');
    return media.paused && media.currentTime >= 10 && media.currentTime < 10.1;
  });

  await page.keyboard.press('o');
  await page.waitForFunction(() => {
    const media = document.getElementById('player');
    return media.paused && media.currentTime >= 18 && media.currentTime < 18.1;
  });
});

test('selected arrow keys move cues, adjust boundaries, and honor the configured step', async ({ page }) => {
  await loadAttachedCues(page, true);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-general').click();
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
  // 传统模式：共享边界手柄的联动/独立由「自动吸附调整相邻字幕」开关决定。
  await loadAttachedCues(page, true, 'classic');
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

test('dual mode links both edges via the seam zone while side handles trim independently', async ({ page }) => {
  // 新默认（中缝联动）：贴合字幕对的中缝区负责联动拖动；相接侧手柄始终独立。
  await loadAttachedCues(page);
  const dragZoneBy = async (deltaMs) => {
    const zone = page.locator('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]');
    await expect(zone).toBeVisible();
    await expect(zone).toHaveClass(/at-row-end/);
    const zoneBox = await zone.boundingBox();
    const row = zone.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " waveform-row ")][1]');
    const rowBox = await row.boundingBox();
    const rowStart = Number(await row.getAttribute('data-start-ms'));
    const rowEnd = Number(await row.getAttribute('data-end-ms'));
    expect(zoneBox).not.toBeNull();
    expect(rowEnd).toBeGreaterThan(rowStart);
    const startX = zoneBox.x + zoneBox.width / 2;
    const y = zoneBox.y + zoneBox.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    // 普通中缝点击替换为前后两句（同一字幕可能跨行分片，用下标集合断言）。
    await expect.poll(() => page.evaluate(() => [
      ...new Set([...document.querySelectorAll('.waveform-cue-block.selected')]
        .map((block) => block.dataset.idx)),
    ].sort())).toEqual(['0', '1']);
    await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
    await page.mouse.move(startX + (rowBox.width * deltaMs) / (rowEnd - rowStart), y, { steps: 5 });
    await page.mouse.up();
  };

  // 行末中缝也可拖动，两侧边界一起联动，状态栏提示新模式。
  await page.locator('.cue[data-idx="2"]').click({ modifiers: ['Control'] });
  await dragZoneBy(-500);
  await expect(page.locator('#waveform-status'))
    .toContainText('中缝联动：中缝拖动两侧一起移动');
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

  // 单独拖动 A 的右手柄：只调整当前字幕，相邻字幕保持不动。
  const handle = page.locator('.waveform-cue-block[data-idx="0"] .waveform-cue-handle.right').first();
  const handleBox = await stableVisibleBoundingBox(page, handle);
  const row = handle.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " waveform-row ")][1]');
  const rowBox = await row.boundingBox();
  const rowStart = Number(await row.getAttribute('data-start-ms'));
  const rowEnd = Number(await row.getAttribute('data-end-ms'));
  const startX = handleBox.x + handleBox.width / 2;
  const y = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await expect(page.locator('#waveform-pane')).toHaveClass(/cue-drag-active/);
  await page.mouse.move(startX + (rowBox.width * -500) / (rowEnd - rowStart), y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9500 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});

test('shared seams align exactly, stay hidden across an 80ms gap, and use accent feedback', async ({ page }) => {
  await loadAttachedCues(page);
  const zone = page.locator('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]');
  await expect(zone).toBeVisible();
  await page.evaluate(() => {
    DATA.multi_subtitle = {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [
          { id: 'extension-001', start: 5000, end: 10000, text: 'First' },
          { id: 'extension-002', start: 10000, end: 18000, text: 'Second' },
        ],
      }],
      bindings: [],
    };
    DATA.overlay_track = {
      enabled: true,
      segments: [
        { id: 'overlay-001', start: 5000, end: 10000, text: 'First overlay' },
        { id: 'overlay-002', start: 10000, end: 18000, text: 'Second overlay' },
      ],
    };
    renderAll({ waveform: 'full' });
  });
  const firstPosition = await zone.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const rowRect = element.closest('.waveform-row').getBoundingClientRect();
    const row = element.closest('.waveform-row');
    const start = Number(row.dataset.startMs);
    const end = Number(row.dataset.endMs);
    const seam = Number(DATA.segments[0].end);
    const boundaryX = rowRect.left + row.clientLeft
      + ((seam - start) / (end - start)) * row.clientWidth;
    return {
      hitWidth: rect.width,
      atRowEnd: element.classList.contains('at-row-end'),
      visibleLineEdge: rect.right,
      boundaryX,
    };
  });
  expect(firstPosition.hitWidth).toBe(8);
  expect(firstPosition.atRowEnd).toBe(true);
  expect(Math.abs(firstPosition.visibleLineEdge - firstPosition.boundaryX)).toBeLessThan(1);

  const handleCursors = await page.evaluate(() => Object.fromEntries(
    ['main', 'extension', 'overlay'].map((track) => [track,
      [...document.querySelectorAll(`.waveform-cue-block[data-track="${track}"] .waveform-cue-handle`)]
        .map((handle) => ({ side: handle.classList.contains('left') ? 'left' : 'right', cursor: getComputedStyle(handle).cursor })),
    ]),
  ));
  for (const track of ['main', 'extension', 'overlay']) {
    expect(handleCursors[track].map(({ side }) => side)).toContain('left');
    expect(handleCursors[track].map(({ side }) => side)).toContain('right');
    expect(handleCursors[track].every(({ cursor }) => cursor === 'ew-resize')).toBe(true);
  }
  expect(await zone.evaluate((element) => getComputedStyle(element).cursor)).toContain('data:image/svg+xml');

  await zone.hover();
  await expect.poll(() => zone.evaluate((element) => getComputedStyle(element).opacity)).toBe('0.78');
  const themeFeedback = await page.evaluate(() => {
    const root = document.documentElement;
    const target = document.querySelector('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]');
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;visibility:hidden;background:var(--accent)';
    document.body.appendChild(probe);
    const result = [];
    for (const [theme, accent] of [['dark', 'blue'], ['light', 'orange'], ['dark', 'custom']]) {
      root.dataset.theme = theme;
      root.dataset.accent = accent;
      if (accent === 'custom') root.style.setProperty('--accent-custom', '#48b878');
      const pseudo = getComputedStyle(target, '::before');
      result.push({
        opacity: getComputedStyle(target).opacity,
        lineColor: pseudo.backgroundColor,
        accentColor: getComputedStyle(probe).backgroundColor,
      });
    }
    root.dataset.theme = 'dark';
    root.dataset.accent = 'blue';
    root.style.removeProperty('--accent-custom');
    probe.remove();
    return result;
  });
  for (const feedback of themeFeedback) {
    expect(feedback.opacity).toBe('0.78');
    expect(feedback.lineColor).toBe(feedback.accentColor);
  }

  await page.evaluate(() => {
    DATA.segments[0].end = 9000;
    DATA.segments[1].start = 9000;
    renderAll();
  });
  const inRowZone = page.locator('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]');
  await expect(inRowZone).toBeVisible();
  const inRowPosition = await inRowZone.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const rowRect = element.closest('.waveform-row').getBoundingClientRect();
    const row = element.closest('.waveform-row');
    const expected = rowRect.left + row.clientLeft + ((9000 - Number(row.dataset.startMs))
      / (Number(row.dataset.endMs) - Number(row.dataset.startMs))) * row.clientWidth;
    return Math.abs(rect.left + rect.width / 2 - expected);
  });
  expect(inRowPosition).toBeLessThan(1);

  await page.evaluate(() => {
    DATA.segments[1].start = 9080;
    renderAll();
  });
  await expect(page.locator('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]'))
    .toHaveCount(0);
});

test('crossing visible waveform rows keeps horizontal-only seam movement across row edges', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await loadAttachedCues(page);
  await page.evaluate(() => {
    const scroll = document.querySelector('.waveform-scroll');
    scroll.style.right = 'auto';
    scroll.style.width = '700px';
  });
  const seam = page.locator('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]');
  await expect(seam).toBeVisible();
  const seamBox = await seam.boundingBox();
  const firstRow = page.locator('.waveform-row[data-row-index="0"]');
  const secondRow = page.locator('.waveform-row[data-row-index="1"]');
  const firstBox = await firstRow.boundingBox();
  const secondBox = await secondRow.boundingBox();
  const viewportBox = await page.locator('.waveform-scroll').boundingBox();
  expect(seamBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(viewportBox).not.toBeNull();
  await page.mouse.move(seamBox.x + seamBox.width / 2, seamBox.y + seamBox.height / 2);
  await page.mouse.down();
  await expect(page.locator('#waveform-pane')).toHaveClass(/shared-boundary-drag-active/);
  await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toBeVisible();

  const startX = seamBox.x + seamBox.width / 2;
  await page.mouse.move(startX, secondBox.y + secondBox.height / 2, { steps: 8 });
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).toBe(10000);
  await expect.poll(() => page.locator(
    '.waveform-row[data-row-index="0"] .waveform-cue-boundary[data-left-idx="0"].dragging',
  ).count()).toBe(1);
  const rowOneCursorStyle = await page.locator('#waveform-pane').evaluate((pane) => getComputedStyle(pane).cursor);
  expect(rowOneCursorStyle).toContain('data:image/svg+xml');

  const targetX = Math.min(
    viewportBox.x + viewportBox.width + 400,
    page.viewportSize().width - 10,
  );
  expect(targetX).toBeLessThan(page.viewportSize().width);
  expect(targetX).toBeGreaterThan(firstBox.x + firstBox.width);
  await page.mouse.move(targetX, secondBox.y + secondBox.height / 2, { steps: 8 });
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).toBeGreaterThan(12000);
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).toBeLessThan(17900);
  await expect.poll(() => page.locator(
    '.waveform-row[data-row-index="1"] .waveform-cue-boundary[data-left-idx="0"].dragging',
  ).count()).toBe(1);
  const snappedLineError = await page.locator('.waveform-pointer-line.boundary-snapped').evaluate((marker) => {
    const row = marker.closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    const lineRect = marker.getBoundingClientRect();
    const rowStart = Number(row.dataset.startMs);
    const rowEnd = Number(row.dataset.endMs);
    const seamMs = Number(DATA.segments[0].end);
    const expectedX = rect.left + row.clientLeft
      + ((seamMs - rowStart) / (rowEnd - rowStart)) * row.clientWidth;
    return Math.abs(lineRect.left + lineRect.width / 2 - expectedX);
  });
  expect(snappedLineError).toBeLessThan(1);
  const dragStyles = await page.locator(
    '.waveform-row[data-row-index="1"] .waveform-cue-boundary[data-left-idx="0"]',
  ).evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    cursor: getComputedStyle(document.getElementById('waveform-pane')).cursor,
  }));
  expect(dragStyles.opacity).toBe('0.85');
  expect(dragStyles.cursor).toContain('data:image/svg+xml');

  const currentBoundary = await page.evaluate(() => DATA.segments[0].end);
  const rowGapY = (firstBox.y + firstBox.height + secondBox.y) / 2;
  if (secondBox.y > firstBox.y + firstBox.height) {
    await page.mouse.move(targetX, rowGapY);
    await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).toBe(currentBoundary);
  }

  await page.mouse.move(targetX, firstBox.y + firstBox.height / 2, { steps: 8 });
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).toBe(currentBoundary);
  await page.mouse.move(startX, firstBox.y + firstBox.height / 2, { steps: 8 });
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).toBe(10000);
  await page.mouse.up();
  await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toHaveCount(0);
  await expect(page.locator('.waveform-row[data-row-index="0"] .waveform-pointer-line:not([hidden])'))
    .toHaveCount(1);
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end === DATA.segments[1].start)).toBe(true);
});

test('moving a cue keeps tracking horizontal pointer deltas past its waveform row', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await loadAttachedCues(page);
  await page.evaluate(() => {
    const scroll = document.querySelector('.waveform-scroll');
    scroll.style.right = 'auto';
    scroll.style.width = '700px';
  });

  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="2"]').first();
  const blockBox = await stableVisibleBoundingBox(page, block);
  const row = block.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " waveform-row ")][1]');
  const rowBox = await row.boundingBox();
  const viewportBox = await page.locator('.waveform-scroll').boundingBox();
  expect(rowBox).not.toBeNull();
  expect(viewportBox).not.toBeNull();

  const startX = blockBox.x + blockBox.width / 2;
  const y = blockBox.y + blockBox.height / 2;
  const targetX = Math.min(
    viewportBox.x + viewportBox.width + 400,
    page.viewportSize().width - 10,
  );
  expect(targetX).toBeLessThan(page.viewportSize().width);
  expect(targetX).toBeGreaterThan(rowBox.x + rowBox.width);
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(targetX, y, { steps: 10 });
  await expect.poll(() => page.evaluate(() => DATA.segments[2].start)).toBeGreaterThan(30000);
  await page.mouse.up();
});

test('A/D on an independent right handle follows the effective end edge', async ({ page }) => {
  await loadAttachedCues(page, false, 'classic');
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-general').click();
  const step = page.locator('#cue-move-step');
  await step.fill('100');
  await step.press('Tab');
  await page.keyboard.press('Escape');

  const handle = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"] .waveform-cue-handle.right').first();
  const handleBox = await stableVisibleBoundingBox(page, handle);
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toBeVisible();
  await page.keyboard.press('a');
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).toBe(9900);

  const line = page.locator('.waveform-row[data-row-index="0"] .waveform-pointer-line.boundary-snapped');
  await expect(line).toBeVisible();
  const lineError = await line.evaluate((marker) => {
    const row = marker.closest('.waveform-row');
    const rowRect = row.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const rowStart = Number(row.dataset.startMs);
    const rowEnd = Number(row.dataset.endMs);
    const expectedX = rowRect.left + row.clientLeft
      + ((9900 - rowStart) / (rowEnd - rowStart)) * row.clientWidth;
    return Math.abs(markerRect.left + markerRect.width / 2 - expectedX);
  });
  expect(lineError).toBeLessThan(1);
  expect(await line.evaluate((marker) => getComputedStyle(marker).backgroundColor))
    .toBe(await page.locator('#waveform-pane').evaluate((pane) => {
      const probe = document.createElement('span');
      probe.style.background = 'var(--accent)';
      pane.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }));

  await page.mouse.up();
  await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toHaveCount(0);
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 9900 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
});

test('Escape and pointer cancellation restore the normal pointer line', async ({ page }) => {
  await loadAttachedCues(page);
  const dragSeam = async (targetMs) => {
    const seam = page.locator('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]');
    const box = await seam.boundingBox();
    const row = seam.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " waveform-row ")][1]');
    const rowBox = await row.boundingBox();
    const start = Number(await row.getAttribute('data-start-ms'));
    const end = Number(await row.getAttribute('data-end-ms'));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox.x + rowBox.width * ((targetMs - start) / (end - start)), box.y + box.height / 2, { steps: 5 });
    await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toBeVisible();
  };

  await dragSeam(9500);
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).not.toBe(10000);
  await page.keyboard.press('Escape');
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10000 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
  await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toHaveCount(0);
  await expect(page.locator('.waveform-row[data-row-index="0"] .waveform-pointer-line:not([hidden])'))
    .toHaveCount(1);
  await page.mouse.up();

  await page.evaluate(() => {
    window.__boundaryPointerId = 0;
    window.__boundaryPointerPosition = null;
    window.addEventListener('pointerdown', (event) => {
      window.__boundaryPointerId = event.pointerId;
    }, { capture: true, once: true });
    window.addEventListener('pointermove', (event) => {
      window.__boundaryPointerPosition = { clientX: event.clientX, clientY: event.clientY };
    }, { capture: true });
  });
  await dragSeam(9500);
  await expect.poll(() => page.evaluate(() => DATA.segments[0].end)).not.toBe(10000);
  await page.evaluate(() => {
    const point = window.__boundaryPointerPosition;
    window.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      pointerId: window.__boundaryPointerId,
      clientX: point.clientX,
      clientY: point.clientY,
    }));
  });
  await expect.poll(() => readTimings(page)).toEqual([
    { start: 5000, end: 10000 },
    { start: 10000, end: 18000 },
    { start: 25000, end: 30000 },
  ]);
  await expect(page.locator('.waveform-pointer-line.boundary-snapped')).toHaveCount(0);
  await expect(page.locator('.waveform-row[data-row-index="0"] .waveform-pointer-line:not([hidden])'))
    .toHaveCount(1);
  await page.mouse.up();
});

test('dual-mode extension seam replaces the existing selection with both adjacent cues', async ({ page }) => {
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
        segments: [
          { id: 'extension-001', start: 5000, end: 10000, text: 'First' },
          { id: 'extension-002', start: 10000, end: 18000, text: 'Second' },
          { id: 'extension-003', start: 25000, end: 30000, text: 'Third' },
        ],
      }],
      bindings: [],
    };
    renderAll({ waveform: 'full' });
  });

  const mainZone = page.locator('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]');
  const extensionZone = page.locator('.waveform-cue-boundary[data-track="extension"][data-left-idx="0"]');
  await expect(mainZone).toBeVisible();
  await expect(extensionZone).toBeVisible();
  const mainZoneBox = await mainZone.boundingBox();
  const extensionZoneBox = await extensionZone.boundingBox();
  if (!mainZoneBox || !extensionZoneBox) throw new Error('双语字幕中缝没有有效布局');
  expect(mainZoneBox.y).toBeLessThan(extensionZoneBox.y);

  await mainZone.click();
  await expect.poll(() => page.evaluate(() => ({
    main: [...document.querySelectorAll('.waveform-cue-block.selected[data-track="main"]')]
      .map((block) => block.dataset.idx).sort(),
    extension: [...document.querySelectorAll('.waveform-cue-block.selected[data-track="extension"]')]
      .map((block) => block.dataset.extIdx).sort(),
  }))).toEqual({ main: ['0', '1'], extension: [] });

  await page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="2"]').first()
    .click({ modifiers: ['Control'] });
  const zone = extensionZone;
  await expect(zone).toBeVisible();
  await zone.click();
  await expect.poll(() => page.evaluate(() => [
    ...new Set([...document.querySelectorAll('.waveform-cue-block.selected[data-track="extension"]')]
      .map((block) => block.dataset.extIdx)),
  ].sort())).toEqual(['0', '1']);
});

test('an independent shared-boundary drag can reverse before release', async ({ page }) => {
  // 该测试验证传统模式「自动吸附关闭」时的独立拖动路径，显式关闭开关。
  await loadAttachedCues(page, false, 'classic');
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
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-general').click();
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

  // 新模式（中缝联动）下，按住中缝拖动区再按 D：共享边界联动移动。
  const boundary = page.locator('.waveform-cue-boundary').first();
  await expect(boundary).toBeVisible();
  const boundaryBox = await boundary.boundingBox();
  expect(boundaryBox).not.toBeNull();
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
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-general').click();
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
  // 关闭设置窗口：浮动窗口悬浮在波形区上方，避免按住拖动被窗口拦截。
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
