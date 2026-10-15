import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';
let server, tempDir;
test.beforeAll(async () => {
  tempDir = makeTempDir('split-styles');
  const media = join(tempDir, 'synthetic.wav'), project = join(tempDir, 'project.mosp');
  generateWav(media, 8);
  writeFileSync(project, JSON.stringify({ media, waveform: generateWaveformPayload(8000),
    segments: [{ id: 'a', start: 1000, end: 5000, text: '甲乙丙丁' }] }), 'utf8');
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({
    autoSaveProject: false, assMode: true, assSpecialSymbolRule: 'both', assEmphasisSyntax: 'both',
  })));
  await page.goto(server.url);
  await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
  await page.evaluate(() => {
    MaweSettings.updateEditorSettings({ autoSaveProject: false,
      assMode: true, assSpecialSymbolRule: 'both', assEmphasisSyntax: 'both' });
    const toggle = document.getElementById('ass-mode-toggle');
    toggle.checked = true; toggle.dispatchEvent(new Event('change'));
  });
});

async function seed(page, role = 'main') {
  await page.evaluate((role) => {
    const cue = (id) => ({ id, start: 1000, end: 5000, text: '**甲乙**',
      items: [{ text: '**甲乙**', start: 1000, end: 5000 }] });
    MaweBoot.DATA.segments = [cue('a')];
    MaweBoot.DATA.overlay_track = { enabled: true, segments: role === 'overlay' ? [cue('o')] : [] };
    MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: ['extension', 'linked'].includes(role),
      display_mode: 'both', tracks: [{ id: 'e', role: 'extension', name: '译文', split_mode: 'continuous', segments: [cue('b')] }],
      bindings: role === 'linked' ? [{ id: 'bind', track_id: 'e', main_segment_ids: ['a'], extension_segment_ids: ['b'] }] : [] };
    MaweMultiSubtitleCore.normalizeMultiSubtitleState();
    MaweSelection.clearSelection({ silent: true });
    MaweCuePanel.renderAll({ waveform: 'full' });
  }, role);
}

for (const role of ['main', 'extension', 'overlay', 'linked']) {
  test(`paired-style modal preview and actual ${role} split agree, keep speech timing and undo`, async ({ page }) => {
    await seed(page, role);
    const opened = await page.evaluate((role) => {
      if (role === 'extension') return MaweSplitCore.openExtensionSplitModal(0, 3000);
      if (role === 'overlay') return openOverlaySplitModal(0, 3000);
      if (role === 'linked') {
        MaweSplitContext.splitFromContextMenu(0, 10, 10, 3000);
        return MaweSplitCore.pendingLinkedSplit?.kind === 'linked';
      }
      return MaweSplitCore.openMainWaveformSplitModal(0, 3000);
    }, role);
    expect(opened).toBe(true);
    await page.evaluate((role) => MaweSplitCore.updateLinkedSplitPreview(3,
      ['extension', 'overlay'].includes(role) ? 'extension' : 'main'), role);
    await expect(page.locator('#multi-subtitle-split-preview')).toContainText('**甲**');
    await expect(page.locator('#multi-subtitle-split-preview')).toContainText('**乙**');
    await page.locator('#multi-subtitle-split-confirm').click();
    const result = await page.evaluate((role) => {
      const tracks = role === 'overlay' ? [MaweBoot.DATA.overlay_track.segments]
        : role === 'extension' ? [MaweBoot.DATA.multi_subtitle.tracks[0].segments]
          : role === 'linked' ? [MaweBoot.DATA.segments, MaweBoot.DATA.multi_subtitle.tracks[0].segments]
            : [MaweBoot.DATA.segments];
      return tracks.map(segments => segments.map(({ text, start, end, items }) => ({ text, start, end, items })));
    }, role);
    for (const segments of result) {
      expect(segments.map(s => s.text)).toEqual(['**甲**', '**乙**']);
      expect(segments.map(s => [s.start, s.end])).toEqual([[1000, 3000], [3000, 5000]]);
      expect(segments.flatMap(s => s.items).map(i => i.text).join('')).toBe('**甲乙**');
      expect(segments[0].items[0].end).toBe(3000);
      expect(segments[1].items[0].start).toBe(3000);
    }
    await page.locator('#undo-btn').click();
    const restored = await page.evaluate((role) => (role === 'overlay' ? MaweBoot.DATA.overlay_track.segments
      : role === 'extension' ? MaweBoot.DATA.multi_subtitle.tracks[0].segments : MaweBoot.DATA.segments), role);
    expect(restored.map(s => s.text)).toEqual(['**甲乙**']);
    expect(restored[0].items.map(({ text, start, end }) => ({ text, start, end })))
      .toEqual([{ text: '**甲乙**', start: 1000, end: 5000 }]);
  });
}

