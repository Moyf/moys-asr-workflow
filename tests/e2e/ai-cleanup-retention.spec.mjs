// AI 局部移除的数据保全回归（真页面）：provenance 投影、时间修复迁移、
// 导出构建器在 production 装配下的行为。node 夹具无法承载 boot.editor
// 级门面依赖（假 DOM 膨胀不可信），本 spec 在真实编辑器页上调用同一批
// window 门面断言——业务断言与迁移前的 test_ai_cleanup_local_export 一致。
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir, disableOnboarding, findFreePort, generateWav,
  generateWaveformPayload, makeTempDir, startServer,
} from './helpers.mjs';

const DURATION_MS = 4_000;
const plain = (value) => JSON.parse(JSON.stringify(value));

const sourceSegment = () => ({ id: 'main-001', start: 0, end: 2000, text: '啊，我这……我这个功能呢',
  items: [{ text: '啊，', start: 0, end: 210 }, { text: '我这……', start: 220, end: 770 }, { text: '我这个功能呢', start: 900, end: 2000 }] });
const localGap = () => ({ detector: 'audio_gate', provenance: { sources: { ai_cleanup: [{ start: 0, end: 770,
  cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 2, text: '啊，我这……' } }] } } });

function buildProject(filePath) {
  const project = {
    media: 'synthetic.wav',
    segments: [sourceSegment()],
    gap_remove: localGap(),
    overlay_track: { enabled: true, segments: [{ id: 'main-001', start: 0, end: 2000, text: 'overlay untouched' }] },
    multi_subtitle: { enabled: true, tracks: [{ id: 'ext', segments: [{ id: 'ext-001', start: 0, end: 2000, text: 'translated body' }] }] },
    waveform: generateWaveformPayload(DURATION_MS),
  };
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
  return filePath;
}

let dir; let server;
test.beforeAll(async () => {
  dir = makeTempDir('ai-cleanup-retention');
  const wav = join(dir, 'synthetic.wav');
  generateWav(wav, DURATION_MS / 1000);
  const project = buildProject(join(dir, 'project.json'));
  const port = await findFreePort();
  server = await startServer(project, wav, port);
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });

async function openEditor(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => typeof window.MaweExportSrt !== 'undefined' && typeof window.AsrGapRemoveCore !== 'undefined');
  await page.waitForFunction(() => window.MaweBoot?.DATA?.segments?.length > 0);
  return page;
}

test('trusted scope projects exact words/items and rejects inexact endpoints', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(({ sourceText }) => {
    const core = window.AsrGapRemoveCore;
    const main = [{ id: 'main-001', start: 0, end: 2000, text: sourceText,
      items: [{ text: '啊，', start: 0, end: 210 }, { text: '我这……', start: 220, end: 770 }, { text: '我这个功能呢', start: 900, end: 2000 }] }];
    const gap = { detector: 'audio_gate', provenance: { sources: { ai_cleanup: [{ start: 0, end: 770,
      cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 2, text: '啊，我这……' } }] } } };
    const normalized = core.normalizeGapRemoveData(gap);
    const projected = core.projectCleanupRetainedSegments(main, normalized)[0];
    const bad = [];
    for (const start of [0.2, '0', -0.2, false]) {
      const inexact = { detector: 'audio_gate', provenance: { sources: { ai_cleanup: [{ start, end: 770,
        cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 2, text: '啊，我这……' } }] } } };
      bad.push({
        same: core.projectCleanupRetainedSegments(main, inexact)[0] === main[0],
        scope: core.normalizeGapRemoveData(inexact).provenance.sources.ai_cleanup[0].cleanup_scope === undefined,
      });
    }
    return {
      text: projected.text,
      items: projected.items.map((item) => [item.text, item.start, item.end]),
      untouched: JSON.stringify(main[0].items.map((item) => item.text)) === JSON.stringify(['啊，', '我这……', '我这个功能呢']),
      bad,
    };
  }, { sourceText: sourceSegment().text });
  expect(result.text).toBe('我这个功能呢');
  expect(result.items).toEqual([['我这个功能呢', 900, 2000]]);
  expect(result.untouched).toBe(true);
  for (const row of result.bad) { expect(row.same).toBe(true); expect(row.scope).toBe(true); }
});

