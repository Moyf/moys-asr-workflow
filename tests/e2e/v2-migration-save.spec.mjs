import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, makeTempDir, startServer } from './helpers.mjs';

for (const schema of ['moy.asr.project.v1', 'moy.asr.project.v1.5']) {
  test(`${schema} migration requires a new v2 file and preserves the source`, async ({ page }) => {
    const directory = makeTempDir('v2-migration-save');
    const projectPath = join(directory, 'legacy.mosp');
    const mediaPath = join(directory, 'synthetic.wav');
    let server;
    try {
      generateWav(mediaPath, 2);
      const project = { schema, media: 'synthetic.wav', segments: [{ id: 'original', start: 100, end: 900, text: '原字幕' }],
        ...(schema === 'moy.asr.project.v1.5' ? { subtitle_groups: { next_id: 1, color: [], sticker: [] } } : {}) };
      const sourceBytes = Buffer.from(JSON.stringify(project, null, 2) + '\n', 'utf8');
      writeFileSync(projectPath, sourceBytes);
      server = await startServer(projectPath, mediaPath, await findFreePort());
      await disableOnboarding(page);
      await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
      await page.goto(server.url);
      await page.waitForFunction(() => Boolean(window.MaweProjectSave && window.MaweMultiImport && window.MaweServerSave));
      expect(await page.evaluate(() => ({ schema: MaweBoot.DATA.schema, needsSaveAs: MaweServerSave.requiresMigrationSaveAs })))
        .toEqual({ schema: 'moy.asr.project.v2', needsSaveAs: true });

      const before = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
      const failed = await page.evaluate(async () => MaweMultiImport.openProjectFile(
        new File([JSON.stringify({ schema: 'moy.asr.project.v99', segments: [] })], 'invalid.mosp', { type: 'application/json' }),
        { suppressMediaPrompt: true },
      ));
      expect(failed).toBe(false);
      expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()))).toEqual(before);
      expect(await page.evaluate(() => MaweServerSave.requiresMigrationSaveAs)).toBe(true);
      expect(readFileSync(projectPath)).toEqual(sourceBytes);

      await page.evaluate(() => {
        window.migrationPickerCalls = [];
        window.migrationWrites = [];
        window.migrationPickerMode = 'cancel';
        window.migrationHandle = { name: 'legacy_v2.mosp', getFile: async () => ({ size: window.migrationPickerMode === 'existing' ? 7 : 0 }),
          createWritable: async () => ({ write: async blob => { window.migrationWrites.push(await blob.text()); }, close: async () => {} }) };
        window.showSaveFilePicker = async options => {
          window.migrationPickerCalls.push(options.suggestedName);
          if (window.migrationPickerMode === 'cancel') throw new DOMException('cancelled', 'AbortError');
          return window.migrationHandle;
        };
      });

      expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(false);
      expect(await page.evaluate(() => ({ calls: migrationPickerCalls.length, writes: migrationWrites.length, pending: MaweServerSave.requiresMigrationSaveAs })))
        .toEqual({ calls: 0, writes: 0, pending: true });
      expect(readFileSync(projectPath)).toEqual(sourceBytes);

      await page.evaluate(() => MaweProjectSave.saveCurrentProject());
      expect(await page.evaluate(() => ({ names: migrationPickerCalls, writes: migrationWrites.length, pending: MaweServerSave.requiresMigrationSaveAs })))
        .toEqual({ names: ['legacy_v2.mosp'], writes: 0, pending: true });
      expect(readFileSync(projectPath)).toEqual(sourceBytes);

      await page.evaluate(() => { migrationPickerMode = 'existing'; });
      expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject())).toBe(false);
      expect(await page.evaluate(() => ({ names: migrationPickerCalls, writes: migrationWrites.length, pending: MaweServerSave.requiresMigrationSaveAs, handle: MaweServerSave.projectFileHandle })))
        .toEqual({ names: ['legacy_v2.mosp', 'legacy_v2.mosp'], writes: 0, pending: true, handle: null });
      expect(readFileSync(projectPath)).toEqual(sourceBytes);

      await page.evaluate(() => { migrationPickerMode = 'new'; });
      await page.evaluate(() => MaweProjectSave.saveCurrentProject());
      const saved = await page.evaluate(() => ({ names: migrationPickerCalls, writes: migrationWrites.map(JSON.parse),
        pending: MaweServerSave.requiresMigrationSaveAs, handle: MaweServerSave.projectFileHandle === migrationHandle }));
      expect(saved.names).toEqual(['legacy_v2.mosp', 'legacy_v2.mosp', 'legacy_v2.mosp']);
      expect(saved.writes).toHaveLength(1);
      expect(saved.writes[0].schema).toBe('moy.asr.project.v2');
      expect(saved.writes[0].tracks.find(track => track.role === 'main').segments[0].text).toBe('原字幕');
      expect(saved.pending).toBe(false);
      expect(saved.handle).toBe(true);
      expect(readFileSync(projectPath)).toEqual(sourceBytes);

      await page.evaluate(() => {
        AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text = '后续编辑';
        MaweState.markProjectDirty();
        return MaweProjectSave.saveCurrentProject();
      });
      const final = await page.evaluate(() => ({ names: migrationPickerCalls, writes: migrationWrites.map(JSON.parse),
        pending: MaweServerSave.requiresMigrationSaveAs, handle: MaweServerSave.projectFileHandle === migrationHandle }));
      expect(final.names).toHaveLength(3);
      expect(final.writes).toHaveLength(2);
      expect(final.writes[1].tracks.find(track => track.role === 'main').segments[0].text).toBe('后续编辑');
      expect(final.pending).toBe(false);
      expect(final.handle).toBe(true);
      expect(readFileSync(projectPath)).toEqual(sourceBytes);
    } finally {
      await server?.stop();
      cleanupTempDir(directory);
    }
  });
}
