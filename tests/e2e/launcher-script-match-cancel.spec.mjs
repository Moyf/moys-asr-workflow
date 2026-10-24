import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function realMatchBridge(page) {
  const child = spawn(process.env.MAW_E2E_PYTHON || 'python', ['-u', 'tests/helpers/script_match_bridge.py'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pending = new Map();
  let sequence = 0;
  let searchCount = 0;
  let stderr = '';
  let fixturesResolve, fixturesReject;
  const fixturesPromise = new Promise((resolve, reject) => { fixturesResolve = resolve; fixturesReject = reject; });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  child.once('error', fixturesReject);
  child.once('exit', code => {
    const error = new Error(`match bridge exited ${code}: ${stderr}`);
    fixturesReject(error);
    for (const { reject } of pending.values()) reject(error);
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.fixtures) fixturesResolve(message.fixtures);
    else if (message.searchStarted) searchCount += 1;
    else if (message.event) page.evaluate(event => window.MAWLauncher.onBackendEvents([event]), message.event).catch(() => {});
    else if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    }
  });
  function call(method, payload) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, payload }) + '\n');
    });
  }
  await page.exposeFunction('__realMatchCall', call);
  const fixtures = await fixturesPromise;
  return {
    fixtures, call, searchCount: () => searchCount,
    async stop() {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end(JSON.stringify({ method: 'shutdown', payload: {} }) + '\n');
      const timer = setTimeout(() => child.kill(), 5000);
      try { await exited; } finally { clearTimeout(timer); lines.close(); }
    },
  };
}

for (const group of ['plain', 'timed']) {
  test(`ordinary ${group} matching stops real computation without outputs and restarts`, async ({ page }) => {
    await page.goto(`file://${path.join(root, 'web/launcher/index.html')}`);
    await completeStaticLauncherDiscovery(page);
    await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
    const backend = await realMatchBridge(page);
    try {
      await page.evaluate(() => {
        const original = window.MAWLauncher.callBackend;
        window.__matchCalls = [];
        window.MAWLauncher.callBackend = (method, payload) => {
          if (['run_script_match', 'cancel_postprocess'].includes(method)) {
            window.__matchCalls.push({ method, payload });
            return window.__realMatchCall(method, payload);
          }
          return original(method, payload);
        };
      });
      await page.locator('#toolboxFab').click();
      await page.locator('#toolboxMatchTab').click();
      await expect(page.locator('#postprocessScriptPath')).toBeVisible();
      const [large, small] = backend.fixtures[group];
      await page.locator('#toolboxInputPath').fill(large.projectPath);
      await page.locator('#postprocessScriptPath').fill(large.scriptPath);
      const run = page.locator('#runScriptMatch');
      const stop = page.locator('#stopToolboxPostprocess');
      await run.click();
      await expect.poll(backend.searchCount).toBeGreaterThan(0);
      await expect(stop).toBeVisible();
      await expect(stop).toHaveText('停止字幕处理');
      await expect(stop).toBeEnabled();
      const firstId = await page.evaluate(() => window.__matchCalls[0].payload.operationId);
      expect(firstId).toBeTruthy();
      // The existing flex action row may sit beside or below the status.
      const spacing = await stop.evaluate(element => {
        const row = element.parentElement;
        const text = document.getElementById('toolboxResultText');
        const actions = row.getBoundingClientRect();
        const message = text.getBoundingClientRect();
        return actions.left >= message.right
          ? actions.left - message.right
          : actions.top - message.bottom;
      });
      expect(spacing).toBeGreaterThanOrEqual(8);
      await page.screenshot({ path: test.info().outputPath(`${group}-stop.png`) });
      await stop.click();
      await expect(page.locator('#toolboxResultText')).toHaveText('字幕处理已取消。');
      await expect(run).toBeEnabled();
      await expect(stop).toBeHidden();
      expect((await backend.call('inspect', large)).files).toEqual(['script.txt', 'source.mosp']);
      await page.evaluate(operationId => window.MAWLauncher.onBackendEvents([{ type: 'postprocess_status', key: 'toolbox_status_writing', operationId }]), firstId);
      await expect(page.locator('#toolboxResultText')).toHaveText('字幕处理已取消。');
      await page.locator('#toolboxInputPath').fill(small.projectPath);
      await page.locator('#postprocessScriptPath').fill(small.scriptPath);
      await run.click();
      await expect(run).toBeEnabled();
      await expect(page.locator('.toolbox-chain-item')).toHaveCount(1);
      const ids = await page.evaluate(() => window.__matchCalls.filter(call => call.method === 'run_script_match').map(call => call.payload.operationId));
      expect(ids).toHaveLength(2);
      expect(ids[1]).not.toBe(ids[0]);
      expect((await backend.call('inspect', small)).files.length).toBeGreaterThan(2);
    } finally {
      await backend.stop();
    }
  });
}