test('legacy AI/manual gaps and stale scope never hide enabled subtitle words', async ({ page }) => {
  await openEditor(page);
  const checks = await page.evaluate(() => {
    const core = window.AsrGapRemoveCore;
    const main = [{ id: 'main-001', start: 0, end: 2000, text: '啊，我这……我这个功能呢',
      items: [{ text: '啊，', start: 0, end: 210 }, { text: '我这……', start: 220, end: 770 }, { text: '我这个功能呢', start: 900, end: 2000 }] }];
    const results = [];
    for (const gap of [
      { gaps: [{ start: 0, end: 770, removed: true }] },
      { provenance: { sources: { ai_cleanup: [{ start: 0, end: 770 }] } } },
      { provenance: { sources: { ai_cleanup_review: [{ start: 0, end: 770, review_marker_id: 'm-1' }] } } },
    ]) results.push(core.projectCleanupRetainedSegments(main, gap)[0].text === main[0].text);
    const base = () => ({ detector: 'audio_gate', provenance: { sources: { ai_cleanup: [{ start: 0, end: 770,
      cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 2, text: '啊，我这……' } }] } } });
    for (const mutation of [
      (g) => { g.provenance.sources.ai_cleanup[0].cleanup_scope.segment_id = 'wrong'; },
      (g) => { g.provenance.sources.ai_cleanup[0].cleanup_scope.text = 'wrong'; },
      (g) => { g.provenance.sources.ai_cleanup[0].start = 1; },
      (g) => { g.provenance.sources.ai_cleanup[0].cleanup_scope.item_end = 9; },
    ]) { const gap = base(); mutation(gap); results.push(core.projectCleanupRetainedSegments(main, gap)[0].text === main[0].text); }
    const edited = JSON.parse(JSON.stringify(main[0]));
    edited.items[0].text = '改'; edited.text = '改我这……我这个功能呢';
    results.push(core.projectCleanupRetainedSegments([edited], base())[0].text === edited.text);
    return results;
  });
  expect(checks.every(Boolean)).toBe(true);
});

test('production SRT/ASS builders remove local words while independent tracks survive', async ({ page }) => {
  await openEditor(page);
  const outputs = await page.evaluate(() => {
    const srt = window.MaweExportSrt;
    const before = JSON.stringify(window.MaweBoot.DATA.segments);
    const list = [srt.buildSrt(), srt.buildGapRemovedSrt(), srt.buildBilingualSrt?.() ?? srt.buildSrt(), srt.buildAss(), srt.buildGapRemovedAss()]
      .filter((value) => typeof value === 'string');
    const srtTime = srt.buildSrt();
    const gapTime = srt.buildGapRemovedSrt();
    const extension = srt.buildExtensionSrt ? srt.buildExtensionSrt() : '';
    const untouched = JSON.stringify(window.MaweBoot.DATA.segments) === before;
    window.MaweBoot.DATA.gap_remove.provenance.manual_overrides = [{ start: 0, end: 770, removed: false }];
    const afterOverride = srt.buildSrt();
    delete window.MaweBoot.DATA.gap_remove.provenance.manual_overrides;
    return { list, srtTime, gapTime, extension, untouched, afterOverride };
  });
  for (const output of outputs.list) {
    expect(output).toContain('我这个功能呢');
    expect(output).not.toMatch(/啊，|我这……/);
    expect(output).toContain('overlay untouched');
  }
  expect(outputs.srtTime).toContain('00:00:00,900 --> 00:00:02,000');
  expect(outputs.gapTime).toContain('00:00:00,130 --> 00:00:01,230');
  expect(outputs.extension).toContain('translated body');
  expect(outputs.untouched).toBe(true);
  expect(outputs.afterOverride).toContain('我这……');
});

