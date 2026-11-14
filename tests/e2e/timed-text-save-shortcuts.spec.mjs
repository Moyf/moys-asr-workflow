import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUtilsModule } from '../../web/shared/utils/project-tracks.js';
import { disableOnboarding, findFreePort, generateWav, makeTempDir, startServer } from './helpers.mjs';

let server;
test.beforeAll(async () => {
  // Keep all synthetic fixtures and browser artifacts for red/green comparison.
  const dir = makeTempDir('timed-text-save-shortcuts');
  const media = join(dir, 'synthetic.wav');
  const project = join(dir, 'project.mosp');
  generateWav(media, 3);
  writeFileSync(project, JSON.stringify(createUtilsModule().importProject({ media: 'synthetic.wav', preserve_punctuation: true,
    segments: [{ id: 'save-1', start: 0, end: 1000, text: 'Original first', items: [] },
      { id: 'save-2', start: 1200, end: 2200, text: 'Original second', items: [] }] }).project));
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  expect(await page.evaluate(() => MaweServerSave.requiresMigrationSaveAs)).toBe(false);
  await page.evaluate(() => {
    window.__applyCount = 0;
    window.__saveKeys = [];
    MaweCommands.onBeforeBegin(label => { if (label === '纯文本编辑') window.__applyCount += 1; });
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        setTimeout(() => window.__saveKeys.push(event.defaultPrevented), 0);
      }
    }, true);
  });
});

const draftText = 'Applied modal draft';
const modal = page => page.locator('#timed-text-edit-modal');
const warning = page => page.locator('#hint-stack .hint-warning').last();
async function editDraft(page, { single = false, english = false } = {}) {
  if (english) await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await page.locator('#timed-text-edit-btn').click();
  // Opening schedules an initial focus; wait for it before a test moves focus.
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toBeFocused();
  if (single) {
    await page.locator('#timed-text-edit-view [data-view="single"]').click();
    await page.locator('#timed-text-edit-single-textarea').fill(`${draftText}\nOriginal second`);
  } else await page.locator('#timed-text-edit-rows textarea').first().fill(draftText);
}
async function routeSave(page, status = 200) {
  const payloads = [];
  const url = new URL(await page.evaluate(() => MaweBoot.SERVER_CONFIG.saveUrl), server.url).href;
  await page.route(url, async route => {
    payloads.push(route.request().postDataJSON().project);
    await route.fulfill({ status, contentType: 'application/json',
      body: JSON.stringify(status === 200 ? { ok: true, filename: 'saved.mosp' } : { ok: false, error: 'Synthetic save failure' }) });
  });
  return payloads;
}
async function state(page) {
  return page.evaluate(() => ({ text: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text,
    dirty: MaweServerSave.hasUnsavedProjectChanges(), applies: window.__applyCount,
    draft: MaweDom.timedTextEditDraft?.texts[0] ?? null, inFlight: MaweServerSave.projectSaveInFlight }));
}
function firstText(project) { return project.tracks.find(track => track.role === 'main').segments[0].text; }
async function expectAppliedUnsaved(page, english = false) {
  await expect(modal(page)).not.toHaveClass(/show/);
  await expect(warning(page)).toContainText(english ? 'Edits were applied, but the project was not saved' : '编辑已应用，但工程未保存');
  expect(await state(page)).toMatchObject({ text: draftText, dirty: true, applies: 1, draft: null, inFlight: false });
}
async function mockFileSave(page, outcome, saveAs = true) {
  await page.evaluate(({ outcome, saveAs }) => {
    window.__filePayloads = [];
    window.__pickerCalls = 0;
    const handle = { name: 'saved-as.mosp', async createWritable() {
      if (outcome === 'failed') throw new Error('Synthetic write failure');
      if (outcome === 'cancelled' && !saveAs) throw new DOMException('Cancelled', 'AbortError');
      return { async write(blob) { window.__filePayloads.push(JSON.parse(await blob.text())); }, async close() {} };
    } };
    if (saveAs) window.showSaveFilePicker = async () => {
      window.__pickerCalls += 1;
      if (outcome === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
      return handle;
    };
    else MaweServerSave.projectFileHandle = handle;
  }, { outcome, saveAs });
}

for (const [key, single] of [['Control+s', false], ['Meta+s', true]]) {
  test(`${key} applies ${single ? 'single' : 'row'} draft before the actual server payload`, async ({ page }) => {
    const payloads = await routeSave(page);
    await editDraft(page, { single });
    await page.keyboard.press(key);
    await expect.poll(() => payloads.length).toBe(1);
    expect(firstText(payloads[0])).toBe(draftText);
    await expect.poll(() => state(page)).toMatchObject({ text: draftText, dirty: false, applies: 1, draft: null, inFlight: false });
    expect(await page.evaluate(() => window.__saveKeys)).toEqual([true]);
  });
}

for (const failure of ['invalid-report', 'cannot-apply', 'exception', 'stale', 'stale-items', 'stale-style']) {
  test(`blocks save on ${failure}, warns and keeps the draft`, async ({ page }) => {
    const payloads = await routeSave(page);
    await mockFileSave(page, 'saved');
    await editDraft(page, { english: true });
    await page.evaluate(failure => {
      if (failure.startsWith('stale')) {
        MaweCommands.run('external edit', () => {
          const segment = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0];
          if (failure === 'stale-items') segment.items = [{ text: segment.text, start: 0, end: 900 }];
          else if (failure === 'stale-style') segment.style = { alignment: 7 };
          else segment.text = 'External edit';
        });
      } else {
        const original = window.AsrEditorUtils;
        window.AsrEditorUtils = { ...original,
          ...(failure === 'invalid-report'
            ? { buildTimedTextEditReport: (...args) => ({ ...original.buildTimedTextEditReport(...args), valid: false }) }
            : { applyTimedTextEdit: () => { if (failure === 'exception') throw new Error('Synthetic apply failure'); return null; } }),
        };
      }
    }, failure);
    await page.keyboard.press(failure === 'stale-items' ? 'Control+Shift+s' : 'Control+s');
    await expect(warning(page)).toContainText(failure.startsWith('stale') ? 'The subtitles changed' : 'Cannot apply text changes');
    await expect(warning(page)).not.toContainText(/[\u4e00-\u9fff]/);
    await expect(modal(page)).toHaveClass(/show/);
    await expect(page.locator('#timed-text-edit-rows textarea').first()).toHaveValue(draftText);
    expect(payloads).toEqual([]);
    expect(await page.evaluate(() => window.__pickerCalls)).toBe(0);
    expect(await state(page)).toMatchObject({ text: failure === 'stale' ? 'External edit' : 'Original first', draft: draftText, applies: 0 });
    expect(await page.evaluate(() => window.__saveKeys)).toEqual([true]);
    await page.screenshot({ path: test.info().outputPath(`${failure}.png`) });
  });
}

