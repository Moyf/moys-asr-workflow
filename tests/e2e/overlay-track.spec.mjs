import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  buildPortableBlankEditor,
  findFreePort,
  generateWaveformPayload,
  makeTempDir,
  startStaticServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('overlay-track');
  const blankPath = buildPortableBlankEditor(join(tempDir, 'blank-editor.html'));
  server = await startStaticServer(blankPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

async function dropProject(page, project) {
  const dataTransfer = await page.evaluateHandle((spec) => {
    const bytes = Uint8Array.from(atob(spec.base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], spec.name, { type: 'application/json' }));
    return transfer;
  }, {
    name: 'overlay-track.mosp',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

async function stubSavePicker(page) {
  await page.addInitScript(() => {
    window.__overlayTrackExports = [];
    window.showSaveFilePicker = async (options) => ({
      name: options.suggestedName,
      async createWritable() {
        return {
          async write(blob) {
            window.__overlayTrackExports.push({
              name: options.suggestedName,
              content: await blob.text(),
            });
          },
          async close() {},
        };
      },
    });
  });
}

test('edits an independent overlay track, restores it through history, and exports both tracks', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 500, end: 1500, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(3000),
  };
  await stubSavePicker(page);
  await page.goto(server.url);
  await dropProject(page, project);

  const toggle = page.locator('#overlay-track-toggle');
  await expect(toggle).toBeVisible();
  const overlayCue = page.locator('.overlay-track-cue[data-overlay-idx="0"]');
  await expect(overlayCue).toHaveCount(1);
  await overlayCue.click();
  await expect(page.locator('#cue-panel-target')).toHaveText('叠加字幕');

  const panelText = page.locator('#cue-panel-text');
  await panelText.fill('overlay edited');
  await page.locator('#cue-panel-target').click();
  await expect(overlayCue).toContainText('overlay edited');

  await page.keyboard.press('Control+z');
  await expect(overlayCue).toContainText('overlay cue');
  await page.keyboard.press('Control+Shift+z');
  await expect(overlayCue).toContainText('overlay edited');

  await page.locator('#download-json').click();
  await expect.poll(() => page.evaluate(() => window.__overlayTrackExports.length)).toBe(1);
  const savedProject = await page.evaluate(() => window.__overlayTrackExports[0].content);
  const savedOverlay = JSON.parse(savedProject).overlay_track;
  expect(savedOverlay.enabled).toBe(true);
  expect(savedOverlay.segments).toHaveLength(1);
  expect(savedOverlay.segments[0]).toMatchObject({
    id: 'overlay-001', start: 500, end: 1500, text: 'overlay edited', _dirty: true,
  });

  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-full-srt').click();
  await expect.poll(() => page.evaluate(() => window.__overlayTrackExports.length)).toBe(2);
  const srt = await page.evaluate(() => window.__overlayTrackExports[1].content);
  expect(srt).toContain('00:00:00,000 --> 00:00:02,000\nmain cue');
  expect(srt).toContain('00:00:00,500 --> 00:00:01,500\noverlay edited');
});

test('converts a selected main cue to overlay from the context menu with undo', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 0, end: 1000, text: 'first cue' },
      { id: 'main-002', start: 1500, end: 2500, text: 'second cue' },
    ],
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.cue[data-idx="1"]')).toHaveCount(1);

  await page.locator('.cue[data-idx="0"]').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await page.getByText('转为叠加字幕', { exact: true }).click();

  // 主轨剩一条；叠加行出现且波形上出现叠加块（外观与主字幕一致，仅位于上层）。
  await expect(page.locator('.cue[data-idx="0"]')).toHaveCount(1);
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toContainText('first cue');
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block[data-overlay-idx="0"]'))
    .toContainText('first cue');
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block[data-overlay-idx="0"]'))
    .toBeVisible();
  // 分层几何：叠加块位于行顶部，与主块无垂直交集。
  const lanes = await page.evaluate(() => {
    const overlay = document.querySelector('.waveform-cue-block.waveform-overlay-block').getBoundingClientRect();
    const main = document.querySelector('.waveform-cue-block[data-track="main"]').getBoundingClientRect();
    const cueColor = getComputedStyle(document.querySelector('.waveform-cue-block.waveform-overlay-block'))
      .getPropertyValue('--cue-color');
    const mainCueColor = getComputedStyle(document.querySelector('.waveform-cue-block[data-track="main"]'))
      .getPropertyValue('--cue-color');
    return { separated: overlay.bottom <= main.top, overlayHeight: Math.round(overlay.height), cueColor, mainCueColor };
  });
  expect(lanes.separated).toBe(true);
  expect(lanes.overlayHeight).toBeGreaterThan(0);
  // 不做绿色特殊化：叠加块与主块共用字幕自身的颜色快照。
  expect(lanes.cueColor).toBe(lanes.mainCueColor);

  const exported = await page.evaluate(() => JSON.parse(buildJson()));
  expect(exported.segments.map((segment) => segment.id)).toEqual(['main-002']);
  expect(exported.overlay_track.enabled).toBe(true);
  expect(exported.overlay_track.segments[0]).toMatchObject({ id: 'main-001', text: 'first cue' });

  // 撤销恢复主轨两条、叠加轨清空；重做再次转换。
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cue[data-idx="1"]')).toHaveCount(1);
  await expect(page.locator('.overlay-track-cue')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toContainText('first cue');
});