test('dynamic caption plans use surviving items', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    const srt = window.MaweExportSrt;
    const rows = [];
    for (const compressed of [false, true]) {
      const data = srt.buildDynamicCaptionExportData(window.MaweBoot.DATA.segments, compressed);
      rows.push({ text: data.segments[0].text, items: data.segments[0].items.map((item) => item.text), start: data.segments[0].start });
    }
    const projected = srt.cleanupMainSegments();
    return { rows, plain: window.AsrEditorUtils.buildPlainTextPayload(projected), items: window.MaweBoot.DATA.segments[0].items.length };
  });
  expect(result.rows[0]).toEqual({ text: '我这个功能呢', items: ['我这个功能呢'], start: 900 });
  expect(result.rows[1].start).toBe(130);
  expect(result.plain).toBe('我这个功能呢');
  expect(result.items).toBe(3);
});

test('OTIO marker names and FCP/XML plans use exact retained main text', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    const timeline = window.MaweExportTimeline;
    const utils = window.AsrEditorUtils;
    const data = window.MaweBoot.DATA;
    const markerChecks = [{ start: 0, end: 2000 }, { start: 770, end: 2000 }].map((interval) => {
      const markers = timeline.buildGapRemovedSubtitleMarkers(interval);
      const overlayMarkers = timeline.buildGapRemovedSubtitleMarkers(interval, 0, data.overlay_track.segments, data.overlay_track.segments);
      return { name: markers[0].name, value: markers[0].marked_range.start_time.value, overlay: overlayMarkers[0].name };
    });
    const planChecks = ['source', 'gap_removed'].map((timelineMode) => {
      const plan = utils.buildProjectExportPlan(data, { timelineMode });
      const [artifact] = utils.buildFcp7ExportArtifacts(plan, { subtitleTracks: 'all', nativeTextObjects: true });
      return { main: plan.cues.main[0].text, extension: plan.cues.extension?.[0]?.text, xml: artifact.content };
    });
    return { markerChecks, planChecks, sourceText: data.segments[0].text };
  });
  for (const row of result.markerChecks) {
    expect(row.name).toBe('我这个功能呢');
    expect(row.value).toBe(54);
    expect(row.overlay).toBe('overlay untouched');
  }
  for (const plan of result.planChecks) {
    expect(plan.main).toBe('我这个功能呢');
    expect(plan.extension).toBe('translated body');
    expect(plan.xml).toContain('我这个功能呢');
    expect(plan.xml).not.toContain('我这……');
  }
});


test('punctuation cleanup migrates only already-exact local scopes', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    const data = window.MaweBoot.DATA;
    data.gap_remove = { detector: 'audio_gate', provenance: { sources: { ai_cleanup: [
      { start: 0, end: 770, cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 2, text: '啊，我这……' } },
      { start: 0, end: 770, cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 2, text: 'stale' } },
    ] } } };
    window.MaweTextCleanup.cleanPunctuation();
    const scopes = data.gap_remove.provenance.sources.ai_cleanup;
    const firstAfter = scopes[0].cleanup_scope.text;
    const secondAfter = scopes[1].cleanup_scope.text;
    const retained = window.AsrGapRemoveCore.projectCleanupRetainedSegments(data.segments, data.gap_remove)[0].text;
    scopes[0].cleanup_scope.text = 'edit mismatch';
    window.MaweTextCleanup.cleanPunctuation();
    const mismatchKept = scopes[0].cleanup_scope.text;
    const mismatchText = window.AsrGapRemoveCore.projectCleanupRetainedSegments(data.segments, data.gap_remove)[0].text;
    return { firstAfter, secondAfter, retained, mismatchKept, mismatchText, full: data.segments[0].text };
  });
  expect(result.firstAfter).toContain('我这');
  expect(result.secondAfter).toBe('stale');
  // mismatch 后的保守性：损坏 scope 不迁移、投影回退全文（不隐藏任何字）
  expect(result.mismatchKept).toBe('edit mismatch');
  expect(result.mismatchText).toBe(result.full);
});

