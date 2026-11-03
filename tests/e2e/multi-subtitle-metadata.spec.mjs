import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson,
  generateWav, getMainTrack, getExtensionTrack, materializeTrackSegments,
  makeTempDir, openSettingsPage, startServer } from './helpers.mjs';

let tempDir;
let server;
let projectPath;
test.beforeAll(async () => {
  tempDir = makeTempDir('multi-metadata');
  projectPath = join(tempDir, 'project.json');
  const media = join(tempDir, 'synthetic.wav');
  generateProjectJson(projectPath);
  generateWav(media, 15);
  server = await startServer(projectPath, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#cues-container')).toBeVisible();
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false }));
});

async function saveAndReopen(page) {
  if (await page.locator('#project-settings-close').isVisible()) await page.locator('#project-settings-close').click();
  const saved = await page.evaluate(async () => {
    try { return { ok: await MaweProjectSave.saveCurrentProject({ silent: true }), canSave: MaweBoot.SERVER_CONFIG.canSave }; }
    catch (error) { return { error: String(error) }; }
  });
  expect(saved).toMatchObject({ ok: true });
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  await page.reload();
  expect(project.schema).toBe('moy.asr.project.v2');
  expect(project.segments).toBeUndefined();
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.id)))
    .toEqual(getMainTrack(project).segments.map(s => s.id));
  return project;
}

async function configureMergeFixture(page, { extension = false, linked = false } = {}) {
  return page.evaluate(({ extension, linked }) => {
    MaweSelection.clearSelection({ silent: true, commitCuePanel: false });
    MaweCuePanelState.resetCuePanelEditState({ discard: true });
    MaweCuePanelState.currentCuePanelIdx = -1;
    const segments = prefix => ['甲', '乙'].map((text, index) => ({
      id: `${prefix}-${index}`, start: 1000 + index * 2000, end: 2000 + index * 2000,
      text: prefix === 'ext' ? `**${text}**` : text,
      speaker: linked && prefix === 'main' ? 'Alice' : index ? 'Bob' : 'Alice',
      vendor: { keep: prefix },
      items: [{ text: prefix === 'ext' ? `**${text}**` : text,
        start: 1100 + index * 2000, end: 1800 + index * 2000,
        speaker: linked && prefix === 'main' ? 'Alice' : index ? 'Bob' : 'Alice' }],
    }));
    const main = segments('main');
    const ext = segments('ext');
    ext[0].color = { name: 'blue', value: '#0000ff' };
    ext[1].color_ref = { name: 'blue', headIdx: 0 };
    const multi = { enabled: extension, display_mode: 'both', main_split_mode: 'continuous',
      tracks: extension ? [{ id: 'ext', split_mode: 'continuous', segments: ext }] : [], bindings: [] };
    if (linked) multi.bindings = main.map((segment, index) => ({ id: `binding-${index}`, track_id: 'ext',
      main_segment_ids: [segment.id], extension_segment_ids: [ext[index].id] }));
    // Legacy fields belong to the import boundary, never to live v2 state.
    const imported = AsrEditorUtils.importProject({ segments: main, multi_subtitle: multi }).project;
    for (const field of ['schema', 'tracks', 'bilingual', 'bindings', 'subtitle_groups',
      'speakers', 'annotation_mode', 'palette_size', 'speaker_shortcuts']) MaweBoot.DATA[field] = imported[field];
    MaweSettings.updateEditorSettings({ mainSplitModeOverride: 'continuous', mergeJoinTextContinuous: '' });
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweDisplaySettings.updateMultiSubtitleUi();
    MaweState.selection.replace(extension && !linked ? 'extension' : 'main', [0, 1]);
    document.activeElement?.blur();
    return structuredClone((extension ? AsrEditorUtils.getExtensionTrack(MaweBoot.DATA)
      : AsrEditorUtils.getMainTrack(MaweBoot.DATA)).segments);
  }, { extension, linked });
}

async function expectMixedMergeRejected(page) {
  const state = () => page.evaluate(() => ({ snapshot: MaweHistory.snapshotSegments(),
    undo: MaweHistory.editorHistory.undoLength(), redo: MaweHistory.editorHistory.redoLength(),
    selection: MaweHistory.snapshotEditorSelection() }));
  const before = await state();
  await page.keyboard.press('c');
  await expect(page.locator('.hint-card').last()).toContainText('不同说话人的字幕不能合并，请先统一归属');
  expect(await state()).toEqual(before);
}

