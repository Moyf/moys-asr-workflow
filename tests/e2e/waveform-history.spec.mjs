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
  tempDir = makeTempDir('history');
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
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
  });
});

test('undoing a waveform-created subtitle keeps redo available', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').filter({ has: page.locator('[data-idx="0"]') }).first();
  await expect(row).toBeVisible();

  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width * 0.9, box.y + 20, { button: 'right' });
  await page.locator('#ctxmenu .item', { hasText: '创建字幕' }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);

  await page.getByRole('button', { name: /撤销/ }).click();

  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);
  await expect(page.getByRole('button', { name: /重做/ })).toBeEnabled();
  await page.getByRole('button', { name: /重做/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
});

test('waveform background split supports undo and redo', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').filter({ has: page.locator('[data-idx="0"]') }).first();
  await expect(row).toBeVisible();

  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width * 0.4, box.y + 20, { button: 'right' });
  const splitItem = page.locator('#ctxmenu .item', { hasText: '按音频位置拆分当前字幕' });
  await expect(splitItem).toBeEnabled();
  await splitItem.click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect.poll(() => page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => segment.text))).toEqual([
    'Al',
    'pha',
  ]);

  await page.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(6);
  await expect.poll(() => page.evaluate(() => DATA.segments[0].text)).toBe('Alpha');
  await expect(page.getByRole('button', { name: /重做/ })).toBeEnabled();

  await page.getByRole('button', { name: /重做/ }).click();
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(7);
  await expect.poll(() => page.evaluate(() => DATA.segments.slice(0, 2).map((segment) => segment.text))).toEqual([
    'Al',
    'pha',
  ]);
});

test('current-cue text keeps the list and waveform labels in sync through undo and redo', async ({ page }) => {
  await page.goto(server.url);

  const waveformCue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  const waveformLabel = waveformCue.locator('.waveform-cue-label');
  const listText = page.locator('.cue[data-idx="0"] .text');
  const panelText = page.locator('#cue-panel-text');
  const undo = page.getByRole('button', { name: /撤销/ });
  const redo = page.getByRole('button', { name: /重做/ });

  await waveformCue.click();
  await expect(panelText).toHaveValue('Alpha');
  await expect(listText).toHaveText('Alpha');
  await expect(waveformLabel).toHaveText('Alpha');

  await panelText.fill('Alpha revised');
  await expect(listText).toHaveText('Alpha revised');
  await expect(waveformLabel).toHaveText('Alpha revised');

  await panelText.blur();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(listText).toHaveText('Alpha');
  await expect(waveformLabel).toHaveText('Alpha');
  await expect(redo).toBeEnabled();

  await redo.click();
  await expect(listText).toHaveText('Alpha revised');
  await expect(waveformLabel).toHaveText('Alpha revised');
});

test('B splits the selected subtitle under the cue-list pointer and supports undo and redo', async ({ page }) => {
  await page.goto(server.url);
  const text = page.locator('.cue[data-idx="0"] .text');
  await page.locator('.cue[data-idx="0"]').click();
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
  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  await expect(page.locator('.cue .text').nth(0)).toHaveText('Al');
  await expect(page.locator('.cue .text').nth(1)).toHaveText('pha');

  await page.getByRole('button', { name: /撤销/ }).click();
  await expect.poll(() => page.locator('.cue').count()).toBe(6);
  await expect(page.locator('.cue .text').first()).toHaveText('Alpha');

  await page.getByRole('button', { name: /重做/ }).click();
  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  await expect(page.locator('.cue .text').nth(0)).toHaveText('Al');
  await expect(page.locator('.cue .text').nth(1)).toHaveText('pha');
});

test('B split makes the selected latter half the Shift+click anchor', async ({ page }) => {
  await page.goto(server.url);
  const cues = page.locator('.cue');

  await cues.nth(0).click();
  const splitPoint = await cues.nth(0).locator('.text').evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 2);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);
  await page.keyboard.press('b');

  await expect.poll(() => page.locator('.cue').count()).toBe(7);
  await expect(page.locator('.cue[data-idx="1"]')).toHaveClass(/selected/);

  await page.locator('.cue[data-idx="3"]').click({ modifiers: ['Shift'] });
  await expect.poll(() => page.locator('.cue.selected').evaluateAll(
    (elements) => elements.map((element) => Number(element.dataset.idx)),
  )).toEqual([1, 2, 3]);
});

