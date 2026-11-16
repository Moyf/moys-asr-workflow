import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectModel, runtimeProject } from '../helpers/runtime-project.mjs';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav,
  generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let directory, server, projectPath;
const cue = (id, text, speaker, start, end) => ({ id, text, speaker, start, end,
  items: [{ text, start, end }], extension: { keep: id } });
function boundProject(scale = 1, farShort = false) {
  const main = [cue('m0', 'Main zero', 'a', 0, 1000), cue('m1', 'Main one', 'a', 1000, 2000),
    cue('m2', 'Unselected main', 'b', 2000, 3000)];
  const secondary = [cue('s0', 'Secondary zero', 'a', 0, 1000), cue('s1', 'Secondary one', 'a', 1000, 1500),
    cue('s2', 'Foreign secondary', 'b', 1500, 3000)];
  if (farShort) {
    secondary[1].end = secondary[1].items[0].end = 2000;
    secondary[2].start = secondary[2].items[0].start = 2500;
    secondary[2].end = secondary[2].items[0].end = 2515;
  }
  for (const segment of [...main, ...secondary]) {
    segment.start *= scale; segment.end *= scale;
    for (const item of segment.items) { item.start *= scale; item.end *= scale; }
  }
  const project = runtimeProject(main, { extensions: [{ id: 'main-after-swap', segments: secondary }],
    speakers: [{ id: 'a', name: 'A', color: '#ff0000' }, { id: 'b', name: 'B', color: '#0000ff' }],
    annotation_mode: 'speaker', palette_size: 5, speaker_shortcuts: {},
  });
  project.tracks[0].id = 'translation-after-swap';
  project.bindings = main.map((segment, i) => ({ id: `binding-${i}`,
    source: { track_id: project.tracks[0].id, segment_id: segment.id },
    target: { track_id: project.tracks[1].id, segment_id: secondary[i].id },
    start_offset_ms: secondary[i].start - segment.start, end_offset_ms: secondary[i].end - segment.end,
    extension: { keep: i } }));
  return project;
}

async function openFixture(page, project) {
  directory = makeTempDir('review-data-safety');
  projectPath = join(directory, 'a.mosp');
  const media = join(directory, 'source.wav');
  generateWav(media, 4);
  const initial = projectModel.importProject({ ...project, media, waveform: generateWaveformPayload(4000) }).project;
  expect(projectModel.validateTracksProject(initial).ok).toBe(true);
  writeFileSync(projectPath, JSON.stringify(initial), 'utf8');
  server = await startServer(projectPath, media, await findFreePort());
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(server.url);
  await expect(page.locator('#cues-container')).toBeVisible();
}
test.afterEach(async () => {
  await server?.stop(); server = null;
  if (directory) cleanupTempDir(directory);
  directory = null;
});

const protectedContent = project => ({
  main: project.tracks.find(track => track.role === 'main').segments.find(cue => cue.id === 'm2'),
  secondary: project.tracks.find(track => track.role === 'secondary').segments.find(cue => cue.id === 's2'),
  binding: project.bindings.find(binding => binding.id === 'binding-2'),
});
async function content(page) {
  return page.evaluate(() => AsrEditorUtils.snapshotProjectContent(MaweBoot.DATA));
}

test('held-boundary save matches normal release for bound tracks and undo', async ({ page }) => {
  const project = boundProject();
  const thirdMain = projectModel.getMainTrack(project).segments[2];
  thirdMain.start = thirdMain.items[0].start = 2400;
  thirdMain.end = thirdMain.items[0].end = 3400;
  const thirdBinding = project.bindings.find(binding => binding.id === 'binding-2');
  thirdBinding.start_offset_ms = 1500 - thirdMain.start;
  thirdBinding.end_offset_ms = 3000 - thirdMain.end;
  await openFixture(page, project);
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false, cueMoveStepMs: 100 }));
  const rangesAndBindings = async () => {
    const project = await content(page);
    return {
      tracks: project.tracks.map(track => ({ id: track.id, segments: track.segments.map(({id, start, end}) => ({id, start, end})) })),
      bindings: project.bindings,
    };
  };
  const hold = async () => {
    const boundary = page.locator('.waveform-cue-boundary[data-track="main"][data-left-idx="0"]').first();
    await expect(boundary).toBeVisible();
    const box = await boundary.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.keyboard.press('d');
  };
  const initial = await rangesAndBindings();
  await hold();
  await page.mouse.up();
  const normalRelease = await rangesAndBindings();
  expect(normalRelease.tracks.find(track => track.id === 'translation-after-swap').segments[0].end).toBe(1100);
  await page.reload();
  await expect(page.locator('#cues-container')).toBeVisible();
  await page.evaluate(() => MaweSettings.updateEditorSettings({ autoSaveProject: false, cueMoveStepMs: 100 }));
  expect(await rangesAndBindings()).toEqual(initial);
  const before = await page.evaluate(() => MaweHistory.editorHistory.undoLength());
  await hold();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/project')
    && response.request().method() === 'POST');
  await page.keyboard.press('Control+s');
  expect((await saved).ok()).toBe(true);
  expect(await page.evaluate(() => Boolean(MaweCoreState.waveformEditor.drag))).toBe(false);
  expect(await rangesAndBindings()).toEqual(normalRelease);
  expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(before + 1);
  await page.mouse.up();
  const savedProject = JSON.parse(readFileSync(projectPath, 'utf8'));
  expect(projectModel.validateTracksProject(savedProject).ok).toBe(true);
  expect(savedProject.tracks.map(track => ({id: track.id, segments: track.segments.map(({id, start, end}) => ({id, start, end}))}))).toEqual(normalRelease.tracks);
  expect(savedProject.bindings).toEqual(normalRelease.bindings);
  await page.keyboard.press('Control+z');
  await expect.poll(rangesAndBindings).toEqual(initial);
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.locator('#cues-container')).toBeVisible();
  expect(await rangesAndBindings()).toEqual(normalRelease);
});

