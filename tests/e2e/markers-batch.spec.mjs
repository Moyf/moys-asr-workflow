import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson,
  generateWav, makeTempDir, startServer,
} from './helpers.mjs';

let tempDir;
let server;
let projectPath;

test.beforeAll(async () => {
  tempDir = makeTempDir('markers-batch');
  const media = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(media, 300);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

async function seed(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    // 保存/重载用例会更新同一服务端工程；每个用例从独立空隙决定开始。
    MaweBoot.DATA.gap_remove = null;
    MaweGapRemoveUi.updateGapRemoveUi();
    MaweBoot.DATA.markers = window.AsrEditorUtils.normalizeMarkers([
      { id: 'human', start: 100, name: '人工标记', note: '请保留' },
      { id: 'ai-delete', start: 1000, end: 2000, name: '试麦', color: '#8e4ec6', note: '[AI] 删除：试麦' },
      { id: 'ai-review', start: 3000, end: 4000, name: '有效步骤', color: '#f5a623', note: '[AI] 替代项：信息覆盖待决策',
        review: { status: 'pending', reason: '步骤没有被覆盖' } },
    ]);
    MaweBoot.DATA.segments[0].disabled = true;
    MaweMarkerEditing.afterExternalMarkersChange();
  });
  await page.locator('#markers-quick-toggle').click();
  await page.locator('#markers-manage').click();
  await expect(page.locator('.markers-item')).toHaveCount(3);
}

