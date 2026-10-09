// Formal Python assembly on both sides, plus file:// and localhost probes.
// Outputs remain in the isolated copy; no release HTML is overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { readManifest, buildBundle } from './research.mjs';

const [baselineArg, convertedArg, pythonArg] = process.argv.slice(2);
if (!baselineArg || !convertedArg || !pythonArg) throw new Error('Usage: verify.mjs BASELINE CONVERTED PYTHON');
const baseline = path.resolve(baselineArg), converted = path.resolve(convertedArg);
const python = path.resolve(pythonArg);
process.env.MAW_E2E_PYTHON = python;
process.env.PYTHONIOENCODING = 'utf-8';
process.chdir(converted);
const { findFreePort, startBlankServer } = await import(pathToFileURL(path.join(converted, 'tests/e2e/helpers.mjs')).href);
const modules = JSON.parse(fs.readFileSync(path.join(converted, 'scripts/esm-mechanical/batch.json'), 'utf8'));
const bundlePath = path.join(converted, 'web/editor/boot/esm-mechanical-bundle.js');
const bundleBefore = fs.readFileSync(bundlePath, 'utf8');
const fresh = (await buildBundle(converted, modules)).code === bundleBefore;
if (!fresh) throw new Error('Stale bundle before browser probes');

function buildPage(root, name) {
  const output = path.join(converted, name);
  execFileSync(python, ['-c',
    'import edit, pathlib, sys; pathlib.Path(sys.argv[1]).write_text(edit.build_blank_html(), encoding="utf-8", newline="\\n")', output],
  { cwd: root, windowsHide: true, env: process.env });
  return output;
}
const baselinePage = buildPage(baseline, 'baseline-probe.html');
const convertedPage = buildPage(converted, 'converted-probe.html');
const html = fs.readFileSync(convertedPage, 'utf8');
const browser = await chromium.launch();
async function probe(url) {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.AsrEditorUtils && document.getElementById('onboarding-card')
    && window.MaweHost && document.getElementById('cues-container'));
  const state = await page.evaluate(() => {
    const utils = window.AsrEditorUtils;
    window.MaweHost.storage.setItem('maw-esm-mechanical', 'roundtrip');
    const storage = window.MaweHost.storage.getItem('maw-esm-mechanical');
    localStorage.removeItem('maw-esm-mechanical');
    return { registry: window.MAWE.list(), version: window.MAWE.version,
      hostShape: Object.keys(window.MaweHost).sort(),
      utilsShape: Object.keys(utils).sort(),
      result: { schema: utils.PROJECT_SCHEMA, count: utils.countTextUnits('a汉'),
        font: utils.subtitleFontFamilyDisplayName('Microsoft YaHei', 'zh'),
        speaker: utils.speakerLabelForSegment({ color: { name: 'yellow' } }, [], {}),
        navigation: utils.normalizeKeyboardOperationReferenceMode('invalid') },
      storage, onboarding: !document.getElementById('onboarding-card').hidden,
      player: Boolean(document.getElementById('player')), cues: Boolean(document.getElementById('cues-container')) };
  });
  await page.close(); return { errors, state };
}
let server;
try {
  const old = await probe(pathToFileURL(baselinePage).href);
  const file = await probe(pathToFileURL(convertedPage).href);
  const port = await findFreePort();
  server = await startBlankServer(port, path.join(converted, 'probe-settings'));
  const http = await probe(server.url);
  const same = value => JSON.stringify(value.state) === JSON.stringify(old.state);
  const sourceShape = modules.every(module => fs.readFileSync(path.join(converted, 'web', module.file), 'utf8')
    .includes(`export function ${module.exportName}`));
  const checks = { fresh, sourceShape,
    bundleInManifest: readManifest(converted).includes('editor/boot/esm-mechanical-bundle.js'),
    bundleInFormalHtml: html.includes(bundleBefore.trimEnd()),
    baselineZeroErrors: old.errors.length === 0, fileZeroErrors: file.errors.length === 0,
    serverZeroErrors: http.errors.length === 0, fileMatchesBaseline: same(file), serverMatchesBaseline: same(http),
    storageRoundtrip: [old, file, http].every(p => p.state.storage === 'roundtrip'),
    noUnreplacedBootTokens: !/__DATA_JSON__|__SERVER_CONFIG_JSON__|__UI_LANGUAGE_JSON__/.test(html),
    buildDidNotRewriteArtifact: fs.readFileSync(bundlePath, 'utf8') === bundleBefore };
  const result = { checks, ok: Object.values(checks).every(Boolean),
    errors: { baseline: old.errors, file: file.errors, server: http.errors },
    samples: file.state.result, registryEntries: file.state.registry.length };
  fs.writeFileSync(path.join(converted, 'browser-verdict.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  if (server) await server.stop();
  await browser.close();
}