test('waveform navigation keeps a cue row in the comfort zone', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#waveform-seconds-per-row').selectOption('30');
  await page.locator('#waveform-row-height').selectOption('64');

  // 让下一条字幕所在行处于舒适区但不要正好居中，验证 A/D 不会强制重定位。
  await page.locator('.cue[data-idx="1"]').click();
  const before = await page.evaluate(() => {
    const scroll = document.getElementById('waveform-scroll');
    const rowIndex = Math.floor(DATA.segments[2].start / (30 * 1000));
    const stride = 64 + 10;
    const comfortInset = Math.min(120, Math.max(48, scroll.clientHeight * 0.2));
    scroll.scrollTop = Math.max(0, rowIndex * stride - comfortInset - 8);
    const rowTop = rowIndex * stride - scroll.scrollTop;
    return {
      scrollTop: scroll.scrollTop,
      rowInComfortZone: rowTop >= comfortInset
        && rowTop + 64 <= scroll.clientHeight - comfortInset,
    };
  });
  expect(before.rowInComfortZone).toBe(true);
  await page.evaluate(() => {
    const scroll = document.getElementById('waveform-scroll');
    const nativeScrollTo = scroll.scrollTo.bind(scroll);
    window.__waveformScrollBehaviors = [];
    scroll.scrollTo = (options) => {
      window.__waveformScrollBehaviors.push(options?.behavior || 'auto');
      nativeScrollTo(options);
    };
  });

  await page.keyboard.press('d');
  await expect(page.locator('.cue[data-idx="2"]')).toHaveClass(/selected/);
  await expect.poll(() => page.evaluate(
    () => document.getElementById('waveform-scroll').scrollTop,
  )).toBe(before.scrollTop);

  // 离开舒适区后仍应自动定位，避免把“减少无意义滚动”变成“不再跟随”。
  await page.evaluate(() => { document.getElementById('waveform-scroll').scrollTop = 0; });
  await page.keyboard.press('d');
  await expect(page.locator('.cue[data-idx="3"]')).toHaveClass(/selected/);
  await expect.poll(() => page.evaluate(
    () => document.getElementById('waveform-scroll').scrollTop,
  )).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__waveformScrollBehaviors)).toContain('smooth');
});

test('rapid subtitle navigation reuses cached waveform rows', async ({ page }) => {
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"]')).toBeVisible();
  await page.locator('.cue[data-idx="0"]').click();

  await page.evaluate(() => {
    // Put all fixture cues inside the cached row band so this test isolates
    // keyboard navigation from the cross-row incremental-render path.
    waveformEditor.settings.secondsPerRow = 60;
    waveformEditor.multiRange = [-1, -1];
    waveformEditor.render();

    const original = waveformEditor.renderMultiVisible.bind(waveformEditor);
    window.__keyboardWaveformRenderStats = { calls: 0, forced: 0 };
    waveformEditor.renderMultiVisible = function wrappedRenderMultiVisible(force = false) {
      window.__keyboardWaveformRenderStats.calls += 1;
      if (force) window.__keyboardWaveformRenderStats.forced += 1;
      return original(force);
    };
  });

  await page.evaluate(() => {
    for (let index = 0; index < 20; index += 1) {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'd',
        bubbles: true,
        repeat: index > 0,
      }));
    }
  });
  await page.waitForTimeout(100);

  await expect(page.locator('.cue[data-idx="5"]')).toHaveClass(/selected/);
  const renderStats = await page.evaluate(() => window.__keyboardWaveformRenderStats);
  expect(renderStats.forced).toBe(0);
  expect(renderStats.calls).toBeLessThan(20);
});

test('B does not split when the playhead is in a gap or while editing text', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('.cue[data-idx="0"]').click();
  // 播放头位于空隙（20s）：列表外按 B 只提示、不拆分
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 20;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await page.locator('#media-controls').hover();
  await page.keyboard.press('b');
  await expect(page.locator('.cue')).toHaveCount(6);
  await expect(page.locator('.hint-card', { hasText: '播放头位置没有可拆分字幕' })).toHaveCount(1);

  const panelText = page.locator('#cue-panel-text');
  await panelText.focus();
  await page.keyboard.press('b');
  await expect(panelText).toHaveValue('Alphab');
  await expect(page.locator('.cue')).toHaveCount(6);
});