test('notes toggle and custom colors preserve marker content', async ({ page }) => {
  await seed(page);
  await expect(page.locator('.markers-item-note')).toHaveCount(0);
  await page.evaluate(() => MaweMarkerEditing.updateMarkerFields('human', { note: '' }));
  await page.locator('#markers-show-notes').check();
  await expect(page.locator('[data-marker-id="human"] .markers-item-note')).toHaveCount(0);
  await expect(page.locator('[data-marker-id="ai-delete"] .markers-item-note')).toHaveText('[AI] 删除：试麦');
  const spacing = await page.locator('.markers-item-note').first().evaluate(el => {
    const title = el.closest('.markers-item').querySelector('.markers-item-title');
    const titleRange = document.createRange();
    titleRange.selectNodeContents(title);
    const noteRange = document.createRange();
    noteRange.selectNodeContents(el);
    return noteRange.getBoundingClientRect().top - titleRange.getBoundingClientRect().bottom;
  });
  expect(spacing).toBeGreaterThanOrEqual(8);
  await test.info().attach('marker-note-spacing', {
    body: Buffer.from(JSON.stringify({ textGapPx: spacing })),
    contentType: 'application/json',
  });
  await page.locator('#markers-panel').screenshot({ path: test.info().outputPath('markers-note-spacing.png') });
  await page.locator('[data-marker-id="human"] .markers-item-edit').click();
  await expect(page.locator('.markers-color-swatches button')).toHaveCount(8);
  await page.locator('.markers-color-picker').evaluate(el => {
    el.value = '#b18be8';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.markers-edit-hex')).toHaveValue('#b18be8');
  expect(await page.evaluate(() => MaweMarkerEditing.findMarker('human').color)).toBe('#b18be8');
  await page.locator('.markers-edit-hex').fill('#ffffff');
  await page.locator('.markers-edit-hex').press('Tab');
  await expect(page.locator('.markers-color-picker')).toHaveValue('#ffffff');
  await page.locator('#markers-show-notes').uncheck();
  await expect(page.locator('.markers-item-note')).toHaveCount(0);
});

test('AI review mute is source-scoped and updates through undo, redo, and unmute', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const core = window.AsrGapRemoveCore;
    const provenance = core.normalizeGapRemoveProvenance({
      sources: {
        ai_cleanup: [{ id: 'existing-ai', start: 3500, end: 3800 }],
        audio_gate: [{ id: 'existing-audio', start: 3200, end: 3300 }],
      },
    });
    MaweGapRemoveUi.setGapRemoveData({
      gaps: core.gapRangesFromProvenance(provenance),
    }, { dirty: false, provenance });
  });

  const aiReviewRow = page.locator('[data-marker-id="ai-review"]');
  await aiReviewRow.locator('.markers-item-edit').click();
  const muteButton = aiReviewRow.locator('.markers-ai-review-mute-toggle');
  await expect(muteButton).toHaveText('设静音');
  await expect(muteButton).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-marker-id="ai-delete"] .markers-ai-review-mute-toggle')).toHaveCount(0);
  await expect(page.locator('[data-marker-id="human"] .markers-ai-review-mute-toggle')).toHaveCount(0);

  await muteButton.click();
  await expect(muteButton).toHaveText('已静音');
  await expect(muteButton).toHaveClass(/is-muted/);
  const reviewToggle = aiReviewRow.locator('.markers-review-toggle');
  await expect(reviewToggle).toHaveText('已移除');
  await expect(reviewToggle).toBeDisabled();
  await expect(reviewToggle).toHaveClass(/removed/);
  await page.evaluate(() => {
    const state = MaweGapRemoveData.getGapRemoveData(true);
    MaweGapRemoveUi.commitManualGapRemoveChange(state, [{ start: 3500, end: 3600, removed: false }]);
  });
  await expect(muteButton).toHaveText('部分静音');
  await expect(reviewToggle).toHaveText('部分移除');
  await expect(reviewToggle).toBeDisabled();
  await page.evaluate(() => {
    const state = MaweGapRemoveData.getGapRemoveData(true);
    const provenance = window.AsrGapRemoveCore.normalizeGapRemoveProvenance(state.provenance, state.gaps);
    provenance.manual_overrides = [];
    MaweGapRemoveUi.setGapRemoveData({
      ...state,
      gaps: window.AsrGapRemoveCore.gapRangesFromProvenance(provenance),
    }, { provenance });
  });
  await expect(muteButton).toHaveText('已静音');
  await expect(reviewToggle).toHaveText('已移除');
  expect(await page.evaluate(() => {
    const state = MaweGapRemoveData.getGapRemoveData(false);
    return {
      review: state.provenance.sources.ai_cleanup_review,
      aiCleanup: state.provenance.sources.ai_cleanup,
      audioGate: state.provenance.sources.audio_gate,
      pendingReview: MaweMarkerEditing.findMarker('ai-review').review.status,
    };
  })).toEqual({
    review: [{
      id: 'ai-review', source: 'ai_cleanup_review', start: 3000, end: 4000,
      review_marker_id: 'ai-review', removed: true,
    }],
    aiCleanup: [{ id: 'existing-ai', source: 'ai_cleanup', start: 3500, end: 3800, removed: true }],
    audioGate: [{ id: 'existing-audio', source: 'audio_gate', start: 3200, end: 3300, removed: true }],
    pendingReview: 'pending',
  });

  await page.locator('#undo-btn').click();
  await expect(muteButton).toHaveText('设静音');
  await expect(reviewToggle).toHaveText('待复核');
  await page.locator('#redo-btn').click();
  await expect(muteButton).toHaveText('已静音');
  await expect(reviewToggle).toHaveText('已移除');
  await expect(reviewToggle).toBeDisabled();
  await muteButton.click();
  await expect(muteButton).toHaveText('设静音');
  await expect(reviewToggle).toHaveText('待复核');
  await reviewToggle.click();
  await expect(reviewToggle).toHaveText('已确认');
  const linkedMuteButton = aiReviewRow.locator('.markers-ai-review-mute-toggle');
  await expect(linkedMuteButton).toHaveText('设静音');
  await expect(linkedMuteButton).not.toHaveClass(/is-muted/);
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(linkedMuteButton).toHaveText('Set mute');
  await expect(linkedMuteButton).toHaveAttribute('data-title', 'Mute the media region linked to this AI review item');
  await linkedMuteButton.click();
  await expect(linkedMuteButton).toHaveText('Muted');
  await expect(aiReviewRow.locator('.markers-review-toggle')).toHaveText('Removed');
  await expect(aiReviewRow.locator('.markers-review-toggle')).toBeDisabled();
  await linkedMuteButton.click();
  await expect(linkedMuteButton).toHaveText('Set mute');
  await expect(page.locator('#hint-stack')).toContainText('Unmuted the AI review region');
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await expect(linkedMuteButton).toHaveText('设静音');
  await expect(aiReviewRow.locator('.markers-review-toggle')).toHaveText('已确认');
  expect(await page.evaluate(() => {
    const source = MaweGapRemoveData.getGapRemoveData(false).provenance.sources;
    return {
      review: source.ai_cleanup_review,
      aiCleanup: source.ai_cleanup,
      audioGate: source.audio_gate,
    };
  })).toEqual({
    review: [],
    aiCleanup: [{ id: 'existing-ai', source: 'ai_cleanup', start: 3500, end: 3800, removed: true }],
    audioGate: [{ id: 'existing-audio', source: 'audio_gate', start: 3200, end: 3300, removed: true }],
  });
});

