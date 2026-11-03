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
  await page.evaluate(({ input, filename }) => {
    window.__installResult = null;
    window.__installPromise = MaweMultiImport.openProjectFile(
      new File([JSON.stringify(input)], filename, { type: 'application/json' }), { suppressMediaPrompt: true },
    ).then(result => { window.__installResult = result; });
  }, { input: { ...input, media: '' }, filename });
  await page.waitForFunction(() => window.__installResult !== null);
  return page.evaluate(() => window.__installResult);
}
async function projectContent(page) {
  return page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
}

test('preview extension fields survive edits, undo, redo, save and reopen', async ({ page }) => {
  const project = structuredClone(canonical);
  const vendor = { flag: false, zero: 0, empty: [], nested: { keep: 'custom' } };
  project.preview = {
    vendor: { ...vendor },
    subtitle: { x: 0.1, y: 0.7, width: 0.6, height: 0.2, font_size: 30, vendor: { ...vendor },
      speaker_labels: { mapping_enabled: true, enabled: true, separator: ':', vendor: { ...vendor },
        names: { yellow: '原名', vendor: { ...vendor } } } },
    sticker: { x: 0.7, y: 0.1, width: 0.2, height: 0.2, vendor: { ...vendor } },
    extension_subtitle: { font_size: 28, vendor: { ...vendor } },
  };
  const original = structuredClone(project);
  expect(await install(page, project)).toBe(true);
  expect(project).toEqual(original);

  const extensions = preview => ({ preview: preview.vendor, subtitle: preview.subtitle.vendor,
    sticker: preview.sticker.vendor, extension: preview.extension_subtitle.vendor,
    labels: preview.subtitle.speaker_labels.vendor, names: preview.subtitle.speaker_labels.names.vendor });
  const expectedExtensions = Object.fromEntries(['preview', 'subtitle', 'sticker', 'extension', 'labels', 'names'].map(key => [key, vendor]));
  const before = await projectContent(page);
  expect(extensions(before.preview)).toEqual(expectedExtensions);

  const rejected = await page.evaluate(async () => {
    const before = JSON.stringify(MaweBoot.DATA);
    const invalid = { ...JSON.parse(before), schema: 'moy.asr.project.v99' };
    const invalidBefore = JSON.stringify(invalid);
    const ok = await MaweMultiImport.openProjectFile(new File([invalidBefore], 'future.mosp', { type: 'application/json' }), { suppressMediaPrompt: true });
    return { ok, unchanged: JSON.stringify(MaweBoot.DATA) === before, inputUnchanged: JSON.stringify(invalid) === invalidBefore };
  });
  expect(rejected).toEqual({ ok: false, unchanged: true, inputUnchanged: true });

  await page.evaluate(() => {
    MaweHistory.pushPreviewUndo('修改预览设置', MaweHistory.snapshotPreviewState());
    MawePreviewGeometry.setPreviewGeometry({ x: 0.2, y: 0.6, width: 0.6, height: 0.2 });
    MawePreviewGeometry.setStickerGeometry({ x: 0.6, y: 0.2, width: 0.2, height: 0.2 });
    MaweAppearance.setSubtitleAppearance({ font_size: 36 });
    MaweAppearance.setExtensionSubtitleAppearance({ font_size: 32 });
    const labels = MaweSpeakerLabels.getSpeakerLabelSettings();
    MaweSpeakerLabels.setSpeakerLabelSettings({ ...labels, names: { ...labels.names, yellow: '新名' }, separator: '：' });
  });
  const edited = await projectContent(page);
  expect(extensions(edited.preview)).toEqual(expectedExtensions);
  expect(edited.preview.subtitle).toMatchObject({ x: 0.2, y: 0.6, width: 0.6, height: 0.2, font_size: 36 });
  expect(edited.preview.sticker).toMatchObject({ x: 0.6, y: 0.2, width: 0.2, height: 0.2 });
  expect(edited.preview.extension_subtitle.font_size).toBe(32);
  expect(edited.preview.subtitle.speaker_labels).toMatchObject({ separator: '：', names: { yellow: '新名' } });

  await page.evaluate(() => MaweHistory.performUndo());
  const undone = await projectContent(page);
  expect(extensions(undone.preview)).toEqual(expectedExtensions);
  expect(undone.preview.subtitle).toMatchObject({ x: 0.1, y: 0.7, width: 0.6, height: 0.2, font_size: 30 });
  expect(undone.preview.sticker).toMatchObject({ x: 0.7, y: 0.1, width: 0.2, height: 0.2 });
  expect(undone.preview.extension_subtitle.font_size).toBe(28);
  expect(undone.preview.subtitle.speaker_labels).toMatchObject({ separator: ':', names: { yellow: '原名' } });
  await page.evaluate(() => MaweHistory.performRedo());
  expect((await projectContent(page)).preview).toEqual(edited.preview);

  const saved = await page.evaluate(async () => {
    window.previewSave = '';
    window.showSaveFilePicker = async () => ({ name: 'preview.mosp',
      createWritable: async () => ({ write: async blob => { window.previewSave = await blob.text(); }, close: async () => {} }) });
    await MaweProjectSave.saveProjectAsToFile();
    return JSON.parse(window.previewSave);
  });
  expect(saved.preview).toEqual(edited.preview);
  expect(await install(page, saved, 'preview-reopened.mosp')).toBe(true);
  const reopened = await projectContent(page);
  expect(reopened.preview).toEqual(saved.preview);
  expect(extensions(reopened.preview)).toEqual(expectedExtensions);
});