test('B splits at the pointer audio position while hovering the waveform', async ({ page }) => {
  await page.goto(server.url);
  const row = page.locator('.waveform-row').first();
  const box = await row.boundingBox();
  // 第一行覆盖 0–5s；40% 处约 2s，落在第一条字幕（0–8s）内部
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.keyboard.press('b');
  await expect(page.locator('.cue')).toHaveCount(7);
  await expect(page.locator('.cue .text').nth(0)).not.toHaveText('Alpha');
});

test('help reflects the selected subtitle-edit split key', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#help-toggle').click();
  const helpPanel = page.locator('#help-panel');
  await expect(helpPanel).toHaveClass(/show/);
  await expect(helpPanel).toHaveAttribute('aria-hidden', 'false');

  const settingsPanel = page.locator('#editor-settings-panel');
  const displayRows = settingsPanel.locator('.editor-settings-display-row');
  const splitKey = page.locator('#split-key');
  const helpSplitKey = page.locator('#help-split-key');
  await expect(settingsPanel).not.toContainText('波形区拆分按键');
  await expect(displayRows).toHaveCount(2);
  const rowBoxes = await displayRows.evaluateAll((rows) => rows.map((row) => {
    const rect = row.getBoundingClientRect();
    const childTops = [...row.children].map((child) => child.getBoundingClientRect().top);
    return { top: rect.top, height: rect.height, childTops };
  }));
  expect(rowBoxes[1].top).toBeGreaterThanOrEqual(rowBoxes[0].top + rowBoxes[0].height);
  for (const row of rowBoxes) {
    expect(Math.max(...row.childTops) - Math.min(...row.childTops)).toBeLessThan(3);
  }
  const modKey = await page.evaluate(() => (
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgentData?.platform || '') ? 'Cmd' : 'Ctrl'
  ));
  await expect(helpSplitKey).toHaveText(`${modKey}+Enter`);
  await expect(page.locator('#help-waveform-split-key')).toHaveText('B');

  await splitKey.selectOption('enter');
  await expect(helpSplitKey).toHaveText('Enter');

  await splitKey.selectOption('ctrl-enter');
  await expect(helpSplitKey).toHaveText(`${modKey}+Enter`);

  await page.keyboard.press('Escape');
  await expect(helpPanel).not.toHaveClass(/show/);
  await expect(helpPanel).toHaveAttribute('aria-hidden', 'true');
});

test('waveform toolbar exposes grouped icon controls and selected cues use a yellow border', async ({ page }) => {
  await page.goto(server.url);

  const utilityGroup = page.locator('.toolbar-utility-group');
  const selectTool = page.locator('[data-waveform-tool="select"]');
  const splitTool = page.locator('[data-waveform-tool="razor"]');
  await expect(utilityGroup).toHaveAttribute('role', 'group');
  await expect(utilityGroup.locator('#editor-settings-toggle')).toBeVisible();
  await expect(utilityGroup.locator('#help-toggle')).toBeVisible();
  await expect(selectTool.locator('svg')).toHaveCount(1);
  await expect(splitTool).toContainText('分割');
  await expect(splitTool.locator('svg')).toHaveCount(1);
  await expect(selectTool).toHaveAttribute('title', /V/);
  await expect(splitTool).toHaveAttribute('title', /R/);
  await expect(page.locator('#help-toggle')).toContainText('帮助');

  await page.keyboard.press('r');
  await expect(splitTool).toHaveClass(/active/);
  await page.keyboard.press('v');
  await expect(selectTool).toHaveClass(/active/);

  const cue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await cue.click();
  // 选中字幕块用 outline 高亮（不再改 border-color）
  await expect(cue).toHaveCSS('outline-color', 'rgb(255, 213, 74)');
});

