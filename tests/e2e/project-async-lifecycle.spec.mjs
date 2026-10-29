import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, makeTempDir, startServer } from './helpers.mjs';
import { createUtilsModule } from '../../web/shared/utils/project-tracks.js';

const { importProject, getMainTrack } = createUtilsModule();

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let dir, server, aPath, bPath;
test.beforeEach(async ({ page }) => {
  dir = makeTempDir('project-async-lifecycle');
  aPath = join(dir, 'a.mosp'); bPath = join(dir, 'b.mosp');
  for (const name of ['a', 'b']) {
    const media = join(dir, `${name}.wav`);
    generateWav(media, 2);
    writeFileSync(join(dir, `${name}.mosp`), JSON.stringify(importProject({ media,
      segments: [{ id: name, start: 0, end: 1000, text: `project ${name}` }],
    }).project), 'utf8');
  }
  server = await startServer(aPath, join(dir, 'a.wav'), await findFreePort());
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#cues-container')).toBeVisible();
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false }));
});

test('stale attach success cannot reload a newer portable project', async ({ page }) => {
  const seen = deferred(), release = deferred();
  await page.route('**/api/project/attach', async route => {
    const response = await route.fetch();
    seen.resolve();
    await release.promise;
    await route.fulfill({response});
  });
  const text = readFileSync(bPath, 'utf8');
  await page.evaluate(text => {
    window.pendingOpen = MaweMultiImport.openProjectFile(new File([text], 'b.mosp'));
  }, text);
  await seen.promise;
  await page.evaluate(() => MaweProjectLoad.applyCanonicalProject({segments: [{start: 0, end: 1000, text: 'new portable'}]}, 'portable.mosp'));
  expect(await page.evaluate(() => window.pendingOpen)).toBe(false);
  await expect(page.locator('#editor-loading')).toBeHidden();
  release.resolve();
  expect(await page.evaluate(() => window.pendingOpen)).toBe(false);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('new portable');
  expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canSave)).toBe(false);
});

for (const kind of ['attach', 'recent']) {
  test(`local portable open invalidates an older ${kind} before the server can publish it`, async ({ page }) => {
    const binding = await page.evaluate(() => ({
      bindingGeneration: MaweBoot.SERVER_CONFIG.bindingGeneration,
      sourceMediaId: MaweBoot.SERVER_CONFIG.sourceMediaId,
      requestToken: MaweBoot.SERVER_CONFIG.requestToken,
    }));
    const before = [readFileSync(aPath, 'utf8'), readFileSync(bPath, 'utf8')];
    const seen = deferred(), release = deferred(), finished = deferred();
    const endpoint = kind === 'attach' ? '/api/project/attach' : '/api/recent-projects/open';
    await page.route(`**${endpoint}`, async route => {
      seen.resolve();
      await release.promise;
      const response = await route.fetch();
      finished.resolve(response.status());
      await route.fulfill({ response });
    });
    try {
      if (kind === 'attach') {
        await page.evaluate(text => { window.oldOpen = MaweMultiImport.openProjectFile(new File([text], 'b.mosp')); }, before[1]);
      } else {
        await page.evaluate(path => { window.oldOpen = MaweServerSave.openRecentProject({ path, name: 'a.mosp' }); }, aPath);
      }
      await seen.promise;
      const notified = page.waitForResponse(r => r.url().endsWith('/api/project/switch-intent') && r.status() === 200);
      expect(await page.evaluate(() => MaweMultiImport.openProjectFile(new File([
        JSON.stringify({ segments: [{ start: 0, end: 1000, text: 'portable B' }] }),
      ], 'portable.mosp')))).toBe(true);
      await notified;
      release.resolve();
      expect(await finished.promise).toBe(409);
      await page.evaluate(() => window.oldOpen);
      expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('portable B');
      expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canSave)).toBe(false);
      expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(false);
      const status = await page.request.post(`${server.url}api/project/binding`, { data: { requestToken: binding.requestToken } });
      const result = await status.json();
      expect(result.bindingGeneration).toBe(binding.bindingGeneration);
      expect(result.sourceMediaId).toBe(binding.sourceMediaId);
      expect([readFileSync(aPath, 'utf8'), readFileSync(bPath, 'utf8')]).toEqual(before);
      const reload = page.waitForEvent('load');
      await page.evaluate(text => { void MaweMultiImport.openProjectFile(new File([text], 'a.mosp')); }, before[0]);
      await reload;
      await expect(page.locator('#json-name')).toHaveText('a.mosp');
      await expect(page.locator('#save-project')).toBeEnabled();
    } finally {
      release.resolve();
    }
  });
}