test('server save failure keeps applied edits dirty; retry does not apply again', async ({ page }) => {
  const payloads = await routeSave(page, 500);
  await editDraft(page);
  await page.keyboard.press('Control+s');
  await expectAppliedUnsaved(page);
  expect(payloads).toHaveLength(1);
  expect(firstText(payloads[0])).toBe(draftText);
  const retry = await routeSave(page);
  await page.keyboard.press('Control+s');
  await expect.poll(() => retry.length).toBe(1);
  await expect.poll(() => state(page)).toMatchObject({ text: draftText, dirty: false, applies: 1 });
});

for (const outcome of ['saved', 'failed', 'cancelled']) {
  test(`save-as ${outcome} reports its result and preserves the applied state`, async ({ page }) => {
    const payloads = await routeSave(page);
    await mockFileSave(page, outcome);
    await editDraft(page, { english: outcome === 'cancelled' });
    await page.keyboard.press('Control+Shift+s');
    if (outcome === 'saved') {
      await expect.poll(() => state(page)).toMatchObject({ dirty: false, applies: 1, draft: null, inFlight: false });
      expect(await page.evaluate(() => window.__filePayloads.map(project => project.tracks.find(track => track.role === 'main').segments[0].text))).toEqual([draftText]);
      await expect(page.locator('#json-name')).toHaveText('saved-as.mosp');
      await expect(warning(page)).toHaveCount(0);
    } else {
      await expectAppliedUnsaved(page, outcome === 'cancelled');
      expect(await page.evaluate(() => window.__filePayloads)).toEqual([]);
      await mockFileSave(page, 'saved');
      await page.keyboard.press('Control+Shift+s');
      await expect.poll(() => state(page)).toMatchObject({ dirty: false, applies: 1, draft: null });
    }
    expect(payloads).toEqual([]);
  });
}

