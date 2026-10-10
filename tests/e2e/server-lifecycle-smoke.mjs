// Optional source-server smoke: set MAW_E2E_PYTHON to an existing project venv.
// No Playwright/browser, environment synchronization, or editor regeneration.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { startBlankServer, findFreePort, makeTempDir } from './helpers.mjs';
import { startScrollFixture } from './cue-scroll-fixture.mjs';

async function assertPortFree(url) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(new URL(url).port), '127.0.0.1', resolve);
  });
  await new Promise(resolve => server.close(resolve));
}

if (!process.env.MAW_E2E_PYTHON) throw new Error('Set MAW_E2E_PYTHON to an existing project interpreter');
const timeout = setTimeout(() => { console.error('Source lifecycle smoke exceeded 90s'); process.exit(1); }, 90000);
try {
  for (const [name, launch] of [
    ['blank helper', async () => startBlankServer(await findFreePort(), makeTempDir('lifecycle-smoke'))],
    ['scroll fixture', () => startScrollFixture({ count: 1 })],
  ]) {
    const service = await launch();
    try {
      const response = await fetch(`${service.url}api/startup-status`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.ok, true);
      assert.equal((await response.json()).status, 'ready');
    } finally { await service.stop(); }
    await service.stop();
    await assertPortFree(service.url);
    console.log(`PASS ${name}: ready, stopped twice, port released`);
  }
} finally { clearTimeout(timeout); }