async function unifyMergeIdentity(page, { extension = false, linked = false } = {}) {
  await page.evaluate(({ extension, linked }) => {
    const track = extension ? AsrEditorUtils.getExtensionTrack(MaweBoot.DATA) : AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    MaweSpeakerLabels.assignIdentity(track.segments.map(segment => ({ track_id: track.id, segment_id: segment.id })), track.segments[0].speaker);
    MaweState.selection.replace(extension && !linked ? 'extension' : 'main', [0, 1]);
    document.activeElement?.blur();
  }, { extension, linked });
}

test('main merge rejects mixed identities and preserves explicit same-person merge through undo and save/reopen', async ({ page }) => {
  const before = await configureMergeFixture(page);
  await expectMixedMergeRejected(page);
  await unifyMergeIdentity(page);
  await page.keyboard.press('c');
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.text))).toEqual(['甲乙']);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker)).toBe(before[0].speaker);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.speaker)))
    .toEqual([before[0].speaker, before[0].speaker]);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.speaker)))
    .toEqual(before.map(s => s.speaker));
  await page.locator('#redo-btn').click();
  await page.locator('#redo-btn').click();
  const saved = await saveAndReopen(page);
  expect(getMainTrack(saved).segments[0].speaker).toBe(before[0].speaker);
  expect(getMainTrack(saved).segments[0].vendor).toEqual(before[0].vendor);
  expect(getMainTrack(saved).segments[0].items).toEqual(before.flatMap(s => s.items));
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker)).toBe(before[0].speaker);
});

for (const linked of [false, true]) {
test(`${linked ? 'linked' : 'extension'} merge rejects mixed identities and preserves same-person timed items through undo, save/reopen and swap`, async ({ page }) => {
  const before = await configureMergeFixture(page, { extension: true, linked });
  if (linked) expect(await page.evaluate(() => new Set(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.speaker)).size)).toBe(1);
  await expectMixedMergeRejected(page);
  await unifyMergeIdentity(page, { extension: true, linked });
  await page.keyboard.press('c');
  const merged = await page.evaluate(() => structuredClone(AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments));
  expect(merged).toHaveLength(1);
  expect(merged[0].text).toBe('**甲乙**');
  expect(merged[0].speaker).toBe(before[0].speaker);
  const items = [{ ...before[0].items[0], text: '**甲' }, { ...before[1].items[0], text: '乙**' }];
  expect(merged[0].items).toEqual(items);
  expect(merged[0].color_group_id).toBe(before[0].color_group_id);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments.map(s => s.items)))
    .toEqual(before.map(s => s.items));
  expect(await page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments.map(s => s.speaker)))
    .toEqual([before[0].speaker, before[0].speaker]);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments.map(s => s.speaker)))
    .toEqual(before.map(s => s.speaker));
  await page.locator('#redo-btn').click();
  await page.locator('#redo-btn').click();
  const saved = await saveAndReopen(page);
  expect(getExtensionTrack(saved).segments[0].items).toEqual(items);
  expect(getExtensionTrack(saved).segments[0].vendor).toEqual(before[0].vendor);
  expect(getExtensionTrack(saved).segments[0].color_group_id).toBe(before[0].color_group_id);
  expect(getExtensionTrack(saved).segments[0].speaker).toBe(before[0].speaker);
  expect(await page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments[0].items)).toEqual(items);
  expect(await page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments[0].speaker)).toBe(before[0].speaker);
  await openSettingsPage(page, 'multi-subtitle');
  await page.locator('#multi-subtitle-swap').click();
  const swapped = await saveAndReopen(page);
  expect(getMainTrack(swapped).segments[0].speaker).toBe(before[0].speaker);
  expect(getMainTrack(swapped).segments[0].items).toEqual(items);
});
}