test('reset appearance defaults and undo a new font size without restoring old managed values', async ({ page }) => {
  const project = structuredClone(canonical);
  const vendor = { flag: false, zero: 0, empty: [] };
  project.preview = { vendor, subtitle: { x: 0.1, y: 0.7, width: 0.6, height: 0.2, vendor,
    font_size: 36, font_family: 'Arial', background_color: '#123456', background_alpha: 0.3, color_underline: false },
    extension_subtitle: { vendor, font_size: 32, font_family: 'Arial', background_color: '#123456', background_alpha: 0.3 } };
  expect(await install(page, project)).toBe(true);
  await page.evaluate(() => {
    MaweAppearance.setSubtitleAppearance({ font_size: 'auto', font_family: 'default', background_color: '#000000', background_alpha: 0.65, color_underline: true });
    MaweAppearance.setExtensionSubtitleAppearance({ font_size: 'auto', font_family: 'default', background_color: '#000000', background_alpha: 0.65 });
  });
  const reset = await page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA.preview)));
  for (const field of ['font_size', 'font_family', 'background_color', 'background_alpha']) {
    expect(Object.hasOwn(reset.subtitle, field), `main ${field} reset`).toBe(false);
    expect(Object.hasOwn(reset.extension_subtitle, field), `secondary ${field} reset`).toBe(false);
  }
  expect(reset.subtitle.color_underline).not.toBe(false);
  expect(reset.vendor).toEqual(vendor);
  expect(reset.subtitle.vendor).toEqual(vendor);
  expect(reset.extension_subtitle.vendor).toEqual(vendor);
  const resetSnapshot = await projectContent(page);
  for (const field of ['font_size', 'font_family', 'background_color', 'background_alpha']) {
    expect(Object.hasOwn(resetSnapshot.preview.subtitle, field), `saved main ${field}`).toBe(false);
    expect(Object.hasOwn(resetSnapshot.preview.extension_subtitle, field), `saved secondary ${field}`).toBe(false);
  }
  expect(resetSnapshot.preview.subtitle.color_underline).not.toBe(false);

  await page.evaluate(() => {
    MaweHistory.pushPreviewUndo('调整默认字号', MaweHistory.snapshotPreviewState());
    MaweAppearance.setSubtitleAppearance({ font_size: 42 });
  });
  expect((await projectContent(page)).preview.subtitle.font_size).toBe(42);
  await page.evaluate(() => MaweHistory.performUndo());
  const undone = await projectContent(page);
  expect(Object.hasOwn(undone.preview.subtitle, 'font_size')).toBe(false);
  expect(undone.preview.subtitle.vendor).toEqual(vendor);
  expect(undone.preview.extension_subtitle.vendor).toEqual(vendor);
  await page.evaluate(() => MaweHistory.performRedo());
  const redone = await projectContent(page);
  expect(redone.preview.subtitle.font_size).toBe(42);
  expect(redone.preview.subtitle.vendor).toEqual(vendor);
  expect(redone.preview.extension_subtitle.vendor).toEqual(vendor);
});

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
  expect(saved.schema).toBe('moy.asr.project.v2');
  expect(saved.tracks.map(track => track.role)).toEqual(['main', 'overlay', 'secondary']);
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