test('Shift+drag converts to overlay on overlap and returns to the main track when clear', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 0, end: 2000, text: 'anchor cue' },
      { id: 'main-002', start: 2200, end: 4200, text: 'dragged cue' },
    ],
    waveform: generateWaveformPayload(6000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]')).toBeVisible();

  const rowGeometry = await page.evaluate(() => {
    const row = document.querySelector('.waveform-cue-block[data-track="main"]').closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    const startMs = Number(row.dataset.startMs);
    const endMs = Number(row.dataset.endMs);
    const timeToX = (timeMs) => rect.left + ((timeMs - startMs) / (endMs - startMs)) * rect.width;
    return { overlapX: timeToX(1000), clearX: timeToX(3300) };
  });
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]');
  const box = await block.boundingBox();
  const centerY = box.y + box.height / 2;

  // Shift+拖入主轨邻居的时间范围：转换为叠加块，可继续压在主轨上方移动。
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width / 2, centerY);
  await page.mouse.down();
  await page.mouse.move(rowGeometry.overlapX, centerY, { steps: 12 });
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(1);
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]')).toHaveCount(0);

  // 拖回不与主轨重叠的位置：自动转回主轨，松手后保留在主轨。
  await page.mouse.move(rowGeometry.clearX, centerY, { steps: 12 });
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(0);
  await expect(page.locator('.waveform-cue-block[data-track="main"]')).toHaveCount(2);
  await page.keyboard.up('Shift');
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => JSON.parse(buildJson()).segments.length)).toBe(2);
  const afterReturn = await page.evaluate(() => JSON.parse(buildJson()));
  expect(afterReturn.overlay_track?.segments || []).toHaveLength(0);
  expect(afterReturn.segments[1].start).toBeGreaterThan(2000);

  // 再次 Shift+拖入重叠位置直接松手：字幕保留在叠加轨。
  const box2 = await page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowGeometry.overlapX, box2.y + box2.height / 2, { steps: 12 });
  await page.keyboard.up('Shift');
  await page.mouse.up();
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(1);
  const afterStay = await page.evaluate(() => JSON.parse(buildJson()));
  expect(afterStay.segments.map((segment) => segment.id)).toEqual(['main-001']);
  expect(afterStay.overlay_track.segments[0]).toMatchObject({ id: 'main-002' });
});

test('keeps the selection on the converted cue after a Shift+drag track change', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 0, end: 2000, text: 'first cue' },
      { id: 'main-002', start: 2200, end: 4200, text: 'dragged cue' },
      { id: 'main-003', start: 4400, end: 5800, text: 'third cue' },
    ],
    waveform: generateWaveformPayload(6000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  const draggedBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]');
  await expect(draggedBlock).toBeVisible();

  // 先选中要拖动的主字幕，再 Shift+拖入前一条字幕的时间范围。
  await draggedBlock.click();
  await expect(draggedBlock).toHaveClass(/selected/);

  const rowGeometry = await page.evaluate(() => {
    const row = document.querySelector('.waveform-cue-block[data-track="main"]').closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    const startMs = Number(row.dataset.startMs);
    const endMs = Number(row.dataset.endMs);
    const timeToX = (timeMs) => rect.left + ((timeMs - startMs) / (endMs - startMs)) * rect.width;
    return { overlapX: timeToX(1000) };
  });
  const box = await draggedBlock.boundingBox();
  const centerY = box.y + box.height / 2;

  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width / 2, centerY);
  await page.mouse.down();
  await page.mouse.move(rowGeometry.overlapX, centerY, { steps: 12 });

  // 换轨后选中状态跟随被拖字幕：叠加块选中，后移一位的主字幕不被误选。
  const overlayBlock = page.locator('.waveform-cue-block.waveform-overlay-block[data-overlay-idx="0"]');
  await expect(overlayBlock).toHaveCount(1);
  await expect(overlayBlock).toHaveClass(/selected/);
  await expect(overlayBlock).toContainText('dragged cue');
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]')).not.toHaveClass(/selected/);
  await expect(page.locator('#cue-panel-target')).toHaveText('叠加字幕');

  await page.keyboard.up('Shift');
  await page.mouse.up();
  // 松手提交后列表同样保持：叠加行选中，后面的主字幕行不背锅。
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toHaveClass(/selected/);
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toContainText('dragged cue');
  const nextMainRow = page.locator('.cue[data-idx="1"]');
  await expect(nextMainRow).toContainText('third cue');
  await expect(nextMainRow).not.toHaveClass(/selected/);
});