test('swapping once and twice preserves speaker and discarded cues through save and reopen', async ({ page }) => {
  const identities = await page.evaluate(() => {
    const makeSegments = (prefix) => [
      { id: `${prefix}-discarded`, start: 1000, end: 2000, text: `${prefix} discarded`, speaker: `${prefix}-speaker`, disabled: true, assOverride: { pos: { x: 123, y: 456 } }, vendor: { nested: ['keep'] }, sticker: { name: prefix, filename: `${prefix}.png`, start: 1000, end: 2000 }, color: { name: prefix === 'main' ? 'blue' : 'yellow', value: '#123456', start: 1000, end: 2000 } },
      { id: `${prefix}-enabled`, start: 3000, end: 4000, text: `${prefix} enabled`, speaker: `${prefix}-other`, disabled: false },
    ];
    MaweSelection.clearSelection({ silent: true, commitCuePanel: false });
    MaweCuePanelState.resetCuePanelEditState({ discard: true });
    MaweCuePanelState.currentCuePanelIdx = -1;
    const imported = AsrEditorUtils.importProject({ segments: makeSegments('main'), multi_subtitle: {
      enabled: true, display_mode: 'both', tracks: [{ id: 'ext', name: '译文', segments: makeSegments('ext') }],
      bindings: ['discarded', 'enabled'].map((suffix, index) => ({ id: `binding-${index}`, track_id: 'ext',
        main_segment_ids: [`main-${suffix}`], extension_segment_ids: [`ext-${suffix}`] })),
    } }).project;
    for (const field of ['schema', 'tracks', 'bilingual', 'bindings', 'subtitle_groups',
      'speakers', 'annotation_mode', 'palette_size', 'speaker_shortcuts']) MaweBoot.DATA[field] = imported[field];
    MaweCuePanel.renderAll();
    MaweDisplaySettings.updateMultiSubtitleUi();
    return { main: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => s.speaker),
      ext: AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments.map(s => s.speaker) };
  });
  for (let round = 0; round < 2; round++) {
    // 双语字幕设置已并入工程设置 → 字幕轨道页。
    await openSettingsPage(page, 'multi-subtitle');
    await expect(page.locator('#multi-subtitle-swap')).toBeVisible();
    await page.locator('#multi-subtitle-swap').click();
    const expectedMain = round === 0 ? 'ext' : 'main';
    await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].id))
      .toBe(`${expectedMain}-discarded`);
    const saved = await saveAndReopen(page);
    for (const segments of [getMainTrack(saved).segments, getExtensionTrack(saved).segments]) {
      const prefix = segments[0].id.split('-')[0];
      expect(segments[0].assOverride).toEqual({ pos: { x: 123, y: 456 } });
      expect(segments[0].vendor).toEqual({ nested: ['keep'] });
      expect(saved.subtitle_groups.sticker.find(g => g.id === segments[0].sticker_group_id).value.name).toBe(prefix);
      expect(saved.subtitle_groups.color.find(g => g.id === segments[0].color_group_id).value.name).toBe(prefix === 'main' ? 'blue' : 'yellow');
      expect(segments.map(s => [s.speaker, Boolean(s.disabled)]))
        .toEqual([[identities[prefix][0], true], [identities[prefix][1], false]]);
    }
    const reopened = await page.evaluate(() => ({
      main: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(s => [s.speaker, Boolean(s.disabled)]),
      ext: AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments.map(s => [s.speaker, Boolean(s.disabled)]),
      mainSrt: AsrEditorUtils.buildSrtPayload(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments),
      extSrt: AsrEditorUtils.buildSrtPayload(AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments),
    }));
    expect(reopened.main).toEqual(getMainTrack(saved).segments.map(s => [s.speaker, Boolean(s.disabled)]));
    expect(reopened.ext).toEqual(getExtensionTrack(saved).segments.map(s => [s.speaker, Boolean(s.disabled)]));
    expect(reopened.mainSrt).not.toContain('discarded');
    expect(reopened.extSrt).not.toContain('discarded');
    expect(reopened.mainSrt).toContain('enabled');
    expect(reopened.extSrt).toContain('enabled');
  }
});

