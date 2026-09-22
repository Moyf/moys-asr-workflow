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
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z';

function textSelector(index, kind, mode) {
  if (mode === 'both') return `.cue[data-${kind === 'main' ? 'idx' : 'ext-idx'}="${index}"] .multi-cue-column.${kind} .text`;
  return `.cue[data-${kind === 'main' ? 'idx' : 'ext-idx'}="${index}"] > .text`;
}

// 本文件是 #124 滚动稳定性重构的回归套件；功能稳定后仅保留最便宜的核心骨架：
// 完整编辑流、播放跟随、滚动打断、身份稳定与原始回归，控制日常开发的全量耗时。
// 重矩阵（视口/行位置/轨道模式组合、30s 自动保存、备份、配对双轨等）如需恢复，
// 从本文件的 git 历史取回。
for (const { mode, width, index } of [
  { mode: 'main', width: 1280, index: 100 },
]) {
  test(`editing matrix ${mode} ${width} row ${index}`, async ({ page }, info) => {
      await open(page, { mode });
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 1080 });
      const kind = mode === 'extension' ? 'extension' : 'main';
      await position(page, index, kind);
      const selector = textSelector(index, kind, mode);
      await page.locator(selector).click();
      await page.locator(textSelector(index + 1, kind, mode)).click({ modifiers: ['Shift'] });
      // Long unbound dual rows can make the second click expose only the
      // bottom of the source row. Explicitly place that source below the toolbar.
      await page.evaluate(({ index, kind }) => scrollCueToCenter(container.querySelector(
        `.cue[data-${kind === 'main' ? 'idx' : 'ext-idx'}="${index}"]`)), { index, kind });
      await page.waitForTimeout(300);
      const original = await visual(page, index, kind);
      await page.keyboard.press('c');
      const merged = await stable(page, original, index, 'C', info, kind);
      expect(merged.id).not.toBe(original.id);
      await page.keyboard.press(undoKey);
      await stable(page, merged, index, 'undo C', info, kind);
      expect((await visual(page, index, kind)).id).toBe(original.id);
      await page.keyboard.press(redoKey);
      await stable(page, merged, index, 'redo C', info, kind);
      await page.keyboard.press(undoKey);
      await page.waitForTimeout(300);

      // Resize a cold list without traversing it, then split at a real UI cursor.
      await page.setViewportSize({ width: width - 120, height: width === 1280 ? 860 : 1020 });
      await page.waitForTimeout(300);
      await page.locator(selector).click();
      await page.locator(selector).hover({ position: { x: 15, y: 10 } });
      const beforeSplit = await visual(page, index, kind);
      await page.keyboard.press('b');
      if (await page.locator('#multi-subtitle-split-modal').evaluate(el => el.classList.contains('show'))) {
        await page.locator('#multi-subtitle-split-auto-submit').uncheck();
        const lane = kind === 'main' ? '#multi-subtitle-split-main-text' : '#multi-subtitle-split-text';
        const gaps = page.locator(`${lane} .multi-subtitle-split-gap`);
        if (await gaps.count()) await gaps.nth(Math.floor((await gaps.count()) / 2)).click();
        await page.locator('#multi-subtitle-split-confirm').click();
      }
      const left = await stable(page, beforeSplit, index, 'B after resize', info, kind);
      expect(left.id).not.toBe(beforeSplit.id);
      expect(left.start).toBe(beforeSplit.start);
      expect(left.end).toBeLessThan(beforeSplit.end);
      // Undo retains the view being read, even though the edit panel selects the right half.
      await page.keyboard.press(undoKey);
      await stable(page, left, index, 'undo B', info, kind);

      const beforeEdit = await visual(page, index, kind);
      await page.locator(selector).dblclick();
      await page.keyboard.insertText('合成改字');
      await page.evaluate(() => { if (editingState) finishEdit(true); if (extensionEditingState) finishExtensionEdit(true); });
      await stable(page, beforeEdit, index, 'inline edit', info, kind);
      await page.locator(selector).click();
      const nearby = await page.evaluate(({ index, kind }) => {
        const source = container.querySelector(`.cue[data-${kind === 'main' ? 'idx' : 'ext-idx'}="${index}"]`);
        const origin = source.getBoundingClientRect().top;
        const bounds = container.getBoundingClientRect();
        return [...container.querySelectorAll(':scope > .cue')].filter(el => el !== source)
          .map(el => ({ id: el.dataset.mainId || el.dataset.extId,
            key: el.dataset.mainId ? 'mainId' : 'extId', top: el.getBoundingClientRect().top - bounds.top,
            distance: Math.abs(el.getBoundingClientRect().top - origin) }))
          .filter(row => row.top >= 0 && row.top < bounds.height)
          .sort((a, b) => a.distance - b.distance).slice(0, 2);
      }, { index, kind });
      await page.keyboard.press('Delete');
      await page.locator('#delete-confirm-modal.show').count().then(async count => {
        if (count) throw new Error('Unexpected delete confirmation; update the test UI flow');
      });
      await page.waitForTimeout(350);
      const readNeighbors = () => page.evaluate(nearby => nearby.map(old => {
        const row = [...container.querySelectorAll(':scope > .cue')].find(el => el.dataset[old.key] === old.id);
        return row ? { ...old, now: row.getBoundingClientRect().top - container.getBoundingClientRect().top } : null;
      }).filter(Boolean), nearby);
      const afterDelete = await readNeighbors();
      await page.waitForTimeout(2100);
      const lateDelete = await readNeighbors();
      await info.attach('delete nearby surviving rows', { body: JSON.stringify({ nearby, afterDelete, lateDelete }), contentType: 'application/json' });
      expect(Math.min(...afterDelete.map(row => Math.abs(row.now - row.top)))).toBeLessThan(1.5);
      expect(lateDelete.map(row => row.id)).toEqual(afterDelete.map(row => row.id));
      expect(Math.max(...lateDelete.map((row, i) => Math.abs(row.now - afterDelete[i].now))))
        .toBeLessThan(1.5);
      expect(Math.min(...lateDelete.map(row => Math.abs(row.now - row.top)))).toBeLessThan(1.5);
      expect(await page.evaluate(({ kind, id }) => (kind === 'main' ? DATA.segments : getActiveExtensionTrack().segments)
        .some(s => s.id === id), { kind, id: beforeEdit.id })).toBe(false);
  });
}

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

