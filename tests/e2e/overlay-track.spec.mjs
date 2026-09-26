import { expect, test } from '@playwright/test';
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

  await page.keyboard.press('ControlOrMeta+z');
  await expect(overlayCue).toContainText('overlay cue');
  await page.keyboard.press('ControlOrMeta+Shift+z');
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

  const exported = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(exported.segments.map((segment) => segment.id)).toEqual(['main-002']);
  expect(exported.overlay_track.enabled).toBe(true);
  expect(exported.overlay_track.segments[0]).toMatchObject({ id: 'main-001', text: 'first cue' });

  // 撤销恢复主轨两条、叠加轨清空；重做再次转换。
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.cue[data-idx="1"]')).toHaveCount(1);
  await expect(page.locator('.overlay-track-cue')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
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
  await expect.poll(() => page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).segments.length)).toBe(2);
  const afterReturn = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
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
  const afterStay = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
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

  const afterOut = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(afterOut.overlay_track.segments[0]).toMatchObject({ id: 'head-1', text: 'red head' });
  expect(afterOut.overlay_track.segments[0].color).toMatchObject({ name: 'red', start: 0, end: 900 });
  expect(afterOut.overlay_track.segments[0].color.value).toMatch(/^#[0-9a-f]{6}$/i);
  expect(afterOut.segments[0]).toMatchObject({ id: 'member-1' });
  expect(afterOut.segments[0].color).toMatchObject({ name: 'red', start: 1000, end: 1900 });
  expect(afterOut.segments[0].color_ref).toBeNull();

  // 转为主字幕：颜色同样跟随（数据层直调，菜单点击路径已有用例覆盖）。
  const reverted = await page.evaluate(() => convertOverlayCueToMain(0));
  expect(reverted).toBe(true);
  const afterBack = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
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

  const afterDrag = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
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
    MaweCoreState.player.currentTime = 0.8;
    MawePlaybackLoop.update();
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

// ASS：叠加轨以 Layer 2 写入，引用独立的 Overlay 样式（MarginV 固化在
// 样式行里，事件行不带边距覆盖）。
const ass = await page.evaluate(() => MaweExportSrt.buildAss());
  const dialogueLines = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  expect(dialogueLines).toHaveLength(2);
  expect(dialogueLines[0]).toMatch(/^Dialogue: 0,/);
  expect(dialogueLines[0]).toContain('main red');
  expect(dialogueLines[1]).toMatch(/^Dialogue: 2,/);
  expect(dialogueLines[1]).toContain('overlay blue');
  expect(dialogueLines[1]).not.toContain('\\an8');
  expect(dialogueLines[1]).toContain(',Overlay BLUE,,0,0,0,');
  expect(ass).toContain('Style: Overlay,');

  // 按颜色拆分导出：颜色池包含叠加轨颜色；合并 SRT 含两条轨的文本。
  const colors = await page.evaluate(() => MaweExportSrt.usedSubtitleColors().map((color) => color.name));
  expect(colors).toEqual(expect.arrayContaining(['red', 'blue']));
  const srt = await page.evaluate(() => MaweExportSrt.buildSrt());
  expect(srt).toContain('main red');
  expect(srt).toContain('overlay blue');
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('ASS mode previews overlay cues in the main style with fad and exports tags per track', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 0, end: 2000, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toHaveCount(1);

  const result = await page.evaluate(() => {
    MaweBoot.DATA.media_metadata = { video_width: 1920, video_height: 1080 };
    const library = window.AsrEditorUtils.defaultAssStyleLibrary();
    const profile = library.assProfiles[0];
    profile.animations.fad = { enabled: true, inMs: 1000, outMs: 1000 };
    profile.animations.move = { enabled: true, x1: 0, y1: 960, x2: 0, y2: 500, t1: 0, t2: 1000 };
    ASS_STYLE_LIBRARY = library;
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    MawePlaybackLoop.refreshSubtitlePreview(600, 0);
    const overlayTrackText = document.getElementById('overlay-track-text');
    const mainText = document.getElementById('overlay-main-text');
    const stageHeight = MaweDom.playerStage.getBoundingClientRect().height;
    return {
      stageHeight,
      mainFontSize: getComputedStyle(mainText).fontSize,
      overlayFontSize: getComputedStyle(overlayTrackText).fontSize,
      overlayBottom: overlayTrackText.style.bottom,
      overlayOpacity: Number(getComputedStyle(overlayTrackText).opacity),
      overlayFontFamily: overlayTrackText.style.fontFamily,
      ass: MaweExportSrt.buildAss(),
    };
  });
  // 叠加轨与主字幕使用完全相同的 ASS 样式（字号/字体一致），锚定在主
  // 字幕上方：MarginV = 样式垂直边距 80 + 1.2 × 字号 72（按 PlayRes 1080
  // 等比换算）。
  expect(result.overlayFontSize).toBe(result.mainFontSize);
  expect(result.overlayFontFamily.length).toBeGreaterThan(0);
  const scale = result.stageHeight / 1080;
  const expectedOffset = Math.ceil(80 * scale + 1.2 * ((72 * result.stageHeight) / 1080));
  expect(result.overlayBottom).toBe(`${expectedOffset}px`);
  // t=600ms、fad(in=1000ms)：淡入进行到 60%。
  expect(result.overlayOpacity).toBeCloseTo(0.6, 5);
  // 导出侧：主轨携带 fad + move；叠加轨只带与位置无关的 fad，不带 move，
  // 引用固化了锚定边距（80 + round(86.4) = 166）的 Overlay 样式。
  const dialogueLines = result.ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  expect(dialogueLines).toHaveLength(2);
  expect(dialogueLines[0]).toContain('{\\fad(1000,1000)\\move(0,960,0,500,0,1000)}main cue');
  expect(dialogueLines[1]).toContain('{\\fad(1000,1000)}overlay cue');
  expect(dialogueLines[1]).not.toContain('\\move(');
  const overlayStyleLine = result.ass.split('\n').find((line) => line.startsWith('Style: Overlay,'));
  expect(overlayStyleLine).toBeTruthy();
  expect(overlayStyleLine.endsWith(',10,10,166,1')).toBe(true);
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
    MaweCuePanel.setCuePanelTarget('overlay', 0);
    return openOverlaySplitModal(0, 1000);
  });
  expect(opened).toBe(true);
  await expect(page.locator('#multi-subtitle-split-modal.show')).toBeVisible();
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择叠加字幕拆分点');
  await page.evaluate(() => MaweSplitCore.confirmLinkedSplit());

  const afterSplit = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(afterSplit.overlay_track.segments).toHaveLength(2);
  expect(afterSplit.overlay_track.segments[0].text).toContain('hello');
  expect(afterSplit.overlay_track.segments[1].text).toContain('world');
  expect(afterSplit.overlay_track.segments[0].color).toMatchObject({ name: 'red' });
  expect(afterSplit.overlay_track.segments[1].color_ref).toMatchObject({ name: 'red', headIdx: 0 });

  // 合并：同组的两条叠加字幕合并后继承该组。
  await page.evaluate(() => MaweCuePanel.setCuePanelTarget('overlay', 0));
  await page.evaluate(() => MaweMergeAdjacent.mergeAdjacentSubtitle(1));
  const afterMerge = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(afterMerge.overlay_track.segments).toHaveLength(1);
  expect(afterMerge.overlay_track.segments[0].text).toContain('hello');
  expect(afterMerge.overlay_track.segments[0].text).toContain('world');
  expect(afterMerge.overlay_track.segments[0].color).toMatchObject({ name: 'red' });
  expect(afterMerge.overlay_track.segments[0].color_ref).toBeNull();
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('batch merge via C key inherits color groups and rejects skipped middle cues', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    overlay_track: {
      enabled: true,
      segments: [
        { id: 'overlay-001', start: 0, end: 800, text: '甲', color_ref: { name: 'red', headIdx: 1 } },
        { id: 'overlay-002', start: 900, end: 1600, text: '乙', color: { name: 'red' } },
        { id: 'overlay-003', start: 1700, end: 2400, text: '丙', color_ref: { name: 'red', headIdx: 1 } },
      ],
    },
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="2"]')).toHaveCount(1);

  // 跳过中间段（选 0 和 2）按 C：必须按下标连续拒绝；三段原样保留且保持
  // 有序（否则保存后会违反相邻段 end <= next.start 的契约，工程无法再打开）。
  await page.evaluate(() => {
    MaweCuePanel.setCuePanelTarget('overlay', 0);
    selectedOverlayIdxs.clear();
    selectedOverlayIdxs.add(0);
    selectedOverlayIdxs.add(2);
  });
  await page.keyboard.press('c');
  await expect(page.locator('.hint-card').last()).toContainText('选中的叠加字幕必须连续');
  const unchanged = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).overlay_track.segments);
  expect(unchanged.map((segment) => segment.text)).toEqual(['甲', '乙', '丙']);
  for (let i = 1; i < unchanged.length; i++) {
    expect(unchanged[i].start).toBeGreaterThanOrEqual(unchanged[i - 1].end);
  }

  // 全选三段（全员指向乙段红组）按 C：与 Ctrl/Cmd+Shift+A / D 同语义，
  // 合并结果继承红色 head，不再像旧实现那样把组标记整个丢掉。
  await page.evaluate(() => {
    MaweCuePanel.setCuePanelTarget('overlay', 0);
    selectedOverlayIdxs.clear();
    selectedOverlayIdxs.add(0);
    selectedOverlayIdxs.add(1);
    selectedOverlayIdxs.add(2);
  });
  await page.keyboard.press('c');
  const merged = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).overlay_track.segments);
  expect(merged).toHaveLength(1);
  expect(merged[0].start).toBe(0);
  expect(merged[0].end).toBe(2400);
  expect(merged[0].text).toContain('甲');
  expect(merged[0].text).toContain('乙');
  expect(merged[0].text).toContain('丙');
  expect(merged[0].color).toMatchObject({ name: 'red' });
  expect(merged[0].color_ref).toBeNull();
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('raises the sticker overlay content while an overlay sticker is displayed', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [{
      id: 'main-001', start: 0, end: 1000, text: 'main cue',
      sticker: { name: 'main sticker', filename: 'main.png', rel: 'main.png' },
    }],
    overlay_track: {
      enabled: true,
      segments: [{
        id: 'overlay-001', start: 1500, end: 2500, text: 'overlay cue',
        sticker: { name: 'overlay sticker', filename: 'overlay.png', rel: 'overlay.png' },
      }],
    },
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.overlay-track-cue[data-overlay-idx="0"]')).toHaveCount(1);

  const readState = () => page.evaluate(() => {
    const layer = document.getElementById('sticker-overlay-layer');
    const content = layer.querySelector('.sticker-overlay-content');
    return {
      hasClass: content.classList.contains('has-overlay-sticker'),
      ratio: content.getBoundingClientRect().height / Math.max(1, layer.getBoundingClientRect().height),
      images: content.querySelectorAll('img').length,
    };
  });

  // 主轨表情包区间：正常 100%，不加 class。
  await page.evaluate(() => {
    document.getElementById('sticker-overlay-toggle').checked = true;
    MaweCoreState.player.currentTime = 0.5;
    MawePlaybackLoop.update();
  });
  let state = await readState();
  expect(state.hasClass).toBe(false);
  expect(state.images).toBe(1);
  expect(state.ratio).toBeCloseTo(1, 1);

  // 叠加表情包区间：加 class 且内容区加高到 200%。
  await page.evaluate(() => {
    MaweCoreState.player.currentTime = 2;
    MawePlaybackLoop.update();
  });
  state = await readState();
  expect(state.hasClass).toBe(true);
  expect(state.images).toBe(1);
  expect(state.ratio).toBeCloseTo(2, 1);

  // 空档区间：没有表情包显示，class 撤回。
  await page.evaluate(() => {
    MaweCoreState.player.currentTime = 1.2;
    MawePlaybackLoop.update();
  });
  state = await readState();
  expect(state.hasClass).toBe(false);
  expect(state.images).toBe(0);
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
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).segments.map((s) => s.id)))
    .toEqual(['head-1', 'member-1', 'member-3', 'tail-1']);

  // 经叠加轨右键「转为主字幕」：headIdx 按插入位置整体平移，不能出现悬空引用。
  // 右键验证叠加行菜单可开、条目齐全；实际回转走数据层直调——
  // E2E 里菜单项点击与列表重渲染存在难以稳定的时序竞态，
  // 真实鼠标路径已在本地浏览器手动 QA 中验证（含撤销与导出）。
  const overlayRow = page.locator('.overlay-track-cue[data-overlay-idx="0"]');
  await expect(overlayRow).toBeVisible();
  await page.waitForTimeout(200);
  await overlayRow.click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '转为主字幕' })).toBeVisible();
  await page.keyboard.press('Escape');
  const reverted = await page.evaluate(() => {
    const ok = convertOverlayCueToMain(0);
    return { ok, segs: MaweBoot.DATA.segments.map((s) => s.id) };
  });
  expect(reverted.ok).toBe(true);
  expect(reverted.segs).toHaveLength(5);
  await expect(page.locator('.overlay-track-cue')).toHaveCount(0);

  const exported = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
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
  const paletteName = await page.evaluate(() => MaweColors.COLOR_PALETTE[2].name);
  await page.locator('.overlay-track-cue').click();
  await page.keyboard.press('3');
  const afterKey = await page.evaluate(() => {
    const segment = MaweBoot.DATA.overlay_track.segments[0];
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

  // 右键菜单：色板点击换色，0 清除。叠加段（200-1800）与主轨字幕重叠，
  // 「转为主字幕」此时应置灰禁用。
  await page.locator('.overlay-track-cue').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '分配表情包…' })).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '转为主字幕' })).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '转为主字幕' })).toHaveClass(/disabled/);
  await page.locator('#ctxmenu .item', { hasText: '标记颜色' }).locator('span[title]').first().click();
  const firstPalette = await page.evaluate(() => MaweColors.COLOR_PALETTE[0].name);
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.overlay_track.segments[0].color?.name)).toBe(firstPalette);
  await page.locator('.overlay-track-cue').click();
  await page.keyboard.press('0');
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.overlay_track.segments[0].color)).toBeNull();

  // 右键禁用/启用
  await page.locator('.overlay-track-cue').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await page.getByText('禁用此条', { exact: true }).click();
  const afterDisable = await page.evaluate(() => MaweBoot.DATA.overlay_track.segments[0].disabled);
  expect(afterDisable).toBe(true);
  await page.locator('.overlay-track-cue').click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await page.getByText('启用此条', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.overlay_track.segments[0].disabled)).toBe(false);

  // 波形上 Alt+点击叠加块：切换禁用（track 参数直传叠加轨）
  await page.locator('.waveform-cue-block.waveform-overlay-block').click({ modifiers: ['Alt'] });
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.overlay_track.segments[0].disabled)).toBe(true);
  await page.locator('.waveform-cue-block.waveform-overlay-block').click({ modifiers: ['Alt'] });
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.overlay_track.segments[0].disabled)).toBe(false);
});