test('failed switch notification keeps the local project exportable without server saving or attach', async ({ page }) => {
  let attaches = 0;
  page.on('request', request => { if (request.url().endsWith('/api/project/attach')) attaches++; });
  await page.route('**/api/project/switch-intent', route => route.abort('failed'));
  expect(await page.evaluate(text => MaweMultiImport.openProjectFile(new File([text], 'b.mosp'), {
    suppressMediaPrompt: true,
  }), readFileSync(bPath, 'utf8'))).toBe(true);
  expect(attaches).toBe(0);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('project b');
  expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canSave)).toBe(false);
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(false);
  const exported = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson({ forFileExport: true })));
  expect(exported.tracks.find(track => track.role === 'main').segments[0].text).toBe('project b');
});

test('a later explicit open recovers after the switch intent was accepted but its response was lost', async ({ page }) => {
  let notifications = 0, attaches = 0;
  page.on('request', request => { if (request.url().endsWith('/api/project/attach')) attaches++; });
  await page.route('**/api/project/switch-intent', async route => {
    notifications++;
    if (notifications > 1) return route.continue();
    expect((await route.fetch()).status()).toBe(200); // Actual server registration.
    await route.abort('failed');
  });
  expect(await page.evaluate(text => MaweMultiImport.openProjectFile(new File([text], 'b.mosp'), {
    suppressMediaPrompt: true,
  }), readFileSync(bPath, 'utf8'))).toBe(true);
  expect(notifications).toBe(1);
  expect(attaches).toBe(0);
  expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canSave)).toBe(false);
  expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(false);
  const reload = page.waitForEvent('load');
  await page.evaluate(text => { void MaweMultiImport.openProjectFile(new File([text], 'a.mosp')); }, readFileSync(aPath, 'utf8'));
  await reload;
  await expect(page.locator('#json-name')).toHaveText('a.mosp');
  await expect(page.locator('#save-project')).toBeEnabled();
  expect(notifications).toBe(2);
  expect(attaches).toBe(1);
});

test('serialized old attach advances transport ownership while only the newer attach may reload', async ({page}) => {
  const seen = deferred(), release = deferred();
  let first = true;
  await page.route('**/api/project/attach', async route => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    seen.resolve();
    await release.promise;
    await route.fulfill({response});
  });
  await page.evaluate(text => {window.oldOpen = MaweMultiImport.openProjectFile(new File([text], 'b.mosp'));}, readFileSync(bPath, 'utf8'));
  await seen.promise;
  await page.evaluate(text => {window.newOpen = MaweMultiImport.openProjectFile(new File([text], 'a.mosp'));}, readFileSync(aPath, 'utf8'));
  const reload = page.waitForEvent('load');
  release.resolve();
  await reload;
  await expect(page.locator('#json-name')).toHaveText('a.mosp');
  await expect(page.locator('#save-project')).toBeEnabled();
});

for (const success of [true, false]) {
  test(`stale recent ${success ? 'success' : 'failure'} cannot reload or warn in a newer project`, async ({page}) => {
    const seen = deferred(), release = deferred();
    await page.route('**/api/recent-projects/open', async route => {
      const response = success ? await route.fetch() : null;
      seen.resolve();
      await release.promise;
      if (response) await route.fulfill({response});
      else await route.fulfill({status: 400, json: {ok: false, missing: true, error: 'old failure'}});
    });
    await page.evaluate(path => {
      window.recentEntry = {path, name: 'a.mosp'};
      window.oldRecent = MaweServerSave.openRecentProject(window.recentEntry);
    }, aPath);
    await seen.promise;
    await page.evaluate(() => MaweProjectLoad.applyCanonicalProject({segments: [{start: 0, end: 1000, text: 'portable'}]}, 'portable.mosp'));
    release.resolve();
    await page.evaluate(() => window.oldRecent);
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe('portable');
    expect(await page.evaluate(() => window.recentEntry.exists)).toBeUndefined();
  });
}

