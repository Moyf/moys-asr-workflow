import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectModel } from '../helpers/runtime-project.mjs';
import {
  cleanupTempDir, closeSettingsPanels, disableOnboarding, findFreePort, openSettingsPage,
  generateWav, generateWaveformPayload, makeTempDir, setProjectTrackEnabled, startServer,
} from './helpers.mjs';

const DURATION_MS = 15_000;
const TRACK_ID = 'translation';
const MAIN_TEXTS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
const EXTENSION_TEXTS = ['第一句。', '第二句。', '第三句。', '第四句。', '第五句。', '第六句。'];

let tempDir, server, projectPath, fixture, pageErrors;

function generateColoredProject(path, adjacentRedGroups = false) {
  const project = { media: 'synthetic.wav', waveform: generateWaveformPayload(DURATION_MS) };
  project.segments = MAIN_TEXTS.map((text, index) => ({
    id: `main-${index}`, start: 1000 + index * 2000, end: 2500 + index * 2000,
    text, items: [],
  }));
  const extension = project.segments.map((segment, index) => ({
    id: `extension-${index}`, start: segment.start, end: segment.end,
    text: EXTENSION_TEXTS[index], color: null, color_ref: null,
  }));
  extension[0].color = { name: 'red', value: '#e74c3c', start: extension[0].start, end: extension[2].end };
  extension[1].color_ref = { name: 'red', headIdx: 0 };
  extension[2].color_ref = { name: 'red', headIdx: 0 };
  extension[4].color = { name: 'green', value: '#2ecc71', start: extension[4].start, end: extension[5].end };
  extension[5].color_ref = { name: 'green', headIdx: 4 };
  if (adjacentRedGroups) {
    // Keep swap/reopen assertions about color, not main-track punctuation cleanup.
    project.preserve_punctuation = true;
    extension[0].color.end = extension[1].end;
    extension[2].color_ref = null;
    extension[2].color = { name: 'red', value: '#e74c3c', start: extension[2].start, end: extension[3].end };
    extension[3].color_ref = { name: 'red', headIdx: 2 };
    project.segments.forEach((segment, index) => {
      segment.color = structuredClone(extension[index].color);
      segment.color_ref = structuredClone(extension[index].color_ref);
    });
  }
  project.multi_subtitle = {
    schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both', main_split_mode: 'word',
    tracks: [{ id: TRACK_ID, role: 'extension', name: '译文', language: 'Chinese',
      split_mode: 'continuous', source_name: 'translation.srt', segments: extension }],
    bindings: project.segments.map((segment, index) => ({
      id: `binding-${index}`, track_id: TRACK_ID, main_segment_ids: [segment.id],
      extension_segment_ids: [extension[index].id], start_offset_ms: 0, end_offset_ms: 0,
    })),
  };
  // Import through the public boundary before starting a save-in-place test.
  // Legacy-first-save protection is tested separately, not bypassed at runtime.
  const canonical = projectModel.importProject(project).project;
  expect(projectModel.validateTracksProject(canonical).ok).toBe(true);
  writeFileSync(path, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
  return canonical;
}

// Compare persisted subtitle content, not transient dirty flags or optional null fields.
function cueSnapshot(segments) {
  return segments.map(segment => ({
    id: segment.id, start: segment.start, end: segment.end, text: segment.text,
    color_group_id: segment.color_group_id || null,
    color_group_metadata: segment.color_group_metadata || null,
  }));
}

function contentSnapshot(project) {
  return {
    schema: project.schema,
    tracks: project.tracks.map(track => ({
        id: track.id, role: track.role, name: track.name, language: track.language,
        enabled: track.enabled, split_mode: track.split_mode, source_name: track.source_name,
        split_mode_override: track.split_mode_override,
        segments: cueSnapshot(track.segments),
    })),
    bilingual: project.bilingual,
    bindings: project.bindings,
    subtitle_groups: project.subtitle_groups,
  };
}

const mainContent = project => project.tracks.find(track => track.role === 'main');
const secondaryContent = project => project.tracks.find(track => track.role === 'secondary');
const colorValue = (project, segment) => project.subtitle_groups.color.find(group => group.id === segment.color_group_id)?.value || null;

async function editorContent(page) {
  return contentSnapshot(await page.evaluate(() => MaweBoot.DATA));
}

async function waitForEditor(page) {
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await expect(page.locator('#cues-container')).toBeVisible();
}

test.beforeEach(async ({ page }, testInfo) => {
  // Each test owns its server, settings directory, media and writable .mosp.
  server = null;
  tempDir = makeTempDir('multi-subtitle-color-save');
  projectPath = join(tempDir, 'synthetic.mosp');
  const mediaPath = join(tempDir, 'synthetic.wav');
  generateWav(mediaPath, DURATION_MS / 1000);
  fixture = generateColoredProject(projectPath, testInfo.title.includes('same-color cross-group'));
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  server = await startServer(projectPath, mediaPath, await findFreePort());
  await page.goto(server.url);
  await waitForEditor(page);
  await page.evaluate(() => MaweSettings.updateEditorSettings({
    autoSaveProject: false, projectBackupEnabled: false, selectGroupMembers: false,
    mergeJoinTextContinuous: '', mergeJoinTextWord: ' ',
  }));
  expect(await editorContent(page)).toEqual(contentSnapshot(fixture));
  expect(pageErrors).toEqual([]);
});

test.afterEach(async () => {
  try { await server?.stop(); }
  finally { cleanupTempDir(tempDir); }
});

async function mergeFirstTwoMainCues(page, bilingual) {
  const text = index => page.locator(bilingual
    ? `.multi-dual-cue[data-main-idx="${index}"] .multi-cue-column.main .text`
    : `#cues-container > .cue[data-idx="${index}"]:not(.multi-dual-cue) .text`);
  await text(0).click();
  await text(1).click({ modifiers: ['ControlOrMeta'] });
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs].sort((a, b) => a - b))).toEqual([0, 1]);
  expect(await page.evaluate(() => MaweCuePanel.getCurrentCuePanelTarget()?.kind)).toBe('main');
  await page.keyboard.press('c');
  expect(pageErrors).toEqual([]);
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(5);
}

