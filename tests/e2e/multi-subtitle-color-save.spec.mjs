import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir, closeSettingsPanels, disableOnboarding, findFreePort, generateProjectJson, openSettingsPage,
  generateWav, generateWaveformPayload, makeTempDir, setProjectTrackEnabled, startServer,
} from './helpers.mjs';

const DURATION_MS = 15_000;
const TRACK_ID = 'translation';
const MAIN_TEXTS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
const EXTENSION_TEXTS = ['第一句。', '第二句。', '第三句。', '第四句。', '第五句。', '第六句。'];

let tempDir, server, projectPath, fixture, pageErrors;

function generateColoredProject(path, adjacentRedGroups = false) {
  generateProjectJson(path);
  const project = JSON.parse(readFileSync(path, 'utf8'));
  project.waveform = generateWaveformPayload(DURATION_MS);
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
  writeFileSync(path, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  return project;
}

// Compare persisted subtitle content, not transient dirty flags or optional null fields.
function cueSnapshot(segments) {
  return segments.map(segment => ({
    id: segment.id, start: segment.start, end: segment.end, text: segment.text,
    color: segment.color || null, color_ref: segment.color_ref || null,
  }));
}

function contentSnapshot(project) {
  const multi = project.multi_subtitle;
  return {
    segments: cueSnapshot(project.segments),
    multi_subtitle: {
      schema: multi.schema, enabled: multi.enabled, display_mode: multi.display_mode,
      main_split_mode: multi.main_split_mode,
      tracks: multi.tracks.map(track => ({
        id: track.id, role: track.role, name: track.name, language: track.language,
        split_mode: track.split_mode, source_name: track.source_name,
        segments: cueSnapshot(track.segments),
      })),
      bindings: multi.bindings,
    },
  };
}

async function editorContent(page) {
  return contentSnapshot(await page.evaluate(() => ({
    segments: MaweBoot.DATA.segments,
    multi_subtitle: MaweMultiSubtitleCore.getMultiSubtitleState(),
  })));
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
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(5);
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
  expect(merged.segments).toEqual([
    { ...before.segments[0], id: 'main-0-merged', end: before.segments[1].end, text: 'Alpha Bravo' },
    ...before.segments.slice(2),
  ]);
  const extension = merged.multi_subtitle.tracks[0].segments;
  expect(extension).toEqual([
    { ...before.multi_subtitle.tracks[0].segments[0], id: 'extension-0-merged',
      end: before.multi_subtitle.tracks[0].segments[1].end, text: '第一句。第二句。' },
    ...before.multi_subtitle.tracks[0].segments.slice(2, 5),
    { ...before.multi_subtitle.tracks[0].segments[5], color_ref: { name: 'green', headIdx: 3 } },
  ]);
  expect(extension).toHaveLength(5);
  for (const [index, segment] of extension.entries()) {
    if (!segment.color_ref) continue;
    expect(segment.color_ref.headIdx).toBeLessThan(index);
    expect(extension[segment.color_ref.headIdx].color.name).toBe(segment.color_ref.name);
  }
  expect(merged.multi_subtitle.bindings).toHaveLength(5);
  expect(merged.multi_subtitle.bindings.slice(0, 4)).toEqual(before.multi_subtitle.bindings.slice(2));
  expect(merged.multi_subtitle.bindings[4]).toMatchObject({
    track_id: TRACK_ID, main_segment_ids: ['main-0-merged'], extension_segment_ids: ['extension-0-merged'],
    start_offset_ms: 0, end_offset_ms: 0,
  });

  await page.locator('#undo-btn').click();
  expect(await editorContent(page)).toEqual(before);
  await page.locator('#redo-btn').click();
  expect(await editorContent(page)).toEqual(merged);
  expect(contentSnapshot(JSON.parse(readFileSync(projectPath, 'utf8')))).toEqual(contentSnapshot(fixture));

  const saved = await saveAndReopen(page, merged);
  expect(cueSnapshot(saved.multi_subtitle.tracks[0].segments)).toEqual(extension);
  await expect(page.locator('.multi-dual-cue .multi-cue-column.main .text')).toHaveText(merged.segments.map(segment => segment.text));
  await expect(page.locator('.multi-dual-cue .multi-cue-column.extension .text')).toHaveText(extension.map(segment => segment.text));
  await expect(page.locator('.multi-cue-column.unbound')).toHaveCount(0);
});

