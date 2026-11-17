import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/full-checks-manual.yml',import.meta.url),'utf8');
const editor = workflow.slice(workflow.indexOf('\n  editor:'));
const steps = editor.split(/\n      - /).slice(1);
const named = name => steps.findIndex(step => step.startsWith(`name: ${name}\n`));

test('browser failure artifacts are uploaded after editor and independent tool pages', () => {
  const upload = named('Preserve failed browser evidence');
  assert.notEqual(named('Real file and HTTP editor'),-1);
  assert.notEqual(named('Independent browser tool pages'),-1);
  assert.ok(upload > named('Real file and HTTP editor'));
  assert.ok(upload > named('Independent browser tool pages'));
  assert.equal(steps.filter(step => step.startsWith('name: Preserve failed browser evidence\n')).length,1);
  const real = steps[named('Real file and HTTP editor')];
  const tools = steps[named('Independent browser tool pages')];
  const realOutput = real.match(/--output=(test-results\/\S+)/)?.[1];
  const toolsOutput = tools.match(/--output=(test-results\/\S+)/)?.[1];
  assert.ok(realOutput && toolsOutput && realOutput !== toolsOutput);
  const toolsCondition = tools.match(/^        if: (.*)$/m)?.[1];
  assert.match(toolsCondition, /!cancelled\(\)/);
  assert.match(toolsCondition, /steps\.chromium\.outcome == 'success'/);
  assert.doesNotMatch(toolsCondition, /ffmpeg|editor_build|success\(\)/);
});

test('browser evidence upload keeps the failure/non-light gate and artifact contract', () => {
  const upload = steps[named('Preserve failed browser evidence')];
  assert.ok(upload);
  assert.match(upload,/if: \$\{\{ failure\(\) && needs\.selection\.outputs\.light != 'true' \}\}/);
  assert.match(upload,/uses: actions\/upload-artifact@v6/);
  assert.match(upload,/name: editor-browser-failures-\$\{\{ runner\.os \}\}/);
  assert.match(upload,/\n +test-results\//);
  for (const group of ['editor', 'tools']) {
    assert.ok(upload.includes(`.artifacts/full-${group}-browser.json`));
  }
  assert.match(upload,/retention-days: 7/);
});

test('manual inspection uses the prepared Python for term report JPEG fixtures', () => {
  const tools = steps[named('Independent browser tool pages')];
  const term = steps[named('Term report browser with developer fixtures')];
  const upload = steps[named('Preserve failed browser evidence')];
  assert.ok(term);
  assert.ok(named('Preserve failed browser evidence') > named('Term report browser with developer fixtures'));
  assert.doesNotMatch(tools, /term-report\.spec\.mjs|steps\.python_install\.outcome/);
  assert.match(term, /steps\.python_install\.outcome == 'success'/);
  assert.match(term, /MAW_E2E_PYTHON: .*\.venv\/bin\/python/);
  assert.match(term, /run: .*tests\/e2e\/term-report\.spec\.mjs/);
  assert.match(upload, /\.artifacts\/full-term-report-browser\.json/);
});

test('the manual full inspection retains the real data-safety review regressions', () => {
  const real = steps[named('Real file and HTTP editor')];
  assert.ok(real);
  assert.match(real, /run: .*tests\/e2e\/review-data-safety\.spec\.mjs/);
});