for (const path of ['extension', 'linked']) {
  for (const targetIndex of [1, 3]) {
    test(`${path} split at color ${targetIndex === 1 ? 'head' : 'member'} keeps track references valid through undo and save`, async ({ page }) => {
      const before = await page.evaluate((targetIndex) => {
        const segments = Array.from({ length: 6 }, (_, index) => ({
          id: `ext-${index}`, start: 1000 + index * 2000, end: 2800 + index * 2000,
          text: '甲乙丙丁', speaker: 'ext-speaker',
        }));
        for (const [index, name, value, endIndex] of [[0, 'green', '#00ff00', 0], [1, 'red', '#ff0000', 1],
          [2, 'blue', '#0000ff', 3], [4, 'purple', '#ff00ff', 5]]) {
          segments[index].color = { name, value, start: segments[index].start, end: segments[endIndex].end };
        }
        segments[3].color_ref = { name: 'blue', headIdx: 2 };
        segments[5].color_ref = { name: 'purple', headIdx: 4 };
        const source = segments[targetIndex];
        const main = { id: 'main-bound', start: source.start, end: source.end, text: '一二三四', speaker: 'main-speaker',
          color: { name: 'yellow', value: '#ffff00', start: source.start, end: source.end } };
        const imported = AsrEditorUtils.importProject({ segments: [main],
          multi_subtitle: { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
            tracks: [{ id: 'ext', name: '译文', split_mode: 'continuous', segments }],
            bindings: [{ id: 'bound', track_id: 'ext', main_segment_ids: [main.id],
              extension_segment_ids: [source.id], start_offset_ms: 0, end_offset_ms: 0 }] },
        }).project;
        MaweSelection.clearSelection({ silent: true, commitCuePanel: false });
        MaweCuePanelState.resetCuePanelEditState({ discard: true });
        MaweCuePanelState.currentCuePanelIdx = -1;
        for (const field of ['schema', 'tracks', 'bilingual', 'bindings', 'subtitle_groups',
          'speakers', 'annotation_mode', 'palette_size', 'speaker_shortcuts']) MaweBoot.DATA[field] = imported[field];
        MaweCuePanel.renderAll();
        return AsrEditorUtils.materializeTrackSegments(MaweBoot.DATA, 'ext')
          .map(s => ({ id: s.id, speaker: s.speaker, color: s.color || null, color_ref: s.color_ref || null }));
      }, targetIndex);
      const cutMs = 1900 + targetIndex * 2000;
      await page.evaluate(({ path, targetIndex, cutMs }) => {
        if (path === 'extension') MaweSplitCore.openExtensionSplitModal(targetIndex, cutMs);
        else MaweSplitContext.splitFromContextMenu(0, 10, 10, cutMs);
      }, { path, targetIndex, cutMs });
      await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
      await page.locator('#multi-subtitle-split-confirm').click();
      const after = await page.evaluate(() => AsrEditorUtils.materializeTrackSegments(MaweBoot.DATA, 'ext'));
      expect(after).toHaveLength(7);
      expect(after[targetIndex + 1].color_ref).toEqual(targetIndex === 1
        ? { name: 'red', headIdx: 1 } : { name: 'blue', headIdx: 2 });
      expect(after.find(s => s.id === 'ext-5').color_ref).toEqual({ name: 'purple', headIdx: 5 });
      for (const segment of after) {
        expect(segment.speaker).toBe(before[0].speaker);
        if (segment.color_ref) expect(after[segment.color_ref.headIdx]?.color?.name).toBe(segment.color_ref.name);
      }
      if (path === 'linked') {
        expect(await page.evaluate(() => AsrEditorUtils.materializeTrackSegments(MaweBoot.DATA,
          AsrEditorUtils.getMainTrack(MaweBoot.DATA).id)[1].color_ref)).toEqual({ name: 'yellow', headIdx: 0 });
      }
      await page.locator('#undo-btn').click();
      expect(await page.evaluate(() => AsrEditorUtils.materializeTrackSegments(MaweBoot.DATA, 'ext')
        .map(s => ({ id: s.id, speaker: s.speaker, color: s.color || null, color_ref: s.color_ref || null }))))
        .toEqual(before);
      await page.locator('#redo-btn').click();
      const saved = await saveAndReopen(page);
      expect(materializeTrackSegments(saved, getExtensionTrack(saved).id).map(s => s.color_ref || null))
        .toEqual(after.map(s => s.color_ref || null));
      expect(await page.evaluate(() => AsrEditorUtils.materializeTrackSegments(MaweBoot.DATA, 'ext').map(s => s.color_ref || null)))
        .toEqual(after.map(s => s.color_ref || null));
      expect(await page.evaluate(() => AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments.map(s => s.speaker)))
        .toEqual(Array(7).fill(before[0].speaker));
    });
  }
}