for (const { syncDuration, scale, farShort = false } of [{ syncDuration: false, scale: 1 }, { syncDuration: true, scale: 1 },
  { syncDuration: true, scale: .01 }, { syncDuration: true, scale: 1, farShort: true }]) {
  test(`main merge preserves unselected bound secondary through undo and real save, sync=${syncDuration}, scale=${scale}, far-short=${farShort}`, async ({ page }) => {
    await openFixture(page, boundProject(scale, farShort));
    await page.evaluate(value => MaweSettings.updateEditorSettings({ multiSubtitleAutoSyncDuration: value }), syncDuration);
    const before = protectedContent(await content(page));
    expect(before.secondary.start).toBe((farShort ? 2500 : 1500) * scale);
    await page.locator('.multi-dual-cue[data-main-idx="0"] .multi-cue-column.main .text').click();
    await page.locator('.multi-dual-cue[data-main-idx="1"] .multi-cue-column.main .text').click({ modifiers: ['ControlOrMeta'] });
    await page.keyboard.press('c');
    await expect.poll(async () => projectModel.getMainTrack(await content(page)).segments.length).toBe(2);
    expect(protectedContent(await content(page))).toEqual(before);
    expect((await content(page)).tracks.find(track => track.role === 'secondary').segments.map(cue => cue.id)).toEqual(['s0', 's2']);
    await page.keyboard.press('ControlOrMeta+z');
    expect(projectModel.getMainTrack(await content(page)).segments).toHaveLength(3);
    expect(protectedContent(await content(page))).toEqual(before);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(projectModel.getMainTrack(await content(page)).segments).toHaveLength(2);
    expect(protectedContent(await content(page))).toEqual(before);
    expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
    const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
    expect(projectModel.validateTracksProject(saved).ok).toBe(true);
    expect(protectedContent(saved)).toEqual(before);
    await page.reload();
    await expect(page.locator('#cues-container')).toBeVisible();
    expect(protectedContent(await content(page))).toEqual(before);
  });
}

