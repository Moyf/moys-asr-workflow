import assert from 'node:assert/strict';
import test from 'node:test';
import { createUtilsModule } from '../web/shared/utils/multi-subtitle.js';

function fixture(ids = ['red-1', 'red-2']) {
  const segments = ids.map((id, index) => ({ id: `cue-${index}`, color_group_id: id }));
  const project = {
    schema: 'moy.asr.project.v2',
    subtitle_groups: { next_id: 4, color: [
      { id: 'red-1', value: { name: 'red', value: '#f00', extension: { source: 'original' } } },
      { id: 'red-2', value: { name: 'red', value: '#f00' } },
      { id: 'blue', value: { name: 'blue', value: '#00f' } },
    ], sticker: [] },
    tracks: [{ id: 'main', role: 'main', segments }],
  };
  const utils = createUtilsModule({ cloneJsonValue: structuredClone, stableId: value => value, getProject: () => project });
  return { project, segments, utils };
}

test('same v2 color group retains its stable identity without mutating project', () => {
  const { project, segments, utils } = fixture(['red-1', 'red-1']);
  const before = structuredClone(project);
  assert.deepEqual(utils.resolveMergedColorInheritance(segments, [0, 1]), {
    groupId: 'red-1', value: null, groupInherited: true,
  });
  assert.deepEqual(project, before);
});

test('different groups of the same color produce an independent value for the transaction', () => {
  const { project, segments, utils } = fixture();
  const before = structuredClone(project);
  const result = utils.resolveMergedColorInheritance(segments, [0, 1]);
  assert.deepEqual(result, {
    groupId: null,
    value: { name: 'red', value: '#f00', extension: { source: 'original' } },
    groupInherited: false,
  });
  result.value.extension.source = 'changed';
  assert.deepEqual(project, before);
});

test('mixed, uncolored, dangling and invalid selections do not inherit a color', () => {
  for (const ids of [['red-1', 'blue'], ['red-1', null], ['red-1', 'missing']]) {
    const { segments, utils } = fixture(ids);
    assert.deepEqual(utils.resolveMergedColorInheritance(segments, [0, 1]), {
      groupId: null, value: null, groupInherited: false,
    });
    assert.deepEqual(utils.resolveMergedColorInheritance(segments, [0, 100]), {
      groupId: null, value: null, groupInherited: false,
    });
  }
});
