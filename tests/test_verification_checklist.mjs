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
const sharedDeclarations = ['storageWarning', 'recordNote', 'includeRecord', 'buildResult', 'buildResultMarkdown', 'downloadResult', 'flashCopyButton']
  .map(declaration).join('\n');
function status() {
  return { textContent: '', classList: { add() {} } };
}
function exportFixture(scope = 'all', confirmed = [true, false], ignored = {}, noteValues) {
  const sections = ['alpha', 'beta', 'readonly'].map(id => ({ id, querySelector: () => ({ title: id }) }));
  const records = confirmed.map((checked, i) => ({
    section: sections[i], box: { id: `check-${i}`, checked },
    text: `目的 ${i}\n（操作）操作步骤 ${i}\n（预期）预期`,
    textarea: i === 1 ? { value: '  第一行\n第二行 <script>原样记录</script>  ' } : null,
    note: i === 0 ? '' : '旧备注',
  }));
  if (noteValues) records.forEach((r, i) => { r.textarea = null; r.note = noteValues[i]; });
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
  vm.createContext(context);
  vm.runInContext(`${sharedDeclarations}\n(${handler(scopeSelector, 'click')})()`, context);
  return { result: payload && JSON.parse(payload), download, context };
}

const mdScopeSelector = "document.getElementById('export-md')";
function markdownFixture(scope = 'all', confirmed = [true, false], ignored = {}, mode = 'export', noteValues) {
  const sections = ['alpha', 'beta'].map(id => ({ id, querySelector: () => ({ title: id }) }));
  const records = confirmed.map((checked, i) => ({
    section: sections[i], box: { id: `check-${i}`, checked },
    text: `目的 ${i}\n（操作）操作步骤 ${i}\n（预期）预期`,
    textarea: i === 1 ? { value: '  第一行\n第二行 <script>原样记录</script>  ' } : null,
    note: i === 0 ? '' : '旧备注',
  }));
  if (noteValues) records.forEach((r, i) => { r.textarea = null; r.note = noteValues[i]; });
  let payload;
  let download;
  let copied;
  const context = {
    sections, records, boxes: records.map(r => r.box), storageFailed: false, status: status(), ignored,
    summaryTitle: summary => summary.title,
    document: {
      title: '验证:导出/测试',
      getElementById: id => id === 'copy-md'
        ? { value: scope, textContent: '复制 Markdown', classList: { add() {}, remove() {} } }
        : { value: scope },
      querySelector: () => ({ textContent: ' 范围说明 ' }),
      createElement: () => ({
        setAttribute() {}, style: {}, select() { copied = this.value; },
        click() { download = this.download; }, remove() {},
      }),
      body: { appendChild() {} },
      execCommand: () => true,
    },
    navigator: mode === 'copy' ? { clipboard: { writeText: text => { copied = text; return Promise.resolve(); } } } : {},
    Blob: class { constructor(parts, options) { payload = parts.join(''); this.type = options.type; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    setTimeout(fn) { fn(); },
  };
  const selector = mode !== 'export' ? "document.getElementById('copy-md')" : mdScopeSelector;
  vm.runInNewContext(`${sharedDeclarations}\n(${handler(selector, 'click')})()`, context);
  return { markdown: mode !== 'export' ? copied : payload, download, context };
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

test('filtered export includes confirmed notes but ignores whitespace notes and ignored groups', () => {
  const { result, download } = exportFixture('unconfirmed', [true, true]);
  assert.equal(result.summary.exported, 1);
  assert.deepEqual(result.sections.map(s => s.id), ['beta']);
  assert.equal(result.sections[0].items[0].confirmed, true);
  assert.match(download, /-未确认和备注-/);
  const ignored = exportFixture('unconfirmed', [true, true], { beta: true }).result;
  assert.equal(ignored.summary.unconfirmed, 0);
  assert.equal(ignored.summary.exported, 0);
  const blank = exportFixture('unconfirmed', [true, true], {}, ['', ' \n\t ']).result;
  assert.equal(blank.summary.exported, 0);
});

test('all-confirmed filtered snapshot without notes contains no sections', () => {
  const { result } = exportFixture('unconfirmed', [true, true], {}, ['', '']);
  assert.equal(result.summary.exported, 0);
  assert.deepEqual(result.sections, []);
});

test('download failure leaves current results available and reports failure', () => {
  const { context } = exportFixture();
  context.URL.createObjectURL = () => { throw new Error('download blocked'); };
  vm.runInNewContext(`${sharedDeclarations}\n(${handler(scopeSelector, 'click')})()`, context);
  assert.match(context.status.textContent, /导出失败/);
  assert.equal(context.boxes[0].checked, true);
  assert.match(context.records[1].textarea.value, /第二行/);
  context.storageFailed = true;
  vm.runInNewContext(`${sharedDeclarations}\n(${handler(scopeSelector, 'click')})()`, context);
  assert.match(context.status.textContent, /本机存储不可用.*导出失败/);
});

test('markdown export mirrors the result snapshot with task list and verbatim notes', async () => {
  const { markdown, download } = markdownFixture();
  assert.match(markdown, /^# 验证:导出\/测试 · 核对结果\n\n> 范围说明\n/);
  assert.match(markdown, /> 导出范围：全部核对项 · 导出时间 \d{4}-\d\d-\d\dT[^\n]*总计 2 项：已确认 1 \/ 忽略 0 \/ 未确认 1（本次导出 2 项）/);
  assert.match(markdown, /## alpha\n- \[x\] 目的 0\n  （操作）操作步骤 0\n  （预期）预期\n  <!-- id: check-0 -->\n/);
  assert.match(markdown, /## beta\n- \[ \] 目的 1\n  （操作）操作步骤 1\n  （预期）预期\n  <!-- id: check-1 -->\n  >   第一行\n  > 第二行 <script>原样记录<\/script>/);
  assert.ok(markdown.endsWith('\n'));
  assert.ok(!/[<>:"*?]/.test(download.slice(0, download.length - '全部-2026-10-15.md'.length)));
  assert.ok(download.endsWith('.md'));

  const pending = markdownFixture('unconfirmed');
  assert.ok(!pending.markdown.includes('## alpha'));
  assert.match(pending.markdown, /## beta\n- \[ \] 目的 1\n  （操作）操作步骤 1/);
  const noted = markdownFixture('unconfirmed', [true, true]);
  assert.match(noted.markdown, /导出范围：仅未确认和备注项/);
  assert.match(noted.markdown, /## beta\n- \[x\] 目的 1/);
  assert.ok(!noted.markdown.includes('## alpha'));
  const ignored = markdownFixture('unconfirmed', [true, true], { beta: true });
  assert.ok(!ignored.markdown.includes('## beta'));
});

test('markdown export marks ignored groups and copy uses the clipboard with fallback', async () => {
  const ignoredAll = markdownFixture('all', [true, false], { beta: true });
  assert.match(ignoredAll.markdown, /## beta（已忽略）\n/);
  assert.match(ignoredAll.markdown, /- \[ \] 目的 1/);

  const copied = markdownFixture('all', [true, false], {}, 'copy');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(copied.markdown, /^# 验证:导出\/测试 · 核对结果/);
  assert.match(copied.context.status.textContent, /已复制 2 项/);

  // 无 clipboard API 的环境走 execCommand 回退，同样报告成功。
  const fallbackSource = markdownFixture('all', [true, false], {}, 'fallback');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(fallbackSource.context.status.textContent, /已复制 2 项/);
});

test('Markdown download and copy preserve trailing note spaces and blank lines like JSON', () => {
  const note = '首行  \n末行  \n\n';
  const jsonNote = exportFixture('unconfirmed', [true, true], {}, ['', note])
    .result.sections[0].items[0].note;
  assert.equal(jsonNote, note);
  for (const mode of ['export', 'copy', 'fallback']) {
    const { markdown } = markdownFixture('unconfirmed', [true, true], {}, mode, ['', note]);
    const quote = markdown.split('\n').filter(line => line.startsWith('  > '))
      .map(line => line.slice(4)).join('\n');
    assert.equal(quote, jsonNote, mode);
  }
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
    window: { confirm: () => true },
  });
  vm.runInContext(`(${handler("document.getElementById('reset')", 'click')})()`, context);
  assert.equal(context.boxes[0].checked, false);
  assert.equal(context.state['other-check'], true);
  assert.equal(context.notes['check-0'], '备注');
  // 处理器在 VM realm 内重建对象，JSON 往返后再比较（跨 realm 原型不同）。
  assert.deepEqual(JSON.parse(JSON.stringify(context.ignored)), {});
  assert.deepEqual(saved.find(([key]) => key === 'legacy:ignored')[1], {});
});

test('cancelling reset does not read or write storage or change current state', () => {
  const context = {
    window: { confirm: () => false },
    state: { 'check-0': true }, ignored: { alpha: true }, notes: { 'check-0': '备注' },
    boxes: [{ checked: true }],
    load() { throw new Error('reset must not load'); },
    save() { throw new Error('reset must not save'); },
    refresh() { throw new Error('reset must not refresh'); },
  };
  vm.runInNewContext(`(${handler("document.getElementById('reset')", 'click')})()`, context);
  assert.equal(context.boxes[0].checked, true);
  assert.deepEqual(context.state, { 'check-0': true });
  assert.deepEqual(context.ignored, { alpha: true });
  assert.deepEqual(context.notes, { 'check-0': '备注' });
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
    refreshExport() {},
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