test('AI review mute keeps split records with another marker owner', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    MaweBoot.DATA.markers = window.AsrEditorUtils.normalizeMarkers([
      { id: 'review-a', start: 1000, end: 3000, note: '[AI] 复核 A', review: { status: 'pending' } },
      { id: 'review-a-2', start: 1800, end: 3000, note: '[AI] 复核 B', review: { status: 'pending' } },
    ]);
    const core = window.AsrGapRemoveCore;
    const initial = core.normalizeGapRemoveProvenance({ sources: {
      ai_cleanup_review: [{ id: 'review-a', review_marker_id: 'review-a', start: 1000, end: 3000 }],
    } });
    // Splitting A assigns its second record the same id as marker B.
    const provenance = core.removeGapRemoveProvenanceRange(initial, 1500, 1800);
    MaweGapRemoveUi.setGapRemoveData({ gaps: core.gapRangesFromProvenance(provenance) }, { dirty: false, provenance });
    MaweMarkerEditing.afterExternalMarkersChange();
  });
  const row = page.locator('[data-marker-id="review-a-2"]');
  await row.locator('.markers-item-edit').click();
  const muteButton = row.locator('.markers-ai-review-mute-toggle');
  const reviewToggle = row.locator('.markers-review-toggle');
  const reviewSources = () => page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review);
  const aRanges = [
    { id: 'review-a', source: 'ai_cleanup_review', start: 1000, end: 1500, review_marker_id: 'review-a', removed: true },
    { id: 'review-a-2', source: 'ai_cleanup_review', start: 1800, end: 3000, review_marker_id: 'review-a', removed: true },
  ];
  const bRange = { id: 'review-a-2-2', source: 'ai_cleanup_review', start: 1800, end: 3000, review_marker_id: 'review-a-2', removed: true };

  await expect(muteButton).toHaveText('设静音');
  await expect(reviewToggle).toHaveText('待复核');
  await expect(reviewToggle).toBeEnabled();
  expect(await reviewSources()).toEqual(aRanges);
  await muteButton.click();
  await expect(muteButton).toHaveText('已静音');
  await expect(reviewToggle).toHaveText('已移除');
  expect(await reviewSources()).toEqual([...aRanges, bRange]);
  await muteButton.click();
  await expect(muteButton).toHaveText('设静音');
  await expect(reviewToggle).toHaveText('待复核');
  expect(await reviewSources()).toEqual(aRanges);
  await page.locator('#undo-btn').click();
  await expect(muteButton).toHaveText('已静音');
  expect(await reviewSources()).toEqual([...aRanges, bRange]);
  await page.locator('#redo-btn').click();
  await expect(muteButton).toHaveText('设静音');
  expect(await reviewSources()).toEqual(aRanges);
});

test('editing a muted AI review range keeps the old source explicit until it is removed', async ({ page }) => {
  await seed(page);
  const row = page.locator('[data-marker-id="ai-review"]');
  await row.locator('.markers-item-edit').click();
  const muteButton = row.locator('.markers-ai-review-mute-toggle');
  const reviewToggle = row.locator('.markers-review-toggle');
  await muteButton.click();
  await expect(muteButton).toHaveText('已静音');
  await page.evaluate(() => MaweMarkerEditing.updateMarkerFields('ai-review', { start: 3100, end: 4100 }));
  await expect(muteButton).toHaveText('取消原静音');
  await expect(reviewToggle).toHaveText('待复核');
  await expect(reviewToggle).toBeEnabled();
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review))
    .toMatchObject([{ start: 3000, end: 4000, review_marker_id: 'ai-review' }]);

  await muteButton.click();
  await expect(muteButton).toHaveText('设静音');
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review)).toEqual([]);
  await muteButton.click();
  await expect(muteButton).toHaveText('已静音');
  await expect(reviewToggle).toHaveText('已移除');
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review))
    .toMatchObject([{ start: 3100, end: 4100, review_marker_id: 'ai-review' }]);
});

