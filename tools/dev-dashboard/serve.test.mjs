// Dev Dashboard 服务端纯逻辑测试。运行：node --test tools/dev-dashboard/
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile, mkdtemp, rm } from 'node:fs/promises';

import {
  extractOwnerRepo,
  parseChecklistFrontMatter,
  groupChecklistsByPr,
  summarizeChecks,
  readStatusMap,
  writeStatusMap,
} from './serve.mjs';

test('extractOwnerRepo 解析 https 与 ssh 形式的 origin', () => {
  assert.equal(extractOwnerRepo('https://github.com/Moyf/moys-asr-workflow.git'), 'Moyf/moys-asr-workflow');
  assert.equal(extractOwnerRepo('git@github.com:Moyf/moys-asr-workflow.git'), 'Moyf/moys-asr-workflow');
  assert.equal(extractOwnerRepo('https://gitlab.com/foo/bar.git'), null);
  assert.equal(extractOwnerRepo(null), null);
});

test('parseChecklistFrontMatter 解析标准清单头', () => {
  const text = [
    '---',
    'task: pr253-progressive-split-review',
    'pr: 253',
    'date: 2026-10-17',
    'status: pending',
    '---',
    '',
    '# 标题',
  ].join('\n');
  assert.deepEqual(parseChecklistFrontMatter(text), {
    task: 'pr253-progressive-split-review',
    pr: 253,
    date: '2026-10-17',
    status: 'pending',
  });
});

test('parseChecklistFrontMatter 容忍 BOM 与缺失可选字段', () => {
  const text = '\uFEFF---\nstatus: passed\n---\n正文';
  assert.deepEqual(parseChecklistFrontMatter(text), { task: '', pr: null, date: '', status: 'passed' });
});

test('parseChecklistFrontMatter 拒绝非清单与缺 status 的文件', () => {
  assert.equal(parseChecklistFrontMatter('# 普通笔记\n没有 front-matter'), null);
  assert.equal(parseChecklistFrontMatter('---\ntask: x\n---\n正文'), null);
  assert.equal(parseChecklistFrontMatter('---\nstatus: 待定'), null); // 未闭合
  assert.equal(parseChecklistFrontMatter(42), null);
});

test('parseChecklistFrontMatter 对非数字 pr 返回 null 字段', () => {
  const fm = parseChecklistFrontMatter('---\npr: 无\nstatus: pending\n---\n');
  assert.equal(fm.pr, null);
});

test('groupChecklistsByPr 按 PR 分组并跳过未挂 PR 的清单', () => {
  const grouped = groupChecklistsByPr([
    { task: 'a', pr: 253, date: '2026-10-17', status: 'pending', file: 'a' },
    { task: 'b', pr: 253, date: '2026-10-18', status: 'passed', file: 'b' },
    { task: 'c', pr: null, date: '', status: 'pending', file: 'c' },
    { task: 'd', pr: 291, date: '', status: 'partial', file: 'd' },
  ]);
  assert.equal(grouped.get(253).length, 2);
  assert.equal(grouped.get(291).length, 1);
  assert.equal(grouped.has(null), false);
});

test('summarizeChecks 汇总 CI 结论', () => {
  assert.equal(summarizeChecks([]), 'none');
  assert.equal(summarizeChecks(undefined), 'none');
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS' }]), 'ok');
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), 'ok');
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'failing');
  assert.equal(summarizeChecks([{ status: 'IN_PROGRESS', conclusion: null }]), 'running');
  assert.equal(summarizeChecks([{ conclusion: 'TIMED_OUT' }]), 'failing');
});

test('summarizeChecks 兼容 StatusContext 的 state 字段（小写）', () => {
  assert.equal(summarizeChecks([{ state: 'success' }]), 'ok');
  assert.equal(summarizeChecks([{ state: 'failure' }]), 'failing');
  assert.equal(summarizeChecks([{ state: 'error' }]), 'failing');
  assert.equal(summarizeChecks([{ state: 'pending' }]), 'running');
  assert.equal(summarizeChecks([{ state: 'expected' }]), 'ok');
  assert.equal(summarizeChecks([{ state: 'success' }, { conclusion: 'FAILURE' }]), 'failing');
  // 混合形态：conclusion 优先于 state
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS', state: 'pending' }]), 'ok');
});

