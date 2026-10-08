import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { buildEditor } from './build-editor.mjs';

const [baselineArg, rootArg, pythonArg] = process.argv.slice(2);
if (!baselineArg || !rootArg || !pythonArg) throw new Error('Usage: verify-editor.mjs CLASSIC_BASELINE ROOT PYTHON');
const baseline = path.resolve(baselineArg), root = path.resolve(rootArg), python = path.resolve(pythonArg);
const outputDir = path.join(root, '.worktrees', 'editor-validation');
fs.mkdirSync(outputDir, {recursive:true});
process.env.MAW_E2E_PYTHON = python;
process.env.PYTHONIOENCODING = 'utf-8';
process.chdir(root);
const { startBlankServer, findFreePort } = await import(pathToFileURL(path.join(root, 'tests/e2e/helpers.mjs')).href);
const built = await buildEditor(root);
const artifact = fs.readFileSync(path.join(root, 'web/editor/boot/editor-bundle.js'), 'utf8');
if (built.code !== artifact) throw new Error('Editor artifact is stale');
const sample = { schema: 'moy.asr.project.v1', media: '', language: 'en', model: 'synthetic',
  segments: [
    { id: 'sample-a', start: 0, end: 1000, text: 'First', items: [{ start: 0, end: 1000, text: 'First' }] },
    { id: 'sample-b', start: 1100, end: 2100, text: 'Second', items: [{ start: 1100, end: 2100, text: 'Second' }] },
  ], research_extension: { preserved: true } };
function render(projectRoot, filename) {
  const output = path.join(outputDir, filename);
  execFileSync(python, ['-c', `import edit, pathlib, sys
original = edit.render_editor_page
def render(**context):
    context['data_json'] = sys.argv[2]
    return original(**context)
edit.render_editor_page = render
pathlib.Path(sys.argv[1]).write_text(edit.build_blank_html(), encoding='utf-8', newline='\\n')
`, output, JSON.stringify(sample)], { cwd: projectRoot, windowsHide: true, env: process.env });
  return output;
}
const baselinePage = render(baseline, 'full-baseline-probe.html');
const fullPage = render(root, 'full-current-probe.html');
const browser = await chromium.launch();
async function probe(url, injected) {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed');
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
  });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.MAWE_EDITOR_BRIDGE && window.MaweCoreState?.waveformEditor),
      undefined, { timeout: 5000 });
    const boot = await page.evaluate(() => ({ registry: window.MAWE.list(),
      host: Object.keys(window.MaweHost).sort(), utils: Object.keys(window.AsrEditorUtils).sort(),
      injected: window.MaweBoot.DATA.segments[0]?.text,
      trace: window.__mawEsmInitializationTrace ?? null }));
    const result = await page.evaluate(project => {
      window.MaweProjectLoad.applyCanonicalProject(project, 'synthetic.mosp');
      const serialized = JSON.parse(window.MaweJsonRepair.buildJson());
      const srt = window.MaweExportSrt.buildSrt();
      const before = JSON.stringify(window.MaweBoot.DATA.segments);
      window.MaweSegmentOps.mergeSegments([0, 1]);
      const merged = window.MaweBoot.DATA.segments.length === 1;
      window.MaweHistory.performUndo();
      const undoRestored = JSON.stringify(window.MaweBoot.DATA.segments) === before;
      return { texts: window.MaweBoot.DATA.segments.map(segment => segment.text), srt,
        extension: serialized.research_extension?.preserved === true,
        integerTiming: serialized.segments.every(segment => Number.isInteger(segment.start) && Number.isInteger(segment.end)),
        merged, undoRestored };
    }, sample);
    return { errors, boot, result, projectInjection: !injected || boot.injected === 'First' };
  } catch (error) { return { errors: [...errors, error.message], boot: null, result: null, projectInjection: false }; }
  finally { await page.close(); }
}
let server;
try {
  const old = await probe(pathToFileURL(baselinePage).href, true);
  const file = await probe(pathToFileURL(fullPage).href, true);
  server = await startBlankServer(await findFreePort(), path.join(outputDir, 'settings'));
  const http = await probe(server.url, false);
  const bootShape = probe => probe.boot && JSON.stringify({ registry: probe.boot.registry,
    host: probe.boot.host, utils: probe.boot.utils });
  const sameResult = probe => probe.result && JSON.stringify(probe.result) === JSON.stringify(old.result);
  const all = [old, file, http];
  const html = fs.readFileSync(fullPage, 'utf8');
  const checks = {
    zeroErrors: all.every(p => p.errors.length === 0),
    artifactInFormalPage: html.includes(built.identity),
    fileBoot: Boolean(bootShape(file)) && bootShape(file) === bootShape(old),
    serverBoot: Boolean(bootShape(http)) && bootShape(http) === bootShape(old),
    projectInjection: old.projectInjection && file.projectInjection,
    sharedStateWrite: all.every(p => p.result?.extension === true),
    integerMilliseconds: all.every(p => p.result?.integerTiming === true),
    exportSrt: all.every(p => p.result?.srt.includes('First') && p.result?.srt.includes('Second')),
    mergeAndUndo: all.every(p => p.result?.merged && p.result?.undoRestored),
    fileResultMatchesBaseline: Boolean(sameResult(file)), serverResultMatchesBaseline: Boolean(sameResult(http)),
    explicitInitializationOrder: [file, http].every(p => JSON.stringify(p.boot?.trace) === JSON.stringify(built.sourceFiles)),
    knownTokensReplaced: !/__DATA_JSON__|__SERVER_CONFIG_JSON__|__UI_LANGUAGE_JSON__|__NINJA_SFX_BASE_URL_JSON__/.test(html),
  };
  const verdict = { ok: Object.values(checks).every(Boolean), checks,
    errors: { baseline: old.errors, file: file.errors, server: http.errors },
    initialized: { file: file.boot?.trace?.length ?? 0, server: http.boot?.trace?.length ?? 0 } };
  fs.writeFileSync(path.join(outputDir, 'browser-verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.ok) process.exitCode = 1;
} finally {
  if (server) await server.stop();
  await browser.close();
}
