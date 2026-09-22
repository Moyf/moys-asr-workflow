import { expect, test } from '@playwright/test';
import { startScrollFixture } from './cue-scroll-fixture.mjs';

let server;
let pageErrors;
test.afterEach(async () => {
  await server?.stop(); server = null;
  expect(pageErrors || []).toEqual([]);
});

async function open(page, options = {}) {
  server = await startScrollFixture(options);
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === new URL(server.url).origin || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue() : route.abort();
  });
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({
    cueListAutoScrollOnClick: false, clickBehavior: 'select-only', splitAutoSubmit: false,
  })));
  await page.goto(server.url);
  await page.waitForFunction(() => typeof renderAll === 'function' && DATA.segments.length > 0);
  await page.locator('#editor-loading').waitFor({ state: 'hidden' }).catch(() => {});
}

const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

function textSelector(index, kind = 'main') {
  return `.cue[data-${kind === 'main' ? 'idx' : 'ext-idx'}="${index}"] > .text`;
}

// 本文件是 #124 滚动稳定性重构的回归套件；功能稳定后仅保留最便宜的核心骨架：
// 完整编辑流、播放跟随、滚动打断、身份稳定与原始回归，控制日常开发的全量耗时。
// 重矩阵（视口/行位置/轨道模式组合、30s 自动保存、备份、配对双轨等）如需恢复，
// 从本文件的 git 历史取回。

test('undo after browsing keeps current viewport and restores selection identity', async ({ page }, info) => {
  await open(page);
  await position(page, 75);
  await page.evaluate(() => mergeSegments([75, 76]));
  await page.waitForTimeout(300);
  await position(page, 25);
  const before = await visual(page, 25);
  await page.keyboard.press(undoKey);
  await stable(page, before, 25, 'undo after browsing', info);
  const state = await page.evaluate(() => ({ selected: [...selectedIdxs].map(i => DATA.segments[i]?.id),
    panel: getCurrentCuePanelTarget()?.segment?.id || null }));
  expect(state.selected.every(Boolean)).toBe(true);
});

test('save in flight retains newer edits and inline caret', async ({ page }, info) => {
  await open(page);
  await position(page, 75);
  const text = page.locator('.cue[data-idx="75"] .text');
  await text.dblclick();
  await page.keyboard.insertText('第一次合成改字');
  let releaseSave;
  await page.route('**/api/project', async route => {
    await new Promise(resolve => { releaseSave = resolve; });
    await route.continue();
  });
  await page.evaluate(() => { window.pendingSave = saveCurrentProject({ silent: true }); });
  await expect.poll(() => Boolean(releaseSave)).toBe(true);
  await page.keyboard.insertText('在途新改字');
  const before = await visual(page, 75);
  const caret = await page.evaluate(() => ({ node: getSelection().anchorNode.textContent, offset: getSelection().anchorOffset }));
  releaseSave();
  expect(await page.evaluate(() => pendingSave)).toBe(true);
  await stable(page, before, 75, 'in-flight edit', info);
  expect(await page.evaluate(() => ({ node: getSelection().anchorNode.textContent, offset: getSelection().anchorOffset }))).toEqual(caret);
  expect(await text.getAttribute('contenteditable')).toBe('plaintext-only');
  expect(await page.evaluate(() => hasUnsavedProjectChanges())).toBe(true);
});

async function position(page, index = 100, kind = 'main') {
  await page.evaluate(({ index, kind }) => {
    player.pause();
    clearSelection({ silent: true });
    const row = container.querySelector(kind === 'main' ? `.cue[data-idx="${index}"]` : `.cue[data-ext-idx="${index}"]`);
    row.scrollIntoView({ block: 'center' });
  }, { index, kind });
  await page.waitForTimeout(400);
}

