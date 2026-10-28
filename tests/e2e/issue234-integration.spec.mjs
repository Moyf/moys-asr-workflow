import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav,
  makeTempDir, startBlankServer, startServer } from './helpers.mjs';

const source = (end, withMedia = false) => ({
  ...(withMedia ? { media: 'synthetic.wav' } : {}),
  segments: [{ start: 100, end, text: 'Legacy cue', items: [], _dirty: true }],
});
const importPaths = changes => changes.map(change => change.path);
const dirty = page => page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges());
const readState = page => page.evaluate(() => ({
  dirty: MaweServerSave.hasUnsavedProjectChanges(),
  highlighted: Boolean(MaweBoot.DATA.segments[0]?._dirty),
  end: MaweBoot.DATA.segments[0]?.end,
  changes: MaweJsonRepair.lastImportReport,
}));
async function openBrowserFile(page, value, filename = 'legacy.mosp') {
  return page.evaluate(async ({ value, filename }) => MaweMultiImport.openProjectFile(
    new File([JSON.stringify(value)], filename, { type: 'application/json' }),
    { suppressMediaPrompt: true },
  ), { value, filename });
}

let temp, blank;
test.beforeAll(async () => {
  temp = makeTempDir('issue234-import-state');
  blank = await startBlankServer(await findFreePort(), join(temp, 'blank-settings'));
});
test.afterAll(async () => {
  await blank?.stop();
  cleanupTempDir(temp);
});
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1',
    JSON.stringify({ autoSaveProject: false })));
});

test('browser File import: legacy defaults and _dirty are clean; timing repair survives failed save', async ({ page }) => {
  await page.goto(blank.url);
  await page.waitForFunction(() => typeof window.MaweMultiImport?.openProjectFile === 'function');

  expect(await openBrowserFile(page, source(200), 'clean.mosp')).toBe(true);
  let state = await readState(page);
  expect(state.dirty).toBe(false);
  expect(state.highlighted).toBe(false);
  expect(importPaths(state.changes)).toEqual(['$.schema', '$.segments[0].id']);

  expect(await openBrowserFile(page, source(100), 'repaired.mosp')).toBe(true);
  state = await readState(page);
  expect(state.end).toBe(200); // C repairs invalid cue duration to at least 100 ms.
  expect(state.highlighted).toBe(false); // Old file flags are session-only.
  expect(state.dirty).toBe(true);
  expect(state.changes).toContainEqual({ path: '$.segments[0].end', kind: 'replace', before: 100, after: 200 });

  // Real handle write path, with a deliberately failed createWritable first.
  await page.evaluate(() => {
    MaweServerSave.projectFileHandle = { name: 'repaired.mosp',
      createWritable: async () => { throw new Error('synthetic write failure'); } };
  });
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(false);
  expect(await dirty(page)).toBe(true);

  await page.evaluate(() => {
    window.importStateSavedJson = null;
    MaweServerSave.projectFileHandle = { name: 'repaired.mosp', createWritable: async () => ({
      write: async blob => { window.importStateSavedJson = await blob.text(); },
      close: async () => {},
    }) };
  });
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
  expect(await dirty(page)).toBe(false);
  const saved = await page.evaluate(() => JSON.parse(window.importStateSavedJson));
  expect(saved.segments[0].end).toBe(200);
  expect(JSON.stringify(saved)).not.toContain('"_dirty"');
});

test('Server startup: defaults stay clean; actual repair is reported and needs successful disk save', async ({ page }) => {
  const media = join(temp, 'synthetic.wav');
  generateWav(media, 2);
  for (const [label, end, shouldBeDirty] of [['clean', 200, false], ['repaired', 100, true]]) {
    const project = join(temp, `${label}.mosp`);
    const raw = JSON.stringify(source(end, true));
    writeFileSync(project, raw);
    const bound = await startServer(project, media, await findFreePort());
    try {
      await page.goto(bound.url);
      await page.waitForFunction(() => typeof window.MaweProjectSave?.saveProjectToServer === 'function');
      const state = await readState(page);
      expect(state.dirty, label).toBe(shouldBeDirty);
      expect(state.highlighted, label).toBe(false);
      expect(state.end, label).toBe(200);
      expect(importPaths(state.changes), label).toContain('$.schema');
      expect(importPaths(state.changes), label).toContain('$.segments[0].id');
      expect(importPaths(state.changes).includes('$.segments[0].end'), label).toBe(shouldBeDirty);
      expect(readFileSync(project, 'utf8')).toBe(raw);
      if (!shouldBeDirty) continue;

      await page.route('**/api/project', route => route.fulfill({
        status: 500, json: { ok: false, error: 'synthetic write failure' },
      }));
      expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer({ silent: true }))).toBe(false);
      expect(await dirty(page)).toBe(true);
      expect(readFileSync(project, 'utf8')).toBe(raw);
      await page.unroute('**/api/project');

      expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer({ silent: true }))).toBe(true);
      expect(await dirty(page)).toBe(false);
      const saved = JSON.parse(readFileSync(project, 'utf8'));
      expect(saved.segments[0].end).toBe(200);
      expect(JSON.stringify(saved)).not.toContain('"_dirty"');
      await page.reload();
      await page.waitForFunction(() => typeof window.MaweJsonRepair?.lastImportReport !== 'undefined');
      expect((await readState(page)).changes).toEqual([]);
      expect(await dirty(page)).toBe(false);
    } finally {
      await bound.stop();
    }
  }
});