async function saveAndReopen(page, expected) {
  const responsePromise = page.waitForResponse(response => (
    response.url().endsWith('/api/project') && response.request().method() === 'POST'
  ));
  // #download-json only exports; #save-project writes the bound localhost file.
  await page.locator('#save-project').click();
  const response = await responsePromise;
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  expect(JSON.parse(body)).toMatchObject({ ok: true });
  await expect.poll(() => page.evaluate(() => (
    !MaweServerSave.projectSaveInFlight && !MaweServerSave.hasUnsavedProjectChanges()
  ))).toBe(true);
  const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
  expect(saved.schema).toBe('moy.asr.project.v2');
  expect(projectModel.validateTracksProject(saved).ok).toBe(true);
  for (const track of saved.tracks) for (const segment of track.segments) {
    expect(Object.hasOwn(segment, 'color')).toBe(false);
    expect(Object.hasOwn(segment, 'color_ref')).toBe(false);
  }
  expect(contentSnapshot(saved)).toEqual(expected);
  await page.reload();
  await waitForEditor(page);
  await expect.poll(() => editorContent(page)).toEqual(expected);
  // Reload uses the server's saved in-memory project. Restart the owned
  // server as well so the same assertions cover parsing the written .mosp.
  await server.stop();
  server = await startServer(projectPath, join(tempDir, 'synthetic.wav'), await findFreePort());
  await page.goto(server.url);
  await waitForEditor(page);
  await expect.poll(() => editorContent(page)).toEqual(expected);
  expect(pageErrors).toEqual([]);
  return saved;
}

test('bound main UI merge preserves extension color groups through undo, redo, localhost save and reopen', async ({ page }) => {
  const before = await editorContent(page);
  await mergeFirstTwoMainCues(page, true);
  const merged = await editorContent(page);
  expect(mainContent(merged).segments).toEqual([
    { ...mainContent(before).segments[0], end: mainContent(before).segments[1].end, text: 'Alpha Bravo' },
    ...mainContent(before).segments.slice(2),
  ]);
  const extension = secondaryContent(merged).segments;
  expect(extension).toEqual([
    { ...secondaryContent(before).segments[0],
      end: secondaryContent(before).segments[1].end, text: '第一句。第二句。' },
    ...secondaryContent(before).segments.slice(2),
  ]);
  expect(extension).toHaveLength(5);
  for (const segment of extension) {
    if (segment.color_group_id) expect(colorValue(merged, segment)).not.toBeNull();
  }
  expect(merged.bindings).toHaveLength(5);
  expect(merged.bindings.slice(0, 4)).toEqual(before.bindings.slice(2));
  expect(merged.bindings[4]).toMatchObject({
    source: { track_id: mainContent(merged).id, segment_id: mainContent(merged).segments[0].id },
    target: { track_id: TRACK_ID, segment_id: extension[0].id },
    start_offset_ms: 0, end_offset_ms: 0,
  });

  await page.locator('#undo-btn').click();
  expect(await editorContent(page)).toEqual(before);
  await page.locator('#redo-btn').click();
  expect(await editorContent(page)).toEqual(merged);
  expect(contentSnapshot(JSON.parse(readFileSync(projectPath, 'utf8')))).toEqual(contentSnapshot(fixture));

  const saved = await saveAndReopen(page, merged);
  expect(cueSnapshot(secondaryContent(saved).segments)).toEqual(extension);
  await expect(page.locator('.multi-dual-cue .multi-cue-column.main .text')).toHaveText(mainContent(merged).segments.map(segment => segment.text));
  await expect(page.locator('.multi-dual-cue .multi-cue-column.extension .text')).toHaveText(extension.map(segment => segment.text));
  await expect(page.locator('.multi-cue-column.unbound')).toHaveCount(0);
});

