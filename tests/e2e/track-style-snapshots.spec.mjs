import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';

const canonical = JSON.parse(readFileSync(new URL('../fixtures/project-tracks/legacy-three-tracks.expected.json', import.meta.url), 'utf8'));
let directory, server;
test.beforeAll(async () => { directory = makeTempDir('track-styles'); server = await startBlankServer(await findFreePort(), directory); });
test.afterAll(async () => { await server?.stop(); cleanupTempDir(directory); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => window.MaweAssManagerWiring && window.MaweMultiImport);
  await page.evaluate(async project => {
    await MaweMultiImport.openProjectFile(new File([JSON.stringify({ ...project, media: '' })], 'styles.mosp', { type: 'application/json' }), { suppressMediaPrompt: true });
  }, canonical);
  await expect.poll(() => page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('main').status)).toBe('linked');
});

test('library edits update linked tracks, project edits fork, and save is one undo', async ({ page }) => {
  await page.evaluate(() => {
    MaweAssManagerWiring.applyProjectStyleSelection('secondary', 'ass');
    MaweHistory.editorHistory.clear();
    MaweState.establishProjectCheckpoint();
  });
  expect(await page.evaluate(() => MaweState.hasProjectChanges())).toBe(false);
  await page.evaluate(() => MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-subtitle-style'));
  await page.locator('#ass-style-manager-open').click();
  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await page.locator('#ass-style-font-size').fill('100');
  await expect.poll(() => page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('main').style.fontSize)).toBe(100);
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('secondary').style.fontSize)).toBe(100);
  expect(await page.evaluate(() => MaweState.hasProjectChanges())).toBe(true);

  await page.evaluate(() => MaweAssManagerWiring.openProjectStyleEditor('main'));
  await page.locator('#ass-style-font-size').fill('120');
  const forked = await page.evaluate(() => ({ main: MaweAssManagerWiring.projectStyleOptions('main'), secondary: MaweAssManagerWiring.projectStyleOptions('secondary') }));
  expect(forked.main.status).toBe('forked');
  expect(forked.main.style.fontSize).toBe(120);
  expect(forked.secondary.style.fontSize).toBe(100);
  const count = await page.evaluate(() => MaweHistory.editorHistory.undoLength());
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(() => MaweAssManagerWiring.saveProjectStyleToLibrary('main'));
  expect(await page.evaluate(() => MaweHistory.editorHistory.undoLength())).toBe(count + 1);
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('secondary').style.fontSize)).toBe(120);
  const status = page.locator('#main-ass-style-status');
  await expect(status).toHaveText('与样式库联动');
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('main').status)).toBe('forked');
  await expect(status).toHaveText('工程样式已分离');
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('secondary').style.fontSize)).toBe(100);
  await page.evaluate(() => MaweHistory.performRedo());
  await expect(status).toHaveText('与样式库联动');
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('secondary').style.fontSize)).toBe(120);
});

