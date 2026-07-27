// Waveform deletion identity regression — shared scenario suite.
// Runs identical assertions against both localhost server and portable HTML.
// All selection is through real waveform pointer/click actions (no force).
// All waits are on observable DOM/DATA state (no arbitrary sleeps).
import { test, expect } from '@playwright/test';
import {
  makeTempDir,
  cleanupTempDir,
  findFreePort,
  generateWav,
  generateProjectJson,
  generateBlankEditor,
  startServer,
  startStaticServer,
  DURATION_MS,
} from './helpers.mjs';
import { join } from 'node:path';

// ===========================================================================
// Shared page utilities — used by both adapter suites.
// ===========================================================================

// Set waveform to multi-row mode with 5s/row via localStorage before page scripts run.
// 60s duration / 5s per row = 12 rows; viewport shows ~3-4 → forces virtualization.
async function configureMultiRowMode(page) {
  await page.addInitScript(() => {
    const settings = {
      mode: 'multi',
      layout: 'wave-right',
      visibleSeconds: 20,
      secondsPerRow: 5,
      side: 'left',
      splitPercent: 60,
      layoutColumnPercent: 58,
      layoutRows: [42, 18, 40],
      freeOrder: ['player', 'panel', 'cues', 'wave'],
      layoutTree: null,
      layoutEditing: false,
      waveformScale: 1,
      disabledDisplay: 'dim',
    };
    localStorage.setItem('moy.asr.waveform.settings.v1', JSON.stringify(settings));
  });
}

// Wait for waveform cue blocks to render. In multi-row mode, segments that
// span multiple rows produce multiple blocks with the same data-idx, and only
// segments in the current viewport + overscan are rendered. We wait for at
// least one block to confirm the waveform is ready.
async function waitForWaveformCues(page) {
  await page.waitForSelector('.waveform-cue-block', { state: 'visible', timeout: 15_000 });
}

// Scroll the waveform to bring the row containing `segmentStartMs` into view.
// Uses the real #waveform-scroll container's scrollTop property.
async function scrollToSegment(page, segmentStartMs) {
  await page.evaluate((startMs) => {
    const secondsPerRow = 5;
    const rowIndex = Math.floor(startMs / 1000 / secondsPerRow);
    const stride = 96 + 10; // ROW_HEIGHT + ROW_GAP
    const scroll = document.getElementById('waveform-scroll');
    if (scroll) {
      scroll.scrollTop = rowIndex * stride;
    }
  }, segmentStartMs);
}

// Scroll waveform to top (row 0).
async function scrollToTop(page) {
  await page.evaluate(() => {
    const scroll = document.getElementById('waveform-scroll');
    if (scroll) scroll.scrollTop = 0;
  });
}