test('a later explicit open recovers after the previous attach committed but its response was lost', async ({ page }) => {
  let first = true;
  await page.route('**/api/project/attach', async route => {
    if (!first) return route.continue();
    first = false;
    expect((await route.fetch()).ok()).toBe(true);
    await route.abort('failed');
  });
  const b = readFileSync(bPath, 'utf8');
  expect(await page.evaluate(text => MaweMultiImport.openProjectFile(new File([text], 'b.mosp'), {suppressMediaPrompt: true}), b)).toBe(true);
  expect(await page.evaluate(() => MaweBoot.SERVER_CONFIG.canSave)).toBe(false);
  const reload = page.waitForEvent('load');
  await page.evaluate(text => { void MaweMultiImport.openProjectFile(new File([text], 'a.mosp')); }, readFileSync(aPath, 'utf8'));
  await reload;
  await expect(page.locator('#json-name')).toHaveText('a.mosp');
  await expect(page.locator('#save-project')).toBeEnabled();
});

for (const replacement of ['project', 'media']) {
  test(`late BWF completion cannot replace newer ${replacement}`, async ({page}) => {
    const bytes = [...readFileSync(join(dir, 'a.wav'))];
    await page.evaluate(bytes => {
      const real = AsrEditorUtils.readBwfTimeReferenceFromFile;
      window.oldBwfEntered = false;
      AsrEditorUtils.readBwfTimeReferenceFromFile = file => file.name === 'old.wav'
        ? new Promise(resolve => { window.oldBwfEntered = true; window.releaseOldBwf = resolve; }) : real(file);
      const revoke = URL.revokeObjectURL.bind(URL);
      window.revoked = [];
      URL.revokeObjectURL = url => {window.revoked.push(url); revoke(url);};
      MaweCoreState.player.volume = 0.37;
      MaweCoreState.player.muted = true;
      MaweCoreState.player.playbackRate = 1.5;
      window.oldMedia = MaweMediaLoad.loadMediaFile(new File([new Uint8Array(bytes)], 'old.wav', {type: 'audio/wav'}));
    }, bytes);
    await expect.poll(() => page.evaluate(() => window.oldBwfEntered)).toBe(true);
    if (replacement === 'project') {
      await page.evaluate(() => MaweProjectLoad.applyCanonicalProject({media: 'new.wav', segments: []}, 'new.mosp'));
    } else {
      expect(await page.evaluate(bytes => MaweMediaLoad.loadMediaFile(new File([new Uint8Array(bytes)], 'new.wav', {type: 'audio/wav'})), bytes)).toBe(true);
      expect(await page.evaluate(() => [MaweCoreState.player.volume, MaweCoreState.player.muted, MaweCoreState.player.playbackRate])).toEqual([0.37, true, 1.5]);
    }
    await page.evaluate(() => window.releaseOldBwf({samples: 99, sample_rate: 8000}));
    expect(await page.evaluate(() => window.oldMedia)).toBe(false);
    expect(await page.evaluate(() => MaweBoot.DATA.media)).toBe('new.wav');
    expect(await page.evaluate(() => MaweBoot.DATA.media_time_reference)).toBeFalsy();
    expect(await page.evaluate(() => window.revoked.length)).toBeGreaterThan(0);
  });
}

test('stale media-plus-subtitle drop cannot continue into a newer project', async ({page}) => {
  await page.evaluate(bytes => {
    MaweProjectLoad.applyCanonicalProject({segments: []}, 'empty.mosp');
    AsrEditorUtils.readBwfTimeReferenceFromFile = () => new Promise(resolve => {window.releaseDropBwf = resolve;});
    window.pendingDrop = MaweDragDrop.handleDroppedFiles([
      new File([new Uint8Array(bytes)], 'old.wav', {type: 'audio/wav'}),
      new File(['1\n00:00:00,000 --> 00:00:00,500\nstale subtitle\n'], 'old.srt'),
    ]);
  }, [...readFileSync(join(dir, 'a.wav'))]);
  await expect.poll(() => page.evaluate(() => Boolean(window.releaseDropBwf))).toBe(true);
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({segments: [{start: 0, end: 1000, text: 'new project'}]}, 'new.mosp');
    window.releaseDropBwf(null);
  });
  await page.evaluate(() => window.pendingDrop);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(cue => cue.text))).toEqual(['new project']);
});