for (const [edit, fields, label] of [
  ['changing its AI note', { note: '已听审' }, '已静音'],
  ['turning it into a point marker', { end: null }, '取消原静音'],
]) {
  test(`AI review mute can be cancelled after ${edit}`, async ({ page }) => {
    await seed(page);
    const row = page.locator('[data-marker-id="ai-review"]');
    await row.locator('.markers-item-edit').click();
    const muteButton = row.locator('.markers-ai-review-mute-toggle');
    await muteButton.click();
    await page.evaluate(fields => MaweMarkerEditing.updateMarkerFields('ai-review', fields), fields);
    await expect(muteButton).toBeVisible();
    await expect(muteButton).toHaveText(label);
    await muteButton.click();
    await expect(muteButton).toBeHidden();
    expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review)).toEqual([]);
    expect(await page.evaluate(() => MaweGapRemoveUi.toggleAiCleanupReviewMute(MaweMarkerEditing.findMarker('ai-review'))))
      .toEqual({ changed: false, muted: false });
    await page.locator('#undo-btn').click();
    await expect(muteButton).toBeVisible();
    await expect(muteButton).toHaveText(label);
    expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review))
      .toMatchObject([{ start: 3000, end: 4000, review_marker_id: 'ai-review' }]);
    await page.locator('#redo-btn').click();
    await expect(muteButton).toBeHidden();
  });
}

test('AI review mute undo restores controls after rebuilding a non-AI card without interrupting typing', async ({ page }) => {
  await seed(page);
  const row = page.locator('[data-marker-id="ai-review"]');
  await row.locator('.markers-item-edit').click();
  const muteButton = row.locator('.markers-ai-review-mute-toggle');
  const reviewToggle = row.locator('.markers-review-toggle');
  await muteButton.click();
  await page.evaluate(() => MaweMarkerEditing.updateMarkerFields('ai-review', { note: '已听审' }));
  await muteButton.click();
  await page.evaluate(() => {
    MaweMarkersPanel.closePanel();
    MaweMarkersPanel.openPanel();
  });
  await expect(muteButton).toBeHidden();
  const noteInput = row.locator('.markers-item-editor textarea');
  await noteInput.fill('尚未提交的备注');
  await noteInput.evaluate(el => el.setSelectionRange(2, 4));

  await page.evaluate(() => MaweHistory.performUndo());
  await expect(muteButton).toBeVisible();
  await expect(muteButton).toHaveText('已静音');
  await expect(reviewToggle).toHaveText('已移除');
  await expect(reviewToggle).toBeDisabled();
  await expect(noteInput).toBeFocused();
  await expect(noteInput).toHaveValue('尚未提交的备注');
  expect(await noteInput.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 4]);
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review))
    .toMatchObject([{ start: 3000, end: 4000, review_marker_id: 'ai-review' }]);

  await page.evaluate(() => MaweHistory.performRedo());
  await expect(muteButton).toBeHidden();
  await expect(reviewToggle).toHaveText('待复核');
  await expect(reviewToggle).toBeEnabled();
  await expect(noteInput).toBeFocused();
  await expect(noteInput).toHaveValue('尚未提交的备注');
  expect(await noteInput.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 4]);
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review)).toEqual([]);
});