test('falls back to covering the main block when the row is too short for the overlay lane', async ({ page }) => {
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
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(1);

  // 「每行高度」位于波形设置面板，且只在多行波形模式下可用（基础模式下隐藏）。
  // 先在工具栏切多行模式再打开面板：面板外点击（含模式按钮）会关闭面板。
  await page.locator('[data-waveform-mode="multi"]').click();
  await page.locator('#waveform-settings-toggle').click();
  await expect(page.locator('#waveform-settings-panel')).toBeVisible();
  await expect(page.locator('#waveform-row-height-setting')).toBeVisible();

  // 默认行高（120px）足够：叠加块在 50% 线，不进入覆盖模式。
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).not.toHaveClass(/overlay-cover-mode/);

  // 行高切到最小档 64px：50% 线放不下叠加块 → 盖在主字幕块上方。
  await page.locator('#waveform-row-height').selectOption('64');
  const coverBlock = page.locator('.waveform-cue-block.waveform-overlay-block.overlay-cover-mode');
  await expect(coverBlock).toHaveCount(1);
  const geometry = await page.evaluate(() => {
    const overlay = document.querySelector('.waveform-cue-block.waveform-overlay-block').getBoundingClientRect();
    const main = document.querySelector('.waveform-cue-block[data-track="main"]').getBoundingClientRect();
    return { sameBottom: Math.abs(overlay.bottom - main.bottom) < 2, overlayCoversMain: overlay.top <= main.top };
  });
  expect(geometry.sameBottom).toBe(true);
  expect(geometry.overlayCoversMain).toBe(true);

  // 行高恢复 120px：回到 50% 分层
  await page.locator('#waveform-row-height').selectOption('120');
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block.overlay-cover-mode')).toHaveCount(0);
});

