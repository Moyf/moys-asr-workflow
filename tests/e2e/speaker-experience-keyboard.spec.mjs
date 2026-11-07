import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { buildBrowserEditorFixture, cleanupTempDir, disableOnboarding, findFreePort,
  generateWaveformPayload, makeTempDir, startStaticServer } from './helpers.mjs';

let dir;
let server;
test.beforeAll(async () => {
  dir = makeTempDir('speaker-keyboard');
  server = await startStaticServer(buildBrowserEditorFixture(join(dir, 'editor.html')), await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });

async function dropProject(page, project) {
  expect(await page.evaluate(project => AsrEditorUtils.validateTracksProject(project).errors, project)).toEqual([]);
  const transfer = await page.evaluateHandle(project => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(project)], 'identity.mosp', { type: 'application/json' }));
    return dt;
  }, project);
  await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect.poll(() => page.evaluate(() => ({ text: MaweBoot.DATA.tracks[0]?.segments[0]?.text,
    errors: window.MAWE_DEBUG_ERRORS || [] }))).toEqual({ text: '主字幕', errors: [] });
}

test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await dropProject(page, {
    schema: 'moy.asr.project.v2', annotation_mode: 'speaker', palette_size: 5, speakers: [], speaker_shortcuts: {},
    tracks: ['main', 'secondary', 'overlay'].map((role, i) => ({ id: role, role, name: role, enabled: true,
      segments: [{ id: `${role}-cue`, start: i * 1200, end: i * 1200 + 1000, text: ['主字幕', '副字幕', '叠加字幕'][i],
        items: [{ text: ['主字幕', '副字幕', '叠加字幕'][i], start: i * 1200, end: i * 1200 + 1000 }] }] })),
    bindings: [], bilingual: { display_mode: 'both', active_track_id: 'secondary' },
    subtitle_groups: { next_id: 1, color: [], sticker: [] }, waveform: generateWaveformPayload(5000),
    preview: { subtitle: { x: 0.1, y: 0.8, width: 0.8, height: 0.15,
      speaker_labels: { enabled: false, export_enabled: false, mapping_enabled: false } } },
  });
});

async function selectTrack(page, kind) {
  await page.evaluate(kind => {
    MaweState.selection.reset();
    MaweState.selection.add(kind, 0);
    MaweCuePanel.setCuePanelTarget(kind, 0, kind === 'extension' ? 'secondary' : null);
    document.activeElement?.blur();
  }, kind);
}

test('empty slots create once, undo atomically, and collapsed extra slots retain identities through reopen', async ({ page }) => {
  await page.evaluate(() => MaweSelection.clearSelection({ silent: true }));
  await page.keyboard.press('1');
  expect(await page.evaluate(() => MaweBoot.DATA.speakers.length)).toBe(0);
  await selectTrack(page, 'main');
  await page.keyboard.press('6');
  expect(await page.evaluate(() => MaweBoot.DATA.speakers.length)).toBe(0);
  const items = await page.evaluate(() => MaweBoot.DATA.tracks[0].segments[0].items);
  await page.keyboard.press('1');
  const first = await page.evaluate(() => structuredClone(MaweBoot.DATA.speakers[0]));
  expect(first).toMatchObject({ name: '说话人 1', color: '#f9ca1f' });
  await page.keyboard.press('1');
  expect(await page.evaluate(() => MaweBoot.DATA.speakers.length)).toBe(1);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.speakers)).toEqual([]);
  await page.locator('#redo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.speakers)).toEqual([first]);
  await page.evaluate(() => MaweSpeakerLabels.setPaletteSize(9));
  await selectTrack(page, 'main');
  await page.keyboard.press('6');
  const extra = await page.evaluate(() => structuredClone(MaweBoot.DATA.speakers[1]));
  expect(extra.color).toBe('#f2a65a');
  await page.evaluate(() => MaweSpeakerLabels.setPaletteSize(5));
  await page.keyboard.press('9');
  expect(await page.evaluate(() => MaweBoot.DATA.speakers.length)).toBe(2);
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(saved.speaker_shortcuts['6']).toBe(extra.id);
  expect(saved.tracks[0].segments[0].items).toEqual(items);
  expect(saved.preview.subtitle.speaker_labels).toMatchObject({ enabled: false, export_enabled: false, mapping_enabled: false });
  await page.reload();
  await dropProject(page, saved);
  expect(await page.evaluate(() => ({ palette: MaweBoot.DATA.palette_size, speakers: MaweBoot.DATA.speakers,
    color: AsrEditorUtils.effectiveSegmentColor(MaweBoot.DATA, MaweBoot.DATA.tracks[0].segments[0])?.value })))
    .toEqual({ palette: 5, speakers: saved.speakers, color: '#f2a65a' });
});

test('digits and clear respect the current track and the identity or category purpose', async ({ page }) => {
  for (const [kind, slot] of [['main', 1], ['extension', 2], ['overlay', 3]]) {
    await selectTrack(page, kind);
    await page.keyboard.press(String(slot));
  }
  const assigned = await page.evaluate(() => MaweBoot.DATA.tracks.map(track => track.segments[0].speaker));
  expect(new Set(assigned).size).toBe(3);
  await page.evaluate(() => MaweSpeakerLabels.setAnnotationMode('color'));
  await selectTrack(page, 'extension');
  await page.keyboard.press('5');
  expect(await page.evaluate(() => MaweBoot.DATA.tracks.map(track => track.segments[0].speaker))).toEqual(assigned);
  expect(await page.evaluate(() => AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA, MaweBoot.DATA.tracks[1].segments[0], 'color').name)).toBe('blue');
  await page.keyboard.press('0');
  expect(await page.evaluate(() => MaweBoot.DATA.tracks[1].segments[0].color_group_id)).toBeUndefined();
  await page.evaluate(() => MaweSpeakerLabels.setAnnotationMode('speaker'));
  await selectTrack(page, 'extension');
  await page.keyboard.press('0');
  expect(await page.evaluate(() => MaweBoot.DATA.tracks.map(track => track.segments[0].speaker ?? null)))
    .toEqual([assigned[0], null, assigned[2]]);
  expect(await page.evaluate(() => MaweBoot.DATA.preview.subtitle.speaker_labels)).toMatchObject({ enabled: false, export_enabled: false });
});

test('a deselected secondary cue cannot redirect a digit to its still-selected main binding', async ({ page }) => {
  await page.evaluate(() => {
    const main = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    const secondary = MaweMultiSubtitleCore.getActiveExtensionTrack();
    MaweBoot.DATA.bindings = [AsrEditorUtils.buildSubtitleBinding(main.segments[0], secondary.segments[0], secondary.id, 'link', main.id)];
    MaweSelection.selectOnlyExtension(0, secondary);
    MaweSelection.toggleExtensionSelection(0, secondary);
  });
  await page.keyboard.press('1');
  expect(await page.evaluate(() => MaweBoot.DATA.speakers)).toEqual([]);
});