test('thousand-row lazy layout and rebuild performance', async ({ page }, info) => {
  await open(page, { count: 1000 });
  await position(page, 975);
  const result = await page.evaluate(async () => {
    const rows = [...container.querySelectorAll(':scope > .cue')];
    let rebuilds = 0;
    const observer = new MutationObserver(records => {
      rebuilds += records.filter(r => [...r.removedNodes].some(n => n.classList?.contains('cue'))).length;
    });
    observer.observe(container, { childList: true });
    const times = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now(); renderAll({ waveform: 'none' }); times.push(performance.now() - start);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const editRebuilds = rebuilds;
    const savedStart = performance.now(); markProjectSaved('synthetic.mosp', null, { silent: true });
    const saveMs = performance.now() - savedStart;
    await new Promise(resolve => setTimeout(resolve, 300));
    observer.disconnect();
    return { count: rows.length, lazy: getComputedStyle(rows[0]).contentVisibility,
      liveLazy: getComputedStyle(container.querySelector('.cue')).contentVisibility,
      editRebuilds, saveRebuilds: rebuilds - editRebuilds, times, saveMs,
      skipped: [...container.querySelectorAll('.cue .text')].filter(el => !el.checkVisibility({ contentVisibilityAuto: true })).length };
  });
  await info.attach('performance', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.count).toBe(1000);
  expect(result.liveLazy).toBe('auto');
  expect(result.skipped).toBeGreaterThan(500);
  expect(result.saveRebuilds).toBe(0);
});