test('single secondary swap undo restores all track metadata and bindings', async ({ page }) => {
  const project = structuredClone(canonical);
  const second = project.tracks.find(track => track.role === 'secondary');
  second.metadata = { original: 'secondary', zero: 0 };
  expect(await install(page, project)).toBe(true);
  const before = await projectContent(page);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().id)).toBe(second.id);
  expect(await page.evaluate(() => MaweMultiImport.swapMainAndExtensionSubtitles())).toBe(true);
  const swapped = await projectContent(page);
  expect(swapped.tracks.find(track => track.role === 'main').id).toBe(second.id);
  expect(swapped.tracks.find(track => track.id === 'main').role).toBe('secondary');
  expect(swapped.bindings.every(binding => binding.source.track_id === second.id)).toBe(true);
  await page.locator('#undo-btn').click();
  expect(await projectContent(page)).toEqual(before);
  await page.locator('#redo-btn').click();
  expect(await projectContent(page)).toEqual(swapped);
});

test('multiple secondary and invalid canonical imports leave the current project intact', async ({ page }) => {
  const project = structuredClone(canonical);
  const second = structuredClone(project.tracks.find(track => track.role === 'secondary'));
  second.id = 'other-language'; second.segments[0].id = 'other-language-cue';
  project.tracks.push(second);
  project.bindings.push({ id: 'unmapped', source: { track_id: 'main', segment_id: 'main-tail' }, target: { track_id: second.id, segment_id: 'other-language-cue' }, start_offset_ms: -1050, end_offset_ms: -950 });
  expect(await install(page, canonical)).toBe(true);
  const before = await projectContent(page);
  const state = await page.evaluate(() => ({ undo: MaweHistory.editorHistory.undoLength(), name: MaweBoot.PROJECT_NAME }));
  expect(await install(page, project, 'multiple-secondary.mosp')).toBe(false);
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
  target.tracks = target.tracks.filter(track => track.role !== 'secondary');
  target.bindings = []; target.bilingual = { display_mode: 'both' };
  expect(await install(page, target)).toBe(true);
  const source = structuredClone(canonical);
  source.tracks[0].metadata = { source: 'imported', flag: false };
  const sourceSpeaker = { id: 'source-speaker', name: '源说话人', color: '#66bb6a', vendor: { empty: [], zero: 0 } };
  source.speakers.push(sourceSpeaker);
  source.tracks[0].segments[0].speaker = sourceSpeaker.id;
  source.tracks[0].segments[0].vendor = { empty: [], zero: 0 };
  source.tracks[0].segments[0].assOverride = { scale: 1.2, pos: { x: 0, y: 1 } };
  let previousImport;
  for (let repeat = 0; repeat < 2; repeat++) {
    const beforeImport = await projectContent(page);
    const undoLength = await page.evaluate(() => MaweHistory.editorHistory.undoLength());
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
    expect(imported.segments[0]).toMatchObject({ vendor: { empty: [], zero: 0 }, assOverride: { scale: 1.2, pos: { x: 0, y: 1 } } });
    const speakerId = imported.segments[0].speaker;
    expect(speakerId).not.toBe(sourceSpeaker.id);
    expect(beforeImport.speakers.some(speaker => speaker.id === speakerId)).toBe(false);
    expect(saved.speakers).toEqual([...beforeImport.speakers, { ...sourceSpeaker, id: speakerId }]);
    expect(saved.speaker_shortcuts).toEqual(beforeImport.speaker_shortcuts);
    expect(imported.segments[0].id).not.toBe(main.segments[0].id);
    expect(imported.segments[0].color_group_id).not.toBe(main.segments[0].color_group_id);
    const group = saved.subtitle_groups.color.find(group => group.id === imported.segments[0].color_group_id);
    expect(group.value).toEqual(source.subtitle_groups.color[0].value);
    expect(saved.bindings.find(binding => binding.source.segment_id === main.segments[0].id)).toMatchObject({
      source: { track_id: main.id, segment_id: main.segments[0].id },
      target: { track_id: imported.id, segment_id: imported.segments[0].id },
      start_offset_ms: 0, end_offset_ms: 0,
    });
    if (previousImport) {
      expect(imported.id).toBe(previousImport.id);
      expect(imported.segments[0].id).not.toBe(previousImport.segments[0].id);
      expect(imported.segments[0].color_group_id).not.toBe(previousImport.segments[0].color_group_id);
      expect(speakerId).not.toBe(previousImport.segments[0].speaker);
    }
    expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(undoLength + 1);
    await page.locator('#undo-btn').click();
    expect(await projectContent(page)).toEqual(beforeImport);
    await page.locator('#redo-btn').click();
    expect(await projectContent(page)).toEqual(saved);
    previousImport = imported;
  }
  const saved = await projectContent(page);
  expect(await install(page, saved, 'imported-reopened.mosp')).toBe(true);
  expect(await projectContent(page)).toEqual(saved);
});