test('normal save cancellation at an existing file handle keeps applied edits dirty', async ({ page }) => {
  await mockFileSave(page, 'cancelled', false);
  await editDraft(page);
  await page.keyboard.press('Control+s');
  await expectAppliedUnsaved(page);
  expect(await page.evaluate(() => window.__filePayloads)).toEqual([]);
});

test('save-as download fallback reports uncertainty and retains dirty state', async ({ page }) => {
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  await editDraft(page, { english: true });
  const downloadEvent = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+s');
  const download = await downloadEvent;
  await download.saveAs(test.info().outputPath('download-fallback.mosp'));
  await expect(warning(page)).toContainText('Edits were applied, but project saving could not be confirmed');
  expect(await state(page)).toMatchObject({ text: draftText, dirty: true, applies: 1, draft: null });
});

test('configured save key works on modal buttons while physical text-save remains available', async ({ page }) => {
  const payloads = await routeSave(page);
  await page.evaluate(() => MaweShortcuts.setBinding('save', 'F2'));
  await editDraft(page);
  await page.evaluate(() => document.addEventListener('keydown', event => {
    if (event.key === 'F2') window.__f2Target = { target: event.target?.id, active: document.activeElement?.id };
  }, { capture: true, once: true }));
  await page.locator('#timed-text-edit-cancel').focus();
  await expect(page.locator('#timed-text-edit-cancel')).toBeFocused();
  await page.keyboard.press('F2');
  expect(await page.evaluate(() => window.__f2Target)).toEqual({ target: 'timed-text-edit-cancel', active: 'timed-text-edit-cancel' });
  await expect.poll(() => payloads.length).toBe(1);
  expect(firstText(payloads[0])).toBe(draftText);
  await expect.poll(() => state(page)).toMatchObject({ inFlight: false, applies: 1 });
  await editDraft(page);
  await page.locator('#timed-text-edit-rows textarea').first().fill('Second edit');
  await page.keyboard.press('Control+s');
  await expect.poll(() => payloads.length).toBe(2);
  expect(firstText(payloads[1])).toBe('Second edit');
});

test('unmodified save keys do not steal typing or apply drafts from a text field', async ({ page }) => {
  const payloads = await routeSave(page);
  await editDraft(page);
  await page.evaluate(() => MaweShortcuts.setBinding('save', 'p'));
  const textarea = page.locator('#timed-text-edit-rows textarea').first();
  await textarea.press('End');
  await textarea.press('p');
  await expect(textarea).toHaveValue(`${draftText}p`);
  await page.evaluate(() => MaweShortcuts.setBinding('save', 'F2'));
  await textarea.press('F2');
  await expect(modal(page)).toHaveClass(/show/);
  expect(payloads).toEqual([]);
  expect(await state(page)).toMatchObject({ applies: 0, draft: `${draftText}p` });
});

test('unchanged draft can save; repeated and composing key events cannot apply it', async ({ page }) => {
  const payloads = await routeSave(page);
  await editDraft(page);
  await page.evaluate(() => {
    for (const flags of [{ repeat: true }, { isComposing: true }]) {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true, ...flags }));
    }
  });
  expect(payloads).toEqual([]);
  expect(await state(page)).toMatchObject({ applies: 0, draft: draftText });
  await page.locator('#timed-text-edit-rows textarea').first().fill('Original first');
  await page.keyboard.press('Control+s');
  await expect.poll(() => payloads.length).toBe(1);
  expect(firstText(payloads[0])).toBe('Original first');
  expect(await state(page)).toMatchObject({ applies: 0 });
});

test('F3 retains modal search semantics even when configured for save', async ({ page }) => {
  const payloads = await routeSave(page);
  await page.evaluate(() => MaweShortcuts.setBinding('save', 'F3'));
  await editDraft(page);
  await page.locator('#timed-text-edit-find').fill('Original');
  await expect(page.locator('#timed-text-edit-search-count')).toHaveText('1/1');
  await page.locator('#timed-text-edit-cancel').focus();
  await page.keyboard.press('F3');
  await expect(modal(page)).toHaveClass(/show/);
  await expect(page.locator('#timed-text-edit-rows textarea').nth(1)).toBeFocused();
  expect(payloads).toEqual([]);
  expect(await state(page)).toMatchObject({ applies: 0, draft: draftText });
});

