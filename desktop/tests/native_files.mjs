import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeSelectedProject } from '../src/native_files.cjs';

test('native project writes publish UTF-8/LF and keep the immediately previous file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mose-save-'));
  const target = path.join(root, '工程 with spaces.mosp');
  writeFileSync(target, 'original');
  const project = { schema: 'moy.asr.project.v1', segments: [{ text: '中文', start: 0, end: 100 }] };
  const result = writeSelectedProject(target, project);
  assert.equal(readFileSync(result.backup, 'utf8'), 'original');
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), project);
  assert.equal(readFileSync(target).includes(13), false);
});

test('native writer rejects unrelated extensions and relative paths', () => {
  assert.throws(() => writeSelectedProject(path.resolve('keys.env'), {}), /工程目标/);
  assert.throws(() => writeSelectedProject('project.mosp', {}), /工程目标/);
});