test('AI review mute reports partial removal after linked source clipping through history and reload', async ({ page }) => {
  await seed(page);
  const row = page.locator('[data-marker-id="ai-review"]');
  await row.locator('.markers-item-edit').click();
  const muteButton = row.locator('.markers-ai-review-mute-toggle');
  const reviewToggle = row.locator('.markers-review-toggle');
  await muteButton.click();
  await page.evaluate(() => {
    MaweGapRemoveUi.applyManualGapRange(3300, 3500, false);
    MaweGapRemoveUi.clearGap(1);
  });
  const splitRanges = [
    { start: 3000, end: 3300, review_marker_id: 'ai-review' },
    { start: 3500, end: 4000, review_marker_id: 'ai-review' },
  ];
  await expect(muteButton).toHaveText('部分静音');
  await expect(reviewToggle).toHaveText('部分移除');
  await expect(reviewToggle).toBeDisabled();
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review))
    .toMatchObject(splitRanges);
  expect(await page.evaluate(() => {
    const marker = MaweMarkerEditing.findMarker('ai-review');
    return [marker.start, marker.end];
  })).toEqual([3000, 4000]);

  await page.evaluate(() => MaweHistory.performUndo());
  await expect(muteButton).toHaveText('部分静音');
  await expect(reviewToggle).toHaveText('部分移除');
  await page.evaluate(() => MaweHistory.performRedo());
  await expect(muteButton).toHaveText('部分静音');
  await expect(reviewToggle).toHaveText('部分移除');
  await expect(reviewToggle).toBeDisabled();
  await page.evaluate(() => MaweGapRemoveUi.applyManualGapRange(3300, 3500, true));
  await expect(muteButton).toHaveText('已静音');
  await expect(reviewToggle).toHaveText('已移除');
  await expect(reviewToggle).toBeDisabled();
  await page.evaluate(() => MaweHistory.performUndo());
  await expect(muteButton).toHaveText('部分静音');
  await expect(reviewToggle).toHaveText('部分移除');
  const response = page.waitForResponse(res => res.url().endsWith('/api/project') && res.request().method() === 'POST');
  await page.locator('#save-project').click();
  expect((await response).ok()).toBe(true);
  await page.reload();
  await page.evaluate(() => MaweMarkersPanel.openPanel());
  await row.locator('.markers-item-edit').click();
  await expect(muteButton).toHaveText('部分静音');
  await expect(reviewToggle).toHaveText('部分移除');
  await expect(reviewToggle).toBeDisabled();
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review))
    .toMatchObject(splitRanges);
  // 包围全部归属片段的区段扩大继续按几何关联计算，而不撤销旧来源。
  await page.evaluate(() => MaweMarkerEditing.updateMarkerFields('ai-review', { start: 2900, end: 4100 }));
  await expect(muteButton).toHaveText('部分静音');
  await expect(reviewToggle).toHaveText('部分移除');
  await expect(reviewToggle).toBeDisabled();
});

test('AI review mute keeps full marker ids through project save and reload', async ({ page }) => {
  await seed(page);
  const markerId = `review-${'x'.repeat(180)}😀`;
  await page.evaluate(id => {
    MaweBoot.DATA.markers = window.AsrEditorUtils.normalizeMarkers([
      { id, start: 3000, end: 4000, note: '[AI] 复核', review: { status: 'pending' } },
    ]);
    MaweMarkerEditing.afterExternalMarkersChange();
  }, markerId);
  const row = page.locator(`[data-marker-id="${markerId}"]`);
  await row.locator('.markers-item-edit').click();
  await row.locator('.markers-ai-review-mute-toggle').click();
  await expect(row.locator('.markers-ai-review-mute-toggle')).toHaveText('已静音');
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review[0].review_marker_id))
    .toBe(markerId);
  const response = page.waitForResponse(res => res.url().endsWith('/api/project') && res.request().method() === 'POST');
  await page.locator('#save-project').click();
  expect((await response).ok()).toBe(true);
  await page.reload();
  await page.evaluate(() => MaweMarkersPanel.openPanel());
  await row.locator('.markers-item-edit').click();
  await expect(row.locator('.markers-ai-review-mute-toggle')).toHaveText('已静音');
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review[0].review_marker_id))
    .toBe(markerId);
  await row.locator('.markers-ai-review-mute-toggle').click();
  await expect(row.locator('.markers-ai-review-mute-toggle')).toHaveText('设静音');
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources.ai_cleanup_review)).toEqual([]);
});

test('filter-select-delete is one undo and preserves manual markers and clip decisions', async ({ page }) => {
  await seed(page);
  await page.locator('#markers-search').fill('[AI]');
  await expect(page.locator('.markers-item')).toHaveCount(2);
  await page.locator('#markers-batch-select').click();
  await expect(page.locator('.markers-item-checkbox')).toHaveCount(2);
  await page.locator('#markers-select-all').click();
  await expect(page.locator('.markers-item-checkbox:checked')).toHaveCount(2);
  await page.locator('#markers-delete-selected').click();
  expect(await page.evaluate(() => MaweMarkerEditing.getMarkers().map(m => m.id))).toEqual(['human']);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].disabled)).toBe(true);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweMarkerEditing.getMarkers().map(m => m.id)))
    .toEqual(['human', 'ai-delete', 'ai-review']);
  await page.locator('#redo-btn').click();
  expect(await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()).markers.items.map(m => m.id)))
    .toEqual(['human']);
  const response = page.waitForResponse(res => res.url().endsWith('/api/project') && res.request().method() === 'POST');
  await page.locator('#save-project').click();
  expect((await response).ok()).toBe(true);
  await page.reload();
  expect(await page.evaluate(() => MaweMarkerEditing.getMarkers().map(m => m.id))).toEqual(['human']);
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].disabled)).toBe(true);
});

