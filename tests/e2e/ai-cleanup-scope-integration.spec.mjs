import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMainTrack, getOverlayTrack, getExtensionTrack,
  cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload,
  generateWav, makeTempDir, startServer,
} from './helpers.mjs';

const INITIAL_TEXT = 'deleted words kept';
const MAIN_CUE = '.multi-dual-cue[data-main-idx="0"] .multi-cue-column.main';
const MAIN_CUE_TEXT = `${MAIN_CUE} .text`;
const INITIAL_ITEMS = [
  { text: 'deleted ', start: 0, end: 300 },
  { text: 'words ', start: 300, end: 1200 },
  { text: 'kept', start: 2000, end: 5000 },
];

let directory;
let server;
let projectPath;

function cue(id, start, end, text) {
  return { id, start, end, text, items: [{ text, start, end }] };
}

function projectData({ neighbor = false } = {}) {
  return {
    media: 'synthetic.wav',
    waveform: generateWaveformPayload(10000),
    segments: [{
      id: 'main-001', start: 0, end: 5000, text: INITIAL_TEXT,
      items: INITIAL_ITEMS.map((item) => ({ ...item })),
    }],
    overlay_track: {
      enabled: true,
      // Keep the overlay lane clear of the scoped gap so the real context-menu hit target remains clickable.
      segments: [cue('overlay-001', 2000, 4500, 'overlay-only')],
    },
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{
        id: 'translation', role: 'extension', segments: [
          cue('extension-001', 100, 5100, 'extension-only'),
          ...(neighbor ? [cue('extension-neighbor', 6000, 7000, 'neighbor-only')] : []),
        ],
      }],
      bindings: [{ id: 'bound', track_id: 'translation', main_segment_ids: ['main-001'],
        extension_segment_ids: ['extension-001'], start_offset_ms: 100, end_offset_ms: 100 }],
    },
    gap_remove: {
      detector: 'audio_gate',
      provenance: { sources: { ai_cleanup: [{
        id: 'local-scope', start: 0, end: 1200,
        cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 2, text: 'deleted words ' },
      }] } },
    },
  };
}

test.beforeAll(async () => {
  directory = makeTempDir('ai-cleanup-scope-integration');
  const mediaPath = join(directory, 'synthetic.wav');
  projectPath = join(directory, 'project.mosp');
  generateWav(mediaPath, 10);
  writeFileSync(projectPath, JSON.stringify(projectData()), 'utf-8');
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(directory);
});

test.beforeEach(async ({ page }, testInfo) => {
  await server?.stop();
  const mediaPath = join(directory, 'synthetic.wav');
  const withNeighbor = testInfo.title.startsWith('S3-T03');
  writeFileSync(projectPath, JSON.stringify(projectData({ neighbor: withNeighbor })), 'utf-8');
  server = await startServer(projectPath, mediaPath, await findFreePort());
  await disableOnboarding(page);
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false }));
  });
  await page.goto(server.url);
  await expect(page.locator(MAIN_CUE_TEXT)).toBeVisible();
});

test.afterEach(async () => {
  await server?.stop();
  server = null;
});

async function setWordTiming(page) {
  const toggle = page.locator('#word-timing-quick-toggle');
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

async function editCueThroughWordTiming(page, replacement) {
  await setWordTiming(page);
  await page.locator(MAIN_CUE).click();
  const editor = page.locator('#cue-panel-text');
  await expect(editor).toHaveValue(INITIAL_TEXT);
  await editor.fill(replacement);
  await editor.blur();
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].text)).toBe(replacement);
  return page.evaluate(() => JSON.parse(JSON.stringify(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0])));
}

async function saveAndReload(page) {
  await expect.poll(() => page.evaluate(() => MaweProjectSave.saveProjectToServer({ silent: true })))
    .toBe(true);
  const saved = JSON.parse(readFileSync(projectPath, 'utf-8'));
  await page.reload();
  await expect(page.locator(MAIN_CUE_TEXT)).toBeVisible();
  return saved;
}

