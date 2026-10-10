import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPreferenceStore } from '../src/preferences.cjs';

test('preferences survive a new store instance and preserve the previous disk version', () => {
  const target = path.join(mkdtempSync(path.join(tmpdir(), 'mose-preferences-')), 'prefs.json');
  const first = createPreferenceStore(target);
  assert.equal(first.getItem('mawe.language'), null);
  first.setItem('mawe.language', 'en');
  first.setItem('moy.asr.editor.settings.v1', '{"charcountThreshold":27}');
  const second = createPreferenceStore(target);
  assert.equal(second.getItem('mawe.language'), 'en');
  assert.equal(JSON.parse(second.getItem('moy.asr.editor.settings.v1')).charcountThreshold, 27);
  assert.deepEqual(JSON.parse(readFileSync(`${target}.bak`, 'utf8')), { 'mawe.language': 'en' });
  assert.equal(readFileSync(target, 'utf8').includes('\r'), false);
});

test('preference bounds cannot overwrite unrelated files or corrupt the last value', () => {
  const target = path.join(mkdtempSync(path.join(tmpdir(), 'mose-preferences-')), 'prefs.json');
  const store = createPreferenceStore(target);
  store.setItem('mawe.language', 'zh');
  assert.throws(() => store.setItem('../other.json', 'x'), /名称/u);
  assert.throws(() => store.setItem('__proto__', 'x'), /名称/u);
  assert.throws(() => store.setItem('mawe.language', 'x'.repeat(1024 * 1024)), /上限/u);
  assert.equal(store.getItem('mawe.language'), 'zh');
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { 'mawe.language': 'zh' });
});

test('malformed preferences fall back while keeping the damaged bytes in a backup', () => {
  const target = path.join(mkdtempSync(path.join(tmpdir(), 'mose-preferences-')), 'prefs.json');
  writeFileSync(target, '{broken');
  const store = createPreferenceStore(target);
  assert.equal(store.getItem('mawe.language'), null);
  store.setItem('mawe.language', 'en');
  assert.equal(readFileSync(`${target}.bak`, 'utf8'), '{broken');
});
