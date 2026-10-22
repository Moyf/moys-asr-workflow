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
