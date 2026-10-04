import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { _electron as electron } from '@playwright/test';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('desktop preferences survive restart and a fresh browser origin', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mose-preference-flow-'));
  const settings = path.join(root, 'settings'); mkdirSync(settings);
  writeFileSync(path.join(settings, 'server-editor-settings.json'), JSON.stringify({ onboarding_status: 'completed', auto_open_last_project: false }));
  const env = { ...process.env, MAW_APP_DATA_ROOT: settings, MAW_DESKTOP_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({
    executablePath: process.env.MOSE_TEST_EXECUTABLE || createRequire(path.join(desktop, 'package.json'))('electron'),
    args: [...(process.env.MOSE_TEST_EXECUTABLE ? [] : [desktop]), `--user-data-dir=${path.join(root, 'profile')}`], env,
  });
  let instance = await launch();
  try {
    const first = await instance.firstWindow();
    await first.waitForFunction(() => Boolean(window.MaweSettings && window.MAWE_I18N));
    const firstOrigin = await first.evaluate(() => location.origin);
    await first.evaluate(() => {
      MaweSettings.updateEditorSettings({ theme: 'light', autoSaveProject: false, cueListCharcountThreshold: 29 });
      MAWE_I18N.applyLanguage('en');
      MaweHost.storage.setItem(MaweDom.EDITOR_SETTINGS_WINDOW_TAB_KEY, 'sticker');
      MaweHost.storage.setItem('moy.asr.waveform.settings.v1', JSON.stringify({ mode: 'multi', secondsPerRow: 10 }));
    });
    await assert.rejects(first.evaluate(() => MOSEDesktop.storage.setItem('../other.json', 'x')), /不支持的桌面偏好名称/u);
    // The next page must recover from the fixed desktop store even if the OS
    // happens to reuse a port. Only this test profile's browser data is cleared.
    await instance.evaluate(async ({ session }) => {
      await session.defaultSession.clearStorageData({ storages: ['localstorage'] });
    });
    await instance.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
    await instance.close();
    instance = await launch();
    const second = await instance.firstWindow();
    await second.waitForFunction(() => Boolean(window.MaweSettings && window.MAWE_I18N));
    const restored = await second.evaluate(() => ({
      theme: MaweSettings.EDITOR_SETTINGS.theme,
      charcountThreshold: MaweSettings.EDITOR_SETTINGS.cueListCharcountThreshold,
      autoSaveProject: MaweSettings.EDITOR_SETTINGS.autoSaveProject,
      language: MAWE_I18N.language,
      tab: MaweHost.storage.getItem(MaweDom.EDITOR_SETTINGS_WINDOW_TAB_KEY),
      waveform: JSON.parse(MaweHost.storage.getItem('moy.asr.waveform.settings.v1')),
    }));
    assert.equal(restored.theme, 'light');
    assert.equal(restored.charcountThreshold, 29);
    assert.equal(restored.autoSaveProject, false);
    assert.equal(restored.language, 'en');
    assert.equal(restored.tab, 'sticker');
    assert.equal(restored.waveform.secondsPerRow, 10);
    console.log(`Preference restart origins: ${firstOrigin} -> ${await second.evaluate(() => location.origin)}`);
  } finally {
    await instance.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; }).catch(() => {});
    await instance.close().catch(() => {});
  }
});