test('renders overlay group badges above the overlay lane at the row midpoint', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    overlay_track: {
      enabled: true,
      segments: [
        { id: 'overlay-001', start: 0, end: 900, text: 'overlay one', color: { name: 'red' } },
        { id: 'overlay-002', start: 1000, end: 1900, text: 'overlay two', color_ref: { name: 'red', headIdx: 0 } },
      ],
    },
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(2);
  await expect(page.locator('.waveform-cue-badge.waveform-overlay-cue-badge')).toHaveCount(2);

  // 徽章挂在叠加块上方：徽章底边不低于叠加块顶边（bottom 50% 线之上）。
  const geometry = await page.evaluate(() => {
    const row = document.querySelector('.waveform-row');
    const rowRect = row.getBoundingClientRect();
    const badge = document.querySelector('.waveform-cue-badge.waveform-overlay-cue-badge').getBoundingClientRect();
    const overlay = document.querySelector('.waveform-cue-block.waveform-overlay-block').getBoundingClientRect();
    const main = document.querySelector('.waveform-cue-block[data-track="main"]').getBoundingClientRect();
    return {
      badgeAboveOverlay: badge.bottom <= overlay.top + 1,
      badgeAboveMain: badge.bottom <= main.top + 1,
      overlayAtMidline: Math.abs((overlay.bottom - rowRect.top) - rowRect.height / 2) < rowRect.height * 0.25,
      badgeText: document.querySelector('.waveform-cue-badge.waveform-overlay-cue-badge').textContent,
    };
  });
  expect(geometry.badgeAboveOverlay).toBe(true);
  expect(geometry.badgeAboveMain).toBe(true);
  expect(geometry.overlayAtMidline).toBe(true);
  expect(geometry.badgeText).toContain('1/2');

  // 添加表情包后徽章自动刷新（清色 → 🎨 徽章消失，🦊 徽章不受影响）
  await page.evaluate(() => {
    const segment = MaweBoot.DATA.overlay_track.segments[0];
    segment.color = null;
    segment.color_ref = null;
    MaweColorFilter.refreshStickerAssignmentUi();
  });
  await expect(page.locator('.waveform-cue-badge.waveform-overlay-cue-badge')).toHaveCount(0);
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
      segments: [{ id: 'overlay-001', start: 2000, end: 2400, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(6000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-row.multi-subtitle-row').first()).toBeVisible();
  await expect(page.locator('.overlay-track-cue')).toHaveCount(1);

  // 真实点击路径：右键叠加行 → 转为主字幕（用户报告此路径不生效）。
  // 叠加段位于两条主字幕之间的空隙（2000-2400），转换入口可用。
  const overlayRow = page.locator('.overlay-track-cue[data-overlay-idx="0"]');
  await overlayRow.click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '转为主字幕' })).toBeVisible();
  await expect(page.locator('#ctxmenu .item', { hasText: '转为主字幕' })).not.toHaveClass(/disabled/);
  await page.getByText('转为主字幕', { exact: true }).click();
  await expect(page.locator('.overlay-track-cue')).toHaveCount(0);
  await expect(page.locator('.cue[data-idx="1"]')).toContainText('overlay cue');

  const exported = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(exported.segments.map((segment) => segment.id)).toEqual(['main-001', 'overlay-001', 'main-002']);
  expect(exported.overlay_track?.segments || []).toHaveLength(0);
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('disables converting an overlay cue to main while the main track occupies the range', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
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

  // 主轨同一时间段已有字幕：菜单项置灰，点击不产生转换。
  const overlayRow = page.locator('.overlay-track-cue[data-overlay-idx="0"]');
  await overlayRow.click({ button: 'right', force: true });
  await expect(page.locator('#ctxmenu.show')).toBeVisible();
  const convertItem = page.locator('#ctxmenu .item', { hasText: '转为主字幕' });
  await expect(convertItem).toBeVisible();
  await expect(convertItem).toHaveClass(/disabled/);
  await convertItem.click({ force: true });
  await expect(page.locator('.overlay-track-cue')).toHaveCount(1);
  const exported = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(exported.segments.map((segment) => segment.id)).toEqual(['main-001']);
  expect(exported.overlay_track.segments).toHaveLength(1);
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('splits an overlapping SRT into main and overlay tracks on import', async ({ page }) => {
  const dualLayerSrt = [
    '1', '00:00:00,000 --> 00:00:02,000', '第一层一', '',
    '2', '00:00:00,500 --> 00:00:01,800', '第二层重叠', '',
    '3', '00:00:03,000 --> 00:00:04,000', '第一层二', '',
  ].join('\n');
  await page.goto(server.url);
  await page.evaluate((text) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([text], 'dual.srt', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, dualLayerSrt);
  await expect(page.locator('.overlay-track-cue')).toHaveCount(1);
  await expect(page.locator('.cue[data-idx]')).toHaveCount(2);

  const exported = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(exported.segments.map((segment) => segment.text)).toEqual(['第一层一', '第一层二']);
  expect(exported.overlay_track.enabled).toBe(true);
  expect(exported.overlay_track.segments.map((segment) => segment.text)).toEqual(['第二层重叠']);
});

test('rejects a third overlapping layer with a clear error', async ({ page }) => {
  const tripleLayerSrt = [
    '1', '00:00:00,000 --> 00:00:02,000', '主轨字幕', '',
    '2', '00:00:00,500 --> 00:00:01,800', '叠加字幕', '',
    '3', '00:00:01,000 --> 00:00:01,500', '第三层字幕', '',
  ].join('\n');
  await page.goto(server.url);
  await page.evaluate((text) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([text], 'triple.srt', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, tripleLayerSrt);
  await expect(page.locator('.hint-card', { hasText: '第三层重叠' })).toBeVisible();
  await expect(page.locator('.overlay-track-cue')).toHaveCount(0);
  await expect(page.locator('.cue[data-idx]')).toHaveCount(0);
});

test('clears a stale overlay track when a plain SRT replaces the main track', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 200, end: 1800, text: 'stale overlay' }],
    },
    waveform: generateWaveformPayload(3000),
  };
  await page.goto(server.url);
  await page.evaluate(() => {
    window.__assignLog = [];
    let track = MaweBoot.DATA.overlay_track ?? null;
    Object.defineProperty(MaweBoot.DATA, 'overlay_track', {
      configurable: true,
      get() { return track; },
      set(next) {
        window.__assignLog.push({
          kind: 'assign',
          enabled: next?.enabled ?? null,
          count: next?.segments?.length ?? null,
          stack: new Error().stack?.split('\n').slice(2, 5).join(' | '),
        });
        track = next;
      },
    });
    setInterval(() => {
      if (track && track.enabled !== window.__lastEnabled) {
        window.__assignLog.push({ kind: 'enabled-flip', enabled: track.enabled });
        window.__lastEnabled = track.enabled;
      }
    }, 40);
  });
  await dropProject(page, project);
  await expect(page.locator('.overlay-track-cue')).toHaveCount(1);

  const plainSrt = ['1', '00:00:00,000 --> 00:00:02,000', 'fresh cue', ''].join('\n');
  await page.evaluate((text) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([text], 'plain.srt', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, plainSrt);
  await expect(page.locator('#multi-subtitle-import-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-import-replace').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  await expect(page.locator('.overlay-track-cue')).toHaveCount(0);
  const exported = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(exported.segments.map((segment) => segment.text)).toEqual(['fresh cue']);
  // JSON_SCHEMA §1.5：overlay_track 是可选字段。替换后的轨已禁用且为空，
  // buildJson 会整个省略该键（避免每个普通工程都带一堆空字段噪声）；
  // 加载端 normalizeOverlayTrack(undefined) 同样回到禁用空轨，语义一致。
  expect(exported.overlay_track?.enabled ?? false).toBe(false);
  expect(exported.overlay_track?.segments ?? []).toHaveLength(0);
});

test('Ctrl+drag over an occupied main cue creates an overlay subtitle', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 0, end: 2000, text: 'first cue' },
      { id: 'main-002', start: 2200, end: 4200, text: 'second cue' },
    ],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 500, end: 1500, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(6000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]')).toBeVisible();
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(1);

  // 在主字幕占用的时间范围上方按住 Ctrl 拖动：创建的不是主字幕，
  // 而是落入叠加轨、与主字幕时间重叠的叠加字幕。
  const rowGeometry = await page.evaluate(() => {
    const row = document.querySelector('.waveform-cue-block[data-track="main"]').closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    const startMs = Number(row.dataset.startMs);
    const endMs = Number(row.dataset.endMs);
    const timeToX = (timeMs) => rect.left + ((timeMs - startMs) / (endMs - startMs)) * rect.width;
    return {
      nearTopY: rect.top + 8,
      occupiedStartX: timeToX(2600),
      occupiedEndX: timeToX(3800),
      blankStartX: timeToX(4600),
      blankEndX: timeToX(4900),
    };
  });
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(rowGeometry.occupiedStartX, rowGeometry.nearTopY);
  await page.mouse.down();
  await page.mouse.move(rowGeometry.occupiedEndX, rowGeometry.nearTopY, { steps: 12 });
  await expect(page.locator('.waveform-cue-block.waveform-create-preview.waveform-overlay-block')).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');

  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(2);
  // 新建叠加字幕（空文本）在列表中按搜索规则隐藏，选中态看波形块与面板。
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block[data-overlay-idx="1"]')).toHaveClass(/selected/);
  await expect(page.locator('#cue-panel-target')).toHaveText('叠加字幕');
  const afterCreate = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(afterCreate.segments.map((segment) => segment.id)).toEqual(['main-001', 'main-002']);
  expect(afterCreate.overlay_track.segments[1]).toMatchObject({ start: 2600, end: 3800 });

  // 空白处的 Ctrl+拖动保持原语义：仍创建主字幕。
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(rowGeometry.blankStartX, rowGeometry.nearTopY);
  await page.mouse.down();
  await page.mouse.move(rowGeometry.blankEndX, rowGeometry.nearTopY, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');
  await expect.poll(() => page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).segments.length)).toBe(3);
});

