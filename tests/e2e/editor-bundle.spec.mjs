import {expect, test} from '@playwright/test';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {cleanupTempDir, disableOnboarding,
  findFreePort, makeTempDir, startBlankServer} from './helpers.mjs';
import {readSources} from '../../scripts/build-editor.mjs';

let directory, server;
const sources = readSources();
const identity = readFileSync('web/editor/boot/editor-bundle.js', 'utf8').split('\n')[0];
test.beforeAll(async () => {
  directory = makeTempDir('editor-bundle');
  // Retired file:// consumers stay skipped; do not prepare their HTML artifacts.
  // Isolate both config-file and environment sticker defaults in the child.
  const envFixture = join(directory, 'empty-settings.conf');
  writeFileSync(envFixture, '', 'utf8');
  server = await startBlankServer(await findFreePort(), join(directory, 'settings'), {
    env: { MAW_ENV_FILE: envFixture, STICKER_DIR: '' },
  });
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });

test('ASS emoji warning tooltip is not clipped on hover or keyboard focus', async ({ page }, testInfo) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean(window.MaweCoreState?.waveformEditor));
  await page.evaluate(() => MaweProjectLoad.applyCanonicalProject({
    schema: 'moy.asr.project.v1', media: '',
    segments: [{ id: 'emoji', start: 0, end: 1000, text: '字幕 🤔' }],
  }, 'synthetic.mosp'));
  const warning = page.locator('#ass-emoji-warning');
  const tip = page.locator('#ass-emoji-warning-tip');
  await expect(warning).toBeHidden();
  await page.locator('#ass-mode-quick-toggle').click();
  await warning.hover();
  await expect(tip).toContainText('当前 ASS 烧录不支持彩色 emoji');
  const checkTip = async () => {
    const { painted, gap } = await tip.evaluate(node => {
      const tipRect = node.getBoundingClientRect();
      const anchor = node.parentElement.getBoundingClientRect();
      return {
        painted: [0.2, 0.5, 0.8].every(fraction => node.contains(document.elementFromPoint(
          tipRect.left + tipRect.width / 2, tipRect.top + tipRect.height * fraction,
        ))),
        gap: Math.max(tipRect.top - anchor.bottom, anchor.top - tipRect.bottom),
      };
    });
    expect(painted, 'tooltip is painted beyond the toolbar clip').toBe(true);
    expect(gap).toBeGreaterThanOrEqual(8);
  };
  await checkTip();
  await page.screenshot({ path: testInfo.outputPath('ass-emoji-tooltip.png') });
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await warning.focus();
  await checkTip();
  await page.locator('#ass-mode-quick-toggle').click();
  await expect(tip).toBeHidden();
});

test('minified portable bundle preserves non-default data, paths and generated language', async ({page}) => {
  // 便携单 HTML 的注入与 file:// 运行契约随 2.0 移除；HTTP bundle 覆盖保留。
  test.skip(true, '便携模式已弃维护，2.0 移除 HTML，见 #336 后回归分析');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableOnboarding(page);
  await page.goto(pathToFileURL(join(directory, 'injected.edit.html')).href);
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
    // 仅 file:// 传输属于弃维护的便携单 HTML；HTTP 传输仍测试共用编辑器代码。
    test.skip(transport === 'file', '便携模式已弃维护，2.0 移除 HTML，见 #336 后回归分析');
    const portable = join(directory, 'current.edit.html');
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
      expect(realpathSync(fileURLToPath(new URL(boot.sfx, pathToFileURL(portable)))))
        .toBe(realpathSync(join(process.cwd(), 'web/sfx')));
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