test('timing repair migrates exact scopes through neutral roots', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    const data = window.MaweBoot.DATA;
    const rows = [['我', 0, 110], ['我这个', 130, 400], ['，', 410, 430], ['功能', 500, 800],
      ['嗯', 810, 930], ['很好', 1000, 1200], ['呢', 1300, 2000]];
    data.segments[0] = { id: 'main-001', start: 0, end: 2000, text: rows.map(([t]) => t).join(''),
      items: rows.map(([t, s, e]) => ({ text: t, start: s, end: e })) };
    data.gap_remove = { provenance: { sources: { ai_cleanup: [
      { start: 0, end: 110, cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 1, text: '我' } },
      { start: 810, end: 930, cleanup_scope: { segment_id: 'main-001', item_start: 4, item_end: 5, text: '嗯' } },
    ] } } };
    window.MaweJsonRepair.normalizeProjectTimings(data);
    const scopes = data.gap_remove.provenance.sources.ai_cleanup;
    const projected = window.AsrGapRemoveCore.projectCleanupRetainedSegments(data.segments, data.gap_remove)[0].text;
    data.segments[0] = { id: 'main-001', start: 0, end: 2000, text: '正文呃。',
      items: [{ text: '正文', start: 0, end: 1000 }, { text: '呃', start: 1100, end: 1800 }, { text: '。', start: 1800, end: 2000 }] };
    data.gap_remove.provenance.sources.ai_cleanup = [{ start: 1100, end: 2000,
      cleanup_scope: { segment_id: 'main-001', item_start: 1, item_end: 3, text: '呃。' } }];
    window.MaweJsonRepair.repairTimingGroup(data.segments);
    const tailScope = data.gap_remove.provenance.sources.ai_cleanup[0];
    const tailText = window.AsrGapRemoveCore.projectCleanupRetainedSegments(data.segments, data.gap_remove)[0].text;
    return { itemStart: scopes[1].cleanup_scope.item_start, projected,
      end: tailScope.end, tailText };
  });
  expect(result.itemStart).toBe(3);
  expect(result.projected).toBe('我这个，功能很好呢');
  expect(result.end).toBe(2000);
  expect(result.tailText).toBe('正文');
});

test('failed first cue cannot replace the live ranges of a later successful cue', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(() => {
    const data = window.MaweBoot.DATA;
    const rows = [['我', 0, 110], ['我这个', 130, 400], ['，', 410, 430], ['功能', 500, 800],
      ['嗯', 810, 930], ['很好', 1000, 1200], ['呢', 1300, 2000]];
    const mk = (offset) => ({ id: offset ? 'second' : 'main-001', start: 0 + offset, end: 2000 + offset,
      text: rows.map(([t]) => t).join(''), items: rows.map(([t, s, e]) => ({ text: t, start: s + offset, end: e + offset })) });
    data.segments = [
      { id: 'lead', start: 0, end: 2000, text: '前文', items: [{ text: '前文', start: 0, end: 2000 }] },
      mk(0), mk(4000),
    ];
    data.gap_remove = { provenance: { sources: { ai_cleanup: [
      { start: 0, end: 110, cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 1, text: '我' } },
      { start: 810, end: 930, cleanup_scope: { segment_id: 'main-001', item_start: 4, item_end: 5, text: '嗯' } },
      { start: 4000, end: 4110, cleanup_scope: { segment_id: 'second', item_start: 0, item_end: 1, text: '我' } },
      { start: 4810, end: 4930, cleanup_scope: { segment_id: 'second', item_start: 4, item_end: 5, text: '嗯' } },
    ] } } };
    data.markers = [{ id: 'user', start: 0, end: 110, name: 'manual', note: 'manual', color: '#ffffff' }];
    window.MaweJsonRepair.normalizeProjectTimings(data);
    const reopened = JSON.parse(JSON.stringify(data));
    window.MaweJsonRepair.normalizeProjectTimings(reopened);
    const retained = window.AsrGapRemoveCore.projectCleanupRetainedSegments(reopened.segments, reopened.gap_remove);
    return {
      isArray: Array.isArray(data.markers),
      pending: data.markers.filter((m) => m.review?.status === 'pending').length,
      manualNote: data.markers.find((m) => m.id === 'user').note,
      scopeCount: data.gap_remove.provenance.sources.ai_cleanup.length,
      itemStart: data.gap_remove.provenance.sources.ai_cleanup[1]?.cleanup_scope?.item_start,
      thirdText: retained[2]?.text,
      reopenedScopes: reopened.gap_remove.provenance.sources.ai_cleanup.length,
    };
  });
  expect(result.isArray).toBe(true);
  expect(result.pending).toBe(2);
  expect(result.manualNote).toBe('manual');
  expect(result.scopeCount).toBe(2);
  expect(result.thirdText).toBe('我这个，功能很好呢');
  expect(result.reopenedScopes).toBe(2);
});