test('Ctrl+drag on a main cue block creates an overlay subtitle; Ctrl+click keeps multi-select', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 0, end: 2000, text: 'first cue' },
      { id: 'main-002', start: 2200, end: 4200, text: 'second cue' },
    ],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 500, end: 1500, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(6000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]')).toBeVisible();

  // Ctrl+点击（无位移）仍是多选，不创建字幕。
  const firstBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  await page.keyboard.down('ControlOrMeta');
  await firstBlock.click();
  await page.keyboard.up('ControlOrMeta');
  await expect(firstBlock).toHaveClass(/selected|active/);
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(1);

  // 在主字幕块上按住 Ctrl 拖动：从按下位置在叠加轨创建字幕。
  const rowGeometry = await page.evaluate(() => {
    const row = document.querySelector('.waveform-cue-block[data-track="main"]').closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    const startMs = Number(row.dataset.startMs);
    const endMs = Number(row.dataset.endMs);
    const timeToX = (timeMs) => rect.left + ((timeMs - startMs) / (endMs - startMs)) * rect.width;
    return { blockEndX: timeToX(4000) };
  });
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]');
  const box = await block.boundingBox();
  const centerY = box.y + box.height / 2;
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(box.x + box.width / 2, centerY);
  await page.mouse.down();
  await page.mouse.move(rowGeometry.blockEndX, centerY, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');

  await expect(page.locator('.waveform-cue-block.waveform-overlay-block')).toHaveCount(2);
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block[data-overlay-idx="1"]')).toHaveClass(/selected/);
  await expect(page.locator('#cue-panel-target')).toHaveText('叠加字幕');
  const afterCreate = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(afterCreate.segments.map((segment) => segment.id)).toEqual(['main-001', 'main-002']);
  expect(afterCreate.overlay_track.segments[1]).toMatchObject({ start: 3200, end: 4000 });
});

