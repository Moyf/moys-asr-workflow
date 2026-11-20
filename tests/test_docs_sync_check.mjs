import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readDocument, readImage } from '../website/scripts/sync-maw-docs.mjs';

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maw-docs-sync-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('# 远端内容\n', { status: 200 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('check mode refuses to read a missing source document from GitHub', async () => {
  const { calls, restore } = stubFetch();
  try {
    await withTempRoot(async (root) => {
      await assert.rejects(
        () => readDocument('docs/user/FAQ.md', { root, allowRemote: false }),
        /本地缺少源文档 docs\/user\/FAQ\.md/,
      );
    });
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('check mode refuses to read a missing image from GitHub', async () => {
  const { calls, restore } = stubFetch();
  try {
    await withTempRoot(async (root) => {
      await assert.rejects(
        () => readImage('docs/assets/readme/overview.webp', { root, allowRemote: false }),
        /本地缺少配图 docs\/assets\/readme\/overview\.webp/,
      );
    });
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('sync mode still falls back to GitHub when the local source is missing', async () => {
  const { calls, restore } = stubFetch();
  try {
    await withTempRoot(async (root) => {
      const text = await readDocument('docs/user/FAQ.md', { root });
      assert.match(text, /远端内容/);
    });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('local sources win over the network', async () => {
  const { calls, restore } = stubFetch();
  try {
    await withTempRoot(async (root) => {
      await mkdir(path.join(root, 'docs', 'user'), { recursive: true });
      await writeFile(path.join(root, 'docs', 'user', 'FAQ.md'), '# 本地\n', 'utf8');
      assert.equal(await readDocument('docs/user/FAQ.md', { root, allowRemote: false }), '# 本地\n');
    });
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});
