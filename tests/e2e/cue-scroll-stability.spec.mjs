import { expect, test } from '@playwright/test';
import { startScrollFixture } from './cue-scroll-fixture.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

for (const mode of ['main', 'extension', 'both']) {
  for (const width of [1280, 1920]) {
    for (const index of [75, 100]) {
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
  }
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

test('background saves and delayed waveform preserve nodes focus selection and location', async ({ page }, info) => {
  await open(page);
  await position(page, 100);
  await page.locator('.cue[data-idx="100"] .text').click();
  await page.evaluate(() => {
    window.originalRows = [...container.querySelectorAll(':scope > .cue')];
    window.listRebuilds = 0;
    new MutationObserver(records => {
      listRebuilds += records.filter(r => [...r.removedNodes].some(n => n.classList?.contains('cue'))).length;
    }).observe(container, { childList: true });
    DATA.segments[100]._dirty = true;
    scheduleAutoSave();
    cuePanelText.focus({ preventScroll: true });
    cuePanelText.setSelectionRange(1, 3);
  });
  const before = await visual(page, 100);
  const start = Date.now();
  const saved = await page.waitForResponse(r => r.url().endsWith('/api/project') && r.request().method() === 'POST', { timeout: 35000 });
  expect(saved.ok()).toBe(true);
  expect(Date.now() - start).toBeGreaterThan(28000);
  await stable(page, before, 100, 'default 30s save', info);
  expect(await page.evaluate(() => ({ rebuilds: listRebuilds, same: originalRows.every(n => n.isConnected),
    focus: document.activeElement === cuePanelText, range: [cuePanelText.selectionStart, cuePanelText.selectionEnd],
    selected: [...selectedIdxs], dirty: hasUnsavedProjectChanges() }))).toEqual({
    rebuilds: 0, same: true, focus: true, range: [1, 3], selected: [100], dirty: false,
  });
  await page.locator('#cue-panel-text').fill('合成失焦保存');
  const flushSaved = page.waitForResponse(r => r.url().endsWith('/api/project') && r.request().method() === 'POST');
  await page.locator('#cue-panel-text').blur();
  expect((await flushSaved).ok()).toBe(true);
  await stable(page, before, 100, '400ms save', info);

  let releaseWaveform;
  await page.route('**/synthetic-delayed-waveform', async route => {
    await new Promise(resolve => { releaseWaveform = resolve; });
    await route.fulfill({ json: { ok: true, status: 'ready', waveform_reapeaks: server.project.waveform } });
  });
  await page.evaluate(() => { SERVER_CONFIG.waveformUrl = '/synthetic-delayed-waveform'; void loadDeferredReapeaks();
    cuePanelText.focus({ preventScroll: true }); cuePanelText.setSelectionRange(0, 2); });
  await expect.poll(() => Boolean(releaseWaveform)).toBe(true);
  releaseWaveform();
  await page.waitForFunction(() => Boolean(waveformEditor.reapeaksPayload));
  await stable(page, before, 100, 'deferred waveform', info);
  expect(await page.evaluate(() => listRebuilds)).toBe(0);
  expect(await page.evaluate(() => originalRows.every(n => n.isConnected))).toBe(true);
  expect(await page.evaluate(() => document.activeElement === cuePanelText)).toBe(true);

  await page.route('**/api/project', route => route.fulfill({ status: 500, json: { ok: false, error: '合成保存失败' } }));
  await page.evaluate(() => { DATA.segments[100]._dirty = true; });
  expect(await page.evaluate(() => saveCurrentProject({ silent: true }))).toBe(false);
  expect(await page.evaluate(() => hasUnsavedProjectChanges())).toBe(true);
  expect(await page.evaluate(() => listRebuilds)).toBe(0);
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

for (const mode of ['main', 'extension']) {
  test(`server backup preserves pending ${mode} text and caret`, async ({ page }, info) => {
    await open(page, { mode });
    const kind = mode === 'main' ? 'main' : 'extension';
    await position(page, 75, kind);
    const originalFile = readFileSync(server.projectPath, 'utf8');
    const row = page.locator(textSelector(75, kind, mode));
    await row.dblclick();
    await page.keyboard.insertText('仅备份合成文字');
    await page.evaluate(() => updateEditorSettings({ projectBackupEnabled: true, projectBackupLimit: 1000 }));
    const before = await visual(page, 75, kind);
    const caret = await page.evaluate(() => ({ node: getSelection().anchorNode.textContent, offset: getSelection().anchorOffset }));
    const response = page.waitForResponse(r => r.url().endsWith('/api/project') && r.request().method() === 'POST');
    expect(await page.evaluate(() => saveProjectToServer({ silent: true, backupOnly: true }))).toBe(true);
    const saved = await response;
    expect(saved.ok()).toBe(true);
    const result = await saved.json();
    expect(result.backup).toMatch(/\.mosp-bak$/);
    expect(readFileSync(server.projectPath, 'utf8')).toBe(originalFile);
    const backup = JSON.parse(readFileSync(join(server.directory, '_maw', 'backups', result.backup), 'utf8'));
    const segments = mode === 'main' ? backup.segments : backup.multi_subtitle.tracks[0].segments;
    expect(segments[75].text).toContain('仅备份合成文字');
    expect(await page.evaluate(() => hasUnsavedProjectChanges())).toBe(true);
    expect(await row.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(await page.evaluate(() => ({ node: getSelection().anchorNode.textContent, offset: getSelection().anchorOffset }))).toEqual(caret);
    await stable(page, before, 75, 'backup without changing live viewport', info, kind);
    expect(await page.evaluate(() => saveCurrentProject({ silent: true }))).toBe(true);
    expect(await page.evaluate(() => hasUnsavedProjectChanges())).toBe(false);
  });
}

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

for (const mode of ['main', 'extension', 'both']) {
  test(`playback ownership ${mode}: browse pause resume and click settings`, async ({ page }, info) => {
    await open(page, { mode });
    const kind = mode === 'extension' ? 'extension' : 'main';
    // WebKit honors preload=metadata and may not buffer audio until a real play gesture.
    await page.waitForFunction(() => player.readyState >= 1);
    await position(page, 75, kind);
    await page.evaluate(() => { player.muted = true; player.currentTime = 2.05; lastActive = -1; });
    await page.locator('#media-play-toggle').click();
    await page.waitForFunction(() => !player.paused && player.currentTime > 2.1);
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => {
      const rect = playbackCueListElement().getBoundingClientRect();
      const bounds = cueListVisibleBounds(); return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    })).toBe(true);
    const list = await page.locator('#cues-container').boundingBox();
    await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2);
    await page.mouse.wheel(0, 650);
    await expect(page.locator('#cue-list-follow')).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(400);
    const manual = await page.evaluate(() => container.scrollTop);
    await page.waitForTimeout(2400);
    expect(Math.abs(await page.evaluate(() => container.scrollTop) - manual)).toBeLessThan(1.5);
    await page.evaluate(() => { player.pause(); player.currentTime = 190; });
    await page.waitForTimeout(500);
    expect(Math.abs(await page.evaluate(() => container.scrollTop) - manual)).toBeLessThan(1.5);
    await page.evaluate(async () => { await player.play(); player.pause(); });
    await expect(page.locator('#cue-list-follow')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#cue-list-follow').click();
    await page.waitForTimeout(350);
    await expect(page.locator('#cue-list-follow')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => {
      const rect = playbackCueListElement().getBoundingClientRect();
      const bounds = cueListVisibleBounds(); return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    })).toBe(true);
    // Both click settings run through real clicks; paused seeked/timeupdate cannot override them.
    await position(page, 75, kind);
    await page.evaluate(() => updateEditorSettings({ cueListAutoScrollOnClick: false, clickBehavior: 'select-and-seek' }));
    const before = await visual(page, 75, kind);
    await page.locator(textSelector(75, kind, mode)).click();
    await stable(page, before, 75, 'click scrolling off', info, kind);
    await page.evaluate(() => updateEditorSettings({ cueListAutoScrollOnClick: true }));
    await page.locator(textSelector(77, kind, mode)).click();
    await page.waitForTimeout(350);
    const after = await visual(page, 77, kind);
    await stable(page, after, 77, 'click scrolling on', info, kind);
  });
}

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

for (const mode of ['main', 'extension', 'both']) {
  for (const autoScroll of [false, true]) {
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

test('space input native controls retain activation without changing follow or playback', async ({ page }, info) => {
  await open(page);
  await page.locator('.cue[data-idx="0"] .text').click();
  const settings = page.locator('#cue-list-settings-toggle');
  await settings.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#cue-list-settings-panel')).toBeVisible();
  expect((await playbackState(page)).following).toBe(true);
  const checkbox = page.locator('#cue-list-auto-scroll-on-click');
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  const state = await playbackState(page);
  expect(state.following).toBe(true);
  expect(state.paused).toBe(true);
  expect(state.time).toBe(0);
  await info.attach('native button and checkbox', { body: JSON.stringify(state), contentType: 'application/json' });
});

test('space input split modal keeps lane shortcuts and list ownership', async ({ page }, info) => {
  await open(page, { mode: 'both', paired: true });
  const row = page.locator(textSelector(1, 'main', 'both'));
  await row.click();
  await row.hover({ position: { x: 15, y: 10 } });
  await page.keyboard.press('b');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  const lane = page.locator('#multi-subtitle-split-main-text');
  await lane.focus();
  const locked = () => page.evaluate(() => splitLaneLocked(pendingLinkedSplit, 'main'));
  const before = await locked();
  await page.keyboard.press('Space');
  expect(await locked()).toBe(!before);
  // Locking a lane focuses its unconfirmed partner; return to the same lane
  // before checking that a second Space unlocks it.
  await lane.focus();
  await page.keyboard.press('Space');
  expect(await locked()).toBe(before);
  const state = await playbackState(page);
  expect(state.following).toBe(true);
  expect(state.paused).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await info.attach('modal spaces', { body: JSON.stringify(state), contentType: 'application/json' });
});

test('space input repeats and focused playback controls preserve prior following', async ({ page }, info) => {
  await open(page);
  await page.waitForFunction(() => player.readyState >= 1);
  await page.evaluate(() => { player.muted = true; });
  await observeSpacePlayback(page);
  await page.locator('.cue[data-idx="0"] .text').click();
  await page.keyboard.down('Space');
  await expect.poll(async () => (await playbackState(page)).events.some(e => e.type === 'playing')).toBe(true);
  await expect.poll(async () => (await playbackState(page)).time).toBeGreaterThan(0.1);
  await page.keyboard.down('Space'); // trusted repeat; one physical hold must not toggle twice
  await page.keyboard.up('Space');
  expect((await playbackState(page)).paused).toBe(false);
  expect((await playbackState(page)).following).toBe(true);
  expect((await playbackState(page)).events.filter(e => e.type === 'play')).toHaveLength(1);
  expect((await playbackState(page)).events.filter(e => e.type === 'pause')).toHaveLength(0);
  await page.locator('#media-play-toggle').focus();
  await spacePlayback(page, true, true, info, 'focused media button: pause');
  const list = await page.locator('#cues-container').boundingBox();
  await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2);
  await page.mouse.wheel(0, 650);
  await page.waitForTimeout(400);
  await page.locator('#media-play-toggle').focus();
  await spacePlayback(page, false, false, info, 'focused media button after browsing: play');
  await spacePlayback(page, false, true, info, 'focused media button after browsing: pause');
});

test('list scrolling keys still interrupt following and pending compensation', async ({ page }, info) => {
  await open(page);
  for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'End', 'Home']) {
    await position(page, 75);
    await page.locator('.cue[data-idx="75"] .text').click();
    await page.evaluate(() => { player.currentTime = 150.05; });
    await page.locator('#cue-list-follow').click();
    await page.waitForTimeout(350);
    await page.locator('#cues-container').focus();
    const before = await page.evaluate(() => {
      renderAll(); return { top: container.scrollTop, generation: cueListScroll.generation };
    });
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    const after = await playbackState(page);
    expect(after.following).toBe(false);
    expect(Math.abs(after.top - before.top)).toBeGreaterThan(1.5);
    expect(await page.evaluate(() => cueListScroll.generation)).toBeGreaterThan(before.generation);
    await page.waitForTimeout(2100);
    const late = await playbackState(page);
    expect(Math.abs(late.top - after.top)).toBeLessThan(1.5);
    expect(await page.evaluate(() => cueListScroll.owner)).toBe(null);
    await info.attach(key, { body: JSON.stringify({ before, after, late }), contentType: 'application/json' });
  }
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

for (const mode of ['main', 'extension', 'both']) {
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

test('paired dual tracks keep their source during split merge and history', async ({ page }, info) => {
  await open(page, { mode: 'both', paired: true });
  await position(page, 75);
  const selector = '.cue[data-idx="75"] .multi-cue-column.main .text';
  await page.locator(selector).click();
  await page.locator(selector).hover({ position: { x: 15, y: 10 } });
  const before = await visual(page, 75);
  await page.keyboard.press('b');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-split-auto-submit').uncheck();
  for (const lane of ['#multi-subtitle-split-main-text', '#multi-subtitle-split-text']) {
    // Character gaps can have zero width. Use the supported keyboard flow,
    // skipping a lane if the B cursor already fixed its split position.
    if (!await page.locator(lane).isVisible()) continue;
    await page.locator(lane).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
  }
  await page.locator('#multi-subtitle-split-confirm').click();
  await stable(page, before, 75, 'paired B', info);
  expect(await page.evaluate(() => [DATA.segments.length, getActiveExtensionTrack().segments.length])).toEqual([108, 108]);
  await page.keyboard.press(undoKey);
  await stable(page, before, 75, 'paired undo B', info);
  await page.locator(selector).click();
  await page.locator('.cue[data-idx="76"] .multi-cue-column.main .text').click({ modifiers: ['Shift'] });
  const mergeBefore = await visual(page, 75);
  await page.keyboard.press('c');
  await stable(page, mergeBefore, 75, 'paired C', info);
  expect(await page.evaluate(() => [DATA.segments.length, getActiveExtensionTrack().segments.length])).toEqual([106, 106]);
  await page.keyboard.press(undoKey);
  await stable(page, mergeBefore, 75, 'paired undo C', info);
  expect(await page.evaluate(() => getMultiSubtitleState().bindings.length)).toBe(107);
});