test('project style editing clears library selection after fork and allows returning to library editing', async ({ page }) => {
  await page.evaluate(() => MaweAssManagerWiring.openProjectStyleEditor('main'));
  const selected = page.locator('#ass-style-list [aria-selected="true"]');
  await expect(selected).toHaveAttribute('data-ass-selection-id', 'ass');
  const librarySize = await page.evaluate(() => ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass').fontSize);
  await page.locator('#ass-style-font-size').fill('121');
  await expect(selected).toHaveCount(0);
  expect(await page.evaluate(() => ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass').fontSize)).toBe(librarySize);
  await page.locator('#ass-style-window-close').click();
  await page.evaluate(() => MaweAssManagerWiring.openProjectStyleEditor('main'));
  await expect(selected).toHaveCount(0);
  await expect(page.locator('#ass-style-font-size')).toHaveValue('121');
  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await expect(selected).toHaveAttribute('data-ass-selection-id', 'ass');
  await expect(page.locator('#ass-style-font-size')).toHaveValue(String(librarySize));
});

test('project style target is invalidated when another project with the same track id opens', async ({ page }) => {
  await page.evaluate(() => MaweAssManagerWiring.openProjectStyleEditor('main'));
  const before = await page.evaluate(() => JSON.stringify(ASS_STYLE_LIBRARY));
  const epoch = await page.evaluate(() => MaweState.projectEpoch);
  await page.locator('#open-project-file').setInputFiles({ name: 'another.mosp', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...canonical, media: '' })) });
  await expect.poll(() => page.evaluate(() => MaweState.projectEpoch)).toBeGreaterThan(epoch);
  await expect(page.locator('#ass-style-form')).toBeHidden();
  const snapshot = await page.evaluate(() => JSON.stringify(MaweBoot.DATA.styles));
  await page.locator('#ass-style-font-size').evaluate(element => { element.value = '121'; element.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(await page.evaluate(() => JSON.stringify(MaweBoot.DATA.styles))).toBe(snapshot);
  expect(await page.evaluate(() => JSON.stringify(ASS_STYLE_LIBRARY))).toBe(before);
});

test('cue style control has 8px spacing without shifting the video stage', async ({ page }, info) => {
  await page.evaluate(() => { MaweSettings.EDITOR_SETTINGS.assMode = true; MaweSelection.clearSelection(); });
  const stage = () => page.locator('.player-stage').evaluate(element => { const r = element.getBoundingClientRect(); return { top: r.top, height: r.height }; });
  const before = await stage();
  await page.evaluate(() => { const track = AsrEditorUtils.getMainTrack(MaweBoot.DATA); MaweCuePanel.setCuePanelTarget('main', 0, track.id); });
  await expect(page.locator('#cue-ass-style-controls')).toBeVisible();
  const gaps = await page.evaluate(() => {
    const target = document.querySelector('#cue-panel-target').getBoundingClientRect();
    const control = document.querySelector('#cue-ass-style-controls').getBoundingClientRect();
    const text = document.querySelector('.cue-panel-text-row').getBoundingClientRect();
    return { beside: control.left - target.right, below: text.top - Math.max(target.bottom, control.bottom) };
  });
  await page.locator('#current-cue-panel').screenshot({ path: info.outputPath('cue-style-spacing.png') });
  writeFileSync(info.outputPath('cue-style-spacing.json'), JSON.stringify({ gaps, before, after: await stage() }, null, 2));
  expect(gaps.beside).toBeGreaterThanOrEqual(8);
  expect(gaps.below).toBeGreaterThanOrEqual(8);
  expect(await stage()).toEqual(before);
});

test('same name with different parameters stays forked and survives offline reopen and swap', async ({ page }) => {
  const saved = await page.evaluate(() => {
    MaweAssManagerWiring.applyProjectStyleSelection('secondary', 'ass-extension');
    const project = JSON.parse(MaweJsonRepair.buildJson());
    const main = project.tracks.find(track => track.role === 'main');
    const snapshot = project.styles.find(style => style.id === main.style.style_id);
    snapshot.fontSize = 123;
    snapshot.fontName = 'Snapshot Fixture';
    return project;
  });
  await page.route('**/api/ass-styles', route => route.abort());
  await page.evaluate(() => localStorage.removeItem('moy.asr.ass.styles.v1'));
  await page.reload();
  await page.waitForFunction(() => window.MaweAssManagerWiring && window.MaweMultiImport);
  const result = await page.evaluate(async project => MaweMultiImport.openProjectFile(new File([JSON.stringify(project)], 'offline.mosp', { type: 'application/json' }), { suppressMediaPrompt: true }), saved);
  expect(result).toBe(true);
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('main').status)).toBe('forked');
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('main').style.fontSize)).toBe(123);
  const exportAss = () => page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    return MaweExportSrt.buildAss();
  });
  expect(await exportAss()).toContain('Style: Default,Snapshot Fixture,');
  const before = await page.evaluate(() => Object.fromEntries(MaweBoot.DATA.tracks.map(track => [track.id, track.style?.style_id])));
  expect(await page.evaluate(() => MaweMultiImport.swapMainAndExtensionSubtitles())).toBe(true);
  const after = await page.evaluate(() => Object.fromEntries(MaweBoot.DATA.tracks.map(track => [track.id, track.style?.style_id])));
  expect(after).toEqual(before);
  expect(await page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('secondary').style.fontSize)).toBe(123);
  expect(await exportAss()).toContain('Style: Extension,Snapshot Fixture,');
});

test('importing a project as secondary copies its style and reference metadata', async ({ page }) => {
  const imported = await page.evaluate(async () => {
    const source = JSON.parse(MaweJsonRepair.buildJson());
    const main = source.tracks.find(track => track.role === 'main');
    main.style.vendor = { reference: true };
    const style = source.styles.find(item => item.id === main.style.style_id);
    style.fontSize = 119;
    style.vendor = { snapshot: true };
    const file = new File([JSON.stringify(source)], 'source.mosp', { type: 'application/json' });
    const segments = await MaweLoadingProgress.parseSubtitleImportFile(file);
    MaweMultiImport.pendingMultiImport = { file, segments, existingTrackId: MaweMultiSubtitleCore.getActiveExtensionTrack().id };
    const oldId = MaweMultiSubtitleCore.getActiveExtensionTrack().style.style_id;
    const ok = MaweMultiImport.commitMultiSubtitleImport();
    let secondary = MaweBoot.DATA.tracks.find(track => track.role === 'secondary');
    const firstId = secondary.style.style_id;
    const oldRemoved = !MaweBoot.DATA.styles.some(item => item.id === oldId);
    MaweBoot.DATA.tracks.find(track => track.role === 'main').style.style_id = firstId;
    MaweMultiImport.pendingMultiImport = { file, segments, existingTrackId: secondary.id };
    MaweMultiImport.commitMultiSubtitleImport();
    secondary = MaweBoot.DATA.tracks.find(track => track.role === 'secondary');
    const secondId = secondary.style.style_id;
    const sharedKept = MaweBoot.DATA.styles.some(item => item.id === firstId);
    MaweMultiImport.pendingMultiImport = { file, segments, existingTrackId: secondary.id };
    MaweMultiImport.commitMultiSubtitleImport();
    secondary = MaweBoot.DATA.tracks.find(track => track.role === 'secondary');
    return { ok, oldRemoved, sharedKept, secondRemoved: !MaweBoot.DATA.styles.some(item => item.id === secondId), ref: secondary.style, style: MaweBoot.DATA.styles.find(item => item.id === secondary.style.style_id) };
  });
  expect(imported.ok).toBe(true);
  expect(imported.oldRemoved).toBe(true);
  expect(imported.sharedKept).toBe(true);
  expect(imported.secondRemoved).toBe(true);
  expect(imported.ref.vendor).toEqual({ reference: true });
  expect(imported.style.vendor).toEqual({ snapshot: true });
  expect(imported.style.fontSize).toBe(119);
});

