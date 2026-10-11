import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload, generateWav, makeTempDir, startServer } from './helpers.mjs';

const cases = [
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
          dynamic: MaweExportSrt.buildDynamicCaptionExportData(MaweBoot.DATA.segments, true),
          removedGaps: MaweGapRemoveData.getRemovedGapRanges(), raw: MaweBoot.DATA.segments[0] };
      }, fixture.previewTime || 1000);
      await test.info().attach('consumer-snapshot', { body: JSON.stringify(snapshot, null, 2), contentType: 'application/json' });
      writeFileSync(test.info().outputPath('consumer-snapshot.json'), JSON.stringify(snapshot, null, 2));
      await page.locator('.player-stage').screenshot({ path: test.info().outputPath('local-punctuation-projection.png') });
      expect(snapshot.removedGaps.length).toBeGreaterThan(0);
      expect(snapshot.css).toBe(fixture.expected);
      expect(snapshot.canvas).toContain(fixture.expected);
      expect(snapshot.dynamic.segments[0].text).toBe(fixture.expected);
      for (const output of [snapshot.ordinary, snapshot.compressed, snapshot.ass]) {
        expect(output).toContain(fixture.expected);
        expect(output).not.toContain(fixture.removed);
      }
      expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer({ silent: true }))).toBe(true);
      await page.reload();
      await expect(page.locator('.cue[data-idx="0"] .text')).toBeVisible();
      expect(await page.evaluate(() => MaweExportSrt.cleanupMainSegments()[0].text)).toBe(fixture.expected);
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
    } finally {
      await server?.stop();
      cleanupTempDir(directory);
    }
  });
}