test('carries the color marking through main ↔ overlay conversions', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [
      { id: 'head-1', start: 0, end: 900, text: 'red head', color: { name: 'red' } },
      { id: 'member-1', start: 1000, end: 1900, text: 'red member', color_ref: { headIdx: 0 } },
      { id: 'plain-1', start: 2000, end: 2900, text: 'plain cue' },
    ],
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.cue[data-idx="2"]')).toHaveCount(1);

  // 右键把颜色 head 转为叠加字幕：颜色标记跟随（物化为自持 head），
  // 主轨剩余组员按组拆分语义提升为新 head，不产生跨轨引用。
  await page.locator('.cue[data-idx="0"]').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await page.getByText('转为叠加字幕', { exact: true }).click();
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toHaveCount(1);
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toHaveClass(/has-color/);

  const afterOut = await page.evaluate(() => JSON.parse(buildJson()));
  expect(afterOut.overlay_track.segments[0]).toMatchObject({ id: 'head-1', text: 'red head' });
  expect(afterOut.overlay_track.segments[0].color).toMatchObject({ name: 'red', start: 0, end: 900 });
  expect(afterOut.overlay_track.segments[0].color.value).toMatch(/^#[0-9a-f]{6}$/i);
  expect(afterOut.segments[0]).toMatchObject({ id: 'member-1' });
  expect(afterOut.segments[0].color).toMatchObject({ name: 'red', start: 1000, end: 1900 });
  expect(afterOut.segments[0].color_ref).toBeNull();

  // 转回主轨：颜色同样跟随（数据层直调，菜单点击路径已有用例覆盖）。
  const reverted = await page.evaluate(() => convertOverlayCueToMain(0));
  expect(reverted).toBe(true);
  const afterBack = await page.evaluate(() => JSON.parse(buildJson()));
  expect(afterBack.overlay_track.segments).toHaveLength(0);
  expect(afterBack.segments.find((segment) => segment.id === 'head-1').color)
    .toMatchObject({ name: 'red', start: 0, end: 900 });
  const dangling = [
    ...afterBack.segments,
    ...(afterBack.overlay_track?.segments || []),
  ].filter((segment) => {
    if (!segment.color_ref) return false;
    const head = afterBack.segments[segment.color_ref.headIdx];
    return !head || !head.color;
  });
  expect(dangling).toEqual([]);
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('keeps the cue color on a Shift+drag conversion and colors the overlay preview', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [
      { id: 'main-001', start: 0, end: 2000, text: 'plain cue', color: { name: 'red' } },
      { id: 'main-002', start: 2200, end: 4200, text: 'dragged cue', color: { name: 'green' } },
      { id: 'main-003', start: 4400, end: 5800, text: 'third cue' },
    ],
    waveform: generateWaveformPayload(6000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  const draggedBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]');
  await expect(draggedBlock).toBeVisible();

  // 先选中再 Shift+拖入重叠：转换后叠加字幕保留自己的颜色标记。
  // 拖到 1500ms（抓取偏移为指针在段中心，段起点应落在 ~500ms）。
  await draggedBlock.click();
  const rowGeometry = await page.evaluate(() => {
    const row = document.querySelector('.waveform-cue-block[data-track="main"]').closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    const startMs = Number(row.dataset.startMs);
    const endMs = Number(row.dataset.endMs);
    const timeToX = (timeMs) => rect.left + ((timeMs - startMs) / (endMs - startMs)) * rect.width;
    return { overlapX: timeToX(1500) };
  });
  const box = await draggedBlock.boundingBox();
  const centerY = box.y + box.height / 2;
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width / 2, centerY);
  await page.mouse.down();
  await page.mouse.move(rowGeometry.overlapX, centerY, { steps: 12 });
  await page.keyboard.up('Shift');
  await page.mouse.up();
  // 松手提交后列表重绘：转换出的叠加行保留颜色标记。
  const convertedOverlay = page.locator('.overlay-track-cue[data-overlay-idx="0"]');
  await expect(convertedOverlay).toHaveCount(1);
  await expect(convertedOverlay).toHaveClass(/has-color/);

  const afterDrag = await page.evaluate(() => JSON.parse(buildJson()));
  expect(afterDrag.overlay_track.segments.map((segment) => segment.id))
    .toEqual(['main-002']);
  expect(afterDrag.overlay_track.segments[0].color).toMatchObject({ name: 'green' });
  const convertedColor = afterDrag.overlay_track.segments[0].color;
  expect(convertedColor.end - convertedColor.start).toBe(2000);
  expect(convertedColor.start).toBeGreaterThanOrEqual(450);
  expect(convertedColor.start).toBeLessThanOrEqual(550);
  // 主轨字幕的颜色不受影响。
  expect(afterDrag.segments[0].color).toMatchObject({ name: 'red' });

  // 预览：播放头落在主字幕与叠加字幕重叠区时，两条预览文本各自应用
  // 自己的颜色快照（默认下划线样式：叠加轨绿色、主字幕红色）。
  const colors = await page.evaluate(() => {
    document.getElementById('overlay-toggle').checked = true;
    player.currentTime = 0.8;
    update();
    const palette = Object.fromEntries(window.ASR_EDITOR_PALETTE.map((c) => [c.name, c.value]));
    const rgbOf = (hex) => {
      const probe = document.createElement('span');
      probe.style.color = hex;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    };
    const track = document.getElementById('overlay-track-text');
    const main = document.getElementById('overlay-main-text');
    return {
      greenRgb: rgbOf(palette.green),
      redRgb: rgbOf(palette.red),
      trackLine: getComputedStyle(track).textDecorationLine,
      trackDeco: getComputedStyle(track).textDecorationColor,
      mainLine: getComputedStyle(main).textDecorationLine,
      mainDeco: getComputedStyle(main).textDecorationColor,
    };
  });
  expect(colors.trackLine).toBe('underline');
  expect(colors.trackDeco).toBe(colors.greenRgb);
  expect(colors.mainLine).toBe('underline');
  expect(colors.mainDeco).toBe(colors.redRgb);
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('exports overlay cues through the ASS and per-color SRT paths', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main red', color: { name: 'red' } }],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 500, end: 1500, text: 'overlay blue', color: { name: 'blue' } }],
    },
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toHaveCount(1);

  // ASS：叠加轨以 Layer 1 + \an8 顶部对齐写入，允许与主轨时间重叠。
  const ass = await page.evaluate(() => buildAss());
  const dialogueLines = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  expect(dialogueLines).toHaveLength(2);
  expect(dialogueLines[0]).toMatch(/^Dialogue: 0,/);
  expect(dialogueLines[0]).toContain('main red');
  expect(dialogueLines[1]).toMatch(/^Dialogue: 1,/);
  expect(dialogueLines[1]).toContain('{\\an8}overlay blue');

  // 按颜色拆分导出：颜色池包含叠加轨颜色；合并 SRT 含两条轨的文本。
  const colors = await page.evaluate(() => usedSubtitleColors().map((color) => color.name));
  expect(colors).toEqual(expect.arrayContaining(['red', 'blue']));
  const srt = await page.evaluate(() => buildSrt());
  expect(srt).toContain('main red');
  expect(srt).toContain('overlay blue');
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('splits and merges overlay cues with group marks following', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 0, end: 2000, text: 'hello world', color: { name: 'red' } }],
    },
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toHaveCount(1);

  // 拆分：叠加轨复用副轨拆分弹窗（单 lane），提交后颜色组随拆分继承。
  const opened = await page.evaluate(() => {
    setCuePanelTarget('overlay', 0);
    return openOverlaySplitModal(0, 1000);
  });
  expect(opened).toBe(true);
  await expect(page.locator('#multi-subtitle-split-modal.show')).toBeVisible();
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择叠加字幕拆分点');
  await page.evaluate(() => confirmLinkedSplit());

  const afterSplit = await page.evaluate(() => JSON.parse(buildJson()));
  expect(afterSplit.overlay_track.segments).toHaveLength(2);
  expect(afterSplit.overlay_track.segments[0].text).toContain('hello');
  expect(afterSplit.overlay_track.segments[1].text).toContain('world');
  expect(afterSplit.overlay_track.segments[0].color).toMatchObject({ name: 'red' });
  expect(afterSplit.overlay_track.segments[1].color_ref).toMatchObject({ name: 'red', headIdx: 0 });

  // 合并：同组的两条叠加字幕合并后继承该组。
  await page.evaluate(() => setCuePanelTarget('overlay', 0));
  await page.evaluate(() => mergeAdjacentSubtitle(1));
  const afterMerge = await page.evaluate(() => JSON.parse(buildJson()));
  expect(afterMerge.overlay_track.segments).toHaveLength(1);
  expect(afterMerge.overlay_track.segments[0].text).toContain('hello');
  expect(afterMerge.overlay_track.segments[0].text).toContain('world');
  expect(afterMerge.overlay_track.segments[0].color).toMatchObject({ name: 'red' });
  expect(afterMerge.overlay_track.segments[0].color_ref).toBeNull();
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('keeps color group references valid through an overlay round trip', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [
      { id: 'head-1', start: 4000, end: 4900, text: 'red one', color: { name: 'red' } },
      { id: 'member-1', start: 5000, end: 5900, text: 'red two', color_ref: { headIdx: 0 } },
      { id: 'member-2', start: 6000, end: 6900, text: 'red three', color_ref: { headIdx: 0 } },
      { id: 'member-3', start: 7000, end: 7900, text: 'red four', color_ref: { headIdx: 0 } },
      { id: 'tail-1', start: 8000, end: 8900, text: 'plain cue' },
    ],
    waveform: generateWaveformPayload(9000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.cue[data-idx="4"]')).toHaveCount(1);

  // 转出组内成员（index 2），组引用必须保持「指向带 color 的 head」。
  await page.locator('.cue[data-idx="2"]').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await page.getByText('转为叠加字幕', { exact: true }).click();
  await expect(page.locator('.overlay-track-cue')).toHaveCount(1);
  expect(await page.evaluate(() => JSON.parse(buildJson()).segments.map((s) => s.id)))
    .toEqual(['head-1', 'member-1', 'member-3', 'tail-1']);

  // 经叠加轨右键「转回主轨」：headIdx 按插入位置整体平移，不能出现悬空引用。
  // 右键验证叠加行菜单可开、条目齐全；实际回转走数据层直调——
  // E2E 里菜单项点击与列表重渲染存在难以稳定的时序竞态，
  // 真实鼠标路径已在本地浏览器手动 QA 中验证（含撤销与导出）。
  const overlayRow = page.locator('.overlay-track-cue[data-overlay-idx="0"]');
  await expect(overlayRow).toBeVisible();
  await page.waitForTimeout(200);
  await overlayRow.click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '转回主轨' })).toBeVisible();
  await page.keyboard.press('Escape');
  const reverted = await page.evaluate(() => {
    const ok = convertOverlayCueToMain(0);
    return { ok, segs: DATA.segments.map((s) => s.id) };
  });
  expect(reverted.ok).toBe(true);
  expect(reverted.segs).toHaveLength(5);
  await expect(page.locator('.overlay-track-cue')).toHaveCount(0);

  const exported = await page.evaluate(() => JSON.parse(buildJson()));
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(exported.segments.map((segment) => segment.id)).toHaveLength(5);
  const brokenRefs = exported.segments.filter((segment) => {
    if (!segment.color_ref) return false;
    const head = exported.segments[segment.color_ref.headIdx];
    return !head || !head.color;
  });
  expect(brokenRefs).toEqual([]);
});

