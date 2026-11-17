import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// An isolated old-workflow negative control must not overwrite another WIP.
const workflow = readFileSync(process.env.MAW_COMMENT_WORKFLOW || '.github/workflows/pr-release-comment.yml', 'utf8');
const script = workflow.split('          script: |\n')[1]
  .split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
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
  const api = (name, value) => async args => { calls.push([name, args]); return { data: value }; };
  const github = { rest: {
    pulls: { get: async args => {
      const currentHead = calls.some(([name]) => name === 'getPR') ? nextHead : head;
      calls.push(['getPR', args]);
      return { data: { number: 7, state, head: { sha: currentHead } } };
    } },
    repos: { listPullRequestsAssociatedWithCommit: api('associated', [{ number: 7, state: 'open' }]) },
    actions: { listJobsForWorkflowRun: 'jobs' },
    issues: {
      listComments: 'comments',
      createComment: async args => writes.push(['create', args]),
      updateComment: async args => writes.push(['update', args]),
    },
  }, paginate: async method => method === 'jobs' ? jobs : comments };
  const context = { repo: { owner: 'test', repo: 'demo' }, payload: { workflow_run: {
    id: 200, run_attempt: 1, conclusion, head_sha: sha, pull_requests: associated ? [] : [{ number: 7 }],
    html_url: 'https://github.com/test/demo/actions/runs/200', updated_at: '2026-11-17T00:00:00Z', ...run,
  } } };
  await vm.runInNewContext(`(async () => {\n${script}\n})()`, { github, context, core: { info() {} } }, { timeout: 1000 });
  return { writes, body: writes[0]?.[1].body || '' };
}

test('scope skip covers non-packaging code without claiming full tests passed', async () => {
  const { body } = await execute({ jobs: [{ name: 'Advisory Windows x64 MAW-lite preview', conclusion: 'skipped' }] });
  assert.match(body, /本次未构建/);
  assert.match(body, /打包.*启动.*runtime/);
  assert.match(body, /不表示测试全部通过/);
  assert.match(body, /辅助.*Change acceptance/);
});

test('legacy in-job skip remains supported', async () => {
  const { body } = await execute({ jobs: [{ name: 'Build Windows x64 MAW-lite preview', conclusion: 'success', steps: [
    { name: 'Build MAW bundle', conclusion: 'skipped' }, { name: 'Upload MAW-lite release preview', conclusion: 'skipped' },
  ] }] });
  assert.match(body, /本次未构建/);
});

test('cancelled has its own status', async () => {
  assert.match((await execute({ conclusion: 'cancelled' })).body, /已取消/);
});

test('archive and upload survive unrelated workflow failure and job rename', async () => {
  const { body } = await execute({ conclusion: 'failure', jobs: [{ name: 'renamed', conclusion: 'failure', steps: steps() }] });
  assert.match(body, /测试包已经生成/);
  assert.match(body, /下载 Windows/);
  assert.match(body, /异常.*review/);
});

test('failed upload or archive and ambiguous jobs cannot advertise a package', async () => {
  for (const jobs of [[{ name: 'renamed', steps: steps('success', 'failure') }],
    [{ name: 'one', steps: steps('failure', 'success') }],
    [{ name: 'one', steps: steps() }, { name: 'two', steps: steps() }]]) {
    assert.doesNotMatch((await execute({ conclusion: 'failure', jobs })).body, /测试包已经生成|下载 Windows/);
  }
});

test('old head, closed PR or changed head during API reads cannot write', async () => {
  for (const options of [{ head: 'b'.repeat(40) }, { state: 'closed' }, { nextHead: 'b'.repeat(40) }]) {
    assert.equal((await execute(options)).writes.length, 0);
  }
});

test('same-head older run or attempt cannot overwrite newer metadata', async () => {
  for (const [id, attempt] of [[201, 1], [200, 2]]) {
    const { writes } = await execute({ comments: [{ id: 1, user: { type: 'Bot' },
      body: `${marker}\n<!-- maw-preview-run: ${sha} ${id} ${attempt} -->` }] });
    assert.equal(writes.length, 0);
  }
});

test('only bot marker is updated and metadata is written', async () => {
  const { writes, body } = await execute({ associated: true, comments: [{ id: 1, user: { type: 'User' }, body: marker }] });
  assert.equal(writes[0][0], 'create');
  assert.match(body, new RegExp(`maw-preview-run: ${sha} 200 1`));
  assert.equal((await execute({ comments: [{ id: 1, user: { type: 'Bot' }, body: marker }] })).writes[0][0], 'update');
});
