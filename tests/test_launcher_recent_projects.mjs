import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const source = name => readFileSync(new URL(`../web/launcher/${name}`, import.meta.url), 'utf8');

test('recent list refresh waits for project readiness, repeats after restart and retries a failed read', async () => {
  let reads = 0;
  let ok = true;
  const context = vm.createContext({
    serverStatusMonitorState: 'connected', serverStatusMonitorFailureCount: 0,
    SERVER_STATUS_MONITOR_FAILURE_THRESHOLD: 2,
    loadRecentProjects: async () => { reads++; return {ok}; },
  });
  vm.runInContext(source('server/launcher-server-monitor.js'), context);
  const healthy = status => vm.runInContext(`handleServerStatusMonitorHealthy({url: 'http://127.0.0.1:8250/', pid: 123, startupStatus: '${status}'})`, context);
  healthy('loading');
  healthy('loading');
  assert.equal(reads, 0);
  healthy('ready');
  await Promise.resolve();
  healthy('ready');
  assert.equal(reads, 1, 'healthy heartbeats must not rebuild the list repeatedly');
  healthy('loading');
  ok = false;
  healthy('ready');
  await Promise.resolve();
  ok = true;
  healthy('ready');
  await Promise.resolve();
  assert.equal(reads, 3);
});

test('older recent-list responses cannot overwrite a newer refresh; bridge failures are contained', async () => {
  const pending = [];
  const rendered = [];
  const context = vm.createContext({bridge: () => new Promise((resolve, reject) => pending.push({resolve, reject}))});
  vm.runInContext(source('server/launcher-media-server.js'), context);
  context.renderRecentProjects = projects => rendered.push(projects[0]?.name);
  const first = vm.runInContext('loadRecentProjects()', context);
  const second = vm.runInContext('loadRecentProjects()', context);
  pending[1].resolve({ok: true, projects: [{name: 'new'}]});
  await second;
  pending[0].resolve({ok: true, projects: [{name: 'old'}]});
  await first;
  assert.deepEqual(rendered, ['new']);
  const failed = vm.runInContext('loadRecentProjects()', context);
  pending[2].reject(new Error('bridge unavailable'));
  assert.equal((await failed).ok, false);
});
