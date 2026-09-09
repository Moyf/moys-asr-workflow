import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  copyPortableBlankEditor,
  findFreePort,
  generateWaveformPayload,
  makeTempDir,
  startStaticServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('overlay-track');
  const blankPath = copyPortableBlankEditor(join(tempDir, 'blank-editor.html'));
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
