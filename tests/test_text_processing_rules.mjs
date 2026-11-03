import assert from 'node:assert/strict';
import test from 'node:test';
import { createUtilsModule } from '../web/shared/utils/text-processing.js';

const { applyTextProcessingRules } = createUtilsModule({ assMarkedRanges: () => [] });

test('replacement rules are ordered and run before text processing', () => {
  const rules = [
    { find: 'um', replace: '', caseSensitive: false },
    { find: '(\\d+)', replace: '[$1]', regex: true },
    { find: 'ignored', replace: 'changed', enabled: false },
  ];
  assert.equal(applyTextProcessingRules(' UM 123 ignored ', rules, { trim: true }), '[123] ignored');
});

test('literal replacements do not interpret capture references', () => {
  assert.equal(applyTextProcessingRules('aa', [{ find: 'a', replace: '$1' }]), '$1$1');
});

test('invalid rules fail rather than return a partial result', () => {
  assert.throws(() => applyTextProcessingRules('a', [{ find: 'a', replace: 'b' }, { find: '(', regex: true }]), /regular expression/i);
  assert.throws(() => applyTextProcessingRules('a', [{ find: '' }]), /查找内容不能为空/);
});