for (const kind of ['cue', 'word']) for (const entry of ['keyboard', 'drop']) {
  test(`old ${kind} quick edit cannot write into a same-ID project opened by ${entry} after attach failure`, async ({ page }) => {
    const legacy = text => ({ segments: [{ start: 0, end: 1000, text, items: [{ start: 0, end: 1000, text }] }] });
    const a = projectModel.importProject(legacy('PROJECT A')).project;
    const b = projectModel.importProject(legacy('PROJECT B')).project;
    expect(projectModel.getMainTrack(a).segments[0].id).toBe(projectModel.getMainTrack(b).segments[0].id);
    await openFixture(page, a);
    const bPath = join(directory, 'b.mosp');
    const bText = JSON.stringify({ ...b, media: join(directory, 'source.wav'), waveform: generateWaveformPayload(4000) });
    writeFileSync(bPath, bText, 'utf8');
    const originalA = readFileSync(projectPath, 'utf8');
    await page.route('**/api/project/attach', route => route.fulfill({ status: 400,
      json: { ok: false, error: 'fixture attach rejected' } }));
    if (kind === 'word') await page.evaluate(() => MaweWordTiming.setEnabled(true));
    await page.evaluate(() => { MaweCoreState.waveformEditor.scroll.scrollTop = 0; MaweState.establishProjectCheckpoint(); });
    const block = page.locator(kind === 'word' ? '.waveform-word-block[data-segment-idx="0"][data-item-idx="0"]'
      : '.waveform-cue-block[data-track="main"][data-idx="0"]').first();
    await block.dblclick();
    await expect(page.locator('.waveform-cue-quick-edit textarea')).toHaveValue('PROJECT A');
    await page.evaluate(() => {
      const state = MaweCoreState.waveformEditor.cueQuickEdit;
      window.reviewOldState = state;
      window.reviewOldCommit = state.commit;
      window.reviewOldNavigate = state.navigate;
      window.reviewOldPending = state.hasUncommittedText;
      window.reviewOldProjectObject = MaweBoot.DATA;
    });
    // Keyboard focus transfer leaves the popup open without a pointerdown.
    await page.locator('#open-project').focus();
    await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(1);
    const attach = page.waitForResponse(response => response.url().endsWith('/api/project/attach'));
    if (entry === 'keyboard') {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#open-project').press('Space');
      await (await chooser).setFiles({ name: 'b.mosp', mimeType: 'application/json', buffer: Buffer.from(bText) });
    } else {
      const transfer = await page.evaluateHandle(text => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([text], 'b.mosp', { type: 'application/json' }));
        return transfer;
      }, bText);
      await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });
      await transfer.dispose();
      await expect(page.locator('#multi-subtitle-import-modal')).toHaveClass(/show/);
      await page.locator('#multi-subtitle-import-replace').press('Space');
      await page.locator('#multi-subtitle-import-result-confirm').press('Space');
    }
    expect((await attach).status()).toBe(400);
    await expect(page.locator('#json-name')).toHaveText('b.mosp');
    const state = await page.evaluate(() => {
      const committed = window.reviewOldCommit(window.reviewOldState);
      window.reviewOldNavigate?.(window.reviewOldState, 1);
      return { committed, sameObject: window.reviewOldProjectObject === MaweBoot.DATA,
        text: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text,
        pending: window.reviewOldPending?.(window.reviewOldState) || false };
    });
    expect(state.text).toBe('PROJECT B');
    expect(state.sameObject).toBe(true);
    expect(state.committed).toBe(false);
    expect(state.pending).toBe(false);
    await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(0);
    expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(false);
    expect(readFileSync(projectPath, 'utf8')).toBe(originalA);
    expect(readFileSync(bPath, 'utf8')).toBe(bText);
    expect(projectModel.getMainTrack(await content(page)).segments[0].text).toBe('PROJECT B');
  });
}

for (const kind of ['cue', 'word']) {
  test(`deferred ${kind} popup request does not open in a replacement project`, async ({ page }) => {
    await openFixture(page, { segments: [{ start: 0, end: 1000, text: 'PROJECT A', items: [{ start: 0, end: 1000, text: 'PROJECT A' }] }] });
    if (kind === 'word') await page.evaluate(() => MaweWordTiming.setEnabled(true));
    const result = await page.evaluate(kind => {
      const waveform = MaweCoreState.waveformEditor;
      const method = kind === 'word' ? 'firstVisibleWordBlock' : 'firstVisibleCueBlock';
      const originalFind = waveform[method], originalFrame = window.requestAnimationFrame;
      const frames = [];
      window.reviewFallbackCount = 0;
      waveform[method] = () => null;
      window.requestAnimationFrame = callback => { frames.push(callback); return 1; };
      try {
        if (kind === 'word') waveform.openWordQuickEditAtIndex(0, 0, () => window.reviewFallbackCount++);
        else waveform.openCueQuickEditAtIndex('main', 0, () => window.reviewFallbackCount++);
      } finally {
        waveform[method] = originalFind;
        window.requestAnimationFrame = originalFrame;
      }
      const original = MaweBoot.DATA;
      const payload = MaweBoot.DATA.waveform;
      MaweProjectLoad.applyCanonicalProject({ segments: [{ start: 0, end: 1000, text: 'PROJECT B',
        items: [{ start: 0, end: 1000, text: 'PROJECT B' }] }], waveform: payload }, 'b.mosp');
      if (kind === 'word') MaweWordTiming.setEnabled(true);
      waveform.scroll.scrollTop = 0;
      window.reviewDeferredFrames = frames;
      return { deferred: frames.length, sameObject: MaweBoot.DATA === original };
    }, kind);
    expect(result).toEqual({ deferred: 1, sameObject: true });
    await expect(page.locator(kind === 'word'
      ? '.waveform-word-block[data-segment-idx="0"][data-item-idx="0"]'
      : '.waveform-cue-block[data-track="main"][data-idx="0"]').first()).toBeVisible();
    await page.evaluate(() => { for (const callback of window.reviewDeferredFrames) callback(performance.now()); });
    expect(await page.evaluate(() => window.reviewFallbackCount)).toBe(0);
    await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(0);
    expect(projectModel.getMainTrack(await content(page)).segments[0].text).toBe('PROJECT B');
  });
}