for (const includeMarkers of [false, true]) {
  test(`caret inside opening marker moves it to its paired side, items include markers=${includeMarkers}`, async ({ page }) => {
    await page.evaluate((includeMarkers) => {
      MaweBoot.DATA.segments = [{ id: 'a', start: 1000, end: 4000, text: '甲++乙丙++',
        items: [{ text: includeMarkers ? '甲++乙丙++' : '甲乙丙', start: 1000, end: 4000 }] }];
      MaweCuePanel.renderAll({ waveform: 'full' });
    }, includeMarkers);
    const text = page.locator('.cue[data-idx="0"] .text');
    await text.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, view: window,
        clientX: rect.left + 2, clientY: rect.top + rect.height / 2 }));
    });
    await expect(text).toHaveAttribute('contenteditable', 'plaintext-only');
    await text.evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild, 2); range.collapse(true);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.press('Enter');
    const segments = await page.evaluate(() => MaweBoot.DATA.segments);
    expect(segments.map(s => s.text)).toEqual(['甲', '++乙丙++']);
    expect(segments.map(s => [s.start, s.end])).toEqual([[1000, 2000], [2000, 4000]]);
    expect(segments.flatMap(s => s.items).map(i => i.text).join('')).toBe(includeMarkers ? '甲++乙丙++' : '甲乙丙');
  });
}

for (const includeMarkers of [false, true]) {
  test(`same-style nested split keeps actual ASS runs emphasized, items include markers=${includeMarkers}`, async ({ page }) => {
    await page.evaluate((includeMarkers) => {
      MaweBoot.DATA.segments = [{ id: 'nested', start: 1000, end: 5000, text: '**a*bc*d**',
        items: [{ text: includeMarkers ? '**a*bc*d**' : 'abcd', start: 1000, end: 5000 }] }];
      MaweCuePanel.renderAll({ waveform: 'full' });
      MaweSplitCore.openMainWaveformSplitModal(0, 3000);
      MaweSplitCore.updateLinkedSplitPreview(5, 'main');
    }, includeMarkers);
    await expect(page.locator('#multi-subtitle-split-preview')).toContainText('**ab**');
    await expect(page.locator('#multi-subtitle-split-preview')).toContainText('**cd**');
    await page.locator('#multi-subtitle-split-confirm').click();
    const output = await page.evaluate(() => ({
      segments: MaweBoot.DATA.segments,
      runs: MaweBoot.DATA.segments.flatMap(segment => window.AsrEditorUtils.assInlineStyleRuns(
        segment.text, MaweSettings.EDITOR_SETTINGS.assEmphasisSyntax, MaweSettings.EDITOR_SETTINGS)),
    }));
    expect(output.runs.map(run => run.text).join('')).toBe('abcd');
    expect(output.runs.every(run => run.emphasized)).toBe(true);
    expect(output.segments.map(segment => [segment.start, segment.end])).toEqual([[1000, 3000], [3000, 5000]]);
    expect(output.segments.flatMap(segment => segment.items).map(item => item.text).join(''))
      .toBe(includeMarkers ? '**a*bc*d**' : 'abcd');
  });
}

test('fade splits into two complete sentence effects without inventing timed words', async ({ page }) => {
  await page.evaluate(() => {
    MaweBoot.DATA.segments = [{ id: 'a', start: 1000, end: 5000, text: '>>甲乙<<',
      items: [{ text: '甲', start: 1000, end: 3000 }, { text: '乙', start: 3000, end: 5000 }] }];
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweSplitContext.splitFromContextMenu(0, 10, 10, 3000);
  });
  const segments = await page.evaluate(() => MaweBoot.DATA.segments);
  expect(segments.map(s => s.text)).toEqual(['>>甲<<', '>>乙<<']);
  expect(segments.map(s => [s.start, s.end])).toEqual([[1000, 3000], [3000, 5000]]);
  expect(segments.flatMap(s => s.items).map(({ text, start, end }) => ({ text, start, end })))
    .toEqual([{ text: '甲', start: 1000, end: 3000 }, { text: '乙', start: 3000, end: 5000 }]);
});

test('ordered style toggles, custom wrapping, scope changes and options preserve expanded previews', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    MaweBoot.DATA.segments = [{ id: 'a', start: 1000, end: 3000, text: ' 甲 ' },
      { id: 'b', start: 3000, end: 5000, text: ' 乙 ' }];
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweSelection.selectOnly(0);
    MaweTextProcess.openTextProcessModal();
  });
  const preset = id => page.locator(`[data-wrap-preset-id="${id}"]`);
  await page.locator('#text-process-trim').check();
  await page.locator('.text-process-preview-toggle').click();
  await preset('emphasis').click();
  await preset('large').click();
  await preset('custom').click();
  await page.locator('#text-process-prefix-input').fill('【');
  await page.locator('#text-process-suffix-input').fill('】');
  await expect(page.locator('#text-process-preview details[open]')).toHaveCount(1);
  await expect(page.locator('#text-process-preview')).toContainText('**++【甲】++**');
  await expect(preset('emphasis')).toHaveAttribute('aria-pressed', 'true');
  await expect(preset('large')).toHaveAttribute('aria-pressed', 'true');
  await expect(preset('custom')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#text-process-selected-only').uncheck();
  await expect(page.locator('#text-process-preview details[open]')).toHaveCount(2);
  await page.locator('#text-process-capitalize').check();
  await expect(page.locator('#text-process-preview details[open]')).toHaveCount(2);
  await preset('emphasis').click();
  await preset('emphasis').click();
  await expect(page.locator('#text-process-preview')).toContainText('++【**甲**】++');
  await expect(page.locator('#text-process-preview details[open]')).toHaveCount(2);
  await page.locator('#text-process-modal .modal').screenshot({ path: testInfo.outputPath('text-process-multistyle.png') });
  await page.locator('#text-process-confirm').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments.map(s => s.text))).toEqual(['++【**甲**】++', '++【**乙**】++']);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments.map(s => s.text))).toEqual([' 甲 ', ' 乙 ']);
});
