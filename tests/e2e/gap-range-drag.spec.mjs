// 空隙范围手势回归：Alt(Option)+左键在空白波形处拖动创建静音空隙。
// macOS 上 Alt 对应 Option，事件层同为 altKey——本用例守住这条跨平台手势，
// 同时验证撤销与普通左键不误触（空白左键仍是清除选中 + seek）。
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  buildPortableBlankEditor, cleanupTempDir, disableOnboarding, findFreePort,
  generateWaveformPayload, makeTempDir, startStaticServer,
} from './helpers.mjs';

let tempDir;
let server;
test.beforeAll(async () => {
  tempDir = makeTempDir('gap-range-drag');
  server = await startStaticServer(buildPortableBlankEditor(join(tempDir, 'blank.html')), await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

async function seed(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate((waveform) => {
    const cue = (id, start, end) => ({ id, start, end, text: id, items: [{ start, end, text: id }] });
    MaweProjectLoad.applyCanonicalProject({ segments: [cue('main', 1000, 2000)], waveform }, 'gap.mosp');
    MaweSettings.EDITOR_SETTINGS.markerEditingEnabled = false;
    const wave = MaweCoreState.waveformEditor;
    wave.settings.mode = 'multi';
    wave.settings.secondsPerRow = 10;
    wave.scroll.style.width = '720px';
    wave.render();
  }, generateWaveformPayload(60000));
  await page.locator('.waveform-row[data-row-index="0"]').waitFor();
}

function gaps(page) {
  return page.evaluate(() => MaweGapRemoveData.getGapRemoveData(true).gaps);
}

// 行内空白区域（避开字幕块/空隙块）按下 Alt+左键并拖出 [startMs, endMs]。
async function altDragEmptyArea(page, startMs, endMs) {
  const geometry = await page.locator('.waveform-row[data-row-index="0"]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left + element.clientLeft, width: element.clientWidth,
      top: rect.top, height: rect.height,
      start: Number(element.dataset.startMs), end: Number(element.dataset.endMs) };
  });
  const msPerPx = (geometry.end - geometry.start) / geometry.width;
  const x1 = geometry.left + (startMs - geometry.start) / msPerPx;
  const x2 = geometry.left + (endMs - geometry.start) / msPerPx;
  // 75% 高度处按下，避开行顶部的标记轨道条（开启标记编辑时会截获左键）。
  const y = geometry.top + geometry.height * 0.75;
  await page.keyboard.down('Alt');
  await page.mouse.move(x1, y);
  await page.mouse.down();
  await page.mouse.move(x2, y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
}

test('Alt+drag on empty waveform creates a manual removed gap and undo restores it', async ({ page }) => {
  await seed(page);
  expect(await gaps(page)).toEqual([]);

  await altDragEmptyArea(page, 5000, 9000);

  // 帮助面板静态 <kbd data-alt-key> 在启动时按平台替换为 Option/Alt。
  const altLabel = await page.evaluate(() => window.AsrEditorUtils.isMacPlatform() ? 'Option' : 'Alt');
  const altKbdTexts = await page.evaluate(() =>
    [...document.querySelectorAll('[data-alt-key]')].map((el) => el.textContent));
  expect(altKbdTexts.length).toBeGreaterThanOrEqual(5);
  for (const text of altKbdTexts) expect(text.startsWith(altLabel)).toBe(true);

  const created = await gaps(page);
  expect(created.length).toBe(1);
  expect(created[0].removed).toBe(true);
  // roundMs(±5ms) + 整数化 clientX 的半像素(≈7ms)余量，避免 Windows 巡检 flake。
  expect(Math.abs(created[0].start - 5000)).toBeLessThanOrEqual(20);
  expect(Math.abs(created[0].end - 9000)).toBeLessThanOrEqual(20);
  await expect(page.locator('.waveform-gap-block')).toHaveCount(1);

  // 面板摘要按平台显示 Alt/Option（macOS 为 Option）。
  await page.evaluate(() => MaweGapRemoveUi.renderGapRemoveList());
  const summary = await page.evaluate(() => document.querySelector('#gap-remove-list .gap-remove-total')?.textContent || '');
  expect(summary).toContain(`${altLabel}+点击切换`);
  expect(summary).toContain(`空白处 ${altLabel}+左键拖动增加`);

  await page.locator('#undo-btn').click();
  expect(await gaps(page)).toEqual([]);
  await expect(page.locator('.waveform-gap-block')).toHaveCount(0);
});

test('plain left drag on empty waveform does not create a gap', async ({ page }) => {
  await seed(page);

  const geometry = await page.locator('.waveform-row[data-row-index="0"]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left + element.clientLeft, width: element.clientWidth,
      top: rect.top, height: rect.height,
      start: Number(element.dataset.startMs), end: Number(element.dataset.endMs) };
  });
  const msPerPx = (geometry.end - geometry.start) / geometry.width;
  const y = geometry.top + geometry.height * 0.75;
  await page.mouse.move(geometry.left + (5000 - geometry.start) / msPerPx, y);
  await page.mouse.down();
  await page.mouse.move(geometry.left + (9000 - geometry.start) / msPerPx, y, { steps: 5 });
  await page.mouse.up();

  expect(await gaps(page)).toEqual([]);
  await expect(page.locator('.waveform-gap-block')).toHaveCount(0);
});
