import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBrowserEditorFixture, cleanupTempDir, disableOnboarding, findFreePort,
  generateWav, generateWaveformPayload, makeTempDir, startServer, startStaticServer } from './helpers.mjs';

let dir, server;
test.beforeAll(async () => {
  dir = makeTempDir('editor-feedback-layout');
  server = await startStaticServer(buildBrowserEditorFixture(join(dir, 'editor.html')), await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });

async function openProject(page) {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('moy.asr.waveform.settings.v1')) {
      localStorage.setItem('moy.asr.waveform.settings.v1', JSON.stringify({ rowHeight: 192 }));
    }
  });
  await page.goto(server.url);
  await page.evaluate(waveform => {
    const segment = (id, text, speaker) => ({ id, text, start: 1000, end: 3000,
      ...(speaker ? { speaker } : {}), items: [{ text, start: 1000, end: 3000 }] });
    MaweProjectLoad.applyCanonicalProject({
      schema: 'moy.asr.project.v2', annotation_mode: 'speaker', palette_size: 9,
      speakers: [{ id: 'a', name: '甲', color: '#d9a300' }, { id: 'b', name: '乙', color: '#42b8bc' }],
      speaker_shortcuts: { 1: 'a', 2: 'b' },
      tracks: [
        { id: 'main', role: 'main', enabled: true, name: '主字幕', segments: [
          segment('m1', '主字幕测试', 'a'), { id: 'm2', text: '没有说话人', start: 4000, end: 5000, items: [] }] },
        { id: 'secondary', role: 'secondary', enabled: true, name: '副字幕', segments: [segment('s1', '双语副字幕测试', 'b')] },
        { id: 'overlay', role: 'overlay', enabled: true, name: '叠加字幕', segments: [segment('o1', '叠加字幕测试', 'a')] },
      ], bilingual: { display_mode: 'both', active_track_id: 'secondary' }, bindings: [],
      subtitle_groups: { next_id: 1, color: [], sticker: [] }, waveform,
    }, 'layout.mosp');
  }, generateWaveformPayload(6000));
  await expect(page.locator('.waveform-cue-block[data-track="extension"]').first()).toBeVisible();
}

test('compact five plus four staggered circles and assigned-only speaker labels', async ({ page }, info) => {
  await openProject(page);
  await expect(page.locator('.cue-speaker-badge.unassigned')).toBeHidden();
  await expect(page.locator('.cue-speaker-badge').filter({ hasText: '甲' }).first()).toBeVisible();
  const readings = [];
  for (const size of [5, 9]) {
    await page.evaluate(size => {
      MaweSpeakerLabels.setPaletteSize(size);
      MaweContextMenus.showContextMenu(100, 100, 0);
    }, size);
    const swatches = page.locator('#ctxmenu .speaker-context-swatches');
    const circles = swatches.locator('[data-speaker-context-slot]');
    await expect(circles).toHaveCount(size);
    const rects = await circles.evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    expect(rects.every(r => r.width === 22 && r.height === 22)).toBe(true);
    expect(rects.slice(0, 5).every(r => Math.abs(r.y - rects[0].y) < 1)).toBe(true);
    if (size === 9) {
      expect(rects.slice(5).every(r => r.y > rects[0].y)).toBe(true);
      for (let i = 0; i < 4; i++) {
        expect(Math.abs(rects[i + 5].x - (rects[i].x + rects[i + 1].x) / 2)).toBeLessThan(1);
      }
    }
    readings.push({ size, rects });
    await page.locator('#ctxmenu').screenshot({ path: info.outputPath(`palette-${size}.png`) });
    await page.keyboard.press('Escape');
  }
  writeFileSync(info.outputPath('circle-geometry.json'), JSON.stringify(readings, null, 2));
});