test('default Ctrl and Meta save keys suppress browser save in other modals', async ({ page }) => {
  const payloads = await routeSave(page);
  await page.evaluate(async () => {
    await MaweTextProcess.openTextProcessModal();
    window.__modalKeyAudit = [];
    document.getElementById('text-process-modal').addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        setTimeout(() => window.__modalKeyAudit.push(event.defaultPrevented), 0);
      }
    });
  });
  await expect(page.locator('#text-process-modal')).toHaveClass(/show/);
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Meta+s');
  await page.keyboard.press('Control+Shift+s');
  await page.keyboard.press('Meta+Shift+s');
  await expect.poll(() => page.evaluate(() => window.__modalKeyAudit)).toEqual([true, true, true, true]);
  expect(payloads).toEqual([]);
});

test('default save keys are suppressed in a native subtitle offset dialog', async ({ page }) => {
  const payloads = await routeSave(page);
  await page.evaluate(() => {
    MaweSegmentOps.openSubtitleTimeOffsetModal([0]);
    window.__nativeSaveAudit = [];
    document.getElementById('subtitle-time-offset-dialog').addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        setTimeout(() => window.__nativeSaveAudit.push(event.defaultPrevented), 0);
      }
    });
  });
  await expect(page.locator('#subtitle-time-offset-dialog')).toHaveAttribute('open', '');
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Meta+Shift+s');
  await expect.poll(() => page.evaluate(() => window.__nativeSaveAudit)).toEqual([true, true]);
  expect(payloads).toEqual([]);
});

test('refresh failure after a real commit closes the draft without applying twice', async ({ page }) => {
  const payloads = await routeSave(page);
  await editDraft(page);
  await page.evaluate(() => {
    const original = MaweViewUpdates;
    window.MaweViewUpdates = { ...original, invalidate(...args) {
      window.MaweViewUpdates = original;
      throw new Error('Synthetic post-commit refresh failure');
    } };
  });
  await page.keyboard.press('Control+s');
  await expect(modal(page)).not.toHaveClass(/show/);
  await expect(warning(page)).toContainText('界面刷新失败');
  await expect.poll(() => payloads.length).toBe(1);
  expect(firstText(payloads[0])).toBe(draftText);
  expect(await state(page)).toMatchObject({ text: draftText, applies: 1, draft: null });
  await page.keyboard.press('Control+s');
  await expect.poll(() => payloads.length).toBe(2);
  expect(await state(page)).toMatchObject({ applies: 1 });
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('Original first');
});


for (const busy of ['load', 'save', 'checkpoint']) {
  test(`busy ${busy} keeps the draft and explains that saving must be retried`, async ({ page }) => {
    const payloads = await routeSave(page);
    await editDraft(page, { english: busy !== 'load' });
    await page.evaluate(kind => {
      if (kind === 'load') window.__busyGeneration = MaweState.beginProjectLoad();
      else if (kind === 'save') MaweServerSave.projectSaveInFlight = true;
      else MaweServerSave.projectCheckpointInFlight = true;
    }, busy);
    await page.keyboard.press('Control+s');
    if (busy === 'load') {
      await expect(warning(page)).toContainText('草稿已保留，未应用或保存');
      await expect(warning(page)).toContainText('请稍后重试');
    } else {
      await expect(warning(page)).toContainText('The project is busy');
      await expect(warning(page)).toContainText('not applied or saved and has been kept');
      await expect(warning(page)).toContainText('try again');
    }
    await expect(modal(page)).toHaveClass(/show/);
    await expect(page.locator('#timed-text-edit-rows textarea').first()).toHaveValue(draftText);
    expect(payloads).toEqual([]);
    expect(await state(page)).toMatchObject({ text: 'Original first', applies: 0, draft: draftText });
    await page.evaluate(kind => {
      if (kind === 'load') MaweState.finishProjectLoad(window.__busyGeneration);
      else if (kind === 'save') MaweServerSave.projectSaveInFlight = false;
      else MaweServerSave.projectCheckpointInFlight = false;
    }, busy);
    await page.keyboard.press('Control+s');
    await expect.poll(() => payloads.length).toBe(1);
    expect(firstText(payloads[0])).toBe(draftText);
  });
}