test('late waveform decode and late reapeaks reads cannot publish into a newer project', async ({page}) => {
  await page.evaluate(bytes => {
    MaweCoreState.waveformLoadedFromProject = false;
    MaweCoreState.waveformEditor.setPayload(null);
    window.closedContexts = 0;
    window.AudioContext = class {
      async decodeAudioData() {
        return new Promise(resolve => {window.releaseDecode = () => resolve({
          numberOfChannels: 1, sampleRate: 8000, length: 8000, duration: 1,
          getChannelData: () => new Float32Array(8000),
        });});
      }
      async close() { window.closedContexts++; }
    };
    window.pendingWaveMedia = MaweMediaLoad.loadMediaFile(new File([new Uint8Array(bytes)], 'wave.wav', {type: 'audio/wav'}));
  }, [...readFileSync(join(dir, 'a.wav'))]);
  await expect.poll(() => page.evaluate(() => Boolean(window.releaseDecode))).toBe(true);
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
  await page.evaluate(async () => {
    await MaweMediaLoad.loadReapeaksFile({name: 'cache.ReaPeaks', size: 1, arrayBuffer: async () => new ArrayBuffer(1)});
  });
  expect(await page.evaluate(() => window.pendingWaveMedia)).toBe(false);
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
  await page.evaluate(() => {
    MaweProjectLoad.applyCanonicalProject({segments: [{start: 0, end: 1000, text: 'new waveform owner'}]}, 'new.mosp');
    window.releaseDecode();
  });
  expect(await page.evaluate(() => window.pendingWaveMedia)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.closedContexts)).toBe(1);
  expect(await page.evaluate(() => MaweBoot.DATA.waveform)).toBeFalsy();
  const stale = await page.evaluate(async () => {
    const file = {name: 'old.ReaPeaks', size: 1, arrayBuffer: () => new Promise(resolve => {window.releasePeaks = resolve;})};
    const pending = MaweMediaLoad.loadReapeaksFile(file);
    MaweProjectLoad.applyCanonicalProject({segments: []}, 'next.mosp');
    const result = await pending;
    window.releasePeaks(new ArrayBuffer(1));
    return {result, wave: MaweBoot.DATA.waveform_reapeaks};
  });
  expect(stale.result).toBe(false);
  expect(stale.wave).toBeFalsy();
});
test.afterEach(async () => { await server?.stop(); cleanupTempDir(dir); });

test('pending project attach cannot save new content into the previous file', async ({ page }) => {
  const seen = deferred(), release = deferred();
  const originalA = readFileSync(aPath, 'utf8'), originalB = readFileSync(bPath, 'utf8');
  await page.route('**/api/project/attach', async route => {
    seen.resolve();
    await release.promise;
    await route.fulfill({ status: 409, json: { ok: false, error: 'controlled attach rejection' } });
  });
  try {
    await page.evaluate(text => {
      window.pendingOpen = MaweMultiImport.openProjectFile(new File([text], 'b.mosp', { type: 'application/json' }), { suppressMediaPrompt: true });
    }, originalB);
    await seen.promise;
    const saving = await page.evaluate(async () => ({
      visible: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text,
      canSave: MaweBoot.SERVER_CONFIG.canSave,
      saved: await MaweProjectSave.saveCurrentProject(),
      mediaRejected: await MaweMediaLoad.loadMediaFile(new File([], 'pending.wav', {type: 'audio/wav'})) === false,
      reapeaksRejected: await MaweMediaLoad.loadReapeaksFile({name: 'pending.ReaPeaks', arrayBuffer() {throw new Error('must not read');}}) === false,
    }));
    const after = readFileSync(aPath, 'utf8');
    mkdirSync('.artifacts/async-lifecycle-20261015', { recursive: true });
    writeFileSync('.artifacts/async-lifecycle-20261015/pending-attach-evidence.json', JSON.stringify({
      upstreamBase: 'de97872103d31a1691171d653b6c72ea2d1f8223', phase: 'fixed', ...saving,
      before: getMainTrack(JSON.parse(originalA)).segments[0].text, after: getMainTrack(JSON.parse(after)).segments[0].text,
      oldFileUnchanged: after === originalA, newFileUnchanged: readFileSync(bPath, 'utf8') === originalB,
    }, null, 2));
    expect(saving.visible).toBe('project b');
    expect(saving.canSave).toBe(false);
    expect(saving.saved).toBe(false);
    expect(saving.mediaRejected).toBe(true);
    expect(saving.reapeaksRejected).toBe(true);
    expect(after, 'the previous disk project must not receive the newly opened project').toBe(originalA);
  } finally {
    release.resolve();
    await page.evaluate(() => window.pendingOpen);
  }
});
