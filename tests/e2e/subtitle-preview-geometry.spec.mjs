// Dev-only Playwright regression for the draggable/resizable subtitle preview.
// Runs against BOTH the localhost editor server and the portable blank-editor.html.
// Proves: overlay geometry drags, resizes, keyboard-nudges, undo/redo, and
// survives persistence — server save+reload (localhost) and export+reimport
// (portable) — all without mutating any segment timing.
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateBlankEditor,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer,
  startStaticServer,
  testSegments,
} from './helpers.mjs';

let tempDir;
let projectPath;
let server;

const EXPECTED_SEGMENTS = testSegments();

test.beforeAll(async () => {
  tempDir = makeTempDir('preview-geometry');
  const mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

// Move the playhead into segment 0 (0–8000ms) so the overlay text is shown,
// then wait until #overlay is visible and its geometry has been applied.
async function revealOverlay(page) {
  await page.evaluate(() => {
    const media = document.getElementById('player');
    media.currentTime = 1;
    media.dispatchEvent(new Event('seeked'));
    media.dispatchEvent(new Event('timeupdate'));
  });
  const overlay = page.locator('#overlay');
  await expect(overlay).toBeVisible();
  return overlay;
}

function readGeometry(page) {
  return page.evaluate(() => JSON.parse(JSON.stringify(DATA.preview.subtitle)));
}

function readSegments(page) {
  return page.evaluate(() => DATA.segments.map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text,
    items: (s.items || []).map((i) => ({ start: i.start, end: i.end, text: i.text })),
  })));
}

// Keep only the timing/text shape so we can compare a normalized on-disk project
// (buildJson adds null sticker/color fields) against the fixture segments.
function onDiskSegmentTiming(segments) {
  return segments.map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text,
    items: (s.items || []).map((i) => ({ start: i.start, end: i.end, text: i.text })),
  }));
}

test('overlay starts at the legacy default band and reports normalized geometry', async ({ page }) => {
  await page.goto(server.url);
  await revealOverlay(page);
  const geo = await readGeometry(page);
  expect(geo.x).toBeCloseTo(0, 5);
  expect(geo.y).toBeCloseTo(0.76, 5);
  expect(geo.width).toBeCloseTo(1, 5);
  expect(geo.height).toBeCloseTo(0.16, 5);
});

test('dragging the overlay body moves it without touching segment timing', async ({ page }) => {
  await page.goto(server.url);
  const overlay = await revealOverlay(page);
  const before = await readGeometry(page);
  const segmentsBefore = await readSegments(page);

  const box = await overlay.boundingBox();
  expect(box).not.toBeNull();
  // Drag up and to the left from the center of the box.
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 - 60, box.y + box.height * 0.5 - 120, { steps: 8 });
  await page.mouse.up();

  const after = await readGeometry(page);
  expect(after.y).toBeLessThan(before.y);
  // width/height unchanged by a move
  expect(after.width).toBeCloseTo(before.width, 5);
  expect(after.height).toBeCloseTo(before.height, 5);
  // stays inside the player
  expect(after.x).toBeGreaterThanOrEqual(0);
  expect(after.y).toBeGreaterThanOrEqual(0);
  expect(after.x + after.width).toBeLessThanOrEqual(1.0001);
  expect(after.y + after.height).toBeLessThanOrEqual(1.0001);
  // segments never change
  expect(await readSegments(page)).toEqual(segmentsBefore);
  expect(segmentsBefore).toEqual(EXPECTED_SEGMENTS);
});

test('resizing via the south-east handle grows the box within player bounds', async ({ page }) => {
  await page.goto(server.url);
  const overlay = await revealOverlay(page);
  // Give the box some slack first: move it up so it can grow downward.
  await page.evaluate(() => {
    setPreviewGeometry({ x: 0.3, y: 0.3, width: 0.3, height: 0.2 }, { markDirty: false });
  });
  const before = await readGeometry(page);
  const handle = overlay.locator('.overlay-handle[data-handle="se"]');
  // Handle only receives pointer events while the overlay is hovered/focused.
  await overlay.hover();
  const hb = await handle.boundingBox();
  expect(hb).not.toBeNull();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 120, hb.y + 80, { steps: 8 });
  await page.mouse.up();

  const after = await readGeometry(page);
  expect(after.width).toBeGreaterThan(before.width);
  expect(after.height).toBeGreaterThan(before.height);
  expect(after.x).toBeCloseTo(before.x, 5);
  expect(after.y).toBeCloseTo(before.y, 5);
  expect(after.x + after.width).toBeLessThanOrEqual(1.0001);
  expect(after.y + after.height).toBeLessThanOrEqual(1.0001);
});

