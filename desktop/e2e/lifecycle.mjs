import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { _electron as electron, expect } from '@playwright/test';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.env.MOSE_TEST_EXECUTABLE || process.env.MOSE_TEST_ELECTRON_EXECUTABLE || createRequire(path.join(desktop, 'package.json'))('electron');
const appArgs = process.env.MOSE_TEST_EXECUTABLE ? [] : [desktop];

test('cancelled close keeps backend, second-instance opens once, confirmed quit stops backend', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mose-lifecycle-'));
  const settings = path.join(root, 'settings'); mkdirSync(settings);
  writeFileSync(path.join(settings, 'server-editor-settings.json'), JSON.stringify({ onboarding_status: 'completed', auto_open_last_project: false }));
  const first = path.join(root, 'first.mosp');
  const second = path.join(root, 'second 工程.mosp');
  const project = (text) => ({ schema: 'moy.asr.project.v1', media: '', segments: [{ id: 's1', start: 0, end: 1000, text }] });
  writeFileSync(first, JSON.stringify(project('第一个工程')));
  writeFileSync(second, JSON.stringify(project('第二个工程')));
  const profile = `--user-data-dir=${path.join(root, 'profile')}`;
  const env = { ...process.env, MAW_APP_DATA_ROOT: settings, MAW_DESKTOP_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = await electron.launch({ executablePath, args: [...appArgs, profile, first], env });
  let backendOrigin;
  try {
    const page = await instance.firstWindow();
    // Electron resolves beforeunload through its native will-prevent-unload
    // handler. Stop Playwright from also sending a CDP dialog decision.
    page.on('dialog', (dialog) => { if (dialog.type() !== 'beforeunload') void dialog.accept(); });
    await page.waitForFunction(() => Boolean(window.MaweServerSave && MaweBoot.SERVER_CONFIG.canSave));
    backendOrigin = await page.evaluate(() => window.location.origin);
    await expect.poll(() => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toMatch(/first\.mosp/u);
    await page.locator('#json-name').click();
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const fontFamilies = await page.evaluate(async () => new Set((await window.queryLocalFonts()).map((font) => font.family)).size);
    assert.ok(fontFamilies > 0, 'Electron should expose installed font families to the editor');
    await page.evaluate(() => {
      MaweSettings.updateEditorSettings({ autoSaveProject: false });
      MaweBoot.DATA.segments[0].text = '未保存编辑'; MaweBoot.DATA.segments[0]._dirty = true;
    });
    await instance.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 2 });
      BrowserWindow.getAllWindows()[0].close();
    });
    await page.waitForFunction(async () => (await window.MOSEDesktop.state()).ok);
    assert.equal(await page.evaluate(() => MaweBoot.DATA.segments[0].text), '未保存编辑');
    await instance.evaluate(({ app }) => app.quit());
    await page.waitForFunction(async () => (await window.MOSEDesktop.state()).ok);
    assert.equal(await page.evaluate(() => MaweBoot.DATA.segments[0].text), '未保存编辑');
    assert.equal(await page.evaluate(() => MaweProjectSave.saveCurrentProject()), true);
    const next = spawn(executablePath, [...appArgs, profile, second], { env, windowsHide: true, stdio: 'ignore' });
    const [exitCode] = await once(next, 'exit');
    assert.equal(exitCode, 0);
    await page.waitForFunction((selected) => MaweBoot.SERVER_CONFIG.desktopProjectPath?.replaceAll('\\', '/') === selected, second.replaceAll('\\', '/'));
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(await page.evaluate(() => MaweBoot.DATA.segments[0].text), '第二个工程');
    await page.waitForFunction(async () => (await window.MOSEDesktop.state()).ok);
    assert.equal(await page.evaluate(() => MaweBoot.SERVER_CONFIG.recentProjects.length), 2);
    await page.evaluate(() => { MaweBoot.DATA.segments[0].text = '放弃退出'; MaweBoot.DATA.segments[0]._dirty = true; });
    await instance.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    const exited = once(instance.process(), 'exit');
    await instance.evaluate(({ app }) => app.quit()).catch(() => {});
    const [code] = await exited;
    assert.equal(code, 0);
    await assert.rejects(fetch(`${backendOrigin}/api/startup-status`, { signal: AbortSignal.timeout(2000) }));
  } finally {
    await instance.close().catch(() => {});
  }
});