test('waveform gaps and opt-in secondary color work in both modes', async ({ page }, info) => {
  await openProject(page);
  const readings = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => MaweTheme.applyTheme(theme), theme);
    for (const mode of ['multi', 'basic']) {
      await page.locator(`[data-waveform-mode="${mode}"]`).click();
      await page.locator('.waveform-cue-block[data-track="main"]').first().click({ position: { x: 25, y: 10 } });
      const geometry = await page.evaluate(() => {
        const read = track => {
          const element = document.querySelector(`.waveform-cue-block[data-track="${track}"]`);
          const r = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { top: r.top, bottom: r.bottom,
            outline: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset),
            outer: Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) };
        };
        return { main: read('main'), extension: read('extension'), overlay: read('overlay') };
      });
      expect(geometry.extension.top - geometry.main.bottom).toBeCloseTo(3, 1);
      expect(geometry.main.outline).toBe(2);
      expect(geometry.main.offset).toBe(0);
      expect(geometry.extension.top - geometry.extension.outer - geometry.main.bottom - geometry.main.outer).toBeCloseTo(0, 1);
      expect(geometry.main.top - geometry.overlay.bottom).toBeGreaterThanOrEqual(3);
      readings.push({ theme, mode, ...geometry });
      await page.locator('#waveform-settings-toggle').click();
      const tooltip = page.getByLabel('悬浮显示完整字幕文本', { exact: true });
      const color = page.getByLabel('双语副字幕显示颜色', { exact: true });
      await expect(tooltip).not.toBeChecked();
      await expect(color).not.toBeChecked();
      const extension = page.locator('.waveform-cue-block[data-track="extension"]').first();
      const before = await extension.evaluate(el => getComputedStyle(el).backgroundColor);
      await color.check();
      await expect.poll(() => extension.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(before);
      await expect(extension).toHaveClass(/has-subtitle-color/);
      const margins = await tooltip.locator('..').evaluate(el => ({
        top: getComputedStyle(el).marginTop, bottom: getComputedStyle(el).marginBottom,
      }));
      expect(margins).toEqual({ top: '0px', bottom: '0px' });
      await page.locator('#waveform-settings-panel').screenshot({ path: info.outputPath(`settings-${theme}-${mode}.png`) });
      await page.locator('#waveform-settings-toggle').click();
      await page.locator('#waveform-pane').screenshot({ path: info.outputPath(`waveform-${theme}-${mode}.png`) });
      await page.locator('#waveform-settings-toggle').click();
      await color.uncheck();
      await page.locator('#waveform-settings-toggle').click();
    }
  }
  await page.locator('#waveform-settings-toggle').click();
  await page.getByLabel('双语副字幕显示颜色', { exact: true }).check();
  await page.reload();
  await page.locator('#waveform-settings-toggle').click();
  await expect(page.getByLabel('双语副字幕显示颜色', { exact: true })).toBeChecked();
  writeFileSync(info.outputPath('waveform-geometry.json'), JSON.stringify(readings, null, 2));
});

test('compact and normal row heights retain safe overlay bounds with word timing', async ({ page }, info) => {
  await openProject(page);
  await page.locator('[data-waveform-mode="multi"]').click();
  const readings = [];
  for (const words of [false, true]) {
    if (words) await page.locator('#word-timing-quick-toggle').click();
    for (const height of [64, 96, 120, 144, 192]) {
      await page.evaluate(height => MaweCoreState.waveformEditor.setRowHeight(height), height);
      const geometry = await page.locator('.waveform-row.multi-subtitle-row').first().evaluate(row => {
        const rowRect = row.getBoundingClientRect();
        const read = selector => {
          const el = row.querySelector(selector), r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return { top: r.top - rowRect.top - row.clientTop,
            bottom: r.bottom - rowRect.top - row.clientTop,
            outer: Math.max(0, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset)) };
        };
        return { available: row.clientHeight,
          cover: row.querySelector('.waveform-overlay-block').classList.contains('overlay-cover-mode'),
          main: read('[data-track="main"]'), extension: read('[data-track="extension"]'),
          overlay: read('[data-track="overlay"]') };
      });
      readings.push({ words, height, ...geometry });
      expect(geometry.extension.top - geometry.main.bottom).toBeCloseTo(3, 1);
      expect(geometry.overlay.top).toBeGreaterThanOrEqual(0);
      expect(geometry.overlay.bottom).toBeLessThanOrEqual(geometry.available);
      if (!geometry.cover) {
        expect(geometry.overlay.top - geometry.overlay.outer).toBeGreaterThanOrEqual(0);
        expect(geometry.main.top - geometry.overlay.bottom).toBeCloseTo(3, 1);
      }
      await page.locator('#waveform-pane').screenshot({ path: info.outputPath(`height-${height}-words-${words}.png`) });
    }
  }
  writeFileSync(info.outputPath('height-geometry.json'), JSON.stringify(readings, null, 2));
});

