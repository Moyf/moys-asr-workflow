import { expect, test } from '@playwright/test';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';

let directory, server;
test.beforeAll(async () => {
  directory = makeTempDir('speaker-project-import');
  server = await startBlankServer(await findFreePort(), directory);
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });

test('project-to-secondary import registers independent people with one undo and preserves settings', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweMultiImport && window.MaweCommands));
  await page.evaluate(async () => {
    MaweSettings.updateEditorSettings({ autoSaveProject: false });
    const project = AsrEditorUtils.makeProject([{ id: 'main', start: 0, end: 1000, text: 'Main', speaker: 'spk-001' }], {
      projectFields: { speakers: [{ id: 'spk-001', name: '同名', color: '#969fab' }],
        annotation_mode: 'color', palette_size: 5, speaker_shortcuts: { 1: 'spk-001' } },
    });
    await MaweMultiImport.openProjectFile(new File([JSON.stringify(project)], 'main.mosp', { type: 'application/json' }), { suppressMediaPrompt: true });
  });
  const capture = () => page.evaluate(() => ({
    project: AsrEditorUtils.snapshotProjectContent(MaweBoot.DATA),
    undo: MaweHistory.editorHistory.undoLength(),
  }));
  const before = await capture();
  await page.evaluate(async () => {
    const source = AsrEditorUtils.makeProject([
      { id: 'a', start: 0, end: 400, text: 'First', speaker: 'spk-001', items: [{ start: 0, end: 400, start_frame: 0, end_frame: 12, text: 'First' }] },
      { id: 'b', start: 400, end: 800, text: 'Second', speaker: 'spk-002' },
    ], { projectFields: { speakers: [
      { id: 'spk-001', name: '同名', color: '#969fab', vendor: { keep: 7 } },
      { id: 'spk-002', name: '同名', color: '#969fab' },
      { id: 'unused', name: '未使用', color: '#123456' },
    ], annotation_mode: 'speaker', palette_size: 9, speaker_shortcuts: { 1: 'spk-001', 2: 'spk-002' } } });
    AsrEditorUtils.assignSubtitleGroup(source, AsrEditorUtils.getMainTrack(source).segments, [0, 1], 'color', { name: 'blue', value: '#123456' });
    window.importedSpeakerFile = new File([JSON.stringify(source)], 'other.mosp', { type: 'application/json' });
    const segments = await MaweLoadingProgress.parseSubtitleImportFile(importedSpeakerFile);
    await MaweMultiImport.showMultiSubtitleImportChoice(importedSpeakerFile, segments, { projectFile: importedSpeakerFile });
  });
  // Cancelling the chooser must not register source identities.
  await page.evaluate(() => MaweMultiImport.closeMultiSubtitleImportModal());
  expect(await capture()).toEqual(before);
  // A later group-copy failure rolls back the already registered identities,
  // not just the newly installed secondary track.
  const failed = await page.evaluate(async () => {
    const segments = await MaweLoadingProgress.parseSubtitleImportFile(importedSpeakerFile);
    delete segments.subtitle_groups.color[0].value.name;
    await MaweMultiImport.showMultiSubtitleImportChoice(importedSpeakerFile, segments, { projectFile: importedSpeakerFile });
    MaweMultiImport.prepareMultiSubtitleImport();
    try { MaweMultiImport.commitMultiSubtitleImport(); return ''; }
    catch (error) { return error.message; }
  });
  expect(failed).toContain('Subtitle group value requires a name');
  expect(await capture()).toEqual(before);
  await page.evaluate(async () => {
    const segments = await MaweLoadingProgress.parseSubtitleImportFile(importedSpeakerFile);
    await MaweMultiImport.showMultiSubtitleImportChoice(importedSpeakerFile, segments, { projectFile: importedSpeakerFile });
  });
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  const after = await capture();
  expect(after.undo).toBe(before.undo + 1);
  expect(after.project.speakers).toEqual([
    { id: 'spk-001', name: '同名', color: '#969fab' },
    { id: 'spk-002', name: '同名', color: '#969fab', vendor: { keep: 7 } },
    { id: 'spk-003', name: '同名', color: '#969fab' },
  ]);
  expect(after.project.annotation_mode).toBe('color');
  expect(after.project.palette_size).toBe(5);
  expect(after.project.speaker_shortcuts).toEqual({ 1: 'spk-001' });
  const secondary = after.project.tracks.find(track => track.role === 'secondary');
  expect(secondary.segments.map(segment => segment.speaker)).toEqual(['spk-002', 'spk-003']);
  expect(secondary.segments[0].items).toEqual([{ start: 0, end: 400, start_frame: 0, end_frame: 12, text: 'First' }]);
  expect(secondary.segments[0].color_group_id).toBe(secondary.segments[1].color_group_id);
  expect(after.project.subtitle_groups.color.find(group => group.id === secondary.segments[0].color_group_id).value).toEqual({ name: 'blue', value: '#123456' });
  await page.locator('#undo-btn').click();
  expect((await capture()).project).toEqual(before.project);
  await page.locator('#redo-btn').click();
  expect((await capture()).project).toEqual(after.project);

  // A missing source identity must be refused before the command mutates data.
  const refused = await page.evaluate(async () => {
    const segments = await MaweLoadingProgress.parseSubtitleImportFile(importedSpeakerFile);
    segments[0].speaker = 'missing';
    await MaweMultiImport.showMultiSubtitleImportChoice(importedSpeakerFile, segments, { projectFile: importedSpeakerFile });
    MaweMultiImport.prepareMultiSubtitleImport();
    return MaweMultiImport.commitMultiSubtitleImport();
  });
  expect(refused).toBe(false);
  expect(await capture()).toEqual(after);
});
