import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload, generateWav, makeTempDir, startServer } from './helpers.mjs';

const cases = [
  { name: 'an unselected emoji followed by a separate terminal punctuation item', expected: '正文😀', artifactText: '正文😀。', manuscript: '正文', previewTime: 500,
    rows: [['正文', 0, 900], ['啊', 1000, 1200], ['😀', 1210, 1250], ['。', 1300, 2000]],
    decision: { removeItemIds: ['c001:i002'], evidence: '啊' }, removed: '啊' },
  { name: 'a separate terminal punctuation item', expected: '我这个功能',
    rows: [['啊，', 0, 210], ['我这个功能', 300, 1800], ['。', 1800, 2000]],
    decision: { removeItemIds: ['c001:i001'], evidence: '啊，' }, removed: '啊' },
  { name: 'two nonadjacent local ranges', expected: '我这个功能很好呢', afterFirstRestore: '我我这个功能很好呢',
    rows: [['我', 0, 110], ['我这个', 130, 430], ['功能', 500, 800], ['嗯', 810, 930], ['很好', 1000, 1200], ['呢', 1300, 2000]],
    decision: { removeItemRanges: [['c001:i001'], ['c001:i004']], evidence: '我嗯' }, removed: '嗯' },
  { name: 'a neutral punctuation item before the second local range', expected: '我这个  功能很好呢', afterFirstRestore: '我我这个  功能很好呢', artifactText: '我这个，功能很好呢', manuscript: '我这个功能很好呢',
    rows: [['我', 0, 110], ['我这个', 130, 400], ['，', 410, 430], ['功能', 500, 800], ['嗯', 810, 930], ['很好', 1000, 1200], ['呢', 1300, 2000]],
    decision: { removeItemRanges: [['c001:i001'], ['c001:i005']], evidence: '我嗯' }, removed: '嗯' },
  { name: 'the removal scope including a separate terminal punctuation item', expected: '正文', previewTime: 500,
    rows: [['正文', 0, 1000], ['呃', 1100, 1800], ['。', 1800, 2000]],
    decision: { removeItemIds: ['c001:i002', 'c001:i003'], evidence: '呃。' }, removed: '呃' },
  { name: 'multiple local ranges with the last scope including terminal punctuation', expected: '我这个', afterFirstRestore: '我我这个', previewTime: 500,
    rows: [['我', 0, 110], ['我这个', 200, 1000], ['呃', 1100, 1800], ['。', 1800, 2000]],
    decision: { removeItemRanges: [['c001:i001'], ['c001:i003', 'c001:i004']], evidence: '我呃。' }, removed: '呃' },
  { name: 'an independent overlay starting before the retained main cue', expected: '我这个功能',
    rows: [['啊，', 0, 210], ['我这个功能', 300, 2000]],
    overlay: { enabled: true, segments: [{ id: 'overlay-001', start: 100, end: 1500, text: '独立叠加' }] },
    decision: { removeItemIds: ['c001:i001'], evidence: '啊，' }, removed: '啊' },
  { name: 'a stale scope index becoming coincidentally valid after neutral merge', expected: '我这个  功能嗯很好', artifactText: '我这个，功能很好', manuscript: '我这个功能很好', preserveRemoved: true,
    rows: [['我这个', 0, 400], ['，', 410, 430], ['功能', 500, 800], ['嗯', 810, 930], ['很好', 1000, 2000]],
    invalidScope: { item_start: 2, item_end: 3 }, decision: { removeItemIds: ['c001:i004'], evidence: '嗯' }, removed: '嗯' },
  { name: 'a stale scope text becoming coincidentally valid after punctuation cleanup', expected: '正文嗯  很好', artifactText: '正文很好', manuscript: '正文很好', preserveRemoved: true,
    rows: [['正文', 0, 900], ['嗯，', 1000, 1200], ['很好', 1300, 2000]],
    invalidScope: { text: '嗯  ' }, decision: { removeItemIds: ['c001:i002'], evidence: '嗯，' }, removed: '嗯' },
  { name: 'an unselected emoji adjacent to a valid removed filler', expected: '正文😀很好', artifactText: '正文😀很好', manuscript: '正文很好', preserveRemoved: true, allowReviewFallback: true,
    allowedTexts: ['正文😀很好', '正文嗯😀很好'],
    rows: [['正文', 0, 900], ['嗯', 1000, 1200], ['😀', 1210, 1250], ['很好', 1300, 2000]],
    decision: { removeItemIds: ['c001:i002'], evidence: '嗯' }, removed: '嗯' },
];