test('main UI merge with bilingual mode off saves and reopens without touching the retained extension track', async ({ page }) => {
  await setProjectTrackEnabled(page, 'multi-subtitle-toggle', false);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().enabled)).toBe(false);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.multiSubtitleVisible())).toBe(false);
  await expect(page.locator('.multi-dual-cue')).toHaveCount(0);
  const before = await editorContent(page);
  expect(secondaryContent(before)).toEqual({ ...secondaryContent(contentSnapshot(fixture)), enabled: false });

  await mergeFirstTwoMainCues(page, false);
  const merged = await editorContent(page);
  expect(mainContent(merged).segments).toEqual([
    { ...mainContent(before).segments[0], end: mainContent(before).segments[1].end, text: 'Alpha Bravo' },
    ...mainContent(before).segments.slice(2),
  ]);
  expect(secondaryContent(merged)).toEqual(secondaryContent(before));
  // Hidden secondary cues survive, but bindings for the merged main sources do not.
  expect(merged.bindings).toEqual(before.bindings.slice(2));

  const saved = await saveAndReopen(page, merged);
  expect(secondaryContent(saved).enabled).toBe(false);
  expect(secondaryContent(saved).segments).toHaveLength(6);
  await expect(page.locator('#cues-container > .cue .text')).toHaveText(mainContent(merged).segments.map(segment => segment.text));
  await expect(page.locator('.multi-dual-cue')).toHaveCount(0);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().enabled)).toBe(false);
});

test('merging four main cues keeps a trailing extension color group saveable', async ({ page }) => {
  await page.locator('.multi-dual-cue[data-main-idx="0"] .multi-cue-column.main .text').click();
  await page.locator('.multi-dual-cue[data-main-idx="3"] .multi-cue-column.main .text').click({ modifiers: ['Shift'] });
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs].sort((a, b) => a - b))).toEqual([0, 1, 2, 3]);
  await page.keyboard.press('c');
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(3);
  const merged = await editorContent(page);
  const extension = secondaryContent(merged).segments;
  expect(extension).toHaveLength(3);
  expect(extension[0].color_group_id).toBeNull();
  expect(colorValue(merged, extension[1]).name).toBe('green');
  expect(extension[2].color_group_id).toBe(extension[1].color_group_id);
  await saveAndReopen(page, merged);
});

test('bound squeeze preview returning to origin preserves colors on localhost save', async ({ page }) => {
  const before = await editorContent(page);
  const preview = await page.evaluate(() => {
    const mainSegments = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
    const main = mainSegments[1];
    const original = { start: main.start, end: main.end };
    const drag = {
      track: 'main', kind: 'move', indices: [1], allowSqueeze: true,
      originals: new Map([[1, original]]),
    };
    main.start = mainSegments[0].start;
    main.end = mainSegments[0].end;
    MaweBoundDrag.syncBoundCueDrag(drag);
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const intermediate = {
      count: track.segments.length,
      greenGroup: track.segments.find(segment => segment.id === 'extension-5').color_group_id,
      redMemberColor: AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA, track.segments.find(segment => segment.id === 'extension-2'), 'color')?.name,
    };
    main.start = original.start;
    main.end = original.end;
    MaweBoundDrag.syncBoundCueDrag(drag);
    return intermediate;
  });
  expect(preview).toEqual({ count: 5, greenGroup: secondaryContent(before).segments[5].color_group_id, redMemberColor: 'red' });
  expect(await editorContent(page)).toEqual(before);
  await saveAndReopen(page, before);
});

function expectCrossGroupRed(project, segments, before) {
  expect(segments).toHaveLength(5);
  expect(segments[0].color_group_id).toBe(before[0].color_group_id);
  expect(segments[1].color_group_id).not.toBe(before[1].color_group_id);
  expect(segments[1].color_group_id).not.toBe(before[2].color_group_id);
  expect(colorValue(project, segments[1])).toMatchObject({ name: 'red', value: '#e74c3c' });
  expect(segments[1].start).toBe(before[1].start);
  expect(segments[1].end).toBe(before[2].end);
  expect(segments[2].color_group_id).toBe(before[3].color_group_id);
  expect(segments[3].color_group_id).toBe(before[4].color_group_id);
  expect(segments[4].color_group_id).toBe(before[5].color_group_id);
}

