import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';

const context = vm.createContext({ crypto: webcrypto, TextEncoder });
vm.runInContext(readFileSync(new URL('../web/shared/templates/ai-translation-review.js', import.meta.url), 'utf8'), context);
const adapter = context.MAWTranslationReview;
const main = project => project.tracks.find(track => track.role === 'main');
const extension = project => project.tracks.find(track => track.role === 'secondary');
const makeProject = (segments, extra = {}) => ({
  schema: 'moy.asr.project.v2',
  tracks: [{ id: 'main', role: 'main', name: '主字幕', enabled: true, segments }],
  bilingual: { display_mode: 'both' }, bindings: [], ...extra,
});
function fixture(mode = 'single') {
  const source = makeProject([
    { id: 'a', start: 0, end: 1000, text: '原文\n第二行' },
    { id: 'b', start: 1200, end: 2000, text: '原文二' },
  ]);
  const result = makeProject([
    { ...main(source).segments[0], text: mode === 'bilingual' ? '译文\n原文\n第二行' : '译文', items: [{ text: '译文', start: 0, end: 1000 }] },
    { ...main(source).segments[1], text: '原文二', items: [{ text: '原文二', start: 1200, end: 2000 }] },
  ], { markers: { items: [{ id: 'user', start: 0, note: '用户注' }] }, user_metadata: { arbitrary: '保持' } });
  result.tracks.push(
    { id: 'overlay', role: 'overlay', name: '叠加字幕', enabled: false, segments: [{ id: 'overlay-cue', start: 0, end: 300, text: '隐藏' }] },
    { id: 'track', role: 'secondary', name: '副字幕', enabled: false, segments: [] },
  );
  const packet = { schema: 'maw.translation-review.v1', source, result, mode, translationFirst: true,
    entries: main(source).segments.map((cue, i) => ({ id: cue.id, start: cue.start, end: cue.end, source: cue.text, translation: i ? '原文二' : '译文', editable: true })) };
  const snapshot = JSON.stringify(packet);
  return { snapshot, sha256: createHash('sha256').update(snapshot).digest('hex'), filename: '核对.mosp' };
}
const plain = value => JSON.parse(JSON.stringify(value));

function trackFixture() {
  const packet = JSON.parse(fixture().snapshot);
  packet.mode = 'tracks';
  packet.translationTrackId = 'track';
  main(packet.result).segments = structuredClone(main(packet.source).segments);
  main(packet.result).segments[0].items = [{ text: '原文\n第二行', start: 0, end: 1000 }];
  extension(packet.result).language = 'zh';
  extension(packet.result).segments = [
    { id: 'translated-a', start: 0, end: 1000, text: '译文', items: [{ text: '译文', start: 0, end: 1000 }] },
  ];
  packet.entries[0].targetId = 'translated-a';
  packet.entries[1].targetId = null;
  packet.entries[1].editable = false;
  const snapshot = JSON.stringify(packet);
  return { snapshot, sha256: createHash('sha256').update(snapshot).digest('hex') };
}

test('dual-track review edits only the translation and preserves editable source words and existing tracks', async () => {
  const review = trackFixture(), original = JSON.parse(review.snapshot).result;
  const { project, changed } = await adapter.applyEdits(review, [{ id: 'a', text: '新译文\n第二行' }]);
  const expected = structuredClone(original), cue = extension(expected).segments[0];
  cue.text = '新译文\n第二行';
  delete cue.items;
  cue._dirty = true;
  assert.equal(changed, 1);
  assert.equal(project.tracks.filter(track => track.role === 'secondary').length, 1);
  assert.deepEqual(plain(project), expected);
  assert.deepEqual(plain((await adapter.applyEdits(review, [])).project), original);
  await assert.rejects(adapter.applyEdits(review, [{ id: 'b', text: '不能改原文' }]));
  for (const mutate of [
    packet => { packet.entries[0].targetId = 'missing'; },
    packet => { extension(packet.result).segments[0].start = 5; },
    packet => { extension(packet.result).segments.push({ id: 'translated-a', start: 0, end: 1000, text: '重复' }); },
    packet => { main(packet.result).segments[0].text = '源文被改动'; },
    packet => { extension(packet.result).segments[0].id = main(packet.result).segments[0].id; },
    packet => { packet.result.schema = 'moy.asr.project.v99'; },
    packet => { packet.result.segments = []; },
  ]) {
    const packet = JSON.parse(review.snapshot);
    mutate(packet);
    const snapshot = JSON.stringify(packet);
    await assert.rejects(adapter.applyEdits({ snapshot, sha256: createHash('sha256').update(snapshot).digest('hex') }, []));
  }
});

test('single, backfill and stacked translations edit only text, keep metadata and clear stale items', async () => {
  for (const mode of ['single', 'backfill', 'bilingual']) {
    const review = fixture(mode), original = JSON.parse(review.snapshot).result;
    const { project, changed } = await adapter.applyEdits(review, [{ id: 'a', text: '新译文\n第二行' }]);
    assert.equal(changed, 1);
    const expected = structuredClone(original);
    main(expected).segments[0].text = mode === 'bilingual' ? '新译文\n第二行\n原文\n第二行' : '新译文\n第二行';
    delete main(expected).segments[0].items;
    main(expected).segments[0]._dirty = true;
    assert.deepEqual(plain(project), expected);
    assert.deepEqual(plain((await adapter.applyEdits(review, [])).project), original);
    assert.deepEqual(plain((await adapter.applyEdits(review, [{ id: 'a', text: '译文' }])).project), original);
  }
});

test('reject unknown or duplicate IDs, empty/control text, arbitrary fields and corrupt snapshots', async () => {
  const review = fixture();
  for (const edits of [[{ id: 'missing', text: 'x' }], [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }],
    [{ id: 'a', text: ' ' }], [{ id: 'a', text: '\x00' }], [{ id: 'a', text: 'x', start: 5 }]]) {
    await assert.rejects(adapter.applyEdits(review, edits));
  }
  await assert.rejects(adapter.applyEdits({ ...review, snapshot: review.snapshot + ' ' }, []), /指纹/);
  const packet = JSON.parse(review.snapshot);
  packet.entries[0].start = 42;
  const snapshot = JSON.stringify(packet);
  await assert.rejects(adapter.applyEdits({ ...review, snapshot, sha256: createHash('sha256').update(snapshot).digest('hex') }, []), /映射/);
});

test('bilingual adapter follows the writer for whitespace equality, blank translations and both line orders', async () => {
  for (const [source, translation] of [[' API ', 'API'], ['API', ' API '], ['source', ' '], [' ', 'translated']]) {
    for (const translationFirst of [false, true]) {
      const resultText = !source.trim() ? translation
        : !translation.trim() || source.trim() === translation.trim() ? source
          : translationFirst ? `${translation}\n${source}` : `${source}\n${translation}`;
      const cue = { id: 'a', start: 0, end: 1000 };
      const packet = { schema: 'maw.translation-review.v1',
        source: makeProject([{ ...cue, text: source }]),
        result: makeProject([{ ...cue, text: resultText }]),
        mode: 'bilingual', translationFirst,
        entries: [{ ...cue, source, translation, editable: Boolean(source.trim()) }] };
      const snapshot = JSON.stringify(packet);
      const review = { snapshot, sha256: createHash('sha256').update(snapshot).digest('hex') };
      assert.deepEqual(plain((await adapter.applyEdits(review, [])).project), packet.result);
      if (source.trim()) {
        const edited = await adapter.applyEdits(review, [{ id: 'a', text: source.trim() }]);
        assert.equal(main(edited.project).segments[0].text, source);
      }
    }
  }
});