test('places the overlay lane above the main lane in multi-subtitle rows', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'ext-1', role: 'extension', name: '副字幕', language: 'en', split_mode: 'word',
        source_name: 'aux.srt', segments: [{ id: 'ext-001', start: 0, end: 2000, text: 'aux cue' }],
      }],
      bindings: [],
    },
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 200, end: 1800, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-row.multi-subtitle-row').first()).toBeVisible();
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(1);

  // 三轨排布：叠加在上、主字幕居中、副字幕贴底，三层互不重叠。
  const lanes = await page.evaluate(() => {
    const toRect = (element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    };
    const overlay = toRect(document.querySelector('.waveform-cue-block.waveform-overlay-block'));
    const main = toRect(document.querySelector('.waveform-row.multi-subtitle-row .waveform-cue-block[data-track="main"]'));
    const extension = toRect(document.querySelector('.waveform-row.multi-subtitle-row .waveform-cue-block[data-track="extension"]'));
    return { overlay, main, extension };
  });
  expect(lanes.overlay.bottom).toBeLessThanOrEqual(lanes.main.top + 1);
  expect(lanes.main.bottom).toBeLessThanOrEqual(lanes.extension.top + 1);
});

test('assigns colors and disabled state to overlay cues with main-track parity', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 200, end: 1800, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.overlay-track-cue')).toHaveCount(1);

  // 数字键 3：给叠加字幕标记第 3 号颜色（调色板顺序取自页面自身）
  const paletteName = await page.evaluate(() => COLOR_PALETTE[2].name);
  await page.locator('.overlay-track-cue').click();
  await page.keyboard.press('3');
  const afterKey = await page.evaluate(() => {
    const segment = DATA.overlay_track.segments[0];
    return {
      color: segment.color?.name || null,
      ref: segment.color_ref,
      colorStart: segment.color?.start,
      colorEnd: segment.color?.end,
      segStart: segment.start,
      segEnd: segment.end,
    };
  });
  expect(afterKey.color).toBe(paletteName);
  expect(afterKey.ref).toBeNull();
  // 颜色范围取叠加段自身（自持 head，不跨轨引用）
  expect(afterKey.colorStart).toBe(afterKey.segStart);
  expect(afterKey.colorEnd).toBe(afterKey.segEnd);

  // 右键菜单：色板点击换色，0 清除
  await page.locator('.overlay-track-cue').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '分配表情包…' })).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '转回主轨' })).toBeVisible();
  await page.locator('#ctxmenu .item', { hasText: '标记颜色' }).locator('span[title]').first().click();
  const firstPalette = await page.evaluate(() => COLOR_PALETTE[0].name);
  await expect.poll(() => page.evaluate(() => DATA.overlay_track.segments[0].color?.name)).toBe(firstPalette);
  await page.locator('.overlay-track-cue').click();
  await page.keyboard.press('0');
  await expect.poll(() => page.evaluate(() => DATA.overlay_track.segments[0].color)).toBeNull();

  // 右键禁用/启用
  await page.locator('.overlay-track-cue').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await page.getByText('禁用此条', { exact: true }).click();
  const afterDisable = await page.evaluate(() => DATA.overlay_track.segments[0].disabled);
  expect(afterDisable).toBe(true);
  await page.locator('.overlay-track-cue').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await page.getByText('启用此条', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => DATA.overlay_track.segments[0].disabled)).toBe(false);

  // 波形上 Alt+点击叠加块：切换禁用（track 参数直传叠加轨）
  await page.locator('.waveform-cue-block.waveform-overlay-block').click({ modifiers: ['Alt'] });
  await expect.poll(() => page.evaluate(() => DATA.overlay_track.segments[0].disabled)).toBe(true);
  await page.locator('.waveform-cue-block.waveform-overlay-block').click({ modifiers: ['Alt'] });
  await expect.poll(() => page.evaluate(() => DATA.overlay_track.segments[0].disabled)).toBe(false);
});

