import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/editor-checks.yml',import.meta.url),'utf8');
const editor = workflow.slice(workflow.indexOf('\n  editor:'));
const steps = editor.split(/\n      - /).slice(1);
const named = name => steps.findIndex(step => step.startsWith(`name: ${name}\n`));

test('browser failure artifacts are uploaded after both browser groups', () => {
  const upload = named('Preserve failed browser evidence');
  assert.notEqual(named('Real file and HTTP editor'),-1);
  assert.notEqual(named('Independent browser tool pages'),-1);
  assert.ok(upload > named('Real file and HTTP editor'));
  assert.ok(upload > named('Independent browser tool pages'));
  assert.equal(steps.filter(step => step.startsWith('name: Preserve failed browser evidence\n')).length,1);
});

test('browser evidence upload keeps the failure/non-light gate and artifact contract', () => {
  const upload = steps[named('Preserve failed browser evidence')];
  assert.ok(upload);
  assert.match(upload,/if: \$\{\{ failure\(\) && needs\.selection\.outputs\.light != 'true' \}\}/);
  assert.match(upload,/uses: actions\/upload-artifact@v6/);
  assert.match(upload,/name: editor-browser-failures-\$\{\{ runner\.os \}\}/);
  assert.match(upload,/path: test-results\//);
  assert.match(upload,/retention-days: 7/);
});