test('wheel scrollbar keyboard and rapid actions cancel old compensation', async ({ page }, info) => {
  await open(page);
  const list = await page.locator('#cues-container').boundingBox();
  for (const input of ['wheel', 'scrollbar', 'keyboard']) {
    await position(page, 75);
    await page.evaluate(() => { renderAll(); });
    if (input === 'wheel') {
      await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2);
      await page.mouse.wheel(0, 320);
    } else if (input === 'scrollbar') {
      await page.mouse.move(list.x + list.width - 3, list.y + list.height * 0.7);
      await page.mouse.down();
      await page.mouse.move(list.x + list.width - 3, list.y + list.height * 0.35, { steps: 5 });
      await page.mouse.up();
    } else {
      await page.locator('#cues-container').focus();
      await page.keyboard.press('PageDown');
    }
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => ({ top: container.scrollTop, owner: cueListScroll.owner,
      following: cueListScroll.following }));
    await page.waitForTimeout(2100);
    expect(await page.evaluate(() => cueListScroll.owner)).toBe(null);
    expect(state.following).toBe(false);
    expect(Math.abs(await page.evaluate(() => container.scrollTop) - state.top)).toBeLessThan(1.5);
    await info.attach(input, { body: JSON.stringify(state), contentType: 'application/json' });
  }
  await position(page, 75);
  await page.evaluate(() => {
    mergeSegments([75, 76]);
    performUndo(); performRedo(); performUndo();
    scrollCueToCenter(container.querySelector('.cue[data-idx="20"]'));
  });
  await page.waitForTimeout(350);
  const before = await visual(page, 20);
  await stable(page, before, 20, 'latest navigation owns rapid edits', info);
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
async function observeSpacePlayback(page) {
  await page.evaluate(() => {
    if (window.spacePlaybackEvents) return;
    window.spacePlaybackEvents = [];
    for (const type of ['play', 'playing', 'pause', 'seeking', 'seeked']) {
      player.addEventListener(type, () => spacePlaybackEvents.push({
        type, time: player.currentTime, paused: player.paused, readyState: player.readyState,
      }));
    }
  });
}

async function playbackState(page) {
  return page.evaluate(() => {
    const bounds = cueListVisibleBounds();
    const active = playbackCueListElement();
    const rect = active?.getBoundingClientRect();
    return { following: cueListScroll.following, paused: player.paused, time: player.currentTime,
      top: container.scrollTop, events: window.spacePlaybackEvents || [],
      activeId: active?.dataset.mainId || active?.dataset.extId,
      activeVisible: Boolean(rect && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1) };
  });
}

async function spacePlayback(page, following, paused, info, label) {
  await observeSpacePlayback(page);
  const before = await playbackState(page);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await playbackState(page)).paused).toBe(paused);
  await expect.poll(async () => (await playbackState(page)).events.slice(before.events.length)
    .some(e => e.type === (paused ? 'pause' : 'playing')), { timeout: 15000 }).toBe(true);
  if (!paused) await expect.poll(async () => (await playbackState(page)).time).toBeGreaterThan(before.time + 0.2);
  const after = await playbackState(page);
  await page.waitForTimeout(paused ? 350 : 100);
  const late = await playbackState(page);
  // WebKit can reconcile an extrapolated currentTime with the media backend
  // just after pause. Check the stopped clock after that asynchronous update,
  // as well as native events, so a double toggle or continued playback still fails.
  if (paused) await page.waitForTimeout(350);
  const settled = paused ? await playbackState(page) : late;
  await info.attach(label, { body: JSON.stringify({ before, after, late, settled }), contentType: 'application/json' });
  expect(after.following).toBe(following);
  expect(late.following).toBe(following);
  expect(settled.following).toBe(following);
  expect(late.paused).toBe(paused);
  expect(settled.paused).toBe(paused);
  const events = settled.events.slice(before.events.length);
  expect(events.filter(e => e.type === 'play')).toHaveLength(paused ? 0 : 1);
  expect(events.filter(e => e.type === 'pause')).toHaveLength(paused ? 1 : 0);
  expect(events.filter(e => e.type === 'seeking')).toHaveLength(0);
  await expect(page.locator('#cue-list-follow')).toHaveAttribute('aria-pressed', String(following));
  if (paused) expect(Math.abs(settled.time - late.time)).toBeLessThan(0.05);
  if (!following || paused) expect(Math.abs(settled.top - before.top)).toBeLessThan(1.5);
}