async function openMergeProject(page, bound = false) {
  await openProject(page);
  await page.evaluate(bound => {
    MaweSettings.EDITOR_SETTINGS.multiSubtitleAutoSyncDuration = true;
    const project = structuredClone(MaweBoot.DATA);
    project.speakers = Array.from({ length: 4 }, (_, i) => ({
      id: `person-${i + 1}`, name: `Person ${i + 1}`, color: ['#d9a300', '#66bb6a', '#f07f6f', '#61a7fa'][i],
    }));
    project.speaker_shortcuts = { 1: 'person-1', 2: 'person-2' };
    const cue = (id, start, end, speaker) => ({ id, start, end, speaker, text: id, items: [] });
    project.tracks = [
      { id: 'main', role: 'secondary', name: 'Secondary', enabled: true, segments: [
        cue('outside-tolerance', 480, 1520, 'person-1'),
        cue('secondary-a', 1720, 2760, 'person-4'), cue('secondary-b', 2760, 3880, 'person-3')] },
      { id: 'extension-1', role: 'main', name: 'Primary', enabled: true, segments: [
        cue('primary-a', 1240, 2050, 'person-2'), cue('primary-b', 2050, 3740, 'person-2')] },
      { id: 'overlay', role: 'overlay', name: 'Overlay', enabled: true, segments: [] },
    ];
    project.bindings = [];
    project.bilingual = { display_mode: 'both', active_track_id: 'main' };
    if (bound) {
      const primary = project.tracks.find(track => track.role === 'main');
      const secondary = project.tracks.find(track => track.role === 'secondary');
      for (let i = 0; i < 2; i++) project.bindings.push(AsrEditorUtils.buildSubtitleBinding(
        primary.segments[i], secondary.segments[i + 1], secondary.id, null, primary.id, project.bindings));
    }
    MaweProjectLoad.applyCanonicalProject(project, 'synthetic-merge-conflict.mosp');
  }, bound);
}

const mergeSnapshot = page => page.evaluate(() => ({
  tracks: MaweBoot.DATA.tracks.map(track => ({ id: track.id, role: track.role,
    segments: track.segments.map(({ id, start, end, text, speaker }) => ({ id, start, end, text, speaker: speaker ?? null })) })),
  bindings: structuredClone(MaweBoot.DATA.bindings),
}));

test('same-speaker main merge overrides secondary identity conflicts and reports it', async ({ page }, info) => {
  for (const language of ['zh', 'en']) {
    await openMergeProject(page);
    const before = await mergeSnapshot(page);
    await page.evaluate(language => {
      MAWE_I18N.applyLanguage(language);
      MaweSegmentOps.mergeSegments([0, 1]);
    }, language);
    const after = await mergeSnapshot(page);
    expect(after.tracks.find(track => track.role === 'main').segments).toHaveLength(1);
    const secondary = after.tracks.find(track => track.role === 'secondary').segments;
    expect(secondary).toHaveLength(2);
    // It is excluded from the merge and retains its text/identity. Existing
    // duration synchronization trims its trailing overlap with the merged pair.
    expect(secondary[0]).toEqual({ ...before.tracks.find(track => track.role === 'secondary').segments[0], end: 1240 });
    expect(secondary[1].speaker).toBe('person-2');
    expect(secondary[1].text).toContain('secondary-a');
    expect(secondary[1].text).toContain('secondary-b');
    expect(after.bindings).toHaveLength(1);
    await expect(page.locator('#hint-stack .hint-card').last()).toContainText(language === 'zh'
      ? /副字幕.*说话人.*主字幕/ : /secondary.*speaker.*main/i);
    if (language === 'en') await expect(page.locator('#hint-stack .hint-card').last()).not.toContainText(/[\u3400-\u9fff]/);
    await page.locator('#hint-stack').screenshot({ path: info.outputPath(`primary-authority-${language}.png`) });
    await page.locator('#undo-btn').click();
    expect(await mergeSnapshot(page)).toEqual(before);
    await page.locator('#redo-btn').click();
    expect(await mergeSnapshot(page)).toEqual(after);
  }
});

