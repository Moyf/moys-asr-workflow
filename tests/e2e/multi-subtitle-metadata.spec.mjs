import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson,
  generateWav, makeTempDir, openSettingsPage, startServer } from './helpers.mjs';

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
  const response = page.waitForResponse((response) => (
    response.url().endsWith('/api/project') && response.request().method() === 'POST'
  ));
  await page.keyboard.press('Control+s');
  const saved = await response;
  expect(saved.ok(), await saved.text()).toBe(true);
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  await page.reload();
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments.map(s => s.id)))
    .toEqual(project.segments.map(s => s.id));
  return project;
}

test('swapping once and twice preserves speaker and discarded cues through save and reopen', async ({ page }) => {
  await page.evaluate(() => {
    const makeSegments = (prefix) => [
      { id: `${prefix}-discarded`, start: 1000, end: 2000, text: `${prefix} discarded`, speaker: `${prefix}-speaker`, disabled: true },
      { id: `${prefix}-enabled`, start: 3000, end: 4000, text: `${prefix} enabled`, speaker: `${prefix}-other`, disabled: false },
    ];
    MaweBoot.DATA.segments = makeSegments('main');
    MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: true,
      display_mode: 'both', tracks: [{ id: 'ext', name: '译文', segments: makeSegments('ext') }],
      bindings: [0, 1].map(i => window.AsrEditorUtils.buildSubtitleBinding(
        MaweBoot.DATA.segments[i], makeSegments('ext')[i], 'ext', `binding-${i}`)),
    };
    MaweSelection.clearSelection({ silent: true });
    MaweCuePanel.renderAll();
    MaweDisplaySettings.updateMultiSubtitleUi();
  });
  for (let round = 0; round < 2; round++) {
    // 双语字幕设置已并入工程设置 → 字幕轨道页。
    await openSettingsPage(page, 'project-tracks');
    await expect(page.locator('#project-multi-subtitle-settings')).toBeVisible();
    await page.locator('#multi-subtitle-swap').click();
    const expectedMain = round === 0 ? 'ext' : 'main';
    await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[0].id))
      .toBe(`${expectedMain}-discarded`);
    const saved = await saveAndReopen(page);
    for (const segments of [saved.segments, saved.multi_subtitle.tracks[0].segments]) {
      const prefix = segments[0].id.split('-')[0];
      expect(segments.map(s => [s.speaker, Boolean(s.disabled)]))
        .toEqual([[`${prefix}-speaker`, true], [`${prefix}-other`, false]]);
    }
    const reopened = await page.evaluate(() => ({
      main: MaweBoot.DATA.segments.map(s => [s.speaker, Boolean(s.disabled)]),
      ext: MaweBoot.DATA.multi_subtitle.tracks[0].segments.map(s => [s.speaker, Boolean(s.disabled)]),
      mainSrt: window.AsrEditorUtils.buildSrtPayload(MaweBoot.DATA.segments),
      extSrt: window.AsrEditorUtils.buildSrtPayload(MaweBoot.DATA.multi_subtitle.tracks[0].segments),
    }));
    expect(reopened.main).toEqual(saved.segments.map(s => [s.speaker, Boolean(s.disabled)]));
    expect(reopened.ext).toEqual(saved.multi_subtitle.tracks[0].segments.map(s => [s.speaker, Boolean(s.disabled)]));
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
        MaweBoot.DATA.segments = [main];
        MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
          tracks: [{ id: 'ext', name: '译文', split_mode: 'continuous', segments }],
          bindings: [window.AsrEditorUtils.buildSubtitleBinding(main, source, 'ext', 'bound')],
        };
        MaweSelection.clearSelection({ silent: true });
        MaweCuePanel.renderAll();
        return segments.map(s => ({ id: s.id, speaker: s.speaker, color: s.color || null, color_ref: s.color_ref || null }));
      }, targetIndex);
      const cutMs = 1900 + targetIndex * 2000;
      await page.evaluate(({ path, targetIndex, cutMs }) => {
        if (path === 'extension') MaweSplitCore.openExtensionSplitModal(targetIndex, cutMs);
        else MaweSplitContext.splitFromContextMenu(0, 10, 10, cutMs);
      }, { path, targetIndex, cutMs });
      await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
      await page.locator('#multi-subtitle-split-confirm').click();
      const after = await page.evaluate(() => MaweBoot.DATA.multi_subtitle.tracks[0].segments);
      expect(after).toHaveLength(7);
      expect(after[targetIndex + 1].color_ref).toEqual(targetIndex === 1
        ? { name: 'red', headIdx: 1 } : { name: 'blue', headIdx: 2 });
      expect(after.find(s => s.id === 'ext-5').color_ref).toEqual({ name: 'purple', headIdx: 5 });
      for (const segment of after) {
        expect(segment.speaker).toBe('ext-speaker');
        if (segment.color_ref) expect(after[segment.color_ref.headIdx]?.color?.name).toBe(segment.color_ref.name);
      }
      if (path === 'linked') {
        expect(await page.evaluate(() => MaweBoot.DATA.segments[1].color_ref)).toEqual({ name: 'yellow', headIdx: 0 });
      }
      await page.locator('#undo-btn').click();
      expect(await page.evaluate(() => MaweBoot.DATA.multi_subtitle.tracks[0].segments
        .map(s => ({ id: s.id, speaker: s.speaker, color: s.color || null, color_ref: s.color_ref || null }))))
        .toEqual(before);
      await page.locator('#redo-btn').click();
      const saved = await saveAndReopen(page);
      expect(saved.multi_subtitle.tracks[0].segments.map(s => s.color_ref || null))
        .toEqual(after.map(s => s.color_ref || null));
      expect(await page.evaluate(() => MaweBoot.DATA.multi_subtitle.tracks[0].segments.map(s => s.color_ref || null)))
        .toEqual(after.map(s => s.color_ref || null));
      expect(await page.evaluate(() => MaweBoot.DATA.multi_subtitle.tracks[0].segments.map(s => s.speaker)))
        .toEqual(Array(7).fill('ext-speaker'));
    });
  }
}