for (const replacement of ['project', 'subtitles']) {
test(`deferred split focus does not select or open cues after ${replacement} replacement`, async ({ page }) => {
  await openFixture(page, { segments: [{ start: 0, end: 1000, text: 'AB',
    items: [{ start: 0, end: 500, text: 'A' }, { start: 500, end: 1000, text: 'B' }] }] });
  await page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first().dblclick();
  expect(await page.evaluate(replacement => {
    const waveform = MaweCoreState.waveformEditor;
    const popup = waveform.cueQuickEdit;
    const split = waveform.options.onCueQuickEditSplit('main', 0, 1, popup);
    popup.commit = null;
    waveform.closeCueQuickEdit();
    const payload = MaweBoot.DATA.waveform;
    const segments = [
      { start: 0, end: 1000, text: 'PROJECT B FIRST' }, { start: 1000, end: 2000, text: 'PROJECT B SECOND' },
    ];
    if (replacement === 'project') MaweProjectLoad.applyCanonicalProject({ segments, waveform: payload }, 'b.mosp');
    else MaweProjectLoad.replaceMainTrack(segments, 'b.srt');
    return split;
  }, replacement)).toBe(true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(0);
  expect(await page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([]);
  expect(projectModel.getMainTrack(await content(page)).segments.map(cue => cue.text)).toEqual(['PROJECT B FIRST', 'PROJECT B SECOND']);
});
}

test('failed project parsing preserves pending quick text and normal save protection', async ({ page }) => {
  await openFixture(page, { segments: [{ start: 0, end: 1000, text: 'PROJECT A' }] });
  await page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first().dblclick();
  const input = page.locator('.waveform-cue-quick-edit textarea');
  await input.fill('PENDING A');
  expect(await page.evaluate(() => MaweMultiImport.openProjectFile(new File(['{bad'], 'invalid.mosp')))).toBe(false);
  await expect(input).toHaveValue('PENDING A');
  expect(await page.evaluate(() => MaweServerSave.hasUnsavedProjectChanges())).toBe(true);
  await input.press('Escape');
  expect(projectModel.getMainTrack(await content(page)).segments[0].text).toBe('PENDING A');
});

for (const kind of ['cue', 'word']) {
  test(`same-project ${kind} popup takeover preserves pending input and creates one undo record`, async ({ page }) => {
    await openFixture(page, { segments: [{ start: 0, end: 1000, text: 'PROJECT A',
      items: [{ start: 0, end: 1000, text: 'PROJECT A' }] }] });
    if (kind === 'word') await page.evaluate(() => MaweWordTiming.setEnabled(true));
    await page.evaluate(() => { MaweCoreState.waveformEditor.scroll.scrollTop = 0; });
    await page.locator(kind === 'word' ? '.waveform-word-block[data-segment-idx="0"][data-item-idx="0"]'
      : '.waveform-cue-block[data-track="main"][data-idx="0"]').first().dblclick();
    const input = page.locator('.waveform-cue-quick-edit textarea');
    await input.fill('UNSAVED A');
    await page.evaluate(kind => {
      const waveform = MaweCoreState.waveformEditor;
      if (kind === 'word') waveform.openWordQuickEditAtIndex(0, 0);
      else waveform.openCueQuickEditAtIndex('main', 0);
    }, kind);
    expect(projectModel.getMainTrack(await content(page)).segments[0].text).toBe('UNSAVED A');
    await expect(input).toHaveValue('UNSAVED A');
    await input.press('Escape');
    expect(projectModel.getMainTrack(await content(page)).segments[0].text).toBe('UNSAVED A');
    expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(1);
    expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
    expect(projectModel.getMainTrack(JSON.parse(readFileSync(projectPath, 'utf8'))).segments[0].text).toBe('UNSAVED A');
    // The post-commit reopen frame must also be cancelled by an actual switch.
    await page.locator(kind === 'word' ? '.waveform-word-block[data-segment-idx="0"][data-item-idx="0"]'
      : '.waveform-cue-block[data-track="main"][data-idx="0"]').first().dblclick();
    await expect(input).toHaveValue('UNSAVED A');
    await page.evaluate(kind => {
      const waveform = MaweCoreState.waveformEditor;
      waveform.cueQuickEdit.textarea.value = 'LAST A';
      if (kind === 'word') waveform.openWordQuickEditAtIndex(0, 0);
      else waveform.openCueQuickEditAtIndex('main', 0);
      MaweProjectLoad.applyCanonicalProject({ waveform: MaweBoot.DATA.waveform,
        segments: [{ start: 0, end: 1000, text: 'PROJECT B', items: [{ start: 0, end: 1000, text: 'PROJECT B' }] }],
      }, 'b.mosp');
    }, kind);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(0);
    expect(projectModel.getMainTrack(await content(page)).segments[0].text).toBe('PROJECT B');
    expect(projectModel.getMainTrack(JSON.parse(readFileSync(projectPath, 'utf8'))).segments[0].text).toBe('UNSAVED A');
  });
}