test('main assignments sync bound secondary only and remain one-way undoable', async ({ page }) => {
  await openMergeProject(page, true);
  const identities = () => page.evaluate(() => Object.fromEntries(MaweBoot.DATA.tracks.map(track =>
    [track.role, track.segments.map(segment => segment.speaker ?? null)])));
  const before = await identities();
  await page.evaluate(() => MaweSpeakerLabels.assignIdentity([
    { track_id: 'extension-1', segment_id: 'primary-a' },
  ], 'person-1'));
  expect(await identities()).toEqual({ main: ['person-1', 'person-2'], secondary: ['person-1', 'person-1', 'person-3'], overlay: [] });
  await page.locator('#undo-btn').click();
  expect(await identities()).toEqual(before);
  await page.locator('#redo-btn').click();
  await page.evaluate(() => MaweSpeakerLabels.assignIdentity([
    { track_id: 'main', segment_id: 'secondary-a' },
  ], 'person-4'));
  expect((await identities()).main).toEqual(['person-1', 'person-2']);
  await page.evaluate(() => MaweSpeakerLabels.clearIdentity([
    { track_id: 'extension-1', segment_id: 'primary-a' },
  ]));
  expect(await identities()).toEqual({ main: [null, 'person-2'], secondary: ['person-1', null, 'person-3'], overlay: [] });
  const colorResult = await page.evaluate(() => {
    MaweSpeakerLabels.setAnnotationMode('color');
    const byRole = role => MaweBoot.DATA.tracks.find(track => track.role === role);
    MaweStickerPicker.assignColor([0], 'red');
    const color = (role, index) => AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA, byRole(role).segments[index], 'color');
    return { primary: color('main', 0), bound: color('secondary', 1), unbound: color('secondary', 0) };
  });
  expect(colorResult.primary).toBeTruthy();
  expect(colorResult.bound).toEqual(colorResult.primary);
  expect(colorResult.unbound).toBeNull();
  await page.evaluate(() => MaweStickerPicker.clearColorOnTargets([0]));
  expect(await page.evaluate(() => MaweBoot.DATA.tracks.filter(track => track.role !== 'overlay')
    .map(track => AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA, track.segments[track.role === 'main' ? 0 : 1], 'color')))).toEqual([null, null]);
});

test('bound speaker assignment and main-led merge survive server save and reopen', async ({ page }) => {
  await openMergeProject(page, true);
  const directory = makeTempDir('main-led-speaker-save');
  let localServer;
  try {
    const media = join(directory, 'synthetic.wav'), projectPath = join(directory, 'project.mosp');
    generateWav(media, 6);
    const project = await page.evaluate(() => JSON.parse(JSON.stringify(MaweBoot.DATA)));
    project.media = media;
    writeFileSync(projectPath, JSON.stringify(project));
    localServer = await startServer(projectPath, media, await findFreePort());
    await page.goto(localServer.url);
    await page.evaluate(() => MaweSpeakerLabels.assignIdentity([
      { track_id: 'extension-1', segment_id: 'primary-a' },
    ], 'person-2'));
    const save = async () => {
      const response = page.waitForResponse(r => r.url().endsWith('/api/project') && r.request().method() === 'POST');
      await page.keyboard.press('Control+s');
      expect((await response).ok()).toBe(true);
      return JSON.parse(readFileSync(projectPath, 'utf8'));
    };
    const assigned = await save();
    expect(assigned.tracks.find(track => track.role === 'secondary').segments[1].speaker).toBe('person-2');
    await page.reload();
    await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA)?.segments?.length)).toBe(2);
    await page.evaluate(() => MaweSegmentOps.mergeSegments([0, 1]));
    const merged = await save();
    expect(merged.tracks.find(track => track.role === 'main').segments).toHaveLength(1);
    const secondary = merged.tracks.find(track => track.role === 'secondary').segments;
    expect(secondary).toHaveLength(2);
    expect(secondary[1].speaker).toBe('person-2');
    await page.reload();
    expect((await mergeSnapshot(page)).bindings).toEqual(merged.bindings);
    expect(await page.evaluate(() => MaweBoot.DATA.tracks.find(track => track.role === 'secondary').segments[1].speaker)).toBe('person-2');
    await page.evaluate(() => {
      MaweSpeakerLabels.setAnnotationMode('color');
      MaweStickerPicker.assignColor([0], 'red');
    });
    const colored = await save();
    expect(colored.tracks.find(track => track.role === 'secondary').segments[1].speaker).toBe('person-2');
    await page.reload();
    const colors = await page.evaluate(() => {
      const value = (role, index) => AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA,
        MaweBoot.DATA.tracks.find(track => track.role === role).segments[index], 'color');
      return { primary: value('main', 0), bound: value('secondary', 1) };
    });
    expect(colors.primary).toBeTruthy();
    expect(colors.bound).toEqual(colors.primary);
  } finally {
    await localServer?.stop();
    cleanupTempDir(directory);
  }
});