async function expectRedMainPreview(page, index, text) {
  // Dual-column rows intentionally have no color bar. Verify the real player
  // preview instead, using its explicit text-color mode at the merged cue.
  await page.evaluate(index => {
    MaweAppearance.setSubtitleAppearance({ color_underline: true, color_style: 'text' }, { markDirty: false });
    MaweCoreState.player.currentTime = (AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index].start + 100) / 1000;
    MawePlaybackLoop.refreshSubtitlePreview();
  }, index);
  await expect(page.locator('#overlay-main-text')).toHaveText(text);
  // Rendering uses the current project palette, not a legacy stored hex value.
  const red = await page.evaluate(() => MaweColors.COLOR_BY_NAME.red.value);
  const channels = red.replace('#', '').match(/.{2}/g).map(channel => parseInt(channel, 16));
  await expect(page.locator('#overlay-main-text')).toHaveAttribute('data-color-text', red);
  await expect(page.locator('#overlay-main-text')).toHaveCSS('color', `rgb(${channels.join(', ')})`);
}

test('same-color cross-group swap and main UI merge stays red through undo, redo, save and server restart', async ({ page }, testInfo) => {
  await openSettingsPage(page, 'multi-subtitle');
  await page.locator('#multi-subtitle-swap').click();
  await closeSettingsPanels(page);
  await expect(page.locator('.multi-dual-cue[data-main-idx="0"] .multi-cue-column.main .text')).toHaveText(EXTENSION_TEXTS[0]);
  const before = await editorContent(page);
  expect(mainContent(before).segments[1].color_group_id).toBe(mainContent(before).segments[0].color_group_id);
  expect(colorValue(before, mainContent(before).segments[2]).name).toBe('red');
  expect(mainContent(before).segments[2].color_group_id).not.toBe(mainContent(before).segments[1].color_group_id);
  await page.locator('.multi-dual-cue[data-main-idx="1"] .multi-cue-column.main .text').click();
  await page.locator('.multi-dual-cue[data-main-idx="2"] .multi-cue-column.main .text').click({ modifiers: ['ControlOrMeta'] });
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs].sort((a, b) => a - b))).toEqual([1, 2]);
  await page.keyboard.press('c');
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)).toBe(5);
  const merged = await editorContent(page);
  expectCrossGroupRed(merged, mainContent(merged).segments, mainContent(before).segments);
  expectCrossGroupRed(merged, secondaryContent(merged).segments, secondaryContent(before).segments);
  expect(mainContent(merged).segments[1].text).toBe(`${EXTENSION_TEXTS[1]}${EXTENSION_TEXTS[2]}`);
  expect(secondaryContent(merged).segments[1].text).toBe('Bravo Charlie');
  await expectRedMainPreview(page, 1, mainContent(merged).segments[1].text);
  await page.locator('#undo-btn').click();
  expect(await editorContent(page)).toEqual(before);
  await page.locator('#redo-btn').click();
  expect(await editorContent(page)).toEqual(merged);
  expect(contentSnapshot(JSON.parse(readFileSync(projectPath, 'utf8')))).toEqual(contentSnapshot(fixture));
  await saveAndReopen(page, merged);
  await expectRedMainPreview(page, 1, mainContent(merged).segments[1].text);
  await page.screenshot({ path: testInfo.outputPath('same-color-saved-preview.png') });
});

test('same-color cross-group extension UI merge stays red independently through undo, redo and save', async ({ page }) => {
  const before = await editorContent(page);
  await page.locator('.multi-dual-cue[data-ext-idx="1"] .multi-cue-column.extension .text').click();
  await page.locator('.multi-dual-cue[data-ext-idx="2"] .multi-cue-column.extension .text').click({ modifiers: ['ControlOrMeta'] });
  expect(await page.evaluate(() => [...MaweSelection.selectedExtensionIdxs].sort((a, b) => a - b))).toEqual([1, 2]);
  expect(await page.evaluate(() => MaweCuePanel.getCurrentCuePanelTarget()?.kind)).toBe('extension');
  await page.keyboard.press('c');
  await expect.poll(() => page.evaluate(() => MaweMultiSubtitleCore.getActiveExtensionTrack().segments.length)).toBe(5);
  const merged = await editorContent(page);
  expect(mainContent(merged)).toEqual(mainContent(before));
  expectCrossGroupRed(merged, secondaryContent(merged).segments, secondaryContent(before).segments);
  expect(merged.bindings).toEqual(before.bindings.filter(binding => !['binding-1', 'binding-2'].includes(binding.id)));
  await page.locator('#undo-btn').click();
  expect(await editorContent(page)).toEqual(before);
  await page.locator('#redo-btn').click();
  expect(await editorContent(page)).toEqual(merged);
  await saveAndReopen(page, merged);
  await expect(page.locator('.multi-cue-column.extension .text').filter({ hasText: `${EXTENSION_TEXTS[1]}${EXTENSION_TEXTS[2]}` })).toHaveCount(1);
});