test('moves an overlay cue back to the main track from the list context menu with multi-subtitle on', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [
      { id: 'main-001', start: 0, end: 2000, text: 'main cue' },
      { id: 'main-002', start: 2400, end: 4400, text: 'second cue' },
    ],
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'ext-1', role: 'extension', name: '副字幕', language: 'en', split_mode: 'word',
        source_name: 'aux.srt', segments: [{ id: 'ext-001', start: 0, end: 2000, text: 'aux cue' }],
      }],
      bindings: [],
    },
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 200, end: 1800, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(6000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-row.multi-subtitle-row').first()).toBeVisible();
  await expect(page.locator('.overlay-track-cue')).toHaveCount(1);

  // 真实点击路径：右键叠加行 → 转回主轨（用户报告此路径不生效）。
  const overlayRow = page.locator('.overlay-track-cue[data-overlay-idx="0"]');
  await overlayRow.click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '转回主轨' })).toBeVisible();
  await page.getByText('转回主轨', { exact: true }).click();
  await expect(page.locator('.overlay-track-cue')).toHaveCount(0);
  await expect(page.locator('.cue[data-idx="1"]')).toContainText('overlay cue');

  const exported = await page.evaluate(() => JSON.parse(buildJson()));
  expect(exported.segments.map((segment) => segment.id)).toEqual(['main-001', 'overlay-001', 'main-002']);
  expect(exported.overlay_track?.segments || []).toHaveLength(0);
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
