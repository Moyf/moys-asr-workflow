import {expect, test} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPortableBlankEditor, cleanupTempDir, disableOnboarding,
  findFreePort, makeTempDir, startBlankServer} from './helpers.mjs';
import {readSources} from '../../scripts/build-editor.mjs';

let directory, portable, server;
const sources = readSources();
const identity = readFileSync('web/editor/boot/editor-bundle.js', 'utf8').split('\n')[0];
test.beforeAll(async () => {
  directory = makeTempDir('editor-bundle');
  portable = buildPortableBlankEditor(join(directory, 'current.edit.html'));
  server = await startBlankServer(await findFreePort(), join(directory, 'settings'));
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });

for (const transport of ['file', 'HTTP']) {
  test(`${transport} executes every source and preserves project/export/undo behavior`, async ({page}) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await disableOnboarding(page);
    await page.goto(transport === 'file' ? pathToFileURL(portable).href : server.url);
    await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
    expect(await page.content()).toContain(identity);
    expect(await page.evaluate(() => window.__mawEsmInitializationTrace)).toEqual(sources);
    const result = await page.evaluate(() => {
      const project = {schema:'moy.asr.project.v1', media:'',
        segments:[{id:'a',start:0,end:1000,text:'First'}, {id:'b',start:1100,end:2100,text:'Second'}],
        extension_fixture:{preserved:true}};
      MaweProjectLoad.applyCanonicalProject(project, 'synthetic.mosp');
      const serialized = JSON.parse(MaweJsonRepair.buildJson());
      const srt = MaweExportSrt.buildSrt();
      const before = JSON.stringify(MaweBoot.DATA.segments);
      MaweSegmentOps.mergeSegments([0,1]);
      const merged = MaweBoot.DATA.segments.length === 1;
      MaweHistory.performUndo();
      return {preserved:serialized.extension_fixture?.preserved, srt, merged,
        restored:JSON.stringify(MaweBoot.DATA.segments) === before,
        integerTiming:serialized.segments.every(cue => Number.isInteger(cue.start) && Number.isInteger(cue.end))};
    });
    expect(result.preserved).toBe(true);
    expect(result.srt).toContain('00:00:00,000 --> 00:00:01,000');
    expect(result.srt).toContain('Second');
    expect(result.merged && result.restored && result.integerTiming).toBe(true);
    expect(errors).toEqual([]);
  });
}