// Scroll waveform to the far end (last row) — used to force unmount of
// segments near the beginning/middle that would remain in overscan at scrollTop=0.
async function scrollToBottom(page) {
  await page.evaluate(() => {
    const scroll = document.getElementById('waveform-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  });
}

// Verify a waveform cue block exists in the DOM (rendered by virtualization).
async function expectCueBlockExists(page, idx) {
  await page.waitForSelector(`.waveform-cue-block[data-idx="${idx}"]`, { state: 'attached', timeout: 5000 });
}

// Verify a waveform cue block is NOT in the DOM (unmounted by virtualization).
async function expectCueBlockAbsent(page, idx) {
  await expect(page.locator(`.waveform-cue-block[data-idx="${idx}"]`)).toHaveCount(0, { timeout: 5000 });
}

// Click a waveform cue block (real click, no force). Waits for the block to
// be visible and stable first.  Returns after selection is confirmed.
async function clickWaveformCue(page, idx) {
  const block = page.locator(`.waveform-cue-block[data-idx="${idx}"]`);
  await block.first().click();
  // Wait for selection to be reflected in the cue list (observable state)
  await page.waitForSelector(`.cue[data-idx="${idx}"].selected`, { timeout: 5000 });
}

// Ctrl+click a waveform cue block to toggle it into the selection.
async function ctrlClickWaveformCue(page, idx) {
  const block = page.locator(`.waveform-cue-block[data-idx="${idx}"]`);
  await block.first().click({ modifiers: ['Control'] });
  // Wait for the selected class to appear on this block in the cue list
  await page.waitForSelector(`.cue[data-idx="${idx}"].selected`, { timeout: 5000 });
}

// Shift+click a waveform cue block to select a range.
async function shiftClickWaveformCue(page, idx) {
  const block = page.locator(`.waveform-cue-block[data-idx="${idx}"]`);
  await block.first().click({ modifiers: ['Shift'] });
  // Wait for selection count to update
  await page.waitForFunction(
    (expected) => {
      const count = document.querySelectorAll('.cue.selected').length;
      return count >= expected;
    },
    2,
    { timeout: 5000 },
  );
}

// Read the text of all segments from DATA (observable JS state).
async function getSegmentTexts(page) {
  return page.evaluate(() => DATA.segments.map((s) => s.text));
}

// Read the selected indices from the cue list DOM.
async function getSelectedIndices(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.cue.selected')].map((el) => Number(el.dataset.idx)).sort((a, b) => a - b),
  );
}

// Press Delete and wait for the expected segment count to be reached.
async function pressDeleteAndWait(page, expectedSegmentCount) {
  await page.keyboard.press('Delete');
  await page.waitForFunction(
    (expected) => DATA.segments.length === expected,
    expectedSegmentCount,
    { timeout: 5000 },
  );
}

// Press Delete and verify the project is NOT mutated (all-delete refusal).
async function pressDeleteAndExpectRefusal(page, expectedSegmentCount) {
  await page.keyboard.press('Delete');
  // Wait for the refusal hint to appear
  await page.waitForFunction(
    () => {
      const hint = document.getElementById('hint');
      return hint && hint.textContent.includes('不能删除全部字幕');
    },
    { timeout: 5000 },
  );
  // Verify segment count is unchanged
  await page.waitForFunction(
    (expected) => DATA.segments.length === expected,
    expectedSegmentCount,
    { timeout: 2000 },
  );
}

// Collect all console errors during a test.
function attachErrorCollector(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

// ===========================================================================
// Localhost server adapter
// ===========================================================================
let localhostDir, localhostServer, localhostPort, wavPath, projectPath;

test.beforeAll(async () => {
  localhostDir = makeTempDir('localhost');
  wavPath = join(localhostDir, 'synthetic.wav');
  projectPath = join(localhostDir, 'project.json');
  generateWav(wavPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  localhostPort = await findFreePort();
  localhostServer = await startServer(projectPath, wavPath, localhostPort);
});

test.afterAll(async () => {
  await localhostServer?.stop();
  cleanupTempDir(localhostDir);
});

test.describe('localhost server', () => {
  test.beforeEach(async ({ page }) => {
    // Each test gets a fresh page; the shared scenarios are run as subtests
  });

  // We use a single test that runs all scenarios to share the page context
  // (each scenario needs a fresh project state, so we reload between scenarios)
  test('all waveform deletion scenarios', async ({ page }) => {
    // The scenarios are defined as inline assertions within this test
    // because each needs a fresh project load (reload page)

    // --- Scenario 1: Delete middle (Delta, idx 3) after virtual scroll ---
    // Delta is at 30s (row 6 at 5s/row), far enough from top to unmount when
    // scrolled away — proving virtual scroll doesn't corrupt selection identity.
    await configureMultiRowMode(page);
    const errors = attachErrorCollector(page);
    await page.goto(localhostServer.url);
    await waitForWaveformCues(page);

    // Scroll to Delta, verify present, scroll to opposite end, verify unmount, scroll back, verify remount
    await scrollToSegment(page, 150000);
    await expectCueBlockExists(page, 3);
    await scrollToBottom(page);
    await expectCueBlockAbsent(page, 3);
    await scrollToSegment(page, 150000);
    await expectCueBlockExists(page, 3);

    await clickWaveformCue(page, 3);
    expect(await getSelectedIndices(page), 'selected before delete').toEqual([3]);
    await pressDeleteAndWait(page, 5);
    expect(await getSegmentTexts(page), 'remaining after Delta').toEqual([
      'Alpha', 'Bravo', 'Charlie', 'Echo', 'Foxtrot',
    ]);
    expect(errors, 'no console errors (middle delete after vscroll)').toEqual([]);

    // --- Scenario 2: Delete first (Alpha) on fresh load ---
    await page.reload();
    await waitForWaveformCues(page);
    await scrollToTop(page);
    await expectCueBlockExists(page, 0);
    await clickWaveformCue(page, 0);
    expect(await getSelectedIndices(page), 'selected before delete').toEqual([0]);
    await pressDeleteAndWait(page, 5);
    expect(await getSegmentTexts(page), 'remaining after Alpha').toEqual([
      'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
    ]);
    expect(errors, 'no console errors (first delete)').toEqual([]);

    // --- Scenario 3: Delete last (Foxtrot) after virtual scroll ---
    await page.reload();
    await waitForWaveformCues(page);
    await scrollToSegment(page, 250000);
    await expectCueBlockExists(page, 5);
    await scrollToTop(page);
    await expectCueBlockAbsent(page, 5);
    await scrollToSegment(page, 250000);
    await expectCueBlockExists(page, 5);
    await clickWaveformCue(page, 5);
    expect(await getSelectedIndices(page), 'selected before delete').toEqual([5]);
    await pressDeleteAndWait(page, 5);
    expect(await getSegmentTexts(page), 'remaining after Foxtrot').toEqual([
      'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo',
    ]);
    expect(errors, 'no console errors (last delete)').toEqual([]);

    // --- Scenario 4: Multi-delete (Alpha + Charlie) via Ctrl+click ---
    await page.reload();
    await waitForWaveformCues(page);
    await scrollToTop(page);
    await clickWaveformCue(page, 0);
    await scrollToSegment(page, 100000);
    await expectCueBlockExists(page, 2);
    await ctrlClickWaveformCue(page, 2);
    expect(await getSelectedIndices(page), 'multi-selected').toEqual([0, 2]);
    await pressDeleteAndWait(page, 4);
    expect(await getSegmentTexts(page), 'remaining after Alpha+Charlie').toEqual([
      'Bravo', 'Delta', 'Echo', 'Foxtrot',
    ]);
    expect(errors, 'no console errors (multi-delete)').toEqual([]);

    // --- Scenario 5: All-delete refused via Shift+click ---
    await page.reload();
    await waitForWaveformCues(page);
    await scrollToTop(page);
    await clickWaveformCue(page, 0);
    await scrollToSegment(page, 250000);
    await expectCueBlockExists(page, 5);
    await shiftClickWaveformCue(page, 5);
    expect(await getSelectedIndices(page), 'all selected').toEqual([0, 1, 2, 3, 4, 5]);
    const beforeTexts = await getSegmentTexts(page);
    await pressDeleteAndExpectRefusal(page, 6);
    expect(await getSegmentTexts(page), 'all-delete refused, no mutation').toEqual(beforeTexts);
    expect(errors, 'no console errors (all-delete refusal)').toEqual([]);
  });
});

// ===========================================================================
// Portable HTML adapter — loads project JSON + synthetic WAV via real UI
// ===========================================================================
let portableDir, portableStaticServer, portablePort, blankHtmlPath, portableProjectPath, portableWavPath;

test.beforeAll(async () => {
  portableDir = makeTempDir('portable');
  portableWavPath = join(portableDir, 'synthetic.wav');
  portableProjectPath = join(portableDir, 'project.json');
  blankHtmlPath = join(portableDir, 'blank-editor.html');
  generateWav(portableWavPath, DURATION_MS / 1000);
  generateProjectJson(portableProjectPath);
  generateBlankEditor(blankHtmlPath);
  portablePort = await findFreePort();
  portableStaticServer = await startStaticServer(blankHtmlPath, portablePort);
});

test.afterAll(async () => {
  await portableStaticServer?.stop();
  cleanupTempDir(portableDir);
});

// Helper: load project JSON + media WAV via the real file-input/modal flow.
async function loadProjectAndMedia(page) {
  // 1. Load project JSON via #open-project-file
  await page.locator('#open-project-file').setInputFiles(portableProjectPath);

  // 2. Media modal appears — click "选择媒体" to load WAV
  const mediaModal = page.locator('#project-media-modal');
  await mediaModal.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#project-media-select').click();

  // 3. Load media WAV via #load-media-file
  await page.locator('#load-media-file').setInputFiles(portableWavPath);

  // 4. Wait for media to be loaded (player has a source)
  await page.waitForFunction(
    () => {
      const p = document.getElementById('player');
      const src = p?.currentSrc || p?.querySelector('source')?.getAttribute('src');
      return Boolean(src && src.trim());
    },
    { timeout: 10_000 },
  );

  // 5. Wait for modal to be hidden
  await mediaModal.waitFor({ state: 'hidden', timeout: 5000 });
}

test.describe('portable HTML', () => {
  test('all waveform deletion scenarios', async ({ page }) => {
    await configureMultiRowMode(page);
    const errors = attachErrorCollector(page);
    await page.goto(portableStaticServer.url);
    await loadProjectAndMedia(page);
    await waitForWaveformCues(page);

    // --- Scenario 1: Delete middle (Delta, idx 3) after virtual scroll ---
    await scrollToSegment(page, 150000);
    await expectCueBlockExists(page, 3);
    await scrollToBottom(page);
    await expectCueBlockAbsent(page, 3);
    await scrollToSegment(page, 150000);
    await expectCueBlockExists(page, 3);
    await clickWaveformCue(page, 3);
    expect(await getSelectedIndices(page), 'selected before delete').toEqual([3]);
    await pressDeleteAndWait(page, 5);
    expect(await getSegmentTexts(page), 'remaining after Delta').toEqual([
      'Alpha', 'Bravo', 'Charlie', 'Echo', 'Foxtrot',
    ]);
    expect(errors, 'no console errors (middle delete after vscroll)').toEqual([]);

    // --- Scenario 2: Delete first (Alpha) on fresh load ---
    await page.goto(portableStaticServer.url);
    await loadProjectAndMedia(page);
    await waitForWaveformCues(page);
    await scrollToTop(page);
    await expectCueBlockExists(page, 0);
    await clickWaveformCue(page, 0);
    expect(await getSelectedIndices(page), 'selected before delete').toEqual([0]);
    await pressDeleteAndWait(page, 5);
    expect(await getSegmentTexts(page), 'remaining after Alpha').toEqual([
      'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
    ]);
    expect(errors, 'no console errors (first delete)').toEqual([]);

    // --- Scenario 3: Delete last (Foxtrot) after virtual scroll ---
    await page.goto(portableStaticServer.url);
    await loadProjectAndMedia(page);
    await waitForWaveformCues(page);
    await scrollToSegment(page, 250000);
    await expectCueBlockExists(page, 5);
    await scrollToTop(page);
    await expectCueBlockAbsent(page, 5);
    await scrollToSegment(page, 250000);
    await expectCueBlockExists(page, 5);
    await clickWaveformCue(page, 5);
    expect(await getSelectedIndices(page), 'selected before delete').toEqual([5]);
    await pressDeleteAndWait(page, 5);
    expect(await getSegmentTexts(page), 'remaining after Foxtrot').toEqual([
      'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo',
    ]);
    expect(errors, 'no console errors (last delete)').toEqual([]);

    // --- Scenario 4: Multi-delete (Alpha + Charlie) via Ctrl+click ---
    await page.goto(portableStaticServer.url);
    await loadProjectAndMedia(page);
    await waitForWaveformCues(page);
    await scrollToTop(page);
    await clickWaveformCue(page, 0);
    await scrollToSegment(page, 100000);
    await expectCueBlockExists(page, 2);
    await ctrlClickWaveformCue(page, 2);
    expect(await getSelectedIndices(page), 'multi-selected').toEqual([0, 2]);
    await pressDeleteAndWait(page, 4);
    expect(await getSegmentTexts(page), 'remaining after Alpha+Charlie').toEqual([
      'Bravo', 'Delta', 'Echo', 'Foxtrot',
    ]);
    expect(errors, 'no console errors (multi-delete)').toEqual([]);

    // --- Scenario 5: All-delete refused via Shift+click ---
    await page.goto(portableStaticServer.url);
    await loadProjectAndMedia(page);
    await waitForWaveformCues(page);
    await scrollToTop(page);
    await clickWaveformCue(page, 0);
    await scrollToSegment(page, 250000);
    await expectCueBlockExists(page, 5);
    await shiftClickWaveformCue(page, 5);
    expect(await getSelectedIndices(page), 'all selected').toEqual([0, 1, 2, 3, 4, 5]);
    const beforeTexts = await getSegmentTexts(page);
    await pressDeleteAndExpectRefusal(page, 6);
    expect(await getSegmentTexts(page), 'all-delete refused, no mutation').toEqual(beforeTexts);
    expect(errors, 'no console errors (all-delete refusal)').toEqual([]);
  });
});