async function renderOutputs(page, timeMs) {
  return page.evaluate((currentTimeMs) => {
    const ordinary = MaweExportSrt.buildSrt();
    const gapRemoved = MaweExportSrt.buildGapRemovedSrt();
    const ass = MaweExportSrt.buildAss();
    MaweDom.overlayToggle.checked = true;
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(currentTimeMs, 0);
    const css = MaweDom.overlayMainTextNode?.nodeValue || '';
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MawePlaybackLoop.refreshSubtitlePreview(currentTimeMs, 0);
    const canvas = window.MaweAssCanvas.lastRender.tracks
      .flatMap((track) => (Array.isArray(track.lines)
        ? track.lines.flatMap((line) => line.items.map((item) => item.text)) : [])).join('');
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    return {
      ordinary, gapRemoved, ass, css, canvas,
      overlay: AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments[0].text,
      extension: AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments[0].text,
    };
  }, timeMs);
}

function expectAllMainOutputs(outputs, ...texts) {
  for (const text of texts) {
    for (const output of [outputs.ordinary, outputs.gapRemoved, outputs.ass, outputs.css, outputs.canvas]) {
      expect(output).toContain(text);
    }
  }
}

function expectRestoredMainOutputs(outputs, ...texts) {
  expect(outputs.gapRemoved).toBeNull();
  for (const text of texts) {
    for (const output of [outputs.ordinary, outputs.ass, outputs.css, outputs.canvas]) {
      expect(output).toContain(text);
    }
  }
}

test('S3-T01 #220 edit of a scoped item revokes stale clipping on save and reopen', async ({ page }) => {
  const edited = await editCueThroughWordTiming(page, 'deleted substantially-rewritten kept');
  expect(edited.text).toBe('deleted substantially-rewritten kept');
  expect(edited.items.map((item) => item.text)).toEqual(['deleted ', 'substantially-rewritten ', 'kept']);

  const saved = await saveAndReload(page);
  expect(getMainTrack(saved).segments[0].items.map((item) => item.text))
    .toEqual(['deleted ', 'substantially-rewritten ', 'kept']);
  expect(saved.gap_remove.provenance.sources.ai_cleanup[0]).not.toHaveProperty('cleanup_scope');

  const outputs = await renderOutputs(page, 500);
  expectAllMainOutputs(outputs, 'deleted', 'substantially-rewritten', 'kept');
  expect(outputs.overlay).toBe('overlay-only');
  expect(outputs.extension).toBe('extension-only');
});

test('S3-T02 editing an unscoped item keeps the scope until the user restores its range', async ({ page }) => {
  const edited = await editCueThroughWordTiming(page, 'deleted words retained-expanded');
  expect(edited.text).toBe('deleted words retained-expanded');
  expect(edited.items.map((item) => item.text))
    .toEqual(['deleted ', 'words ', 'retained-expanded']);

  const saved = await saveAndReload(page);
  expect(getMainTrack(saved).segments[0].items.map((item) => item.text))
    .toEqual(['deleted ', 'words ', 'retained-expanded']);
  expect(saved.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope)
    .toEqual({ segment_id: 'main-001', item_start: 0, item_end: 2, text: 'deleted words ' });

  const clipped = await renderOutputs(page, 2500);
  expectAllMainOutputs(clipped, 'retained-expanded');
  for (const output of [clipped.ordinary, clipped.gapRemoved, clipped.ass, clipped.css, clipped.canvas]) {
    expect(output).not.toContain('deleted');
    expect(output).not.toContain('words');
  }

  await page.evaluate(() => {
    const wave = MaweCoreState.waveformEditor;
    wave.settings.mode = 'multi';
    wave.settings.secondsPerRow = 10;
    wave.scroll.style.width = '720px';
    wave.render();
  });
  const gap = page.locator('.waveform-gap-block[data-gap-index="0"]').first();
  await expect(gap).toBeVisible();
  await gap.click({ button: 'right' });
  const menu = page.locator('#ctxmenu');
  await expect(menu).toHaveClass(/show/);
  await menu.locator('.item').filter({ hasText: '恢复区段' }).click();

  const restored = await renderOutputs(page, 2500);
  expectRestoredMainOutputs(restored, 'deleted', 'words', 'retained-expanded');
  expect(restored.overlay).toBe('overlay-only');
  expect(restored.extension).toBe('extension-only');
  const restoredSaved = await saveAndReload(page);
  expect(restoredSaved.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope)
    .toEqual({ segment_id: 'main-001', item_start: 0, item_end: 2, text: 'deleted words ' });
  expect(restoredSaved.gap_remove.provenance.manual_overrides)
    .toEqual(expect.arrayContaining([expect.objectContaining({ start: 0, end: 1200, removed: false })]));
  expectRestoredMainOutputs(await renderOutputs(page, 2500), 'deleted', 'words', 'retained-expanded');
});

