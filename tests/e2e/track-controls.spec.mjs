import { test, expect } from '@playwright/test';
import { createUtilsModule as createProjectTracks } from '../../web/shared/utils/project-tracks.js';
import { writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';
let dir, server, project;
test.beforeAll(async () => {
 dir=realpathSync(makeTempDir('track-settings')); const media=join(dir,'audio.wav'); project=join(dir,'settings.mosp');
 generateWav(media,4); writeFileSync(project,JSON.stringify(createProjectTracks().importProject({media,waveform:generateWaveformPayload(4000),segments:[{id:'one',start:500,end:3000,text:'字幕'}],overlay_track:{enabled:true,segments:[]}}).project));
 server=await startServer(project,media,await findFreePort());
});
test.afterAll(async()=>{await server?.stop();cleanupTempDir(dir)});
test('track controls preserve state, undo and save at narrow size',async({page}, info)=>{
 await page.setViewportSize({width:800,height:700}); await disableOnboarding(page); await page.goto(server.url); await expect(page.locator('.waveform-row').first()).toBeVisible();
 await page.evaluate(()=>MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-project-tracks'));
 const main=page.locator('[data-track-role="main"]'); const overlay=page.locator('[data-track-role="overlay"]');
 const originalSegments = await page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA.tracks.map(track => ({ id: track.id, segments: track.segments })))));
 await expect(main.locator('[data-track-field="enabled"]')).toBeChecked();
 await expect(overlay.locator('[data-track-field="enabled"]')).toBeChecked();
 const before=await page.evaluate(()=>MaweHistory.editorHistory.undoLength());
 await main.locator('[data-track-field="preview"]').uncheck();
 expect(await page.evaluate(()=>MaweHistory.editorHistory.undoLength())).toBe(before+1);
 await page.evaluate(()=>MaweHistory.performUndo()); await expect(main.locator('[data-track-field="preview"]')).toBeChecked();
 await page.evaluate(()=>MaweHistory.performRedo()); await expect(main.locator('[data-track-field="preview"]')).not.toBeChecked();
 await overlay.locator('[data-track-field="export"]').uncheck();
 await expect.poll(()=>page.evaluate(()=>MaweProjectSave.saveProjectToServer({silent:true}))).toBe(true);
 let saved=JSON.parse(readFileSync(project,'utf8')); expect(saved.tracks.find(t=>t.role==='main').preview_visible).toBe(false); expect(saved.tracks.find(t=>t.role==='overlay').export.enabled).toBe(false);
 expect(saved.tracks.map(track => ({ id: track.id, segments: track.segments }))).toEqual(originalSegments);
 await page.reload(); await page.evaluate(()=>MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-project-tracks'));
 await expect(main.locator('[data-track-field="preview"]')).not.toBeChecked(); await expect(overlay.locator('[data-track-field="export"]')).not.toBeChecked();
 const gap=await main.evaluate(el=>getComputedStyle(el).columnGap); expect(parseFloat(gap)).toBeGreaterThanOrEqual(8);
});
test('overlay enable creates a track and shares the old switch with undo', async ({page}) => {
 await disableOnboarding(page); await page.goto(server.url); await expect(page.locator('.waveform-row').first()).toBeVisible();
 await page.evaluate(() => { MaweBoot.DATA.tracks = MaweBoot.DATA.tracks.filter(t => t.role !== 'overlay'); MaweDisplaySettings.updateMultiSubtitleUi(); });
 await page.evaluate(()=>MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-project-tracks'));
 const enabled = page.locator('[data-track-role="overlay"] [data-track-field="enabled"]');
 await enabled.check(); await expect(page.locator('#overlay-track-toggle')).toBeChecked();
 expect(await page.evaluate(()=>MaweBoot.DATA.tracks.filter(t=>t.role==='overlay').length)).toBe(1);
 await page.evaluate(()=>MaweHistory.performUndo()); await expect(enabled).not.toBeChecked();
 await page.evaluate(()=>MaweHistory.performRedo()); await expect(enabled).toBeChecked();
 await page.evaluate(() => { AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).variant = 'future-type'; MaweProjectSettings.syncTrackControls(); });
 await expect(page.locator('[data-track-role="overlay"] .track-variant-warning')).toContainText('不支持的叠加轨类型：future-type');
 expect(await page.evaluate(()=>AsrEditorUtils.TrackPolicy.isTrackEnabled(AsrEditorUtils.getOverlayTrack(MaweBoot.DATA), 'preview'))).toBe(false);
});

test('plain text export respects the main track export switch without deleting the cue', async ({ page }) => {
 await disableOnboarding(page); await page.goto(server.url); await expect(page.locator('.waveform-row').first()).toBeVisible();
 await page.evaluate(() => { window.showSaveFilePicker = undefined; });
 async function exportText(enabled) {
  await page.evaluate(value => { AsrEditorUtils.getMainTrack(MaweBoot.DATA).export = { enabled: value }; }, enabled);
  await page.locator('#extra-export-btn').click();
  await page.locator('#extra-export-menu > .dropdown-submenu').nth(2).locator('.dropdown-submenu-toggle').click();
  const pending = page.waitForEvent('download');
  await page.locator('#download-plain-text').click();
  const stream = await (await pending).createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
 }
 expect(await exportText(true)).toContain('字幕');
 expect(await exportText(false)).not.toContain('字幕');
 expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('字幕');
});

test('unknown overlay warnings follow the interface language', async ({ page }) => {
 await disableOnboarding(page); await page.goto(`${server.url}?lang=en`);
 await expect(page.locator('.waveform-row').first()).toBeVisible();
 await page.evaluate(() => {
  const overlay = AsrEditorUtils.getOverlayTrack(MaweBoot.DATA);
  overlay.enabled = true; overlay.export = { enabled: true }; overlay.name = 'My overlay'; overlay.variant = 'future-type';
  MaweProjectSettings.syncTrackControls();
  MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-project-tracks');
 });
 const warning = page.locator('[data-track-role="overlay"] .track-variant-warning');
 await expect(warning).toHaveText('Unsupported overlay track type: future-type. Data has been preserved.');
 await page.evaluate(() => document.getElementById('download-full-srt').click());
 await expect(page.locator('.hint-card').last()).toHaveText('Cannot export overlay track “My overlay” with type “future-type”; disable the track or its export switch.');
 await page.evaluate(() => document.getElementById('download-full-ass').click());
 await expect(page.locator('.hint-card').last()).toHaveText('ASS export failed: Cannot export overlay track “My overlay” with type “future-type”; disable the track or its export switch.');
 await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
 await expect(warning).toHaveText('不支持的叠加轨类型：future-type。数据已保留。');
 await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
 await expect(warning).toHaveText('Unsupported overlay track type: future-type. Data has been preserved.');
});
