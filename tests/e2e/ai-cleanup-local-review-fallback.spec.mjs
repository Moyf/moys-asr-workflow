import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload, generateWav, makeTempDir, startServer } from './helpers.mjs';

test('two consecutive failed local mappings survive actual marker UI, save and reopening', async ({ page }) => {
  const directory = makeTempDir('ai-local-two-review');
  let server;
  try {
    const mediaPath = join(directory, 'synthetic.wav');
    const projectPath = join(directory, 'review.mosp');
    generateWav(mediaPath, 6);
    writeFileSync(projectPath, JSON.stringify({ media: 'synthetic.wav', waveform: generateWaveformPayload(6000),
      segments: [{ id: 'initial', start: 0, end: 1000, text: '初始', items: [{ text: '初始', start: 0, end: 1000 }] }] }), 'utf8');
    server = await startServer(projectPath, mediaPath, await findFreePort());
    await disableOnboarding(page);
    await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
    await page.goto(server.url);
    await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
    const snapshot = await page.evaluate(() => {
      const rows = [['我', 0, 110], ['我这个', 130, 400], ['，', 410, 430], ['功能', 500, 800],
        ['嗯', 810, 930], ['很好', 1000, 1200], ['呢', 1300, 2000]];
      const segment = (id, offset) => ({ id, start: offset, end: offset + 2000,
        text: rows.map(([text]) => text).join(''),
        items: rows.map(([text, start, end]) => ({ text, start: start + offset, end: end + offset })) });
      const ranges = (id, offset) => [
        { start: offset, end: offset + 110, cleanup_scope: { segment_id: id, item_start: 0, item_end: 1, text: '我' } },
        { start: offset + 810, end: offset + 930, cleanup_scope: { segment_id: id, item_start: 4, item_end: 5, text: '嗯' } },
      ];
      AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments = [{ id: 'lead', start: 0, end: 2000, text: '前文', items: [{ text: '前文', start: 0, end: 2000 }] },
        segment('first', 0), segment('second', 1000)];
      MaweBoot.DATA.gap_remove = { provenance: { sources: {
        ai_cleanup: [...ranges('first', 0), ...ranges('second', 1000)],
        audio_gate: [{ start: 810, end: 930 }], script_alignment: [{ start: 3000, end: 3050 }],
      }, manual_overrides: [{ id: 'manual-late', start: 1500, end: 1600, removed: true }] } };
      MaweBoot.DATA.markers = [
        { id: 'ordinary', start: 810, end: 930, name: '用户标记', note: '用户备注', color: '#ffffff' },
        { id: 'ai-first', start: 0, end: 110, name: 'AI', note: '[AI] 删除：口吃', color: '#8e4ec6' },
        { id: 'ai-second', start: 1810, end: 1930, name: 'AI', note: '[AI] 删除：填充词', color: '#8e4ec6' },
      ];
      const incoming = MaweBoot.DATA.gap_remove.provenance.sources.ai_cleanup.every((range) => {
        const cue = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.find((item) => item.id === range.cleanup_scope.segment_id);
        return AsrGapRemoveCore.getCleanupScopeItems(cue, range).length > 0;
      });
      MaweJsonRepair.normalizeProjectTimings(MaweBoot.DATA);
      MaweMarkersPanel.openPanel();
      return { incoming, array: Array.isArray(MaweBoot.DATA.markers), markers: MaweBoot.DATA.markers,
        gap: AsrGapRemoveCore.normalizeGapRemoveData(MaweBoot.DATA.gap_remove),
        texts: MaweExportSrt.cleanupMainSegments().map((cue) => cue.text), srt: MaweExportSrt.buildSrt() };
    });
    expect(snapshot.incoming).toBe(true);
    expect(snapshot.array).toBe(true);
    expect(snapshot.gap.provenance.sources.ai_cleanup).toHaveLength(0);
    expect(snapshot.markers.filter((item) => item.review?.status === 'pending')).toHaveLength(4);
    expect(snapshot.markers.find((item) => item.id === 'ordinary').note).toBe('用户备注');
    expect(snapshot.texts.slice(1)).toEqual(['我我这个，功能嗯很好呢', '我我这个，功能嗯很好呢']);
    expect(snapshot.srt).toContain('嗯');
    await expect(page.locator('[data-marker-id="ordinary"]')).toBeVisible();
    await expect(page.locator('[data-marker-id="ai-first"]')).toContainText('待复核');
    await expect(page.locator('[data-marker-id="ai-second"]')).toContainText('待复核');
    await page.locator('[data-marker-id="ai-second"]').screenshot({ path: test.info().outputPath('consecutive-review-marker.png') });
    writeFileSync(test.info().outputPath('consecutive-review-snapshot.json'), JSON.stringify(snapshot, null, 2));
    expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer({ silent: true }))).toBe(true);
    await page.reload();
    await expect(page.locator('.cue[data-idx="2"] .text')).toBeVisible();
    const reopened = await page.evaluate(() => ({ array: Array.isArray(MaweBoot.DATA.markers), markers: MaweBoot.DATA.markers,
      gap: AsrGapRemoveCore.normalizeGapRemoveData(MaweBoot.DATA.gap_remove), texts: MaweExportSrt.cleanupMainSegments().map((cue) => cue.text) }));
    expect(reopened.array).toBe(true);
    expect(reopened.markers.filter((item) => item.review?.status === 'pending')).toHaveLength(4);
    expect(reopened.markers.find((item) => item.id === 'ordinary').note).toBe('用户备注');
    expect(reopened.gap.provenance.sources.ai_cleanup).toHaveLength(0);
    expect(reopened.gap.provenance.sources.audio_gate.map(({ start, end }) => [start, end])).toEqual([[810, 930]]);
    expect(reopened.gap.provenance.sources.script_alignment.map(({ start, end }) => [start, end])).toEqual([[3000, 3050]]);
    expect(reopened.gap.provenance.manual_overrides.find((item) => item.id === 'manual-late').removed).toBe(true);
    expect(reopened.texts.slice(1).every((text) => text.includes('嗯'))).toBe(true);
  } finally {
    if (server) await server.stop();
    cleanupTempDir(directory);
  }
});