test('readStatusMap 对缺失文件返回空表，write/read 往返一致', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-dashboard-test-'));
  try {
    const file = path.join(dir, 'nested', 'status.json');
    assert.deepEqual(await readStatusMap(file), {});
    await writeStatusMap({ '293': 'review', '292': null }, file);
    assert.deepEqual(await readStatusMap(file), { '293': 'review', '292': null });
    const raw = await readFile(file, 'utf8');
    assert.match(raw, /\n$/); // 以换行结尾，diff 友好
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readStatusMap 对损坏 JSON 抛错而非静默清空', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-dashboard-test-'));
  try {
    const file = path.join(dir, 'broken.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{not json', 'utf8');
    await assert.rejects(() => readStatusMap(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- handleRequest HTTP 层（mock req/res）----

import { handleRequest } from './serve.mjs';
import { EventEmitter } from 'node:events';

function mockReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  if (method === 'POST') {
    queueMicrotask(() => {
      if (body) req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  }
  return req;
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
    },
    end(chunk) {
      this.body = String(chunk ?? '');
    },
  };
}

const HOST = { host: '127.0.0.1:8262' };

async function callApi(options, reqArgs) {
  const res = mockRes();
  await handleRequest(mockReq(reqArgs), res, { port: 8262, ...options });
  return res;
}

test('POST /api/status 合法请求写入状态文件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-dashboard-test-'));
  try {
    const statusFile = path.join(dir, 'status.json');
    const res = await callApi(
      { statusFile },
      {
        method: 'POST',
        url: '/api/status',
        headers: { ...HOST, 'content-type': 'application/json' },
        body: JSON.stringify({ pr: 42, status: 'review' }),
      },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { '42': 'review' });
    assert.deepEqual(await readStatusMap(statusFile), { '42': 'review' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /api/status 拒绝跨源 Origin（CSRF）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-dashboard-test-'));
  try {
    const statusFile = path.join(dir, 'status.json');
    for (const origin of ['https://evil.example', 'http://192.168.1.5:8262']) {
      const res = await callApi(
        { statusFile },
        {
          method: 'POST',
          url: '/api/status',
          headers: { ...HOST, 'content-type': 'application/json', origin },
          body: '{"pr":1,"status":"pass"}',
        },
      );
      assert.equal(res.statusCode, 403, `origin=${origin}`);
    }
    // 同源 Origin 与无 Origin（curl/同源 fetch）都放行
    for (const origin of [undefined, 'http://127.0.0.1:8262', 'http://localhost:8262']) {
      const headers = { ...HOST, 'content-type': 'application/json' };
      if (origin) headers.origin = origin;
      const res = await callApi(
        { statusFile },
        { method: 'POST', url: '/api/status', headers, body: '{"pr":1,"status":"pass"}' },
      );
      assert.equal(res.statusCode, 200, `origin=${origin}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /api/status 拒绝非 application/json 内容类型（no-cors 伪造）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-dashboard-test-'));
  try {
    const res = await callApi(
      { statusFile: path.join(dir, 'status.json') },
      {
        method: 'POST',
        url: '/api/status',
        headers: { ...HOST, 'content-type': 'text/plain' },
        body: '{"pr":1,"status":"pass"}',
      },
    );
    assert.equal(res.statusCode, 415);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/status 走 HTTP 层返回状态表', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-dashboard-test-'));
  try {
    const res = await callApi(
      { statusFile: path.join(dir, 'status.json') },
      { url: '/api/status', headers: { ...HOST } },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET 请求 Host 校验不通过返回 403', async () => {
  const res = await callApi({}, { url: '/api/status', headers: { host: 'evil.example:8262' } });
  assert.equal(res.statusCode, 403);
});

test('changelog-editor 静态响应使用宽松 CSP，面板自身用严格 CSP', async () => {
  const editor = await callApi({}, { url: '/changelog-editor/index.html', headers: { ...HOST } });
  assert.equal(editor.statusCode, 200);
  assert.match(editor.headers['Content-Security-Policy'], /'unsafe-inline'/);
  const panel = await callApi({}, { url: '/', headers: { ...HOST } });
  assert.equal(panel.statusCode, 200);
  assert.doesNotMatch(panel.headers['Content-Security-Policy'], /unsafe-inline/);
  assert.match(panel.headers['Content-Security-Policy'], /script-src 'self'/);
});
