import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';

const legacy = JSON.parse(readFileSync(new URL('../fixtures/project-tracks/legacy-three-tracks.input.json', import.meta.url), 'utf8'));
const canonical = JSON.parse(readFileSync(new URL('../fixtures/project-tracks/legacy-three-tracks.expected.json', import.meta.url), 'utf8'));
let directory, server;

test.beforeAll(async () => {
  directory = makeTempDir('unified-tracks');
  server = await startBlankServer(await findFreePort(), directory);
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweJsonRepair && window.MaweMultiImport));
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false }));
});
async function install(page, input, filename = 'tracks.mosp') {
  return page.evaluate(({ input, filename }) => MaweMultiImport.openProjectFile(
    new File([JSON.stringify(input)], filename, { type: 'application/json' }), { suppressMediaPrompt: true },
  ), { input: { ...input, media: '' }, filename });
}
async function projectContent(page) {
  return page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
}

test('legacy import edits all roles and saves/reopens one tracks tree without losing metadata', async ({ page }) => {
  expect(await install(page, legacy)).toBe(true);
  await expect(page.locator('#cues-container .cue')).not.toHaveCount(0);
  const result = await page.evaluate(() => {
    const original = MaweBoot.DATA;
    MaweCommands.run('Edit every subtitle role', () => {
      for (const track of MaweBoot.DATA.tracks) {
        track.segments[0].text += ` ${track.role}`;
        track.metadata = { role: track.role, zero: 0, empty: [], flag: false };
      }
    });
    return {
      sameProject: original === MaweBoot.DATA,
      keys: Object.keys(MaweBoot.DATA),
      dirty: MaweState.hasProjectChanges(),
    };
  });
  expect(result.sameProject).toBe(true);
  expect(result.dirty).toBe(true);
  expect(result.keys).not.toContain('segments');
  expect(result.keys).not.toContain('overlay_track');
  expect(result.keys).not.toContain('multi_subtitle');
  const saved = await projectContent(page);
  expect(saved.schema).toBe('moy.asr.project.v3');
  expect(saved.tracks.map(track => track.role)).toEqual(['main', 'overlay', 'extension']);
  for (const track of saved.tracks) {
    expect(track.metadata).toEqual({ role: track.role, zero: 0, empty: [], flag: false });
    for (const cue of track.segments) for (const key of ['_dirty', 'color', 'color_ref', 'sticker', 'sticker_ref']) {
      expect(Object.hasOwn(cue, key)).toBe(false);
    }
  }
  expect(saved.tracks[1].custom_overlay).toEqual([]);
  expect(saved.tracks[2].custom_track).toBe(false);
  expect(saved.tracks[2].segments[0].speaker).toBe('person');
  expect(saved.bindings[0].custom_binding).toEqual([]);
  expect(await install(page, saved, 'reopened.mosp')).toBe(true);
  expect(await projectContent(page)).toEqual(saved);
  expect(await page.evaluate(() => MaweState.hasProjectChanges())).toBe(false);
});

test('second language remains active and swap undo restores all track metadata and bindings', async ({ page }) => {
  const project = structuredClone(canonical);
  const second = structuredClone(project.tracks.find(track => track.role === 'extension'));
  second.id = 'translation-ja'; second.name = '日语'; second.language = 'ja';
  second.segments[0].id = 'japanese-cue'; second.segments[0].text = '日本語';
  project.tracks.push(second);
  project.bindings.push({ ...structuredClone(project.bindings[0]), id: 'japanese-binding', target_track_id: second.id, target_segment_ids: ['japanese-cue'] });
  project.bilingual.active_track_id = second.id;
  expect(await install(page, project)).toBe(true);
  const before = await projectContent(page);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().id)).toBe(second.id);
  expect(await page.evaluate(() => MaweMultiImport.swapMainAndExtensionSubtitles())).toBe(true);
  const swapped = await projectContent(page);
  expect(swapped.tracks.find(track => track.role === 'main').id).toBe(second.id);
  expect(swapped.tracks.find(track => track.id === 'main').role).toBe('extension');
  expect(swapped.bindings.every(binding => binding.source_track_id === second.id)).toBe(true);
  await page.locator('#undo-btn').click();
  expect(await projectContent(page)).toEqual(before);
  await page.locator('#redo-btn').click();
  expect(await projectContent(page)).toEqual(swapped);
});

