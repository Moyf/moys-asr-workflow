import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const template = readFileSync(new URL('../tools/verification-checklist/templates/verification-checklist.html', import.meta.url), 'utf8');
const source = template.match(/<script>([\s\S]*?)<\/script>/)[1];
const ast = parse(source, { ecmaVersion: 'latest' });
const body = ast.body[0].expression.callee.body.body;
function declaration(name) {
  const node = body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, `Missing template function ${name}`);
  return source.slice(node.start, node.end);
}
function handler(selector, event) {
  let found;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && node.callee.property.name === 'addEventListener' && node.arguments[0].value === event
        && source.slice(node.callee.object.start, node.callee.object.end) === selector) {
      found = node.arguments[1];
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast);
  assert.ok(found, `Missing ${selector} ${event} handler`);
  return source.slice(found.start, found.end);
}
const scopeSelector = "document.getElementById('export-json')";
function status() {
  return { textContent: '', classList: { add() {} } };
}
function exportFixture(scope = 'all', confirmed = [true, false], ignored = {}) {
  const sections = ['alpha', 'beta', 'readonly'].map(id => ({ id, querySelector: () => ({ title: id }) }));
  const records = confirmed.map((checked, i) => ({
    section: sections[i], box: { id: `check-${i}`, checked }, text: `操作 ${i} → 预期`,
    textarea: i === 1 ? { value: '  第一行\n第二行 <script>原样记录</script>  ' } : null,
    note: i === 0 ? '' : '旧备注',
  }));
  let payload;
  let download;
  const context = {
    sections, records, boxes: records.map(r => r.box), storageFailed: false, status: status(), ignored,
    summaryTitle: summary => summary.title,
    document: {
      title: '验证:导出/测试',
      getElementById: () => ({ value: scope }), querySelector: () => ({ textContent: ' 范围说明 ' }),
      createElement: () => ({ click() { download = this.download; }, remove() {} }),
      body: { appendChild() {} },
    },
    Blob: class { constructor(parts, options) { payload = parts.join(''); this.type = options.type; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    setTimeout(fn) { fn(); },
  };
  vm.runInNewContext(`(${handler(scopeSelector, 'click')})()`, context);
  return { result: payload && JSON.parse(payload), download, context };
}

test('exports complete results with section identity, metadata and verbatim multiline notes', () => {
  const { result, download } = exportFixture();
  assert.equal(result.schema, 'maw.verification-checklist.v1');
  assert.equal(result.scope, 'all');
  assert.deepEqual(result.summary, { total: 2, confirmed: 1, ignored: 0, unconfirmed: 1, exported: 2 });
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].items[0].confirmed, true);
  assert.equal(result.sections[0].items[0].ignored, false);
  assert.equal(result.sections[0].items[0].note, '');
  assert.equal(result.sections[1].items[0].note, '  第一行\n第二行 <script>原样记录</script>  ');
  assert.match(result.exportedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(!/[<>:"/\\|?*]/.test(download));
});

test('unconfirmed export omits confirmed items and empty sections but retains whole-page counts', () => {
  const { result } = exportFixture('unconfirmed');
  assert.deepEqual(result.summary, { total: 2, confirmed: 1, ignored: 0, unconfirmed: 1, exported: 1 });
  assert.deepEqual(result.sections.map(s => s.id), ['beta']);
  assert.equal(result.sections[0].items[0].confirmed, false);
});

test('ignored group items count as handled and stay out of unconfirmed export', () => {
  const ignoredAll = exportFixture('all', [true, false], { beta: true }).result;
  assert.deepEqual(ignoredAll.summary, { total: 2, confirmed: 1, ignored: 1, unconfirmed: 0, exported: 2 });
  assert.equal(ignoredAll.sections[1].items[0].ignored, true);
  assert.equal(ignoredAll.sections[0].items[0].ignored, false);

  const ignoredPending = exportFixture('unconfirmed', [true, false], { beta: true }).result;
  assert.deepEqual(ignoredPending.summary, { total: 2, confirmed: 1, ignored: 1, unconfirmed: 0, exported: 0 });
  assert.deepEqual(ignoredPending.sections, []);
});

test('all-confirmed filtered snapshot contains no sections', () => {
  const { result } = exportFixture('unconfirmed', [true, true]);
  assert.equal(result.summary.exported, 0);
  assert.deepEqual(result.sections, []);
});

test('download failure leaves current results available and reports failure', () => {
  const { context } = exportFixture();
  context.URL.createObjectURL = () => { throw new Error('download blocked'); };
  vm.runInNewContext(`(${handler(scopeSelector, 'click')})()`, context);
  assert.match(context.status.textContent, /导出失败/);
  assert.equal(context.boxes[0].checked, true);
  assert.match(context.records[1].textarea.value, /第二行/);
});

function storageContext(raw, blocked = false) {
  const context = { status: status(), storageFailed: false,
    localStorage: { getItem() { if (blocked) throw new Error('blocked'); return raw; }, setItem() { if (blocked) throw new Error('blocked'); } },
  };
  vm.createContext(context);
  vm.runInContext(['storageWarning', 'load', 'save'].map(declaration).join('\n'), context);
  return context;
}

test('legacy boolean progress and string notes remain readable', () => {
  const context = storageContext('{"check-0":true,"check-1":false}');
  const result = vm.runInContext("load('legacy')", context);
  assert.equal(result['check-0'], true);
  assert.equal(result['check-1'], false);
  assert.equal(context.storageFailed, false);
});

test('invalid or unavailable storage keeps in-memory fallback and exposes warning', () => {
  for (const raw of ['null', '[]', 'true', '{bad']) {
    const context = storageContext(raw);
    const result = vm.runInContext("load('key', {note:'保留'})", context);
    assert.equal(result.note, '保留');
    assert.match(context.status.textContent, /导出 JSON/);
  }
  const context = storageContext(null, true);
  vm.runInContext("save('key', {note:'保留'})", context);
  assert.equal(context.storageFailed, true);
});

test('checkbox reset preserves notes and unrelated persisted item state', () => {
  const context = storageContext('{"other-check":true}');
  const saved = [];
  context.localStorage.setItem = (key, value) => saved.push([key, JSON.parse(value)]);
  Object.assign(context, {
    KEY: 'legacy', IGNORE_KEY: 'legacy:ignored', state: {}, ignored: { 'sec-1': true },
    boxes: [{ id: 'check-0', checked: true }], notes: { 'check-0': '备注' }, refresh() {},
  });
  vm.runInContext(`(${handler("document.getElementById('reset')", 'click')})()`, context);
  assert.equal(context.boxes[0].checked, false);
  assert.equal(context.state['other-check'], true);
  assert.equal(context.notes['check-0'], '备注');
  // 处理器在 VM realm 内重建对象，JSON 往返后再比较（跨 realm 原型不同）。
  assert.deepEqual(JSON.parse(JSON.stringify(context.ignored)), {});
  assert.deepEqual(saved.find(([key]) => key === 'legacy:ignored')[1], {});
});

test('ignore toggle persists per section, collapses on ignore and reopens on cancel', () => {
  const context = storageContext('{}');
  const saved = [];
  // 存储桩需按 key 回读最新值：取消忽略依赖从存储载入的 ignored 状态。
  const store = new Map();
  context.localStorage.getItem = key => store.get(key) ?? null;
  context.localStorage.setItem = (key, value) => {
    store.set(key, value);
    saved.push([key, JSON.parse(value)]);
  };
  Object.assign(context, {
    IGNORE_KEY: 'ignored', ignored: {}, sec: { id: 'alpha', open: true }, refresh() {},
  });
  const click = `(${handler('ignoreBtn', 'click')})({ preventDefault() {}, stopPropagation() {} })`;
  vm.runInContext(click, context);
  const realmIgnored = () => JSON.parse(JSON.stringify(context.ignored));
  assert.deepEqual(realmIgnored(), { alpha: true });
  assert.equal(context.sec.open, false);
  vm.runInContext(click, context);
  assert.deepEqual(realmIgnored(), {});
  assert.equal(context.sec.open, true);
  const ignoredSave = saved.filter(([key]) => key === 'ignored').map(([, value]) => value);
  assert.deepEqual(ignoredSave, [{ alpha: true }, {}]);
});

test('note input persists multiline text without affecting confirmation', () => {
  const context = storageContext('{"other-check":"existing"}');
  const saved = [];
  context.localStorage.setItem = (key, value) => saved.push([key, JSON.parse(value)]);
  Object.assign(context, {
    NOTES_KEY: 'notes', notes: {}, box: { id: 'check-0', checked: true },
    record: { note: '' }, textarea: { value: '  复现\n下一步  ' }, printNote: { textContent: '' },
    toggle: { classList: { toggle() {} } },
  });
  vm.runInContext(`(${handler('textarea', 'input')})()`, context);
  assert.equal(saved[0][0], 'notes');
  assert.equal(saved[0][1]['check-0'], '  复现\n下一步  ');
  assert.equal(saved[0][1]['other-check'], 'existing');
  assert.equal(context.box.checked, true);
  assert.equal(context.printNote.textContent, '备注：  复现\n下一步  ');
});

test('hide-confirmed preference toggles without changing confirmations or notes', () => {
  const context = storageContext('{"otherPreference":true}');
  let refreshed = 0;
  Object.assign(context, {
    VIEW_KEY: 'view', view: {}, hideConfirmed: false,
    boxes: [{ checked: true }], notes: { 'check-0': '备注' }, refresh() { refreshed++; },
  });
  const click = `(${handler("document.getElementById('hide-confirmed')", 'click')})()`;
  vm.runInContext(click, context);
  assert.equal(context.hideConfirmed, true);
  assert.equal(context.view.otherPreference, true);
  assert.equal(context.boxes[0].checked, true);
  assert.equal(context.notes['check-0'], '备注');
  vm.runInContext(click, context);
  assert.equal(context.hideConfirmed, false);
  assert.equal(refreshed, 2);
});

test('printing expands all sections and restores previous disclosure state', () => {
  const context = { sections: [{ open: true }, { open: false }], printOpenStates: undefined };
  vm.createContext(context);
  vm.runInContext(`(${handler('window', 'beforeprint')})()`, context);
  assert.deepEqual(context.sections.map(s => s.open), [true, true]);
  vm.runInContext(`(${handler('window', 'afterprint')})()`, context);
  assert.deepEqual(context.sections.map(s => s.open), [true, false]);
});