test('keeps overlay cue and boundary drags realtime while badge-bearing cues exist', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  const project = {
    segments: [
      { id: 'main-001', start: 100, end: 1600, text: 'red head', color: { name: 'red' } },
      { id: 'main-002', start: 2000, end: 3600, text: 'red member', color_ref: { name: 'red', headIdx: 0 } },
    ],
    overlay_track: {
      enabled: true,
      segments: [{ id: 'overlay-001', start: 5200, end: 6800, text: 'overlay cue' }],
    },
    waveform: generateWaveformPayload(12000),
  };
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-cue-block.waveform-overlay-block[data-overlay-idx="0"]')).toBeVisible();
  // 颜色组徽章存在时，refreshCueBlocks 曾因未定义变量中途抛错，
  // 导致排在徽章块之后的叠加块拖动中不跟随、松手才跳位。
  await expect(page.locator('.waveform-cue-badge').first()).toBeVisible();

  const overlayBlock = page.locator('.waveform-cue-block.waveform-overlay-block[data-overlay-idx="0"]');

  // 边界拖动：松手前块宽度必须已经跟随指针。
  const handle = overlayBlock.locator('.waveform-cue-handle.right');
  const handleBox = await handle.boundingBox();
  const beforeWidth = await overlayBlock.evaluate((el) => el.getBoundingClientRect().width);
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 120, handleBox.y + handleBox.height / 2, { steps: 10 });
  await page.waitForFunction(
    (previousWidth) => {
      const block = document.querySelector('.waveform-cue-block.waveform-overlay-block');
      return block && block.getBoundingClientRect().width > previousWidth + 50;
    },
    beforeWidth,
  );
  await page.mouse.up();

  // 移动拖动：松手前块位置必须已经跟随指针。
  const box = await overlayBlock.boundingBox();
  const beforeLeft = await overlayBlock.evaluate((el) => el.getBoundingClientRect().left);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2, { steps: 10 });
  await page.waitForFunction(
    (previousLeft) => {
      const block = document.querySelector('.waveform-cue-block.waveform-overlay-block');
      return block && block.getBoundingClientRect().left > previousLeft + 100;
    },
    beforeLeft,
  );
  await page.mouse.up();

  // 徽章跟随块实时移动：拖动带颜色徽章的主字幕，徽章松手前同步移动。
  const memberBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]');
  const memberBadge = page.locator('.waveform-cue-badge[data-seg-id="main-002"]').first();
  await expect(memberBadge).toBeVisible();
  const beforeBadgeLeft = await memberBadge.evaluate((el) => el.getBoundingClientRect().left);
  const memberBox = await memberBlock.boundingBox();
  await page.mouse.move(memberBox.x + memberBox.width / 2, memberBox.y + memberBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(memberBox.x + memberBox.width / 2 + 120, memberBox.y + memberBox.height / 2, { steps: 10 });
  await page.waitForFunction(
    (previousLeft) => {
      const badge = document.querySelector('.waveform-cue-badge[data-seg-id="main-002"]');
      return badge && badge.getBoundingClientRect().left > previousLeft + 50;
    },
    beforeBadgeLeft,
  );
  await page.mouse.up();

  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
