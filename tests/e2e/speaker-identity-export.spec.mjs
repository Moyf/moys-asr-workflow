import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson, generateWav, makeTempDir, startServer } from './helpers.mjs';

let directory, server;
test.beforeAll(async () => {
  directory = makeTempDir('speaker-identity-export');
  const media = join(directory, 'synthetic.wav');
  generateWav(media, 300);
  const project = generateProjectJson(join(directory, 'project.mosp'));
  server = await startServer(project, media, await findFreePort());
});

test('custom HEX color export stays distinct and secondary CSS color survives ASS roundtrip', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweSpeakerLabels && window.MawePlaybackLoop));
  await page.evaluate(() => {
    MaweSettings.updateEditorSettings({ autoSaveProject: false, assMode: false, exportSpeakerLabels: true });
    MaweBoot.DATA.speakers = [{ id: 'person', name: 'Custom person', color: '#123456' }];
    MaweBoot.DATA.annotation_mode = 'speaker';
    const main = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    main.segments[0].speaker = 'person';
    MaweBoot.DATA.tracks.push({ id: 'secondary', role: 'secondary', name: '副字幕', enabled: true,
      segments: [{ id: 'secondary-cue', start: 0, end: 8000, text: 'Secondary', speaker: 'person' }] });
    MaweBoot.DATA.bilingual = { display_mode: 'both', active_track_id: 'secondary' };
    MaweSpeakerLabels.setSpeakerLabelSettings({ ...MaweSpeakerLabels.getSpeakerLabelSettings(), enabled: true, separator: ':' });
    MaweAppearance.setSubtitleAppearance({ color_style: 'text', color_underline: true });
    MaweDom.overlayToggle.checked = true;
    MaweDom.extensionOverlayToggle.checked = true;
    MaweCoreState.player.currentTime = 1;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    MaweExportSrt.updateSubtitleExportUi();
  });
  await expect(page.locator('#overlay-extension-text')).toHaveCSS('color', 'rgb(18, 52, 86)');
  const exported = await page.evaluate(() => {
    const colors = MaweExportSrt.usedSubtitleColors();
    const segments = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
    const options = MaweSpeakerLabels.speakerLabelExportOptions();
    return { colors, hidden: MaweDom.downloadColorSrtItem.hidden,
      colored: AsrEditorUtils.buildSrtPayload(segments, { ...options, colorName: '#123456' }),
      unassigned: AsrEditorUtils.buildSrtPayload(segments, { ...options, colorName: 'default' }) };
  });
  expect(exported.colors).toContainEqual({ name: '#123456', value: '#123456', label: '#123456' });
  expect(exported.hidden).toBe(false);
  expect(exported.colored).toContain('Custom person:Alpha');
  expect(exported.colored).not.toContain('Bravo');
  expect(exported.unassigned).toContain('Bravo');
  expect(exported.unassigned).not.toContain('Alpha');
  await page.evaluate(async () => {
    await loadAssStyleLibrary({ force: true });
    MaweSettings.updateEditorSettings({ assMode: true });
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay')).toHaveAttribute('data-ass-mode', 'true');
  await page.evaluate(() => {
    MaweSettings.updateEditorSettings({ assMode: false });
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay-extension-text')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await page.evaluate(() => {
    MaweBoot.DATA.annotation_mode = 'color';
    AsrEditorUtils.assignSubtitleGroup(MaweBoot.DATA, AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, [0], 'color', { name: 'yellow', value: '#f9ca1f' });
    MaweSettings.updateEditorSettings({ subtitleColorPaletteEnabled: true,
      subtitleColorPalette: { ...MaweSettings.EDITOR_SETTINGS.subtitleColorPalette, yellow: '#ab12cd' } });
    MaweColors.rebuildEditorColorPalette();
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay-main-text')).toHaveCSS('color', 'rgb(171, 18, 205)');
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });

test('preview and exported names independently use real identity with collapsed extra color and no category group', async ({ page }, info) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweSpeakerLabels && window.MawePlaybackLoop));
  await page.evaluate(() => {
    MaweSettings.updateEditorSettings({ autoSaveProject: false, assMode: false, exportSpeakerLabels: false });
    MaweBoot.DATA.speakers = [{ id: 'person', name: 'Host<&>', color: '#49c5c1' }];
    MaweBoot.DATA.speaker_shortcuts = { 7: 'person' };
    MaweBoot.DATA.palette_size = 5;
    MaweBoot.DATA.annotation_mode = 'speaker';
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker = 'person';
    MaweSpeakerLabels.setSpeakerLabelSettings({ ...MaweSpeakerLabels.getSpeakerLabelSettings(), mapping_enabled: false, enabled: true, separator: ':' });
    MaweAppearance.setSubtitleAppearance({ color_style: 'text', color_underline: true });
    MaweDom.overlayToggle.checked = true;
    MaweCoreState.player.currentTime = 1;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay-main-speaker-label')).toHaveText('Host<&>:');
  await expect(page.locator('#overlay-main-speaker-label')).toBeVisible();
  await expect(page.locator('#overlay-main-text')).toHaveCSS('color', 'rgb(73, 197, 193)');
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).not.toContain('Host<&>');
  await page.screenshot({ path: info.outputPath('identity-cyan-preview.png') });
  const exports = await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels = true;
    MaweSpeakerLabels.setSpeakerLabelSettings({ ...MaweSpeakerLabels.getSpeakerLabelSettings(), enabled: false });
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    return {
      srt: MaweExportSrt.buildSrt(),
      txt: AsrEditorUtils.buildPlainTextPayload(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, MaweSpeakerLabels.speakerLabelExportOptions()),
      ass: MaweExportSrt.buildAss(), resolve: JSON.parse(MaweExportTimeline.buildResolveJson()),
      dynamicText: MaweSpeakerLabels.subtitleExportText(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0], AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments),
    };
  });
  await expect(page.locator('#overlay-main-speaker-label')).toBeHidden();
  expect(exports.srt).toContain('Host<&>:Alpha');
  expect(exports.txt).toContain('Host<&>:Alpha');
  expect(exports.ass).toContain('Host<&>');
  expect(exports.ass).toContain('SPEAKER_49C5C1');
  expect(exports.resolve.segments[0].color.value).toBe('#49c5c1');
  expect(exports.resolve.segments[0].text).toBe('Host<&>:Alpha');
  expect(exports.dynamicText).toBe('Host<&>:Alpha');

  await page.evaluate(() => {
    MaweBoot.DATA.annotation_mode = 'color';
    MaweSpeakerLabels.setSpeakerLabelSettings({ ...MaweSpeakerLabels.getSpeakerLabelSettings(), enabled: true });
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay-main-speaker-label')).toHaveText('Host<&>:');
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).toContain('Host<&>:Alpha');
  await page.evaluate(() => {
    const main = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    main.segments[0].speaker = null;
    AsrEditorUtils.assignSubtitleGroup(MaweBoot.DATA, main.segments, [0], 'color', { name: 'yellow', value: '#f9ca1f' });
    MaweSpeakerLabels.setSpeakerLabelSettings({ ...MaweSpeakerLabels.getSpeakerLabelSettings(), mapping_enabled: true, names: { yellow: 'Wrong old name' } });
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay-main-speaker-label')).toBeHidden();
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).not.toContain('Wrong old name');
});