test('a real in-flight server save does not silently swallow a modal save request', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let notifyArrived;
  const arrived = new Promise(resolve => { notifyArrived = resolve; });
  const url = new URL(await page.evaluate(() => MaweBoot.SERVER_CONFIG.saveUrl), server.url).href;
  const payloads = [];
  await page.route(url, async route => {
    payloads.push(route.request().postDataJSON().project);
    if (payloads.length === 1) { notifyArrived(); await held; }
    await route.fulfill({ json: { ok: true, filename: 'saved.mosp' } });
  });
  await editDraft(page, { english: true });
  await page.evaluate(() => { window.__pendingServerSave = MaweProjectSave.saveCurrentProject(); });
  await arrived;
  expect(await page.evaluate(() => MaweServerSave.projectSaveInFlight)).toBe(true);
  await page.keyboard.press('Control+s');
  await expect(warning(page)).toContainText('draft was not applied or saved');
  await expect(modal(page)).toHaveClass(/show/);
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toHaveValue(draftText);
  expect(payloads).toHaveLength(1);
  expect(firstText(payloads[0])).toBe('Original first');
  release();
  expect(await page.evaluate(() => window.__pendingServerSave)).toBe(true);
  await page.keyboard.press('Control+s');
  await expect.poll(() => payloads.length).toBe(2);
  expect(firstText(payloads[1])).toBe(draftText);
});


test('an actual pending checkpoint picker warns and preserves the draft until retry', async ({ page }) => {
  const payloads = await routeSave(page);
  await editDraft(page, { english: true });
  await page.evaluate(() => {
    window.__checkpointPickerStarted = false;
    window.showSaveFilePicker = () => {
      window.__checkpointPickerStarted = true;
      return new Promise((resolve, reject) => { window.__cancelCheckpoint = () => reject(new DOMException('Cancelled', 'AbortError')); });
    };
    window.__checkpointResult = MaweProjectLoad.createProjectCheckpoint(MaweProjectLoad.buildBlankProject(), 'new.mosp');
  });
  await expect.poll(() => page.evaluate(() => window.__checkpointPickerStarted)).toBe(true);
  expect(await page.evaluate(() => [MaweState.projectLoadPending, MaweServerSave.projectCheckpointInFlight])).toEqual([true, true]);
  await page.keyboard.press('Meta+s');
  await expect(warning(page)).toContainText('draft was not applied or saved');
  await expect(modal(page)).toHaveClass(/show/);
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toHaveValue(draftText);
  expect(payloads).toEqual([]);
  await page.evaluate(() => window.__cancelCheckpoint());
  expect(await page.evaluate(() => window.__checkpointResult)).toBe(false);
  expect(await page.evaluate(() => [MaweState.projectLoadPending, MaweServerSave.projectCheckpointInFlight])).toEqual([false, false]);
  await page.keyboard.press('Control+s');
  await expect.poll(() => payloads.length).toBe(1);
  expect(firstText(payloads[0])).toBe(draftText);
});


test('unchanged draft save cancellation reports no save without claiming edits applied', async ({ page }) => {
  await mockFileSave(page, 'cancelled');
  await page.locator('#timed-text-edit-btn').click();
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toBeFocused();
  await page.keyboard.press('Control+Shift+s');
  await expect.poll(() => page.evaluate(() => window.__pickerCalls)).toBe(1);
  await expect(warning(page)).toContainText('工程未保存');
  await expect(warning(page)).not.toContainText('编辑已应用');
  await expect(modal(page)).toHaveClass(/show/);
  expect(await state(page)).toMatchObject({ applies: 0, draft: 'Original first' });
});

test('stale draft warning tells users to copy their retained work before reopening', async ({ page }) => {
  await routeSave(page);
  await editDraft(page, { english: true });
  await page.evaluate(() => MaweCommands.run('external edit', () => {
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text = 'External edit';
  }));
  await page.keyboard.press('Control+s');
  await expect(warning(page)).toContainText('draft was kept');
  await expect(warning(page)).toContainText('copy');
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toHaveValue(draftText);
  await expect(modal(page)).toHaveClass(/show/);
});


test('English unchanged save failure clearly reports the project was not saved', async ({ page }) => {
  await mockFileSave(page, 'cancelled');
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await page.locator('#timed-text-edit-btn').click();
  await expect(page.locator('#timed-text-edit-rows textarea').first()).toBeFocused();
  await page.keyboard.press('Control+Shift+s');
  await expect(warning(page)).toContainText('The project was not saved');
  await expect(warning(page)).not.toContainText('Edits were applied');
  await expect(modal(page)).toHaveClass(/show/);
});