test('invalid canonical imports and an unmappable role swap leave the current project intact', async ({ page }) => {
  const project = structuredClone(canonical);
  const second = structuredClone(project.tracks.find(track => track.role === 'extension'));
  second.id = 'other-language'; second.segments[0].id = 'other-language-cue';
  project.tracks.push(second);
  project.bindings.push({ id: 'unmapped', source_track_id: 'main', target_track_id: second.id,
    source_segment_ids: ['main-tail'], target_segment_ids: ['other-language-cue'], start_offset_ms: -1050, end_offset_ms: -950 });
  expect(await install(page, project)).toBe(true);
  const before = await projectContent(page);
  const state = await page.evaluate(() => ({ undo: MaweHistory.editorHistory.undoLength(), name: MaweBoot.PROJECT_NAME }));
  expect(await page.evaluate(() => MaweMultiImport.swapMainAndExtensionSubtitles())).toBe(false);
  expect(await projectContent(page)).toEqual(before);
  expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(state.undo);
  const invalid = structuredClone(before);
  invalid.tracks[1].segments[0].id = invalid.tracks[0].segments[0].id;
  expect(await install(page, invalid, 'invalid.mosp')).toBe(false);
  expect(await projectContent(page)).toEqual(before);
  expect(await page.evaluate(() => MaweBoot.PROJECT_NAME)).toBe(state.name);
  expect(await install(page, { ...before, schema: 'moy.asr.project.v99' }, 'future.mosp')).toBe(false);
  expect(await projectContent(page)).toEqual(before);
});

test('project-as-extension import preserves metadata and allocates independent cue/group identities', async ({ page }) => {
  const target = structuredClone(canonical);
  target.tracks = target.tracks.filter(track => track.role !== 'extension');
  target.bindings = []; target.bilingual = { display_mode: 'both' };
  expect(await install(page, target)).toBe(true);
  const source = structuredClone(canonical);
  source.tracks[0].metadata = { source: 'imported', flag: false };
  source.tracks[0].segments[0].speaker = 'source-speaker';
  source.tracks[0].segments[0].vendor = { empty: [], zero: 0 };
  source.tracks[0].segments[0].assOverride = { scale: 1.2, pos: { x: 0, y: 1 } };
  let previousImport;
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.evaluate(async source => {
      const file = new File([JSON.stringify(source)], 'source.mosp', { type: 'application/json' });
      const segments = await MaweLoadingProgress.parseSubtitleImportFile(file);
      await MaweMultiImport.showMultiSubtitleImportChoice(file, segments, { projectFile: file });
    }, source);
    await page.locator('#multi-subtitle-import-extension').click();
    await page.locator('#multi-subtitle-import-result-confirm').click();
    const saved = await projectContent(page);
    const main = saved.tracks.find(track => track.role === 'main');
    const imported = saved.tracks.find(track => track.id === saved.bilingual.active_track_id);
    expect(main.segments[0].color_group_id).toBe(target.tracks[0].segments[0].color_group_id);
    expect(imported.metadata).toEqual(source.tracks[0].metadata);
    expect(imported.language).toBe('zh');
    expect(imported.segments[0]).toMatchObject({ speaker: 'source-speaker', vendor: { empty: [], zero: 0 }, assOverride: { scale: 1.2, pos: { x: 0, y: 1 } } });
    expect(imported.segments[0].id).not.toBe(main.segments[0].id);
    expect(imported.segments[0].color_group_id).not.toBe(main.segments[0].color_group_id);
    const group = saved.subtitle_groups.color.find(group => group.id === imported.segments[0].color_group_id);
    expect(group.value).toEqual(source.subtitle_groups.color[0].value);
    if (previousImport) {
      expect(imported.id).toBe(previousImport.id);
      expect(imported.segments[0].id).not.toBe(previousImport.segments[0].id);
      expect(imported.segments[0].color_group_id).not.toBe(previousImport.segments[0].color_group_id);
    }
    previousImport = imported;
  }
});