test('main UI merge with bilingual mode off saves and reopens without touching the retained extension track', async ({ page }) => {
  await setProjectTrackEnabled(page, 'multi-subtitle-toggle', false);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getMultiSubtitleState().enabled)).toBe(false);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.multiSubtitleVisible())).toBe(false);
  await expect(page.locator('.multi-dual-cue')).toHaveCount(0);
  const before = await editorContent(page);
  expect(before.multi_subtitle.tracks).toEqual(contentSnapshot(fixture).multi_subtitle.tracks);

  await mergeFirstTwoMainCues(page, false);
  const merged = await editorContent(page);
  expect(merged.segments).toEqual([
    { ...before.segments[0], id: 'main-0-merged', end: before.segments[1].end, text: 'Alpha Bravo' },
    ...before.segments.slice(2),
  ]);
  expect(merged.multi_subtitle.enabled).toBe(false);
  expect(merged.multi_subtitle.tracks).toEqual(before.multi_subtitle.tracks);
  // Removed main IDs cannot remain bound, but the hidden extension cues stay intact.
  expect(merged.multi_subtitle.bindings).toEqual(before.multi_subtitle.bindings.slice(2));

  const saved = await saveAndReopen(page, merged);
  expect(saved.multi_subtitle.enabled).toBe(false);
  expect(saved.multi_subtitle.tracks[0].segments).toHaveLength(6);
  await expect(page.locator('#cues-container > .cue .text')).toHaveText(merged.segments.map(segment => segment.text));
  await expect(page.locator('.multi-dual-cue')).toHaveCount(0);
  expect(await page.evaluate(() => MaweMultiSubtitleCore.getMultiSubtitleState().enabled)).toBe(false);
});

test('merging four main cues keeps a trailing extension color group saveable', async ({ page }) => {
  await page.locator('.multi-dual-cue[data-main-idx="0"] .multi-cue-column.main .text').click();
  await page.locator('.multi-dual-cue[data-main-idx="3"] .multi-cue-column.main .text').click({ modifiers: ['Shift'] });
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs].sort((a, b) => a - b))).toEqual([0, 1, 2, 3]);
  await page.keyboard.press('c');
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(3);
  const merged = await editorContent(page);
  const extension = merged.multi_subtitle.tracks[0].segments;
  expect(extension).toHaveLength(3);
  expect(extension[0].color).toBeNull();
  expect(extension[1].color.name).toBe('green');
  expect(extension[2].color_ref).toEqual({ name: 'green', headIdx: 1 });
  await saveAndReopen(page, merged);
});

test('bound squeeze preview returning to origin preserves colors on localhost save', async ({ page }) => {
  const before = await editorContent(page);
  const preview = await page.evaluate(() => {
    const main = MaweBoot.DATA.segments[1];
    const original = { start: main.start, end: main.end };
    const drag = {
      track: 'main', kind: 'move', indices: [1], allowSqueeze: true,
      originals: new Map([[1, original]]),
    };
    main.start = MaweBoot.DATA.segments[0].start;
    main.end = MaweBoot.DATA.segments[0].end;
    MaweBoundDrag.syncBoundCueDrag(drag);
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const intermediate = {
      count: track.segments.length,
      greenRef: track.segments.find(segment => segment.id === 'extension-5').color_ref.headIdx,
      redMemberPromoted: Boolean(track.segments.find(segment => segment.id === 'extension-2').color),
    };
    main.start = original.start;
    main.end = original.end;
    MaweBoundDrag.syncBoundCueDrag(drag);
    return intermediate;
  });
  expect(preview).toEqual({ count: 5, greenRef: 3, redMemberPromoted: true });
  expect(await editorContent(page)).toEqual(before);
  await saveAndReopen(page, before);
});