test('C merges a common group and Shift+A/D extends the subtitle selection', async ({ page }) => {
  await page.goto(server.url);
  const cues = page.locator('.cue');
  await expect(cues).toHaveCount(6);

  await cues.nth(0).click();
  await expect(cues.nth(0)).toHaveClass(/selected/);
  await page.keyboard.press('c');
  await expect(cues).toHaveCount(6);
  await expect(page.locator('.hint-card', { hasText: '请选择至少两个字幕块！' })).toHaveCount(1);

  await cues.nth(2).click();
  await expect(cues.nth(2)).toHaveClass(/selected/);
  await page.keyboard.press('Shift+a');
  await expect(page.locator('.cue.selected')).toHaveCount(2);
  await expect.poll(() => page.locator('.cue.selected').evaluateAll(
    (elements) => elements.map((element) => Number(element.dataset.idx)),
  )).toEqual([1, 2]);
  await page.keyboard.press('Shift+d');
  await expect(page.locator('.cue.selected')).toHaveCount(3);

  await page.reload();
  await expect(cues).toHaveCount(6);
  await page.evaluate(() => {
    DATA.segments[0].color = {
      name: 'red',
      value: '#e74c3c',
      start: DATA.segments[0].start,
      end: DATA.segments[2].end,
    };
    DATA.segments[0].sticker = {
      name: 'reaction',
      path: 'reaction.png',
      start: DATA.segments[0].start,
      end: DATA.segments[2].end,
    };
    for (const index of [1, 2]) {
      DATA.segments[index].color_ref = { name: 'red', headIdx: 0 };
      DATA.segments[index].sticker_ref = { name: 'reaction', headIdx: 0 };
    }
    renderAll();
  });

  await cues.nth(1).locator('.text').click();
  await expect(cues.nth(1)).toHaveClass(/selected/);
  await page.keyboard.down('Control');
  await cues.nth(2).locator('.text').click();
  await page.keyboard.up('Control');
  await page.keyboard.press('c');

  await expect(cues).toHaveCount(5);
  await expect(cues.nth(1).locator('.text')).toHaveText('BravoCharlie');
  await expect.poll(() => page.evaluate(() => ({
    colorRef: DATA.segments[1].color_ref,
    stickerRef: DATA.segments[1].sticker_ref,
    colorEnd: DATA.segments[0].color.end,
    stickerEnd: DATA.segments[0].sticker.end,
  }))).toEqual({
    colorRef: { name: 'red', headIdx: 0 },
    stickerRef: { name: 'reaction', headIdx: 0 },
    colorEnd: 108000,
    stickerEnd: 108000,
  });
});

test('context-menu subtitle deletion is immediate and undoable', async ({ page }) => {
  await page.goto(server.url);
  let confirmationShown = false;
  page.on('dialog', async (dialog) => {
    confirmationShown = true;
    await dialog.dismiss();
  });

  const cue = page.locator('.waveform-cue-block[data-idx="0"]').first();
  await cue.click({ button: 'right' });
  await page.locator('#ctxmenu .item', { hasText: '删除字幕' }).click();

  await expect(page.locator('.cue')).toHaveCount(5);
  expect(confirmationShown).toBe(false);
  await page.getByRole('button', { name: /撤销/ }).click();
  await expect(page.locator('.cue')).toHaveCount(6);
});

test('colored subtitles export per-color SRT files including the uncolored default group', async ({ page }) => {
  // 关闭「彩色字幕统一导出」，回到逐个下载的行为（默认勾选时会走目录选择器，自动化无法处理）
  await page.addInitScript(() => {
    const key = 'moy.asr.editor.settings.v1';
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    saved.exportColorUnified = false;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.segments[0].color = { name: 'red', value: '#e74c3c', start: 0, end: 58000 };
    DATA.segments[1].color_ref = { name: 'red', headIdx: 0 };
    DATA.segments[2].color = { name: 'blue', value: '#168cff', start: 100000, end: 108000 };
    renderAll();
    window.showSaveFilePicker = undefined;
  });

  await expect(page.locator('#download-srt')).toBeHidden();
  await expect(page.locator('#subtitle-export-dropdown')).toBeVisible();
  await page.locator('#subtitle-export-btn').click();
  await expect(page.locator('#download-full-srt')).toBeVisible();
  await expect(page.locator('#download-color-srt')).toBeVisible();
  await expect(page.locator('#download-plain-text')).toBeVisible();

  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.locator('#download-color-srt').click();
  await expect.poll(() => downloads.length).toBe(3);
  expect(downloads.map((download) => download.suggestedFilename())).toEqual([
    'project_red.srt',
    'project_blue.srt',
    'project_default.srt',
  ]);
  expect(await downloads[0].createReadStream().then(async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  })).toContain('Alpha');

  await page.locator('#subtitle-export-btn').click();
  const textDownload = page.waitForEvent('download');
  await page.locator('#download-plain-text').click();
  expect((await textDownload).suggestedFilename()).toBe('project.txt');
});

