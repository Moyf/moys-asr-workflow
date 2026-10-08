// Actual file/HTTP feature wiring and freshness; never builds or repairs assets.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { buildEditor } from './full-build.mjs';

const [rootArg, pythonArg, ...flags] = process.argv.slice(2);
if (!rootArg || !pythonArg) throw new Error('Usage: verify-upstream.mjs ROOT PYTHON [--expected-root CLASSIC] [--fork-probe]');
const root = path.resolve(rootArg), python = path.resolve(pythonArg);
const expectedIndex = flags.indexOf('--expected-root');
const expectedRoot = expectedIndex >= 0 ? path.resolve(flags[expectedIndex + 1]) : root;
const manifest = fs.existsSync(path.join(expectedRoot, 'web/editor-sources.txt')) ? 'editor-sources.txt' : 'editor-scripts.txt';
const files = fs.readFileSync(path.join(expectedRoot, 'web', manifest), 'utf8').split('\n')
  .map(line => line.split('#')[0].trim()).filter(Boolean);
const expected = {
  canvas: files.includes('editor/styles/editor-wiring-ass-canvas.js'),
  wordTiming: files.includes('shared/utils/word-timing.js'),
  projectSettings: files.includes('editor/state/editor-project-settings.js'),
  fork: flags.includes('--fork-probe'),
};
process.env.MAW_E2E_PYTHON = python;
process.env.PYTHONIOENCODING = 'utf-8';
process.chdir(root);
const { startBlankServer, findFreePort } = await import(pathToFileURL(path.join(root, 'tests/e2e/helpers.mjs')).href);
const artifact = fs.readFileSync(path.join(root, 'web/editor/boot/editor-bundle.js'), 'utf8');
let freshness = false, buildError = null;
try { freshness = (await buildEditor(root)).code === artifact; }
catch (error) { buildError = error.message.replaceAll(root, '<experiment>'); }
const portable = path.join(root, 'upstream-feature-probe.html');
execFileSync(python, ['-c', "import edit,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(edit.build_blank_html(),encoding='utf-8',newline='\\n')", portable],
  { cwd: root, windowsHide: true, env: process.env });
const browser = await chromium.launch();
async function probe(url) {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed'));
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.MAWE_EDITOR_BRIDGE && window.MaweCoreState?.waveformEditor), undefined, { timeout: 5000 });
    const checks = await page.evaluate(expected => {
      const utils = window.AsrEditorUtils;
      let canvas = !expected.canvas;
      if (expected.canvas && typeof utils?.assCanvasAlignmentGrid === 'function' && typeof window.MaweAssCanvas?.render === 'function') {
        const grid = utils.assCanvasAlignmentGrid(2);
        window.MaweAssCanvas.render({ width: 320, height: 180, tracks: [] });
        canvas = grid.column === 1 && grid.row === 2;
      }
      let wordTiming = !expected.wordTiming;
      if (expected.wordTiming && typeof utils?.getWordTimingEntries === 'function') {
        const entries = utils.getWordTimingEntries({ start: 0, end: 1000, text: 'Hello', items: [{ text: 'Hello', start: 0, end: 1000 }] });
        wordTiming = entries.length === 1 && entries[0].start === 0 && entries[0].end === 1000;
      }
      return { canvas, wordTiming,
        projectSettings: !expected.projectSettings || typeof window.MaweProjectSettings?.syncControls === 'function',
        fork: !expected.fork || window.__forkMergeRehearsal === 'preserved' };
    }, expected);
    return { boot: true, checks, errors };
  } catch (error) { return { boot: false, checks: {}, errors: [...errors, error.message] }; }
  finally { await page.close(); }
}
let server;
try {
  const file = await probe(pathToFileURL(portable).href);
  server = await startBlankServer(await findFreePort(), path.join(root, 'upstream-feature-settings'));
  const http = await probe(server.url);
  const ok = freshness && [file, http].every(p => p.boot && p.errors.length === 0 && Object.values(p.checks).every(Boolean));
  const result = { ok, freshness, buildError, expected, file, http };
  fs.writeFileSync(path.join(root, 'upstream-feature-verdict.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  if (!ok) process.exitCode = 1;
} finally {
  if (server) await server.stop();
  await browser.close();
}
