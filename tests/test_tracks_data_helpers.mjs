import assert from 'node:assert/strict';
import test from 'node:test';
import { createUtilsModule as createTracks } from '../web/shared/utils/project-tracks.js';
import { createUtilsModule as createData } from '../web/shared/utils/data.js';

test('editor ID helpers preserve canonical Unicode IDs and keep generated collisions in bounds', () => {
  const helpers = createData(createTracks());
  const original = '🙂'.repeat(160);
  const segments = [{ id: original }];
  assert.equal(helpers.ensureStableSegmentIds(segments), 0);
  assert.equal(segments[0].id, original);
  const next = helpers.uniqueStableSegmentId(segments, original);
  assert.notEqual(next, original);
  assert.equal(helpers.stableId(next), next);
  assert.equal(Array.from(next).length, 160);
  assert.equal(helpers.PROJECT_SCHEMA, 'moy.asr.project.v2');
});