test('changing filters drops hidden selections and all-select matches kind/review filters', async ({ page }) => {
  await seed(page);
  await page.locator('#markers-batch-select').click();
  await page.locator('[data-marker-id="human"] .markers-item-checkbox').check();
  await expect(page.locator('#markers-selection-summary')).toHaveText('已选 1 项');
  await page.locator('#markers-search').fill('[AI]');
  await expect(page.locator('#markers-delete-selected')).toBeDisabled();
  await page.locator('#markers-filter-review').selectOption('pending');
  await page.locator('#markers-filter-kind').selectOption('marker');
  await expect(page.locator('#markers-select-all')).toBeDisabled();
  await page.locator('#markers-filter-kind').selectOption('region');
  await page.locator('#markers-filter-color').selectOption('#f5a623');
  await page.locator('#markers-select-all').click();
  await expect(page.locator('.markers-item-checkbox:checked')).toHaveCount(1);
  await page.locator('#markers-delete-selected').click();
  expect(await page.evaluate(() => MaweMarkerEditing.getMarkers().map(m => m.id))).toEqual(['human', 'ai-delete']);
  await page.locator('#markers-search').fill('不存在');
  await expect(page.locator('#markers-select-all')).toBeDisabled();
  await expect(page.locator('#markers-delete-selected')).toBeDisabled();
});

test('checkbox selection does not seek; exit clears checks and selection is reset on project import', async ({ page }) => {
  await seed(page);
  await page.locator('#markers-batch-select').click();
  const time = await page.evaluate(() => MaweCoreState.player.currentTime);
  await page.locator('[data-marker-id="ai-review"] .markers-item-checkbox').check();
  expect(await page.evaluate(() => MaweCoreState.player.currentTime)).toBe(time);
  await page.locator('#markers-batch-select').click();
  await expect(page.locator('.markers-item-checkbox')).toHaveCount(0);
  await page.locator('#markers-batch-select').click();
  await expect(page.locator('#markers-delete-selected')).toBeDisabled();
  await page.locator('#markers-select-all').click();
  await page.evaluate(() => MaweProjectLoad.applyCanonicalProject({
    segments: [{ id: 'new', start: 0, end: 1000, text: '新工程' }],
    markers: { schema: 'moy.asr.markers.v1', items: [{ id: 'human', start: 100, name: '另一个工程' }] },
  }, 'new.mosp'));
  await expect(page.locator('#markers-batch-select')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.markers-item-checkbox')).toHaveCount(0);
});

test('batch controls translate and have measured spacing without translating AI notes', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await seed(page);
  await expect(page.locator('#markers-batch-select')).toHaveText('Batch select');
  await page.locator('#markers-batch-select').click();
  await expect(page.locator('#markers-select-all')).toHaveText('Select all');
  await expect(page.locator('#markers-delete-selected')).toHaveText('Delete selected');
  await page.locator('[data-marker-id="ai-delete"] .markers-item-checkbox').check();
  await expect(page.locator('#markers-selection-summary')).toHaveText('Selected 1 item(s)');
  const distances = await page.evaluate(() => {
    const filters = document.querySelector('.markers-filters-field').getBoundingClientRect();
    const actions = document.querySelector('#markers-batch-actions').getBoundingClientRect();
    const list = document.querySelector('#markers-list').getBoundingClientRect();
    return [actions.top - filters.bottom, list.top - actions.bottom];
  });
  expect(distances.every(distance => distance >= 8)).toBe(true);
  expect(await page.evaluate(() => MaweMarkerEditing.findMarker('ai-delete').note)).toBe('[AI] 删除：试麦');
  await page.screenshot({ path: test.info().outputPath('markers-batch-english.png') });
});