test('a drag gesture is a single undo step and redo re-applies it', async ({ page }) => {
  await page.goto(server.url);
  const overlay = await revealOverlay(page);
  const original = await readGeometry(page);

  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 - 40, box.y + box.height * 0.5 - 100, { steps: 6 });
  await page.mouse.up();
  const moved = await readGeometry(page);
  expect(moved.y).not.toBeCloseTo(original.y, 3);

  const undo = page.getByRole('button', { name: /撤销/ });
  const redo = page.getByRole('button', { name: /重做/ });
  await expect(undo).toBeEnabled();

  await undo.click();
  const restored = await readGeometry(page);
  expect(restored.x).toBeCloseTo(original.x, 4);
  expect(restored.y).toBeCloseTo(original.y, 4);
  expect(restored.width).toBeCloseTo(original.width, 4);
  expect(restored.height).toBeCloseTo(original.height, 4);

  await expect(redo).toBeEnabled();
  await redo.click();
  const redone = await readGeometry(page);
  expect(redone.x).toBeCloseTo(moved.x, 4);
  expect(redone.y).toBeCloseTo(moved.y, 4);
});

test('keyboard arrows nudge the focused overlay by one percent', async ({ page }) => {
  await page.goto(server.url);
  const overlay = await revealOverlay(page);
  const before = await readGeometry(page);
  await overlay.focus();
  await page.keyboard.press('ArrowUp');
  const after = await readGeometry(page);
  expect(after.y).toBeCloseTo(before.y - 0.01, 4);
  expect(after.width).toBeCloseTo(before.width, 5);
});

test('geometry persists through a server save and reload, segments untouched', async ({ page }) => {
  await page.goto(server.url);
  await revealOverlay(page);
  // Set a distinctive geometry and mark it dirty, then save to the server.
  await page.evaluate(() => {
    setPreviewGeometry({ x: 0.12, y: 0.34, width: 0.5, height: 0.2 }, { markDirty: true });
  });
  const saved = await readGeometry(page);

  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(() => page.evaluate(() => previewGeometryDirty)).toBe(false);

  // The on-disk project must carry the normalized geometry and unchanged segment timing.
  const onDisk = JSON.parse(readFileSync(projectPath, 'utf-8'));
  expect(onDisk.preview.subtitle.x).toBeCloseTo(saved.x, 4);
  expect(onDisk.preview.subtitle.y).toBeCloseTo(saved.y, 4);
  expect(onDisk.preview.subtitle.width).toBeCloseTo(saved.width, 4);
  expect(onDisk.preview.subtitle.height).toBeCloseTo(saved.height, 4);
  // buildJson normalizes segment shape (adds null sticker/color fields); assert only
  // that timing and text — the fields preview geometry must never touch — are intact.
  expect(onDiskSegmentTiming(onDisk.segments)).toEqual(EXPECTED_SEGMENTS);

  // Reload the page: the server re-renders from disk, so geometry survives.
  await page.reload();
  await revealOverlay(page);
  const reloaded = await readGeometry(page);
  expect(reloaded.x).toBeCloseTo(saved.x, 4);
  expect(reloaded.y).toBeCloseTo(saved.y, 4);
  expect(reloaded.width).toBeCloseTo(saved.width, 4);
  expect(reloaded.height).toBeCloseTo(saved.height, 4);
  expect(await readSegments(page)).toEqual(EXPECTED_SEGMENTS);
});