for (const fixture of cases) {
  test(`real AI artifact keeps local projection through default cleanup, save and restoration: ${fixture.name}`, async ({ page }) => {
    const directory = makeTempDir('ai-local-punctuation');
    let server;
    try {
      const mediaPath = join(directory, 'synthetic.wav');
      const input = join(directory, 'input.mosp');
      const script = join(directory, 'script.txt');
      const decision = join(directory, 'decision.json');
      generateWav(mediaPath, 2);
      writeFileSync(input, JSON.stringify({ media: 'synthetic.wav', waveform: generateWaveformPayload(2000),
        ...(fixture.overlay ? { overlay_track: fixture.overlay } : {}),
        segments: [{ id: 'main-001', start: 0, end: 2000,
          text: fixture.rows.map(([text]) => text).join(''),
          items: fixture.rows.map(([text, start, end]) => ({ text, start, end })) }] }), 'utf-8');
      writeFileSync(script, fixture.manuscript || fixture.expected, 'utf-8');
      writeFileSync(decision, JSON.stringify(fixture.decision), 'utf-8');
      const python = String(process.env.MAW_E2E_PYTHON || '').trim();
      expect(python, 'use the configured isolated Python runtime').not.toBe('');
      const artifact = JSON.parse(execFileSync(python, ['-c', `
import json, sys
from pathlib import Path
from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup import AiCleanupRequest, run_ai_cleanup
from maw.postprocess_io import render_srt, read_project
decision = json.loads(Path(sys.argv[3]).read_text(encoding='utf-8'))
def complete(prompt, rows):
    return {'decisions': [{'id': 'c001', 'decision': 'discard', 'scriptLine': rows[0]['scriptLine'], **decision}]}
artifact = run_ai_cleanup(AiCleanupRequest(Path(sys.argv[1]), None, Path(sys.argv[2]), OutputMode.BOTH, review_enabled=False), complete=complete)
print(json.dumps({'path': str(artifact.project_path), 'srt': render_srt(read_project(artifact.project_path)), 'stats': dict(artifact.stats or {})}, ensure_ascii=False))
`, input, script, decision], { encoding: 'utf8', timeout: 30_000 }));
      expect(artifact.stats.removed).toBe(1);
      expect(artifact.srt).toContain(fixture.artifactText || fixture.expected);
      expect(artifact.srt).not.toContain(fixture.removed);
      const produced = JSON.parse(readFileSync(artifact.path, 'utf-8'));
      writeFileSync(test.info().outputPath('produced-project.json'), JSON.stringify(produced, null, 2));
      expect(produced.segments[0].text).toBe(fixture.rows.map(([text]) => text).join(''));
      expect(produced.segments[0].disabled).not.toBe(true);
      expect(produced.gap_remove.provenance.sources.ai_cleanup).toHaveLength(fixture.decision.removeItemRanges?.length || 1);
      if (fixture.invalidScope) {
        Object.assign(produced.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope, fixture.invalidScope);
        writeFileSync(artifact.path, JSON.stringify(produced), 'utf-8');
      }
      server = await startServer(artifact.path, mediaPath, await findFreePort());
      await disableOnboarding(page);
      await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
      await page.goto(server.url);
      await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
      const snapshot = await page.evaluate((previewTime) => {
        MaweDom.overlayToggle.checked = true;
        MaweSettings.EDITOR_SETTINGS.assMode = false;
        MawePlaybackLoop.refreshSubtitlePreview(previewTime, 0);
        const css = MaweDom.overlayMainTextNode.nodeValue;
        MaweSettings.EDITOR_SETTINGS.assMode = true;
        MawePlaybackLoop.refreshSubtitlePreview(previewTime, 0);
        return { css, canvas: MaweAssCanvas.lastRender.tracks.flatMap((track) => track.lines.flatMap((line) => line.items.map((item) => item.text))).join(''),
          ordinary: MaweExportSrt.buildSrt(), compressed: MaweExportSrt.buildGapRemovedSrt(), ass: MaweExportSrt.buildAss(),
          dynamic: MaweExportSrt.buildDynamicCaptionExportData(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, true),
          removedGaps: MaweGapRemoveData.getRemovedGapRanges(), raw: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0],
          aiSources: MaweBoot.DATA.gap_remove?.provenance?.sources?.ai_cleanup || [], markers: MaweBoot.DATA.markers };
      }, fixture.previewTime || 1000);
      await test.info().attach('consumer-snapshot', { body: JSON.stringify(snapshot, null, 2), contentType: 'application/json' });
      writeFileSync(test.info().outputPath('consumer-snapshot.json'), JSON.stringify(snapshot, null, 2));
      await page.locator('.player-stage').screenshot({ path: test.info().outputPath('local-punctuation-projection.png') });
      if (fixture.allowReviewFallback && !snapshot.removedGaps.length) {
        expect(snapshot.aiSources).toHaveLength(0);
        expect(snapshot.markers.some((marker) => marker.review?.status === 'pending')).toBe(true);
      } else expect(snapshot.removedGaps.length).toBeGreaterThan(0);
      expect(fixture.allowedTexts || [fixture.expected]).toContain(snapshot.css);
      expect(snapshot.canvas).toContain(snapshot.css);
      expect(snapshot.dynamic.segments[0].text).toBe(snapshot.css);
      for (const output of [snapshot.ordinary, snapshot.compressed, snapshot.ass]) {
        expect(output).toContain(snapshot.css);
        if (!fixture.preserveRemoved) expect(output).not.toContain(fixture.removed);
      }
      if (fixture.overlay) {
        const aligned = await page.evaluate(() => {
          MaweSettings.EDITOR_SETTINGS.exportStartAtZero = true;
          return MaweExportSrt.buildSrt();
        });
        writeFileSync(test.info().outputPath('aligned-srt.txt'), aligned);
        expect(snapshot.ordinary.trim().split(/\n\s*\n/)[0]).toContain('独立叠加');
        const blocks = aligned.trim().split(/\n\s*\n/);
        expect(blocks[0]).toContain('00:00:00,000 --> 00:00:01,500');
        expect(blocks[0]).toContain('独立叠加');
        expect(blocks[1]).toContain('00:00:00,300 --> 00:00:02,000');
      }
      expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer({ silent: true }))).toBe(true);
      await page.reload();
      await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
      expect(await page.evaluate(() => MaweExportSrt.cleanupMainSegments()[0].text)).toBe(snapshot.css);
      if (fixture.afterFirstRestore) {
        const partial = await page.evaluate(() => {
          const state = MaweGapRemoveData.getGapRemoveData(false);
          const original = JSON.parse(JSON.stringify(state.provenance));
          const provenance = AsrGapRemoveCore.replaceGapRemoveProvenanceSource(state.provenance, 'ai_cleanup', original.sources.ai_cleanup.slice(1));
          MaweGapRemoveUi.setGapRemoveData(state, { provenance });
          const text = MaweExportSrt.cleanupMainSegments()[0].text;
          MaweGapRemoveUi.setGapRemoveData(state, { provenance: original });
          return text;
        });
        expect(partial).toBe(fixture.afterFirstRestore);
      }
      const restored = await page.evaluate(() => {
        const state = MaweGapRemoveData.getGapRemoveData(false);
        MaweGapRemoveUi.setGapRemoveData(state, { provenance: AsrGapRemoveCore.replaceGapRemoveProvenanceSource(state.provenance, 'ai_cleanup', []) });
        return MaweExportSrt.buildSrt();
      });
      expect(restored).toContain(fixture.removed);
      if (fixture.afterFirstRestore && fixture.rows.length === 7) {
        const mixed = await page.evaluate(({ segment, ranges }) => {
          const failed = structuredClone(segment);
          const good = structuredClone(segment);
          good.id = 'second'; good.start += 4000; good.end += 4000;
          good.items.forEach((item) => { item.start += 4000; item.end += 4000; });
          AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments = [{ id: 'lead', start: 0, end: 2000, text: '前文',
            items: [{ text: '前文', start: 0, end: 2000 }] }, failed, good];
          const later = ranges.map((range) => ({ ...structuredClone(range), start: range.start + 4000, end: range.end + 4000,
            cleanup_scope: { ...range.cleanup_scope, segment_id: 'second' } }));
          MaweBoot.DATA.gap_remove = { provenance: { sources: { ai_cleanup: [...ranges, ...later],
            audio_gate: [{ start: 810, end: 930 }] } } };
          MaweBoot.DATA.markers = [{ id: 'ordinary', start: 0, end: 110, name: '普通标记', note: '用户备注', color: '#ffffff' },
            { id: 'known-ai', start: 0, end: 110, name: 'AI', note: '[AI] 删除：口吃', color: '#8e4ec6' }];
          MaweJsonRepair.normalizeProjectTimings(MaweBoot.DATA);
          MaweMarkersPanel.openPanel();
          return { array: Array.isArray(MaweBoot.DATA.markers), scopes: MaweBoot.DATA.gap_remove.provenance.sources.ai_cleanup,
            markers: MaweBoot.DATA.markers, texts: MaweExportSrt.cleanupMainSegments().map((cue) => cue.text) };
        }, { segment: produced.segments[0], ranges: produced.gap_remove.provenance.sources.ai_cleanup });
        expect(mixed.array).toBe(true);
        expect(mixed.scopes).toHaveLength(2);
        expect(mixed.scopes.every((range) => range.cleanup_scope.segment_id === 'second')).toBe(true);
        expect(mixed.scopes[1].cleanup_scope.item_start).toBe(3);
        expect(mixed.texts[1]).toContain('嗯');
        expect(mixed.texts[2]).toBe(fixture.artifactText);
        await expect(page.locator('[data-marker-id="ordinary"]')).toBeVisible();
        await expect(page.locator('[data-marker-id="known-ai"]')).toContainText('待复核');
        expect(mixed.markers.find((marker) => marker.id === 'ordinary').note).toBe('用户备注');
        expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer({ silent: true }))).toBe(true);
        await page.reload();
        await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
        const reopened = await page.evaluate(() => ({ text: MaweExportSrt.cleanupMainSegments()[2].text,
          array: Array.isArray(MaweBoot.DATA.markers), sources: MaweBoot.DATA.gap_remove.provenance.sources }));
        expect(reopened.text).toBe(fixture.expected);
        expect(reopened.array).toBe(true);
        expect(reopened.sources.ai_cleanup).toHaveLength(2);
        expect(reopened.sources.audio_gate).toHaveLength(1);
      }
    } finally {
      await server?.stop();
      cleanupTempDir(directory);
    }
  });
}
