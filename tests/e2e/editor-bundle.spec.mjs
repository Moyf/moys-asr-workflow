import {expect, test} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPortableBlankEditor, cleanupTempDir, disableOnboarding,
  findFreePort, makeTempDir, startBlankServer} from './helpers.mjs';
import {readSources} from '../../scripts/build-editor.mjs';

let directory, portable, injected, server;
const sources = readSources();
const identity = readFileSync('web/editor/boot/editor-bundle.js', 'utf8').split('\n')[0];
test.beforeAll(async () => {
  directory = makeTempDir('editor-bundle');
  portable = buildPortableBlankEditor(join(directory, 'current.edit.html'));
  injected = join(directory, 'injected.edit.html');
  const python = process.env.MAW_E2E_PYTHON || 'uv';
  const prefix = process.env.MAW_E2E_PYTHON ? [] : ['run', '--no-sync', 'python'];
  execFileSync(python, [...prefix, '-c', `import edit, pathlib, sys
original = edit.render_editor_page
def render(**context):
    context.update(data_json='{"segments":[{"id":"injected","start":0,"end":1000,"text":"Injected cue"}]}',
                   filename_base_json='"injected project"', stickers_json='[]',
                   sticker_root_json='"portable-root"', sticker_url_prefix_json='"fixture-stickers/"',
                   ninja_sfx_base_url_json='"fixture-sfx/"', ui_language_json='"en"')
    return original(**context)
edit.render_editor_page = render
pathlib.Path(sys.argv[1]).write_text(edit.build_blank_html(), encoding='utf-8', newline='\\n')
`, injected], {windowsHide:true});
  server = await startBlankServer(await findFreePort(), join(directory, 'settings'));
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });

test('minified portable bundle preserves non-default data, paths and generated language', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableOnboarding(page);
  await page.goto(pathToFileURL(injected).href);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.evaluate(() => ({text:MaweBoot.DATA.segments[0]?.text,
    filename:MaweBoot.FILENAME_BASE, stickers:MaweBoot.STICKERS, root:MaweBoot.STICKER_ROOT,
    prefix:MaweBoot.STICKER_URL_PREFIX, sfx:MaweBoot.NINJA_SFX_BASE_URL, server:MaweBoot.SERVER_CONFIG})))
    .toEqual({text:'Injected cue',filename:'injected project',stickers:[],root:'portable-root',
      prefix:'fixture-stickers/',sfx:'fixture-sfx/',server:null});
  expect(errors).toEqual([]);
});

for (const transport of ['file', 'HTTP']) {
  test(`${transport} executes every source and preserves project/export/undo behavior`, async ({page}) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await disableOnboarding(page);
    await page.goto(transport === 'file' ? pathToFileURL(portable).href : server.url);
    await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
    expect(await page.content()).toContain(identity);
    expect(await page.evaluate(() => window.__mawEsmInitializationTrace)).toEqual(sources);
    const boot = await page.evaluate(() => ({stickers:MaweBoot.STICKERS, root:MaweBoot.STICKER_ROOT,
      server:MaweBoot.SERVER_CONFIG, sfx:MaweBoot.NINJA_SFX_BASE_URL}));
    expect(boot.stickers).toEqual([]);
    expect(boot.root).toBe('');
    expect(boot.server === null).toBe(transport === 'file');
    if (transport === 'file') {
      expect(new URL(boot.sfx, pathToFileURL(portable)).href)
        .toBe(pathToFileURL(join(process.cwd(), 'web/sfx') + '/').href);
    } else expect(boot.sfx).toBe('/sfx/');
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
