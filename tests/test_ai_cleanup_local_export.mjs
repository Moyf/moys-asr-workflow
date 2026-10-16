// ASS 堆栈缓存的输入签名逻辑：纯计算切片，vm 里只跑 ass-preview 的 revision
// 函数体。其余 AI 清理数据保全断言（provenance 投影/时间修复/导出构建器）
// 需要 production 装配级门面，随 ESM 迁移移到真页面测试：
// tests/e2e/ai-cleanup-retention.spec.mjs（vm 夹具无法承载 boot.editor 级依赖）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const plain = (value) => JSON.parse(JSON.stringify(value));

test('ASS cache retains raw identity but invalidates equal-text selections with different item boundaries', () => {
  const script = fs.readFileSync(new URL('../web/editor/styles/editor-wiring-ass-preview.js', import.meta.url), 'utf8');
  const start = script.indexOf('const assStackCueSnapshots =');
  const end = script.indexOf("document.fonts?.addEventListener('loadingdone'", start);
  const context = {};
  vm.runInNewContext(`${script.slice(start, end)}; globalThis.revision = assStackInputRevision;`, context);
  const raw = { id: 'repeated', start: 0, end: 2000, text: '正文啊正文啊正文' };
  const first = { ...raw, text: '正文正文啊正文', items: [{ text: '正文', start: 0, end: 300 }, { text: '正文啊正文', start: 500, end: 2000 }] };
  const second = { ...first, items: [{ text: '正文啊正文', start: 0, end: 1500 }, { text: '正文', start: 1700, end: 2000 }] };
  const identities = [[raw], [], []];
  const initial = context.revision([[first], [], []], identities);
  assert.equal(context.revision([[plain(first)], [], []], identities), initial, 'per-frame projection clones do not rebuild');
  const changed = context.revision([[second], [], []], identities);
  assert.equal(changed, initial + 1, 'equal cue text/timing still observes retained item selection');
  assert.equal(context.revision(identities, identities), changed + 1, 'restoration invalidates projected plan');
});
