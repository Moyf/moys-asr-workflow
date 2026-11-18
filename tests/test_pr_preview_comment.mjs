import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Override only for the old-script negative control, without touching WIP.
const workflow = readFileSync(process.env.MAW_COMMENT_WORKFLOW || '.github/workflows/pr-release-comment.yml', 'utf8');
const script = workflow.split('          script: |\n')[1]
  .split('\n').map((line) => line.replace(/^ {12}/, '')).join('\n');
const sha = 'a'.repeat(40);
const marker = '<!-- maw-windows-pr-release -->';
const steps = (archive = 'success', upload = 'success') => [
  { name: 'Build MAW bundle', conclusion: 'success' },
  { name: 'Create MAW-lite release preview archive', conclusion: archive },
  { name: 'Upload MAW-lite release preview', conclusion: upload },
];

async function execute({ conclusion = 'success', jobs = [], head = sha, comments = [], run = {}, associated = false, state = 'open', nextHead = head } = {}) {
  const writes = [];
  const calls = [];
  const api = (name, value) => async (args) => { calls.push([name, args]); return { data: value }; };
  const github = { rest: {
    pulls: { get: async (args) => {
      const currentHead = calls.some(([name]) => name === 'getPR') ? nextHead : head;
      calls.push(['getPR', args]);
      return { data: { number: 7, state, head: { sha: currentHead } } };
    } },
    repos: { listPullRequestsAssociatedWithCommit: api('associated', [{ number: 7, state: 'open' }]) },
    actions: { listJobsForWorkflowRun: 'jobs' },
    issues: {
      listComments: 'comments',
      createComment: async (args) => writes.push(['create', args]),
      updateComment: async (args) => writes.push(['update', args]),
    },
  }, paginate: async (method) => method === 'jobs' ? jobs : comments };
  const context = { repo: { owner: 'test', repo: 'demo' }, payload: { workflow_run: {
    id: 200, run_attempt: 1, conclusion, head_sha: sha, pull_requests: associated ? [] : [{ number: 7 }],
    html_url: 'https://github.com/test/demo/actions/runs/200', updated_at: '2026-11-17T00:00:00Z', ...run,
  } } };
  await vm.runInNewContext(`(async () => {\n${script}\n})()`, { github, context, core: { info() {} } }, { timeout: 1000 });
  return { writes, calls, body: writes[0]?.[1].body || '' };
}

test('scope skip covers non-packaging code without claiming full tests passed', async () => {
  const { body } = await execute({ jobs: [{ name: 'Advisory Windows x64 MAW-lite preview', conclusion: 'skipped' }] });
  assert.match(body, /本次未构建/);
  assert.match(body, /打包.*启动.*runtime/);
  assert.doesNotMatch(body, /文档或网站/);
  assert.match(body, /不表示测试全部通过/);
  assert.match(body, /辅助.*Change acceptance/);
});

test('legacy in-job scope skip remains supported', async () => {
  const { body } = await execute({ jobs: [{ name: 'Build Windows x64 MAW-lite preview', conclusion: 'success', steps: [
    { name: 'Build MAW bundle', conclusion: 'skipped' },
    { name: 'Upload MAW-lite release preview', conclusion: 'skipped' },
  ] }] });
  assert.match(body, /本次未构建/);
});

test('cancelled has its own status and no false failure claim', async () => {
  const { body } = await execute({ conclusion: 'cancelled' });
  assert.match(body, /已取消/);
  assert.doesNotMatch(body, /打包失败/);
});

test('archive and upload success survives unrelated workflow failure and job rename', async () => {
  const { body } = await execute({ conclusion: 'failure', jobs: [{ name: 'renamed preview job', conclusion: 'failure', steps: steps() }] });
  assert.match(body, /测试包已经生成/);
  assert.match(body, /下载 Windows/);
  assert.match(body, /异常.*review/);
  assert.doesNotMatch(body, /没有生成/);
});

test('upload failure does not advertise a downloadable package', async () => {
  const { body } = await execute({ conclusion: 'failure', jobs: [{ name: 'renamed', steps: steps('success', 'failure') }] });
  assert.doesNotMatch(body, /测试包已经生成|下载 Windows/);
  assert.match(body, /未确认.*上传/);
});

test('old head cannot create or overwrite a comment', async () => {
  for (const comments of [[], [{ id: 1, user: { type: 'Bot' }, body: marker }]]) {
    const { writes } = await execute({ head: 'b'.repeat(40), comments });
    assert.equal(writes.length, 0);
  }
});

test('same-head older run or attempt cannot overwrite newer bot metadata', async () => {
  for (const [id, attempt] of [[201, 1], [200, 2]]) {
    const { writes } = await execute({ comments: [{ id: 1, user: { type: 'Bot' },
      body: `${marker}\n<!-- maw-preview-run: ${sha} ${id} ${attempt} -->` }] });
    assert.equal(writes.length, 0);
  }
});

test('only bot-owned marker can be updated; current run metadata is written', async () => {
  const { writes, body } = await execute({ associated: true, comments: [{ id: 1, user: { type: 'User' }, body: marker }] });
  assert.equal(writes[0][0], 'create');
  assert.match(body, new RegExp(`maw-preview-run: ${sha} 200 1`));
});

test('current run updates legacy bot marker', async () => {
  const { writes } = await execute({ comments: [{ id: 1, user: { type: 'Bot' }, body: marker }] });
  assert.equal(writes[0][0], 'update');
});

test('closed PR or head updated during API reads cannot get a comment', async () => {
  assert.equal((await execute({ state: 'closed' })).writes.length, 0);
  assert.equal((await execute({ nextHead: 'b'.repeat(40) })).writes.length, 0);
});

test('cancelled run can still report a successfully uploaded package', async () => {
  const { body } = await execute({ conclusion: 'cancelled', jobs: [{ name: 'renamed', steps: steps() }] });
  assert.match(body, /已取消/);
  assert.match(body, /测试包已经生成/);
});

test('ambiguous upload jobs or unsuccessful archive cannot claim a package', async () => {
  for (const jobs of [
    [{ name: 'one', steps: steps() }, { name: 'two', steps: steps() }],
    [{ name: 'one', steps: steps('failure', 'success') }],
  ]) {
    assert.doesNotMatch((await execute({ jobs })).body, /测试包已经生成|下载 Windows/);
  }
});
