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
  highlighted: Boolean(MaweBoot.DATA.tracks.find(t => t.role === 'main').segments[0]?._dirty),
  end: MaweBoot.DATA.tracks.find(t => t.role === 'main').segments[0]?.end,
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

async function installMigrationPicker(page) {
  await page.evaluate(() => {
    window.migrationWrites = [];
    window.migrationNames = [];
    window.migrationFailWrite = false;
    window.showSaveFilePicker = async options => {
      window.migrationNames.push(options.suggestedName);
      return { name: options.suggestedName, getFile: async () => ({ size: 0 }),
        createWritable: async () => {
          if (window.migrationFailWrite) throw new Error('synthetic write failure');
          return { write: async blob => window.migrationWrites.push(await blob.text()), close: async () => {} };
        } };
    };
  });
}
async function expectMigrationPending(page) {
  expect(await dirty(page)).toBe(true);
  expect(await page.evaluate(() => MaweServerSave.requiresMigrationSaveAs)).toBe(true);
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(false);
  expect(await page.evaluate(() => ({ names: migrationNames, writes: migrationWrites }))).toEqual({ names: [], writes: [] });
}
async function saveMigration(page) {
  await page.evaluate(() => MaweProjectSave.saveCurrentProject());
  const result = await page.evaluate(() => ({ names: migrationNames, writes: migrationWrites.map(JSON.parse),
    pending: MaweServerSave.requiresMigrationSaveAs }));
  expect(result.writes).toHaveLength(1);
  expect(result.pending).toBe(false);
  expect(result.writes[0].schema).toBe('moy.asr.project.v2');
  expect(await dirty(page)).toBe(false);
  return result;
}

test('browser File import: legacy migration preserves timing repair through failed and successful Save As', async ({ page }) => {
  await page.goto(blank.url);
  await page.waitForFunction(() => typeof window.MaweMultiImport?.openProjectFile === 'function');
  await installMigrationPicker(page);
  expect(await openBrowserFile(page, source(200), 'clean.mosp')).toBe(true);
  let state = await readState(page);
  expect(state.highlighted).toBe(false);
  expect(importPaths(state.changes)).toEqual(expect.arrayContaining(['$.schema', '$.segments', '$.tracks']));
  await expectMigrationPending(page);

  expect(await openBrowserFile(page, source(100), 'repaired.mosp')).toBe(true);
  state = await readState(page);
  expect(state.end).toBe(200);
  expect(state.highlighted).toBe(false);
  expect(importPaths(state.changes)).toEqual(expect.arrayContaining(['$.segments', '$.tracks']));
  await expectMigrationPending(page);
  await page.evaluate(() => { migrationFailWrite = true; });
  await page.evaluate(() => MaweProjectSave.saveCurrentProject());
  expect(await page.evaluate(() => migrationWrites)).toEqual([]);
  expect(await dirty(page)).toBe(true);
  expect(await page.evaluate(() => MaweServerSave.requiresMigrationSaveAs)).toBe(true);
  await page.evaluate(() => { migrationFailWrite = false; });
  const result = await saveMigration(page);
  expect(result.names).toEqual(['repaired_v2.mosp', 'repaired_v2.mosp']);
  expect(result.writes[0].tracks.find(t => t.role === 'main').segments[0].end).toBe(200);
  expect(JSON.stringify(result.writes[0])).not.toContain('"_dirty"');
});

test('Server startup: legacy source stays untouched while repairs are saved to a new v2 file', async ({ page }) => {
  const media = join(temp, 'synthetic.wav');
  generateWav(media, 2);
  for (const [label, end] of [['clean', 200], ['repaired', 100]]) {
    const project = join(temp, `${label}.mosp`);
    const raw = JSON.stringify(source(end, true));
    writeFileSync(project, raw);
    const bound = await startServer(project, media, await findFreePort());
    try {
      await page.goto(bound.url);
      await page.waitForFunction(() => typeof window.MaweProjectSave?.saveProjectToServer === 'function');
      await installMigrationPicker(page);
      const state = await readState(page);
      expect(state.highlighted, label).toBe(false);
      expect(state.end, label).toBe(200);
      expect(importPaths(state.changes), label).toContain('$.schema');
      expect(importPaths(state.changes), label).toEqual(expect.arrayContaining(['$.segments', '$.tracks']));
      await expectMigrationPending(page);
      expect(readFileSync(project, 'utf8')).toBe(raw);
      const result = await saveMigration(page);
      expect(result.names).toEqual([`${label}_v2.mosp`]);
      expect(result.writes[0].tracks.find(t => t.role === 'main').segments[0].end).toBe(200);
      expect(JSON.stringify(result.writes[0])).not.toContain('"_dirty"');
      expect(readFileSync(project, 'utf8')).toBe(raw);
    } finally {
      await bound.stop();
    }
  }
});

test('D/E follow-on: FPS intent and v1.5 group membership survive migration and checkpoints', async ({ page }) => {
  await page.goto(blank.url);
  await page.waitForFunction(() => typeof window.MaweMultiImport?.openProjectFile === 'function');
  expect(await page.evaluate(() => window.AsrEditorUtils.supportsProjectSchema({ schema: 'moy.asr.project.v1.5' }))).toBe(true);
  const input = {
    schema: 'moy.asr.project.v1.5',
    timebase: { unit: 'milliseconds', fps: 30, fps_source: 'auto' },
    subtitle_groups: { color: [{ id: 'color-1', value: { name: 'blue' } }], sticker: [] },
    segments: [{ id: 'main-1', start: 100, end: 200, text: 'Grouped', items: [], color_group_id: 'color-1' }],
  };
  await installMigrationPicker(page);
  expect(await openBrowserFile(page, input, 'grouped.mosp')).toBe(true);
  await expectMigrationPending(page);
  let saved = (await saveMigration(page)).writes[0];
  expect(saved.timebase.fps_source).toBe('auto');
  expect(saved.subtitle_groups.color[0].id).toBe('color-1');
  expect(saved.tracks.find(t => t.role === 'main').segments[0].color_group_id).toBe('color-1');
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
    return { groups: MaweBoot.DATA.subtitle_groups, cues: MaweBoot.DATA.tracks.find(t => t.role === 'main').segments,
      range: window.AsrEditorUtils.subtitleGroupRanges(MaweBoot.DATA).map(r => [r.start, r.end]) };
  });
  expect(result.cues.map(c => c.color_group_id)).toEqual(['color-1', 'color-1']);
  expect(result.cues.map(c => c.sticker_group_id)).toEqual(['sticker-1', 'sticker-1']);
  expect(result.groups.color).toEqual([{ id: 'color-1', value: { name: 'red', value: '#f07f6f' } }]);
  expect(result.groups.sticker).toEqual([{ id: 'sticker-1', value: { name: 'replacement', filename: 'replacement.png' } }]);
  expect(result.range).toEqual([[1000, 7000]]);
  expect(await dirty(page)).toBe(true);
});