// ===========================================================================
// Portable blank-editor.html — import project+media, edit geometry through the
// real user surface, export project JSON, reimport it, observe same geometry
// with unchanged segment timing. No server; download captured via page events.
// ===========================================================================
test.describe('portable HTML', () => {
  let portableDir;
  let portableStaticServer;
  let blankHtmlPath;
  let portableProjectPath;
  let portableWavPath;

  test.beforeAll(async () => {
    portableDir = makeTempDir('preview-geometry-portable');
    portableWavPath = join(portableDir, 'synthetic.wav');
    portableProjectPath = join(portableDir, 'project.json');
    blankHtmlPath = join(portableDir, 'blank-editor.html');
    generateWav(portableWavPath, DURATION_MS / 1000);
    generateProjectJson(portableProjectPath);
    generateBlankEditor(blankHtmlPath);
    portableStaticServer = await startStaticServer(blankHtmlPath, await findFreePort());
  });

  test.afterAll(async () => {
    await portableStaticServer?.stop();
    cleanupTempDir(portableDir);
  });

  // Load project JSON + media WAV through the actual file inputs / media modal.
  async function loadProjectAndMedia(page, projectPath) {
    await page.locator('#open-project-file').setInputFiles(projectPath);
    const mediaModal = page.locator('#project-media-modal');
    await mediaModal.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#project-media-select').click();
    await page.locator('#load-media-file').setInputFiles(portableWavPath);
    await page.waitForFunction(() => {
      const p = document.getElementById('player');
      const src = p?.currentSrc || p?.querySelector('source')?.getAttribute('src');
      return Boolean(src && src.trim());
    }, { timeout: 10_000 });
    await mediaModal.waitFor({ state: 'hidden', timeout: 5000 });
  }

  test('geometry survives export + reimport through the real UI, segments untouched', async ({ page }) => {
    // Force the anchor-download fallback so the export is deterministically
    // captured by Playwright's download event in headless Chromium.
    await page.addInitScript(() => { delete window.showSaveFilePicker; });
    await page.goto(portableStaticServer.url);
    await loadProjectAndMedia(page, portableProjectPath);

    const overlay = await revealOverlay(page);
    const segmentsBefore = await readSegments(page);
    expect(segmentsBefore).toEqual(EXPECTED_SEGMENTS);

    // --- Drag the overlay body up through the user surface ---
    const box = await overlay.boundingBox();
    expect(box).not.toBeNull();
    const beforeDrag = await readGeometry(page);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5 - 40, box.y + box.height * 0.5 - 110, { steps: 8 });
    await page.mouse.up();
    const afterDrag = await readGeometry(page);
    expect(afterDrag.y).toBeLessThan(beforeDrag.y);

    // --- Resize with the south-east handle through the user surface ---
    await overlay.hover();
    const handle = overlay.locator('.overlay-handle[data-handle="se"]');
    const hb = await handle.boundingBox();
    expect(hb).not.toBeNull();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x - 80, hb.y - 30, { steps: 6 });
    await page.mouse.up();

    const edited = await readGeometry(page);
    // Editing must never touch segment timing.
    expect(await readSegments(page)).toEqual(EXPECTED_SEGMENTS);

    // --- Export project JSON via the real "导出工程" (#download-json) button ---
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download-json').click();
    const download = await downloadPromise;
    const exportedPath = join(portableDir, 'exported.json');
    await download.saveAs(exportedPath);

    // The exported file carries the edited geometry and unchanged timing.
    const exported = JSON.parse(readFileSync(exportedPath, 'utf-8'));
    expect(exported.preview.subtitle.x).toBeCloseTo(edited.x, 4);
    expect(exported.preview.subtitle.y).toBeCloseTo(edited.y, 4);
    expect(exported.preview.subtitle.width).toBeCloseTo(edited.width, 4);
    expect(exported.preview.subtitle.height).toBeCloseTo(edited.height, 4);
    expect(onDiskSegmentTiming(exported.segments)).toEqual(EXPECTED_SEGMENTS);

    // --- Reimport the downloaded JSON through #open-project-file ---
    // (Fresh reload so the reimport starts from the legacy default, proving the
    // observed geometry comes from the file, not leftover in-memory state.)
    await page.reload();
    await page.locator('#open-project-file').setInputFiles(exportedPath);
    // Media is named in the project; a media modal may appear — dismiss by
    // selecting the WAV so load completes, but geometry is already applied.
    const mediaModal = page.locator('#project-media-modal');
    if (await mediaModal.isVisible().catch(() => false)) {
      await page.locator('#project-media-select').click();
      await page.locator('#load-media-file').setInputFiles(portableWavPath);
      await mediaModal.waitFor({ state: 'hidden', timeout: 5000 });
    }

    const reimported = await readGeometry(page);
    expect(reimported.x).toBeCloseTo(edited.x, 4);
    expect(reimported.y).toBeCloseTo(edited.y, 4);
    expect(reimported.width).toBeCloseTo(edited.width, 4);
    expect(reimported.height).toBeCloseTo(edited.height, 4);
    expect(await readSegments(page)).toEqual(EXPECTED_SEGMENTS);
  });
});
