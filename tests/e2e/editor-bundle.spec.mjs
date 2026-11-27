import {expect, test} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer} from './helpers.mjs';

let directory, server;
const productionIdentity = readFileSync('web/editor/boot/editor-bundle.js', 'utf8').split('\n')[0];
test.beforeAll(async () => {
  directory = makeTempDir('editor-bundle');
  server = await startBlankServer(await findFreePort(), join(directory, 'settings'));
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });

test('HTTP starts the editor once per page and preserves project/export/undo behavior', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableOnboarding(page);
  await page.addInitScript(() => {
    const add = window.addEventListener;
    window.mawStartupUnloadListeners = 0;
    window.addEventListener = function (type, ...args) {
      if (type === 'beforeunload') window.mawStartupUnloadListeners++;
      return Reflect.apply(add, this, [type, ...args]);
    };
  });
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  expect(await page.evaluate(() => typeof window.MAWE)).toBe('undefined');
  expect(await page.evaluate(() => [
    window.MaweBoot, window.MaweState, window.MaweInlineEdit, window.MaweHost,
  ].every(Object.isFrozen))).toBe(true);
  // Startup guards unsaved edits and ASS storage guards its own pending writes.
  expect(await page.evaluate(() => window.mawStartupUnloadListeners)).toBe(2);
  const boot = await page.evaluate(() => ({stickers:MaweBoot.STICKERS, root:MaweBoot.STICKER_ROOT,
    server:MaweBoot.SERVER_CONFIG, sfx:MaweBoot.NINJA_SFX_BASE_URL}));
  expect(boot.stickers).toEqual([]);
  expect(boot.root).toBe('');
  expect(boot.server).not.toBeNull();
  expect(boot.sfx).toBe('/sfx/');
  const result = await page.evaluate(() => {
    const project = {schema:'moy.asr.project.v1', media:'',
      segments:[{id:'a',start:0,end:1000,text:'First'}, {id:'b',start:1100,end:2100,text:'Second'}],
      extension_fixture:{preserved:true}};
    MaweProjectLoad.applyCanonicalProject(project, 'synthetic.mosp');
    const serialized = JSON.parse(MaweJsonRepair.buildJson());
    const srt = MaweExportSrt.buildSrt();
    const before = AsrEditorUtils.getMainTrack(AsrEditorUtils.snapshotProjectContent(MaweBoot.DATA)).segments;
    MaweSegmentOps.mergeSegments([0,1]);
    const merged = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length === 1;
    MaweHistory.performUndo();
    return {preserved:serialized.extension_fixture?.preserved, srt, merged,
      restored:JSON.stringify(AsrEditorUtils.getMainTrack(AsrEditorUtils.snapshotProjectContent(MaweBoot.DATA)).segments) === JSON.stringify(before),
      integerTiming:AsrEditorUtils.getMainTrack(serialized).segments.every(cue => Number.isInteger(cue.start) && Number.isInteger(cue.end))};
  });
  expect(result.preserved).toBe(true);
  expect(result.srt).toContain('00:00:00,000 --> 00:00:01,000');
  expect(result.srt).toContain('Second');
  expect(result.merged && result.restored && result.integerTiming).toBe(true);
  const other = await page.context().newPage();
  try {
    await disableOnboarding(other);
    await other.goto(server.url);
    await other.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
    expect(await other.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments)).toEqual([]);
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments)).toHaveLength(2);
  } finally {
    await other.close();
  }
  expect(errors).toEqual([]);
});

test('production starts and opens the command palette without publishing editor services', async ({page}) => {
  const settings = join(directory, 'production-settings');
  const production = await startBlankServer(await findFreePort(), settings, { production: true });
  try {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await disableOnboarding(page);
    await page.goto(production.url);
    expect(await page.content()).toContain(productionIdentity);
    expect(errors).toEqual([]);
    await page.locator('#command-palette-open').click();
    await expect(page.locator('#command-palette')).toBeVisible();
    const globals = await page.evaluate(() => Object.getOwnPropertyNames(window)
      .filter(name => /^(?:Mawe[A-Z]|MAWE_|Asr(?:EditorUtils|Waveform|GapRemoveCore)|ASR_EDITOR_PALETTE|ASS_STYLE_LIBRARY|__mawe[A-Z])/.test(name)
        || ['assStyleManagerSetSelection', 'updateAssStyleManagerLibrary', 'syncAssStyleForm', 'loadAssStyleLibrary'].includes(name)));
    expect(globals).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await production.stop();
  }
});