// Exercise the real keyboard/media event path. No product functions are replaced;
// synthetic audio advances through native playback timeupdate.
async function playbackState(page) {
  return page.evaluate(() => {
    const bounds = cueListVisibleBounds();
    const active = playbackCueListElement();
    const rect = active?.getBoundingClientRect();
    return { following: cueListScroll.following, paused: player.paused, time: player.currentTime,
      top: container.scrollTop,
      activeId: active?.dataset.mainId || active?.dataset.extId,
      activeVisible: Boolean(rect && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1) };
  });
}


test('space input text and inline editing', async ({ page }, info) => {
  await open(page);
  const row = page.locator(textSelector(0));
  await row.click();
  const panel = page.locator('#cue-panel-text');
  await panel.fill('甲乙');
  await panel.evaluate(el => el.setSelectionRange(1, 1));
  await page.keyboard.press('Space');
  await expect(panel).toHaveValue('甲 乙');
  await panel.blur();
  await row.dblclick();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.insertText('丙');
  await page.keyboard.press('Space');
  await page.keyboard.insertText('丁');
  expect((await row.textContent()).replace(/\u00a0/g, ' ')).toBe('丙 丁');
  const state = await playbackState(page);
  expect(state.following).toBe(true);
  expect(state.paused).toBe(true);
  expect(state.time).toBe(0);
  await info.attach('text spaces', { body: JSON.stringify(state), contentType: 'application/json' });
});

async function visual(page, index, kind = 'main') {
  return page.evaluate(({ index, kind }) => {
    const row = container.querySelector(kind === 'main' ? `.cue[data-idx="${index}"]` : `.cue[data-ext-idx="${index}"]`);
    const segment = kind === 'main' ? DATA.segments[index] : getActiveExtensionTrack().segments[index];
    return { id: segment.id, top: row.getBoundingClientRect().top - container.getBoundingClientRect().top,
      scrollTop: container.scrollTop, text: segment.text, start: segment.start, end: segment.end };
  }, { index, kind });
}

async function stable(page, before, index, label, info, kind = 'main') {
  await page.waitForTimeout(350);
  const after = await visual(page, index, kind);
  await page.waitForTimeout(2100);
  const late = await visual(page, index, kind);
  await info.attach(label, { body: JSON.stringify({ before, after, late }), contentType: 'application/json' });
  expect(Math.abs(after.top - before.top), `${label}: initial drift`).toBeLessThan(1.5);
  expect(Math.abs(late.top - after.top), `${label}: delayed drift`).toBeLessThan(1.5);
  return after;
}

test('original near-end merge and undo regression', async ({ page }, info) => {
  await open(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await position(page);
  await page.locator('.cue[data-idx="100"] .text').click();
  await page.locator('.cue[data-idx="101"] .text').click({ modifiers: ['Shift'] });
  const before = await visual(page, 100);
  await page.screenshot({ path: `${server.directory}/original-before-${info.project.name}.png` });
  await page.keyboard.press('c');
  const merged = await stable(page, before, 100, 'merge', info);
  await page.screenshot({ path: `${server.directory}/original-merged-${info.project.name}.png` });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await stable(page, merged, 100, 'undo', info);
  await page.screenshot({ path: `${server.directory}/original-undo-${info.project.name}.png` });
  const restored = await visual(page, 100);
  expect(restored.id).toBe(before.id);
  expect(restored.text).toBe(before.text);
  expect([restored.start, restored.end]).toEqual([before.start, before.end]);
});

test.describe('touch interruption', () => {
  test.use({ hasTouch: true });
  test('trusted touch cancels pending layout compensation', async ({ page }, info) => {
    await open(page);
    await position(page, 75);
    const list = await page.locator('#cues-container').boundingBox();
    const generation = await page.evaluate(() => { renderAll(); return cueListScroll.generation; });
    await page.touchscreen.tap(list.x + list.width / 2, list.y + list.height / 2);
    expect(await page.evaluate(() => cueListScroll.generation)).toBeGreaterThan(generation);
    expect(await page.evaluate(() => cueListScroll.following)).toBe(false);
    await page.waitForTimeout(350);
    const before = await visual(page, 75);
    await stable(page, before, 75, 'touch interruption', info);
  });
});
