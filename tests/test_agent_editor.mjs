import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { createAgentCore } from '../web/editor/io/editor-agent-core.js';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const core = createAgentCore(context.window.AsrEditorUtils);
const copy = value => JSON.parse(JSON.stringify(value));
const project = () => ({ media: 'demo.wav', segments: [
  { id: 'a', start: 0, end: 1000, text: '你好', speaker: 'Alice', items: [
    { start: 0, end: 500, text: '你' }, { start: 500, end: 1000, text: '好' } ] },
  { id: 'b', start: 1500, end: 2500, text: 'outside', custom: 'preserve' },
] });
const proposal = (p, operation) => ({ schema: 'moy.asr.agent.proposal.v1', reason: 'fixture', base: copy(p), operation });

test('text correction uses real word reconciliation and preserves metadata/outside cues', () => {
  const p = project();
  const before = copy(p);
  const result = core.plan(p, proposal(p, { type: 'text', edits: [{ id: 'a', text: '您好' }] }));
  assert.equal(result.segments[0].items[0].text, '您');
  assert.equal(result.segments[0].items[0].start, 0);
  assert.equal(result.segments[0].speaker, 'Alice');
  assert.deepEqual(result.segments[1], p.segments[1]);
  assert.deepEqual(p, before);
});

test('lost alignment is removed instead of attaching stale words', () => {
  const p = project();
  const result = core.plan(p, proposal(p, { type: 'text', edits: [{ id: 'a', text: '完全不同的内容' }] }));
  assert.ok(!result.segments[0].items?.length);
  assert.deepEqual([result.segments[0].start, result.segments[0].end], [0, 1000]);
});

test('checks concurrent edits both before review and again on apply', () => {
  const p = project();
  const change = proposal(p, { type: 'text', edits: [{ id: 'a', text: '您好' }] });
  core.plan(p, change);
  p.segments[1].text = 'user edit outside proposal';
  assert.throws(() => core.plan(p, change), { code: 'conflict' });
});

test('text operations reject missing IDs and preserve extension bindings', () => {
  const p = project();
  p.multi_subtitle = { tracks: [{ id: 't', segments: [{ id: 'translation', bindings: ['a'] }] }] };
  core.plan(p, proposal(p, { type: 'text', edits: [{ id: 'a', text: '您好' }] }));
  assert.throws(() => core.plan(p, proposal(p, { type: 'text', edits: [{ id: 'unknown', text: 'x' }] })), { code: 'invalid_request' });
  assert.equal(p.multi_subtitle.tracks[0].segments[0].bindings[0], 'a');
});

test('range replacement preserves outside data and rejects partial boundaries', () => {
  const p = project();
  const op = { type: 'replace_range', start: 0, end: 1000, segments: [
    { id: 'new', start: 100, end: 800, text: '新字幕', speaker: 'Alice' }] };
  const result = core.plan(p, proposal(p, op));
  assert.deepEqual(result.segments[1], p.segments[1]);
  assert.equal(result.segments[0].id, 'new');
  assert.throws(() => core.plan(p, proposal(p, { ...op, start: 200 })), { code: 'boundary_conflict' });
  assert.throws(() => core.plan(p, proposal(p, { ...op, segments: [{ id: 'b', start: 100, end: 800, text: 'collision' }] })), { code: 'invalid_request' });
});

test('range replacement validates untrusted timings and refuses unsafe structures', () => {
  const p = project();
  const op = { type: 'replace_range', start: 0, end: 1000, segments: [{ id: 'x', start: 0, end: 999, text: 'x', items: [{ start: 0, end: 1001, text: 'x' }] }] };
  assert.throws(() => core.plan(p, proposal(p, op)), { code: 'invalid_request' });
  for (const field of ['disabled', 'unknown']) {
    const q = project(); q.segments[0][field] = true;
    assert.throws(() => core.plan(q, proposal(q, { ...op, segments: [] })), { code: 'unsupported_structure' });
  }
  p.multi_subtitle = { tracks: [{}] };
  assert.throws(() => core.plan(p, proposal(p, { ...op, segments: [] })), { code: 'unsupported_structure' });
});

test('no-op has no new edit and baseline order is independent of object key order', () => {
  const p = project();
  const change = proposal(p, { type: 'text', edits: [{ id: 'a', text: '你好' }] });
  change.base.segments[0] = Object.fromEntries(Object.entries(change.base.segments[0]).reverse());
  p.segments[0]._dirty = true;
  assert.equal(core.plan(p, change).changed, false);
});