for (const role of ['main', 'secondary', 'overlay']) test(`cue style selector overrides ${role}, undoes, reopens and clears to track style`, async ({ page }) => {
  const setup = await page.evaluate(role => {
    const track = MaweBoot.DATA.tracks.find(track => track.role === role);
    track.enabled = true;
    const cue = track.segments[0];
    cue.assOverride = { pos: { x: 640, y: 360 }, scale: 1.2 };
    const style = ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass-extension');
    Object.assign(style, { fontName: 'Arial', fontSize: 103, primaryColor: '#123456' });
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true; MaweDom.extensionOverlayToggle.checked = true;
    MaweCuePanel.setCuePanelTarget(role === 'secondary' ? 'extension' : role, 0, track.id);
    MaweHistory.editorHistory.clear();
    return { id: cue.id, trackId: track.id, styles: JSON.parse(JSON.stringify(MaweBoot.DATA.styles)) };
  }, role);
  await page.locator('#cue-ass-style').selectOption('ass-extension');
  const read = () => page.evaluate(id => {
    const cue = MaweBoot.DATA.tracks.flatMap(track => track.segments).find(cue => cue.id === id);
    MawePlaybackLoop.refreshSubtitlePreview(cue.start + 1, 0);
    const item = MaweAssPreview.stackPlan.slices.flatMap(slice => slice.items).find(item => item.segment.id === id);
    return { style: cue.assStyle, pos: cue.assOverride, rendered: item?.style.fontSize,
      styles: MaweBoot.DATA.styles, ass: MaweExportSrt.buildAss(), undo: MaweHistory.editorHistory.undoLength() };
  }, setup.id);
  let current = await read();
  expect(current.style.fontSize).toBe(103);
  expect(current.rendered).toBe(103);
  expect(current.styles).toEqual(setup.styles);
  expect(current.ass).toContain('Style: Cue_0,Arial,103,');
  expect(current.pos).toEqual({ pos: { x: 640, y: 360 }, scale: 1.2 });
  expect(current.undo).toBe(1);
  await page.evaluate(() => MaweHistory.performUndo());
  expect((await read()).style).toBeUndefined();
  await page.evaluate(() => MaweHistory.performRedo());
  expect((await read()).rendered).toBe(103);
  const saved = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  await page.reload();
  await page.waitForFunction(() => window.MaweMultiImport);
  await page.evaluate(async ({ saved, role, trackId }) => {
    await MaweMultiImport.openProjectFile(new File([JSON.stringify(saved)], 'cue-style.mosp', { type: 'application/json' }), { suppressMediaPrompt: true });
    MaweCuePanel.setCuePanelTarget(role === 'secondary' ? 'extension' : role, 0, trackId);
  }, { saved, role, trackId: setup.trackId });
  expect((await read()).rendered).toBe(103);
  await page.locator('#cue-ass-style').selectOption('');
  current = await read();
  expect(current.style).toBeUndefined();
  expect(current.pos).toEqual({ pos: { x: 640, y: 360 }, scale: 1.2 });
  expect(current.ass).not.toContain('Style: Cue_0,');
  expect(current.rendered).toBe(await page.evaluate(role => MaweAssManagerWiring.projectStyleOptions(role).style.fontSize, role));
});

for (const action of ['new', 'duplicate']) test(`creating ${action} from track editor selects the new library style`, async ({ page }) => {
  await page.evaluate(() => MaweAssManagerWiring.openProjectStyleEditor('main'));
  const before = await page.evaluate(() => JSON.stringify(MaweAssManagerWiring.projectStyleOptions('main').style));
  await page.locator(`#ass-style-${action}`).click();
  await page.locator('#ass-style-name').fill(`Library ${action}`);
  expect(await page.evaluate(name => ASS_STYLE_LIBRARY.styles.some(style => style.name === name), `Library ${action}`)).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(MaweAssManagerWiring.projectStyleOptions('main').style))).toBe(before);
});
