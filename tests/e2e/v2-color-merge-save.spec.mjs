import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectModel } from '../helpers/runtime-project.mjs';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, makeTempDir, startServer } from './helpers.mjs';

let dir, server, projectPath, initialProject;
test.beforeAll(async () => {
  dir = makeTempDir('v2-color-merge');
  projectPath = join(dir, 'project.mosp');
  const media = join(dir, 'source.wav');
  generateWav(media, 8);
  const main = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, start: i * 1500, end: i * 1500 + 1000, text: `main ${i}` }));
  const secondary = main.map((cue, i) => ({ id: `e${i}`, start: cue.start, end: cue.end, text: `translation ${i}` }));
  secondary[0].color = { name: 'red', value: '#aa0000', start: 0, end: 2500 };
  secondary[1].color_ref = { name: 'red', headIdx: 0 };
  secondary[2].color = { name: 'red', value: '#bb0000', start: 3000, end: 5500 };
  secondary[3].color_ref = { name: 'red', headIdx: 2 };
  const legacy = { media, segments: main, multi_subtitle: { schema: 'moy.asr.multi_subtitle.v1',
    enabled: true, display_mode: 'both', tracks: [{ id: 'translation', role: 'extension', segments: secondary }], bindings: [] } };
  initialProject = projectModel.importProject(legacy).project;
  writeFileSync(projectPath, JSON.stringify(initialProject, null, 2), 'utf8');
  server = await startServer(projectPath, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });
test.beforeEach(() => writeFileSync(projectPath, JSON.stringify(initialProject, null, 2), 'utf8'));

async function snapshot(page) {
  return page.evaluate(() => {
    const project = MaweBoot.DATA;
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    return track.segments.map(segment => ({ id: segment.id, text: segment.text,
      group: segment.color_group_id || null,
      color: AsrEditorUtils.getSubtitleGroupValue(project, segment, 'color')?.name || null }));
  });
}

test('cross-group secondary merge keeps color and supports real undo, save and reopen', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  await expect(page.locator('.multi-cue-column.extension').first()).toBeVisible();
  const before = await snapshot(page);
  expect(before.map(item => item.color)).toEqual(['red', 'red', 'red', 'red']);
  expect(before[0].group).toBe(before[1].group);
  expect(before[2].group).toBe(before[3].group);
  expect(before[0].group).not.toBe(before[2].group);

  expect(await page.evaluate(() => MaweSegmentOps.mergeExtensionSegments([1, 2]))).toBe(true);
  const merged = await snapshot(page);
  expect(merged).toHaveLength(3);
  expect(merged.map(item => item.color)).toEqual(['red', 'red', 'red']);
  expect(merged[0].group).toBe(before[0].group);
  expect(merged[2].group).toBe(before[3].group);
  expect(merged[1].group).not.toBe(before[0].group);
  expect(merged[1].group).not.toBe(before[2].group);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => snapshot(page)).toEqual(before);
  expect(await page.evaluate(() => MaweSegmentOps.mergeExtensionSegments([1, 2]))).toBe(true);
  const saved = await snapshot(page);
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
  expect(JSON.parse(readFileSync(projectPath, 'utf8')).schema).toBe('moy.asr.project.v2');
  await page.reload();
  await expect(page.locator('.multi-cue-column.extension').first()).toBeVisible();
  await expect.poll(() => snapshot(page)).toEqual(saved);
});

test('returning a bound drag restores secondary identities and canonical color groups', async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  await expect(page.locator('.multi-cue-column.extension').first()).toBeVisible();
  const result = await page.evaluate(() => {
    const project = MaweBoot.DATA;
    const main = AsrEditorUtils.getMainTrack(project);
    const extension = MaweMultiSubtitleCore.getActiveExtensionTrack();
    project.bindings.push(AsrEditorUtils.buildSubtitleBinding(main.segments[1], extension.segments[1],
      extension.id, null, main.id, project.bindings));
    const original = extension.segments.slice();
    const before = extension.segments.map(segment => ({ id: segment.id, group: segment.color_group_id,
      start: segment.start, end: segment.end }));
    const drag = { track: 'main', kind: 'move', indices: [1], allowSqueeze: true,
      originals: new Map([[1, { start: main.segments[1].start, end: main.segments[1].end }]]) };
    main.segments[1].start = 0;
    main.segments[1].end = 1000;
    MaweBoundDrag.syncBoundCueDrag(drag);
    const during = extension.segments.map(segment => ({ id: segment.id, group: segment.color_group_id }));
    main.segments[1].start = 1500;
    main.segments[1].end = 2500;
    MaweBoundDrag.syncBoundCueDrag(drag);
    return { before, during, after: extension.segments.map(segment => ({ id: segment.id, group: segment.color_group_id,
      start: segment.start, end: segment.end })), sameIdentities: extension.segments.every((segment, i) => segment === original[i]) };
  });
  expect(result.during.map(item => item.id)).not.toContain('e0');
  expect(result.after).toEqual(result.before);
  expect(result.sameIdentities).toBe(true);
});