function expectCrossGroupRed(segments, before) {
  expect(segments).toHaveLength(5);
  expect(segments[0].color).toEqual({ ...before[0].color, end: before[0].end });
  expect(segments[1].color).toEqual({ name: 'red', value: '#e74c3c', start: before[1].start, end: before[2].end });
  expect(segments[1].color_ref).toBeNull();
  expect(segments[2].color).toEqual({ ...before[2].color, start: before[3].start, end: before[3].end });
  expect(segments[2].color_ref).toBeNull();
  expect(segments[3].color).toEqual(before[4].color);
  expect(segments[4].color_ref).toEqual({ name: 'green', headIdx: 3 });
}

async function expectRedMainPreview(page, index, text) {
  // Dual-column rows intentionally have no color bar. Verify the real player
  // preview instead, using its explicit text-color mode at the merged cue.
  await page.evaluate(index => {
    MaweAppearance.setSubtitleAppearance({ color_underline: true, color_style: 'text' }, { markDirty: false });
    MaweCoreState.player.currentTime = (MaweBoot.DATA.segments[index].start + 100) / 1000;
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
  expect(before.segments[1].color_ref).toEqual({ name: 'red', headIdx: 0 });
  expect(before.segments[2].color.name).toBe('red');
  expect(before.segments[2].color_ref).toBeNull();
  await page.locator('.multi-dual-cue[data-main-idx="1"] .multi-cue-column.main .text').click();
  await page.locator('.multi-dual-cue[data-main-idx="2"] .multi-cue-column.main .text').click({ modifiers: ['ControlOrMeta'] });
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs].sort((a, b) => a - b))).toEqual([1, 2]);
  await page.keyboard.press('c');
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(5);
  const merged = await editorContent(page);
  expectCrossGroupRed(merged.segments, before.segments);
  expectCrossGroupRed(merged.multi_subtitle.tracks[0].segments, before.multi_subtitle.tracks[0].segments);
  expect(merged.segments[1].text).toBe(`${EXTENSION_TEXTS[1]}${EXTENSION_TEXTS[2]}`);
  expect(merged.multi_subtitle.tracks[0].segments[1].text).toBe('Bravo Charlie');
  await expectRedMainPreview(page, 1, merged.segments[1].text);
  await page.locator('#undo-btn').click();
  expect(await editorContent(page)).toEqual(before);
  await page.locator('#redo-btn').click();
  expect(await editorContent(page)).toEqual(merged);
  expect(contentSnapshot(JSON.parse(readFileSync(projectPath, 'utf8')))).toEqual(contentSnapshot(fixture));
  await saveAndReopen(page, merged);
  await expectRedMainPreview(page, 1, merged.segments[1].text);
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
  expect(merged.segments).toEqual(before.segments);
  expectCrossGroupRed(merged.multi_subtitle.tracks[0].segments, before.multi_subtitle.tracks[0].segments);
  expect(merged.multi_subtitle.bindings).toEqual(before.multi_subtitle.bindings.filter(binding => !['binding-1', 'binding-2'].includes(binding.id)));
  await page.locator('#undo-btn').click();
  expect(await editorContent(page)).toEqual(before);
  await page.locator('#redo-btn').click();
  expect(await editorContent(page)).toEqual(merged);
  await saveAndReopen(page, merged);
  await expect(page.locator('.multi-cue-column.extension .text').filter({ hasText: `${EXTENSION_TEXTS[1]}${EXTENSION_TEXTS[2]}` })).toHaveCount(1);
});