test('neutral migration cannot reauthorize stale or newly mixed scopes', async ({ page }) => {
  await openEditor(page);
  const failures = ['stale', 'boundary', 'accidental', 'symbol'];
  const results = await page.evaluate((failureList) => {
    const out = {};
    for (const failure of failureList) {
      const data = window.MaweBoot.DATA;
      const rows = [['我', 0, 110], ['我这个', 130, 400], ['，', 410, 430], ['功能', 500, 800],
        ['嗯', 810, 930], ['很好', 1000, 1200], ['呢', 1300, 2000]];
      data.segments = [{ id: 'main-001', start: 0, end: 2000, text: rows.map(([t]) => t).join(''),
        items: rows.map(([t, s, e]) => ({ text: t, start: s, end: e })) }];
      data.gap_remove = { provenance: { sources: { ai_cleanup: [
        { start: 0, end: 110, cleanup_scope: { segment_id: 'main-001', item_start: 0, item_end: 1, text: '我' } },
        { start: 810, end: 930, cleanup_scope: { segment_id: 'main-001', item_start: 4, item_end: 5, text: '嗯' } },
      ] } } };
      const ranges = data.gap_remove.provenance.sources.ai_cleanup;
      if (failure === 'stale') ranges[1].cleanup_scope.text = 'stale';
      if (failure === 'boundary') ranges[1].start = 810.2;
      if (failure === 'accidental') { ranges[1].cleanup_scope.item_start = 3; ranges[1].cleanup_scope.item_end = 4; }
      if (failure === 'symbol') {
        data.segments[0].items[2].text = '🙂';
        data.segments[0].text = data.segments[0].items.map((i) => i.text).join('');
        ranges[0].end = 400; ranges[0].cleanup_scope.item_end = 2; ranges[0].cleanup_scope.text = '我我这个';
      }
      window.MaweJsonRepair.normalizeProjectTimings(data);
      const output = window.AsrGapRemoveCore.projectCleanupRetainedSegments(data.segments, data.gap_remove)[0].text;
      out[failure] = {
        scopeDropped: ranges[1].cleanup_scope === undefined,
        hasEn: /嗯/.test(output),
        hasSmile: /🙂/.test(output),
        smileStart: data.segments[0].items.find((i) => i.text === '🙂')?.start,
      };
    }
    return out;
  }, failures);
  for (const failure of ['stale', 'boundary', 'accidental']) {
    expect(results[failure].scopeDropped, failure).toBe(true);
    expect(results[failure].hasEn, failure).toBe(true);
  }
  expect(results.symbol.hasSmile).toBe(true);
  expect(results.symbol.hasEn).toBe(false);
  expect(results.symbol.smileStart).toBe(410);
});