async function trackRanges(page) {
  return page.evaluate(() => [
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments,
    AsrEditorUtils.getOverlayTrack(MaweBoot.DATA).segments,
    AsrEditorUtils.getExtensionTrack(MaweBoot.DATA).segments,
  ].map((segments) => segments.map((segment) => ({
    id: segment.id,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    items: segment.items.map((item) => ({ start: item.start, end: item.end, text: item.text })),
  }))));
}

async function grab(page, selector) {
  const block = page.locator(selector).first();
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  const geometry = await block.evaluate((element) => {
    const row = element.closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    return {
      left: rect.left + row.clientLeft,
      width: row.clientWidth,
      start: Number(row.dataset.startMs),
      end: Number(row.dataset.endMs),
    };
  });
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return { x, y, msPerPixel: (geometry.end - geometry.start) / geometry.width };
}

test('S3-T03 multi-track drag fail-opens the moved scope and saves independent tracks', async ({ page }) => {
  await page.evaluate(() => {
    const wave = MaweCoreState.waveformEditor;
    wave.settings.mode = 'multi';
    wave.settings.secondsPerRow = 10;
    wave.scroll.style.width = '720px';
    wave.render();
    MaweSelection.selectAll();
    MaweState.selection.clear('extension');
    wave.updateSelection();
  });
  const before = await trackRanges(page);
  const drag = await grab(page, '.waveform-cue-block[data-track="main"]');
  await page.keyboard.down('Alt');
  await page.mouse.move(drag.x + 1000 / drag.msPerPixel, drag.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');

  const moved = await trackRanges(page);
  expect(moved[0][0].start).toBe(before[0][0].start + 1000);
  expect(moved[1][0].start).toBe(before[1][0].start + 1000);
  expect(moved[2][0].start).toBe(before[2][0].start + 1000);
  expect(moved[2][1].start).toBeGreaterThan(before[2][1].start);
  expect(moved[2][1].start).toBeGreaterThanOrEqual(moved[2][0].end);
  expect(moved[0][0].items.map((item) => item.text)).toEqual(['deleted ', 'words ', 'kept']);

  const live = await renderOutputs(page, 2500);
  expectAllMainOutputs(live, 'deleted', 'words', 'kept');
  expect(live.overlay).toBe('overlay-only');
  expect(live.extension).toBe('extension-only');

  const saved = await saveAndReload(page);
  expect(saved.gap_remove.provenance.sources.ai_cleanup[0]).not.toHaveProperty('cleanup_scope');
  expect(getOverlayTrack(saved).segments[0].text).toBe('overlay-only');
  expect(getExtensionTrack(saved).segments.map((segment) => segment.text))
    .toEqual(['extension-only', 'neighbor-only']);
  const reopened = await renderOutputs(page, 2500);
  expectAllMainOutputs(reopened, 'deleted', 'words', 'kept');
  expect(reopened.overlay).toBe('overlay-only');
  expect(reopened.extension).toBe('extension-only');
});