for (const mode of ['main']) {
  for (const autoScroll of [true]) {
    test(`space input playback matrix ${mode} click scroll ${autoScroll}`, async ({ page }, info) => {
      await open(page, { mode });
      await page.waitForFunction(() => player.readyState >= 1);
      await page.evaluate(autoScroll => {
        player.muted = true; player.playbackRate = 8;
        updateEditorSettings({ cueListAutoScrollOnClick: autoScroll });
      }, autoScroll);
      const kind = mode === 'extension' ? 'extension' : 'main';
      await page.locator(textSelector(0, kind, mode)).click();
      await page.waitForTimeout(350);
      await spacePlayback(page, true, false, info, 'selected cue: play');
      await spacePlayback(page, true, true, info, 'pause');
      await spacePlayback(page, true, false, info, 'play again');
      const initial = await playbackState(page);
      await expect.poll(async () => (await playbackState(page)).top, { timeout: 12000 }).toBeGreaterThan(initial.top + 30);
      await expect.poll(async () => (await playbackState(page)).activeVisible).toBe(true);
      const followed = await playbackState(page);
      expect(followed.time).toBeGreaterThan(initial.time);
      expect(followed.activeId).not.toBe(initial.activeId);
      await info.attach('native playback leaves original viewport and follows', {
        body: JSON.stringify({ initial, followed }), contentType: 'application/json' });
      await page.screenshot({ path: `${server.directory}/space-follow-${info.project.name}.png` });

      const list = await page.locator('#cues-container').boundingBox();
      await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2);
      await page.mouse.wheel(0, 1600);
      await expect.poll(async () => (await playbackState(page)).following).toBe(false);
      await page.waitForTimeout(400);
      await spacePlayback(page, false, true, info, 'manual browsing: pause');
      await spacePlayback(page, false, false, info, 'manual browsing: play');
      const browsed = await playbackState(page);
      // Native media can buffer, especially in WebKit.
      // Wait for actual advancement, then independently measure delayed drift.
      await expect.poll(async () => (await playbackState(page)).time, { timeout: 15000 }).toBeGreaterThan(browsed.time + 2);
      await page.waitForTimeout(2100);
      const browsedLate = await playbackState(page);
      expect(browsedLate.time).toBeGreaterThan(browsed.time + 2);
      expect(Math.abs(browsedLate.top - browsed.top)).toBeLessThan(1.5);
      expect(browsedLate.following).toBe(false);

      await page.locator('#cue-list-follow').click();
      await expect.poll(async () => (await playbackState(page)).activeVisible).toBe(true);
      await page.waitForTimeout(300);
      await spacePlayback(page, true, true, info, 'follow button restored: pause');
      await spacePlayback(page, true, false, info, 'follow button restored: play');
    });
  }

  test(`space input text and inline editing ${mode}`, async ({ page }, info) => {
    await open(page, { mode });
    const kind = mode === 'extension' ? 'extension' : 'main';
    const row = page.locator(textSelector(0, kind, mode));
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
}

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

test('legacy rows receive stable identities before merge rendering', async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => {
    DATA.segments = DATA.segments.map(({ id, ...segment }) => segment);
    renderAll();
  });
  expect(await page.evaluate(() => new Set(DATA.segments.map(s => s.id)).size)).toBe(107);
  await position(page, 100);
  const before = await visual(page, 100);
  await page.evaluate(() => mergeSegments([100, 101]));
  await stable(page, before, 100, 'legacy identity merge', info);
  await page.evaluate(() => performUndo());
  await stable(page, before, 100, 'legacy identity undo', info);
});

for (const mode of ['main']) {
  test(`selection identity ${mode} survives repeated merge undo redo`, async ({ page }, info) => {
    await open(page, { mode });
    const kind = mode === 'extension' ? 'extension' : 'main';
    await position(page, 75, kind);
    await page.evaluate(kind => {
      if (kind === 'main') { selectOnly(75); addToSelection(76); setCurrentCuePanelIndex(76); }
      else { selectOnlyExtension(75); addExtensionToSelection(76); setCurrentCuePanelExtensionIndex(76); }
    }, kind);
    const before = await visual(page, 75, kind);
    const expectedSelection = await page.evaluate(kind => ({
      ids: [...(kind === 'main' ? selectedIdxs : selectedExtensionIdxs)].map(i =>
        (kind === 'main' ? DATA.segments : getActiveExtensionTrack().segments)[i].id),
      panelId: getCurrentCuePanelTarget().segment.id,
    }), kind);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(kind => kind === 'main' ? mergeSegments([75, 76]) : mergeExtensionSegments([75, 76]), kind);
      await page.waitForTimeout(25);
      await page.evaluate(() => performUndo());
      expect(await page.evaluate(kind => ({
        ids: [...(kind === 'main' ? selectedIdxs : selectedExtensionIdxs)].map(i =>
          (kind === 'main' ? DATA.segments : getActiveExtensionTrack().segments)[i].id),
        panelId: getCurrentCuePanelTarget().segment.id,
      }), kind)).toEqual(expectedSelection);
      await page.waitForTimeout(25);
      await page.evaluate(() => performRedo());
      expect(await page.evaluate(() => getCurrentCuePanelTarget().segment.id)).toContain('-merged');
      await page.waitForTimeout(25);
      await page.evaluate(() => performUndo());
    }
    await stable(page, before, 75, 'repeated asynchronous history', info, kind);
  });
}

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
