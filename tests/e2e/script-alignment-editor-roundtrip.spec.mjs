import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, findFreePort, generateWav, makeTempDir, startServer } from './helpers.mjs';

test('generated script project retains punctuation and NFD text through Server save and reload', async ({ page }) => {
  const directory = makeTempDir('script-alignment-roundtrip');
  const media = join(directory, 'audio.wav');
  const script = join(directory, 'script.txt');
  let server;
  try {
    generateWav(media, 5);
    writeFileSync(script, '你好，世界。\ncafe\u0301!\n', 'utf8');
    const source = `
import sys
from pathlib import Path
from maw.script_timestamp_alignment import ScriptAlignmentRequest, run_script_alignment
from maw.timestamp_alignment import TimedToken
class Backend:
    def align(self, audio_path, text, *, language=None):
        assert text == "你好，世界。\\ncafé!"
        return [TimedToken("你", 100, 400), TimedToken("好", 400, 700),
                TimedToken("世", 800, 1100), TimedToken("界", 1100, 1400),
                TimedToken("café", 3000, 4000)]
run_script_alignment(ScriptAlignmentRequest(Path(sys.argv[1]), Path(sys.argv[2])), backend=Backend())
`;
    const python = process.env.MAW_E2E_PYTHON || 'uv';
    const prefix = process.env.MAW_E2E_PYTHON ? [] : ['run', '--no-sync', 'python'];
    execFileSync(python, [...prefix, '-c', source, script, media], { encoding: 'utf8' });
    const project = join(directory, 'script.script-aligned.mosp');
    server = await startServer(project, media, await findFreePort());
    await page.goto(server.url);
    await page.waitForFunction(() => window.MAWE_EDITOR_BRIDGE?.data?.segments.length === 2);
    const snapshot = () => page.evaluate(() => ({
      text: MaweBoot.DATA.segments.map((cue) => cue.text),
      items: MaweBoot.DATA.segments.map((cue) => cue.items.map((item) => item.text).join('')),
      preserve: MaweBoot.DATA.preserve_punctuation,
    }));
    const expected = { text: ['你好，世界。', 'cafe\u0301!'], items: ['你好，世界。', 'cafe\u0301!'], preserve: true };
    expect(await snapshot()).toEqual(expected);
    expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).preserve_punctuation)).toBe(true);
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/project') && response.request().method() === 'POST');
    await page.locator('#save-project').click();
    expect((await saved).ok()).toBe(true);
    await expect(page.locator('#save-project')).toBeEnabled();
    await expect.poll(() => JSON.parse(readFileSync(project, 'utf8')).preserve_punctuation).toBe(true);
    await page.reload();
    await page.waitForFunction(() => window.MAWE_EDITOR_BRIDGE?.data?.segments.length === 2);
    expect(await snapshot()).toEqual(expected);
    await page.screenshot({ path: test.info().outputPath('editor-roundtrip.png') });
    const legacy = JSON.parse(readFileSync(project, 'utf8'));
    delete legacy.preserve_punctuation;
    const legacyPath = join(directory, 'legacy.mosp');
    writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8');
    await server.stop();
    server = await startServer(legacyPath, media, await findFreePort());
    await page.goto(server.url);
    await page.waitForFunction(() => window.MAWE_EDITOR_BRIDGE?.data?.segments.length === 2);
    expect((await snapshot()).text[0]).toBe('你好  世界');
  } finally {
    await server?.stop();
    cleanupTempDir(directory);
  }
});
