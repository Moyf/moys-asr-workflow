import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { _electron as electron, expect } from '@playwright/test';

const require = createRequire(import.meta.url);
const { resolveSourcePython } = require('../src/runtime_helpers.cjs');
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.dirname(desktop);

test('native media rejection preserves player and binding; accepted stream survives Save As', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mose-media-transaction-'));
  const settings = path.join(root, 'settings');
  mkdirSync(settings);
  writeFileSync(path.join(settings, 'server-editor-settings.json'), JSON.stringify({ onboarding_status: 'completed', auto_open_last_project: false }));
  const resolved = spawnSync(resolveSourcePython(repository), ['-c', 'from maw.ffmpeg import resolve_ffmpeg_tools; print(resolve_ffmpeg_tools().ffmpeg or "")'], {
    cwd: repository, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  const ffmpeg = resolved.stdout.trim();
  assert.ok(ffmpeg, 'This decoder regression requires FFmpeg');
  const firstMedia = path.join(root, 'good.wav');
  const nextMedia = path.join(root, 'second.wav');
  const rejectedMedia = path.join(root, 'valid-but-unplayable.avi');
  for (const args of [
    ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '1', firstMedia],
    ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=8000', '-t', '1', nextMedia],
    ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1', '-c:v', 'mpeg4', '-t', '1', rejectedMedia],
  ]) {
    const result = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  const projectPath = path.join(root, '工程 🌙.mosp');
  writeFileSync(projectPath, JSON.stringify({ schema: 'moy.asr.project.v1', media: 'good.wav', segments: [{ id: 's1', start: 0, end: 1000, text: '原字幕' }] }));
  const originalBytes = readFileSync(projectPath);
  const env = { ...process.env, MAW_APP_DATA_ROOT: settings, MAW_DESKTOP_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: process.env.MOSE_TEST_ELECTRON_EXECUTABLE || createRequire(path.join(desktop, 'package.json'))('electron'),
    args: [desktop, `--user-data-dir=${path.join(root, 'profile')}`], env,
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => Boolean(window.MaweMediaLoad));
    const choose = (selected) => app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, selected);
    await choose(projectPath);
    await page.locator('#open-project').click();
    await page.waitForFunction((selected) => MaweBoot.SERVER_CONFIG.desktopProjectPath?.replaceAll('\\', '/') === selected
      && document.getElementById('player').readyState >= 1, projectPath.replaceAll('\\', '/'));
    await page.evaluate(() => {
      MaweSettings.updateEditorSettings({ autoSaveProject: false });
      MaweBoot.DATA.segments[0].text = '尚未保存的字幕';
      MaweBoot.DATA.segments[0]._dirty = true;
      window.__mediaTransactionPlayer = document.getElementById('player');
      window.__mediaTransactionPlayer.currentTime = 0.25;
    });
    const before = await page.evaluate(async () => ({
      status: (await MaweHost.desktop.command('status', { force: true })).data,
      epoch: MaweWaveformInit.deferredReapeaksEpoch,
      source: document.getElementById('player').currentSrc,
      paused: document.getElementById('player').paused,
      seek: [MaweNavPreview.seekWarned, MaweNavPreview.pendingMediaSeekTimeSec, MaweNavPreview.autoLoadedMediaReadyNotified],
    }));
    const importSelected = () => page.evaluate(async () => {
      const selected = await MaweHost.desktop.chooseFile('media', 'zh');
      return MaweMediaLoad.loadMediaReference(selected.file);
    });
    await choose(rejectedMedia);
    assert.equal(await importSelected(), false);
    const after = await page.evaluate(async () => ({
      status: (await MaweHost.desktop.command('status', { force: true })).data,
      epoch: MaweWaveformInit.deferredReapeaksEpoch,
      source: document.getElementById('player').currentSrc,
      paused: document.getElementById('player').paused,
      seek: [MaweNavPreview.seekWarned, MaweNavPreview.pendingMediaSeekTimeSec, MaweNavPreview.autoLoadedMediaReadyNotified],
      samePlayer: document.getElementById('player') === window.__mediaTransactionPlayer,
      time: document.getElementById('player').currentTime,
      text: MaweBoot.DATA.segments[0].text,
    }));
    assert.equal(after.status.mediaPath, before.status.mediaPath);
    assert.equal(after.status.generation, before.status.generation);
    assert.equal(after.epoch, before.epoch);
    assert.equal(after.source, before.source);
    assert.equal(after.paused, before.paused);
    assert.deepEqual(after.seek, before.seek);
    assert.equal(after.samePlayer, true);
    assert.ok(Math.abs(after.time - 0.25) < 0.02);
    assert.equal(after.text, '尚未保存的字幕');
    assert.deepEqual(readFileSync(projectPath), originalBytes);
    console.log('Rejected AVI preserves player, edits and generation:', before.status.generation, '->', after.status.generation);

    await choose(nextMedia);
    // Hold the prepared response while the user adjusts the accepted player.
    await app.evaluate(() => {
      globalThis.__mediaTestFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        const response = await globalThis.__mediaTestFetch(...args);
        if (String(args[1]?.body || '').includes('"command":"prepareMedia"')) {
          await new Promise((resolve) => { globalThis.__mediaTestRelease = resolve; });
        }
        return response;
      };
    });
    const importing = importSelected();
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.__mediaTestRelease))).toBe(true);
    await page.evaluate(() => {
      const player = document.getElementById('player');
      player.volume = 0.23;
      player.muted = true;
      player.playbackRate = 1.25;
    });
    await app.evaluate(() => {
      globalThis.fetch = globalThis.__mediaTestFetch;
      globalThis.__mediaTestRelease();
      delete globalThis.__mediaTestRelease;
      delete globalThis.__mediaTestFetch;
    });
    assert.equal(await importing, true);
    const playbackSettings = await page.evaluate(() => {
      const player = document.getElementById('player');
      return [player.volume, player.muted, player.playbackRate];
    });
    assert.deepEqual(playbackSettings, [0.23, true, 1.25]);
    const accepted = await page.evaluate(async () => (await MaweHost.desktop.command('status', { force: true })).data);
    assert.equal(accepted.mediaPath.replaceAll('\\', '/'), nextMedia.replaceAll('\\', '/'));
    assert.equal(accepted.generation, before.status.generation + 1);
    assert.equal(await page.evaluate(() => MaweProjectSave.saveCurrentProject()), true);
    assert.equal(JSON.parse(readFileSync(projectPath, 'utf8')).segments[0].text, '尚未保存的字幕');
    const savedAs = path.join(root, '另存为.mosp');
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, savedAs);
    assert.equal(await page.evaluate(() => MaweProjectSave.saveProjectAsToFile()), true);
    const savedGeneration = await page.evaluate(() => MaweBoot.SERVER_CONFIG.desktopGeneration);
    await choose(rejectedMedia);
    assert.equal(await importSelected(), false);
    assert.equal(await page.evaluate(() => MaweBoot.SERVER_CONFIG.desktopGeneration), savedGeneration);
    await page.evaluate(() => document.getElementById('player').load());
    await page.waitForFunction(() => document.getElementById('player').readyState >= 1);
    assert.equal(JSON.parse(readFileSync(savedAs, 'utf8')).segments[0].text, '尚未保存的字幕');
    await page.screenshot({ path: path.join(root, 'media-transaction.png') });
    console.log('Media transaction evidence:', root);
  } finally {
    await app.evaluate(({ dialog }) => {
      if (globalThis.__mediaTestFetch) globalThis.fetch = globalThis.__mediaTestFetch;
      globalThis.__mediaTestRelease?.();
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    await app.close();
  }
});
