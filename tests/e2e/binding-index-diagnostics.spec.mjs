import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';

const project = JSON.parse(readFileSync(new URL('../fixtures/project-tracks/legacy-three-tracks.expected.json', import.meta.url), 'utf8'));
let directory, server;
test.beforeAll(async () => { directory = makeTempDir('binding-index'); server = await startBlankServer(await findFreePort(), directory); });
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });
test('binding diagnostic preserves swap, undo/redo, save/reopen and switch results', async ({ page }) => {
  await disableOnboarding(page); await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweMultiImport));
  await page.evaluate(input => {
    MaweSettings.updateEditorSettings({ autoSaveProject: false });
    MaweProjectLoad.applyCanonicalProject({ ...input, media: '' }, 'binding-v2.mosp');
  }, project);
  expect(await page.evaluate(() => AsrEditorUtils.isBindingIndexEnabled())).toBe(true);
  async function equivalent() {
    const outputs = await page.evaluate(() => {
      return [false, true].map(enabled => {
        AsrEditorUtils.setBindingIndexEnabled(enabled);
        MaweMultiSubtitleCore.syncBindingOffsets();
        return { project: JSON.parse(MaweJsonRepair.buildJson()), srt: MaweExportSrt.buildSrt(), ass: MaweExportSrt.buildAss() };
      });
    });
    expect(outputs[0]).toEqual(outputs[1]);
    expect(JSON.stringify(outputs[0].project)).not.toContain('bindingIndexEnabled');
    return outputs[0].project;
  }
  await equivalent();
  await page.evaluate(() => MaweMultiImport.swapMainAndExtensionSubtitles());
  await equivalent();
  await page.evaluate(() => MaweHistory.performUndo()); await equivalent();
  await page.evaluate(() => MaweHistory.performRedo()); await equivalent();
  const saved = await page.evaluate(async () => {
    let text;
    window.showSaveFilePicker = async () => ({ name: 'binding-v2.mosp', createWritable: async () => ({ write: async blob => { text = await blob.text(); }, close: async () => {} }) });
    await MaweProjectSave.saveProjectAsToFile(); return JSON.parse(text);
  });
  await page.evaluate(saved => MaweProjectLoad.applyCanonicalProject(saved, 'reopened.mosp'), saved);
  await equivalent();
  await page.evaluate(input => MaweProjectLoad.applyCanonicalProject({ ...input, media: '' }, 'another.mosp'), project);
  await equivalent();
  const timing = await page.evaluate(() => {
    const project = { tracks: ['main', 'secondary'].map((id, t) => ({ id, role: id,
      segments: Array.from({ length: 3000 }, (_, i) => ({ id: `${id}-${i}`, start: i * 2000 + t * 100, end: i * 2000 + 1500 + t * 100 })) })),
    bindings: Array.from({ length: 3000 }, (_, i) => ({ source: { track_id: 'main', segment_id: `main-${i}` }, target: { track_id: 'secondary', segment_id: `secondary-${i}` } })) };
    const samples = { off: [], on: [] };
    for (let round = 0; round < 6; round++) for (const enabled of round % 2 ? [true, false] : [false, true]) {
      AsrEditorUtils.setBindingIndexEnabled(enabled);
      const start = performance.now(); AsrEditorUtils.rebuildBindingOffsets(project);
      if (round) samples[enabled ? 'on' : 'off'].push(performance.now() - start);
    }
    AsrEditorUtils.setBindingIndexEnabled(true);
    return Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, values.sort((a, b) => a - b)[2]]));
  });
  console.log('binding-index browser 3000 bindings median ms', timing);
});