test('D/E follow-on: FPS intent and v1.5 group membership share the persistence checkpoint', async ({ page }) => {
  await page.goto(blank.url);
  await page.waitForFunction(() => typeof window.MaweMultiImport?.openProjectFile === 'function');
  const supportsV15 = await page.evaluate(() => window.AsrEditorUtils.supportsProjectSchema({ schema: 'moy.asr.project.v1.5' }));
  expect(supportsV15).toBe(true);
  const input = {
    schema: 'moy.asr.project.v1.5',
    timebase: { unit: 'milliseconds', fps: 30, fps_source: 'auto' },
    subtitle_groups: { color: [{ id: 'color-1', value: { name: 'blue' } }], sticker: [] },
    segments: [{ id: 'main-1', start: 100, end: 200, text: 'Grouped', items: [], color_group_id: 'color-1' }],
  };
  expect(await openBrowserFile(page, input, 'grouped.mosp')).toBe(true);
  expect(await dirty(page)).toBe(false);
  let saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.schema).toBe('moy.asr.project.v1.5');
  expect(saved.timebase.fps_source).toBe('auto');
  expect(saved.subtitle_groups.color[0].id).toBe('color-1');
  expect(saved.segments[0].color_group_id).toBe('color-1');
  await page.evaluate(() => { MaweBoot.DATA.timebase.fps_source = 'user'; });
  expect(await dirty(page)).toBe(true);
  await page.evaluate(() => {
    MaweState.establishProjectCheckpoint();
    MaweBoot.DATA.subtitle_groups.color[0].value.name = 'green';
  });
  expect(await dirty(page)).toBe(true);
  saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.subtitle_groups.color[0].value.name).toBe('green');
});


test('project subtitle import uses the same v1.5 validation and preserves zero-width items', async ({ page }) => {
  await page.goto(blank.url);
  await page.waitForFunction(() => typeof window.MaweLoadingProgress?.parseSubtitleImportFile === 'function');
  const result = await page.evaluate(async () => {
    const value = { schema: 'moy.asr.project.v1.5', subtitle_groups: { color: [], sticker: [] },
      timebase: { unit: 'milliseconds', fps: 30, fps_source: 'user' },
      segments: [{ id: 'cue', start: 0, end: 1000, text: 'punctuation，', items: [{ start: 500, end: 500, text: '，' }] }] };
    const parse = value => MaweLoadingProgress.parseSubtitleImportFile(new File([JSON.stringify(value)], 'subtitle.mosp'));
    const cues = await parse(value);
    const rejected = [];
    for (const modify of [p => p.timebase.fps_source = [], p => p.segments[0].sticker = { name: 'legacy' },
      p => p.segments[0].sticker_group_id = 'missing', p => p.schema = 'moy.asr.project.v99']) {
      const bad = JSON.parse(JSON.stringify(value)); modify(bad);
      try { await parse(bad); rejected.push(false); } catch (_) { rejected.push(true); }
    }
    return { items: cues[0].items, groups: cues.subtitle_groups, rejected };
  });
  expect(result.items).toEqual([{ start: 500, end: 500, text: '，' }]);
  expect(result.groups).toEqual({ color: [], sticker: [] });
  expect(result.rejected).toEqual([true, true, true, true]);
});

test('picker replaces an existing group head without splitting its members', async ({ page }) => {
  await page.goto(blank.url);
  await page.waitForFunction(() => typeof window.MaweMultiImport?.openProjectFile === 'function');
  const input = { schema: 'moy.asr.project.v1.5', subtitle_groups: {
    color: [{ id: 'color-1', value: { name: 'blue', value: '#0000ff' } }],
    sticker: [{ id: 'sticker-1', value: { name: 'first', filename: 'first.png' } }],
  }, segments: [
    { id: 'one', start: 1000, end: 3000, text: 'one', color_group_id: 'color-1', sticker_group_id: 'sticker-1' },
    { id: 'two', start: 5000, end: 7000, text: 'two', color_group_id: 'color-1', sticker_group_id: 'sticker-1' },
  ] };
  expect(await openBrowserFile(page, input)).toBe(true);
  const result = await page.evaluate(() => {
    MaweStickerPicker.assignColor([0], 'red');
    MaweStickerPicker.stickerTargetIdxs = [0];
    MaweStickerPicker.assignSticker({ name: 'replacement', filename: 'replacement.png' });
    return { groups: MaweBoot.DATA.subtitle_groups, cues: MaweBoot.DATA.segments,
      range: window.AsrEditorUtils.subtitleGroupRanges(MaweBoot.DATA).map(r => [r.start, r.end]) };
  });
  expect(result.cues.map(c => c.color_group_id)).toEqual(['color-1', 'color-1']);
  expect(result.cues.map(c => c.sticker_group_id)).toEqual(['sticker-1', 'sticker-1']);
  expect(result.groups.color).toEqual([{ id: 'color-1', value: { name: 'red', value: '#f07f6f' } }]);
  expect(result.groups.sticker).toEqual([{ id: 'sticker-1', value: { name: 'replacement', filename: 'replacement.png' } }]);
  expect(result.range).toEqual([[1000, 7000]]);
  expect(await dirty(page)).toBe(true);
});