test('subtitle export stays direct when only disabled subtitles have colors', async ({ page }) => {
  await page.goto(server.url);
  await expect(page.locator('#download-srt')).toBeVisible();
  await expect(page.locator('#subtitle-export-dropdown')).toBeHidden();

  await page.evaluate(() => {
    DATA.segments[0].color = { name: 'red', value: '#e74c3c', start: 0, end: 8000 };
    DATA.segments[0].disabled = true;
    renderAll();
  });
  await expect(page.locator('#download-srt')).toBeVisible();
  await expect(page.locator('#subtitle-export-dropdown')).toBeHidden();
});

test('gap-removed export includes color SRT and names OTIO as a timeline project', async ({ page }) => {
  // 关闭「彩色字幕统一导出」，回到逐个下载的行为（默认勾选时会走目录选择器，自动化无法处理）
  await page.addInitScript(() => {
    const key = 'moy.asr.editor.settings.v1';
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    saved.exportColorUnified = false;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.segments[0].color = { name: 'red', value: '#e74c3c', start: 0, end: 58000 };
    DATA.segments[1].color_ref = { name: 'red', headIdx: 0 };
    DATA.gap_remove = {
      schema: 'moy.asr.gap_remove.v1',
      detector: 'audio_gate',
      minimum_ms: 500,
      threshold_db: -24,
      hysteresis_db: 2,
      lead_in_ms: 40,
      lead_out_ms: 80,
      skip_playback: true,
      operation_mode: 'middle_drag',
      manual_corrections: false,
      gaps: [{ start: 20000, end: 30000, removed: true }],
    };
    updateGapRemoveUi();
    renderAll();
    window.showSaveFilePicker = undefined;
  });

  await page.locator('#gap-removed-export-btn').click();
  await expect(page.locator('#download-gap-removed-color-srt')).toBeVisible();
  await expect(page.locator('#download-gap-removed-otio')).toHaveText('时间线 OTIO 工程');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-gap-removed-color-srt').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('project_gap-removed_red.srt');
});

test('server media loads from the resolved project path and OTIO keeps its absolute source URL', async ({ page }) => {
  await page.goto(server.url);
  const state = await page.evaluate(() => ({
    media: DATA.media,
    currentSrc: document.getElementById('player').currentSrc,
  }));
  expect(state.media).toMatch(/synthetic\.wav$/);
  expect(state.media).toMatch(/^(?:[A-Za-z]:[\\/]|\/)/);
  expect(state.currentSrc).toBe(`${server.url}media`);

  await page.evaluate(() => {
    DATA.gap_remove = {
      schema: 'moy.asr.gap_remove.v1',
      detector: 'audio_gate',
      minimum_ms: 500,
      threshold_db: -24,
      hysteresis_db: 2,
      lead_in_ms: 40,
      lead_out_ms: 80,
      skip_playback: true,
      operation_mode: 'middle_drag',
      manual_corrections: false,
      gaps: [{ start: 20000, end: 30000, removed: true }],
    };
    updateGapRemoveUi();
    renderAll();
    window.showSaveFilePicker = undefined;
  });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#gap-removed-export-btn').click();
  await page.locator('#download-gap-removed-otio').click();
  const download = await downloadPromise;
  const payload = await download.createReadStream().then(async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  });
  const targetUrl = payload.tracks.children[0].children[0]
    .media_references.DEFAULT_MEDIA.target_url;
  expect(targetUrl).toMatch(/^file:\/\/\//);
  expect(decodeURI(targetUrl)).toContain('synthetic.wav');
});
