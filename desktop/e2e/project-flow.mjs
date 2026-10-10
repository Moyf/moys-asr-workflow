import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { _electron as electron, expect } from '@playwright/test';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeWave(target) {
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 4000), 44 + i * 2);
  writeFileSync(target, wav);
}

test('native project selection and dropped project keep paths, binding and recent entries', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mose-flow-'));
  const settings = path.join(root, 'settings');
  mkdirSync(settings);
  writeFileSync(path.join(settings, 'server-editor-settings.json'), JSON.stringify({ onboarding_status: 'completed', auto_open_last_project: false }));
  const first = path.join(root, 'native project.mosp');
  const second = path.join(root, 'dropped 工程.mosp');
  const project = (text) => ({ schema: 'moy.asr.project.v1', media: 'missing.wav', segments: [{ id: 's1', start: 0, end: 1000, text }] });
  writeFileSync(first, JSON.stringify(project('原生打开')));
  writeFileSync(second, JSON.stringify(project('拖拽打开')));
  const env = { ...process.env, MAW_APP_DATA_ROOT: settings, MAW_DESKTOP_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: process.env.MOSE_TEST_EXECUTABLE || createRequire(path.join(desktop, 'package.json'))('electron'),
    args: [...(process.env.MOSE_TEST_EXECUTABLE ? [] : [desktop]), `--user-data-dir=${path.join(root, 'profile')}`], env,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => Boolean(window.MaweMultiImport));
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, first);
    await page.locator('#open-project').click();
    await page.waitForFunction((selected) => MaweBoot.SERVER_CONFIG.projectPath === selected, first.replaceAll('\\', '/'));
    assert.equal(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canSave), true);
    assert.equal(await page.evaluate(() => MaweBoot.SERVER_CONFIG.missingMedia), true);
    await page.setInputFiles('#open-project-file', second);
    await page.waitForFunction((selected) => MaweBoot.SERVER_CONFIG.projectPath === selected, second.replaceAll('\\', '/'));
    const recents = await page.evaluate(() => MaweBoot.SERVER_CONFIG.recentProjects.map((entry) => entry.path));
    assert.equal(recents.length, 2);
    assert.equal(recents[0].replaceAll('\\', '/'), second.replaceAll('\\', '/'));
    await expect(page.locator('#json-name')).toHaveText(path.basename(second));
    await page.evaluate(() => {
      MaweSettings.updateEditorSettings({ autoSaveProject: false });
      MaweBoot.DATA.segments[0].text = '另存为保留改动';
      MaweBoot.DATA.segments[0]._dirty = true;
    });
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true });
    });
    assert.equal(await page.evaluate(() => MaweProjectSave.saveProjectAsToFile()), false);
    assert.equal(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges()), true);
    assert.equal(await page.evaluate(() => MaweBoot.SERVER_CONFIG.projectPath), second.replaceAll('\\', '/'));
    const saved = path.join(root, 'new folder', '另存为.mosp');
    mkdirSync(path.dirname(saved));
    await app.evaluate(({ dialog }, selected) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected });
    }, saved);
    assert.equal(await page.evaluate(() => MaweProjectSave.saveProjectAsToFile()), true);
    assert.equal(await page.evaluate(() => MaweBoot.SERVER_CONFIG.projectPath), saved.replaceAll('\\', '/'));
    assert.equal(JSON.parse(readFileSync(saved, 'utf8')).media.replaceAll('\\', '/'), path.join(root, 'missing.wav').replaceAll('\\', '/'));
    assert.equal(JSON.parse(readFileSync(second, 'utf8')).segments[0].text, '拖拽打开');
    await page.evaluate(() => { MaweBoot.DATA.segments[0].text = '持续写回新工程'; MaweBoot.DATA.segments[0]._dirty = true; });
    assert.equal(await page.evaluate(() => MaweProjectSave.saveCurrentProject()), true);
    assert.equal(JSON.parse(readFileSync(saved, 'utf8')).segments[0].text, '持续写回新工程');
    const blank = path.join(root, '新建工程.mosp');
    await app.evaluate(({ dialog }, selected) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected });
    }, blank);
    await page.locator('#new-project').click();
    await page.waitForFunction((selected) => MaweBoot.SERVER_CONFIG.projectPath === selected, blank.replaceAll('\\', '/'));
    assert.equal(JSON.parse(readFileSync(blank, 'utf8')).segments.length, 0);
    assert.equal(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canSave), true);
    const media = path.join(root, 'real media.wav');
    writeWave(media);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, media);
    await page.locator('#open-project-menu-btn').click();
    await page.locator('#load-media').click();
    await page.waitForFunction((selected) => MaweBoot.DATA.media === selected && document.getElementById('player').readyState >= 1, media.replaceAll('\\', '/'));
    assert.match(await page.locator('#player').getAttribute('src').catch(() => '') || await page.locator('#player source').getAttribute('src'), /^http:\/\/127\.0\.0\.1:/);
    assert.equal(await page.evaluate(() => MaweBoot.DATA.waveform?.peak_count > 0), true);
    const subtitle = path.join(root, '字幕.srt');
    writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:00,800\n保留字幕与媒体路径\n');
    await page.setInputFiles('#load-srt-file', subtitle);
    await page.waitForFunction(() => MaweBoot.DATA.segments[0]?.text === '保留字幕与媒体路径');
    await page.evaluate(() => MaweProjectSave.saveCurrentProject());
    assert.equal(JSON.parse(readFileSync(blank, 'utf8')).media.replaceAll('\\', '/'), media.replaceAll('\\', '/'));
    const broken = path.join(root, 'broken.wav');
    writeFileSync(broken, 'invalid audio');
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, broken);
    assert.equal(await page.evaluate(() => MaweMediaLoad.chooseNativeMedia()), false);
    assert.equal(await page.evaluate(() => MaweBoot.DATA.media), media.replaceAll('\\', '/'));
    const stickers = path.join(root, 'stickers');
    mkdirSync(stickers);
    writeFileSync(path.join(stickers, 'test.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, stickers);
    await page.locator('#editor-settings-toggle').click();
    await page.locator('#editor-settings-tab-sticker').click();
    await page.locator('#sticker-root-btn').click();
    await page.locator('#sticker-root-browse').click();
    await page.waitForFunction((selected) => MaweBoot.STICKER_ROOT === selected, stickers.replaceAll('\\', '/'));
    const spacing = await page.locator('#sticker-root-modal .modal-field-row').evaluate((row) => ({
      gap: Number.parseFloat(getComputedStyle(row).gap),
      top: row.getBoundingClientRect().top - row.previousElementSibling.getBoundingClientRect().bottom,
    }));
    assert.equal(spacing.gap >= 8 && spacing.top >= 8, true, JSON.stringify(spacing));
    await page.screenshot({ path: path.join(root, 'directory-picker.png') });
    assert.equal(existsSync(path.join(root, 'directory-picker.png')), true);
    await page.locator('#sticker-root-cancel').click();
    assert.equal(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true })), true);
    assert.equal(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges()), false);
    assert.deepEqual(errors, []);
    console.log(`Electron interaction evidence: ${root}`);
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
    await app.close();
  }
});
