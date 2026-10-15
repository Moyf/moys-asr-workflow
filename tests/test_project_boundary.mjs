import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/project-boundary.json', import.meta.url), 'utf8'));
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../web/shared/utils/project-validation.js', import.meta.url), 'utf8'), context);
const boundary = context.window.MaweProjectValidation;
const json = (v) => JSON.parse(JSON.stringify(v));
const python = process.env.MAW_TEST_PYTHON || 'python';
const result = spawnSync(python, ['-c', [
  'import json',
  'from pathlib import Path',
  'from maw.project import validate_project',
  'from maw.project_boundary import prepare_project',
  'cases = json.loads(Path("tests/fixtures/project-boundary.json").read_text(encoding="utf-8"))',
  'print(json.dumps([{ "strict": validate_project(c["input"]).to_json(), "imported": prepare_project(c["input"]).to_json() } for c in cases], ensure_ascii=False))',
].join('\n')], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, timeout: 30_000 });
assert.equal(result.status, 0, result.stderr);
const expected = JSON.parse(result.stdout);
const sortedErrors = (errors) => [...errors].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

for (const [i, c] of cases.entries()) test(`shared boundary: ${c.name}`, () => {
  const original = json(c.input);
  const strict = json(boundary.validateProject(original));
  const imported = json(boundary.prepareProject(original));
  assert.equal(strict.ok, c.strict_ok);
  assert.equal(imported.ok, c.import_ok);
  assert.deepEqual([...new Set(strict.errors.map((e) => e.path))].sort(), c.error_paths.toSorted());
  for (const [actual, wanted] of [[strict, expected[i].strict], [imported, expected[i].imported]]) {
    assert.deepEqual(sortedErrors(actual.errors), sortedErrors(wanted.errors));
    assert.deepEqual(actual.project, wanted.project);
  }
  assert.deepEqual(imported.changes, expected[i].imported.changes);
  assert.deepEqual(original, c.input, 'validation/import must not mutate the input');
  if (imported.ok) {
    if (c.change_paths) assert.deepEqual(imported.changes.map((change) => change.path), c.change_paths);
    assert.deepEqual(json(boundary.prepareProject(imported.project)).changes, [], 'reimport must be idempotent');
  } else assert.equal(imported.project, null);
});
