import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson,
  generateWav, makeTempDir, startServer,
} from './helpers.mjs';

let tempDir;
let server;
test.beforeAll(async () => {
  tempDir = makeTempDir('ai-marker-restore');
  const media = join(tempDir, 'synthetic.wav');
  const project = join(tempDir, 'project.json');
  generateWav(media, 300);
  generateProjectJson(project);
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

async function seed(page) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.markers = AsrEditorUtils.normalizeMarkers([
      { id: 'auto', start: 1000, end: 2000, name: '口误', color: '#8e4ec6', note: '[AI] 删除：口误' },
      { id: 'human', start: 2500, end: 2800, name: '人工', color: '#8e4ec6' },
      { id: 'review', start: 3000, end: 4000, note: '[AI] 复核：待确认', review: { status: 'pending' } },
    ]);
    AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].disabled = true;
    const provenance = AsrGapRemoveCore.normalizeGapRemoveProvenance({ sources: {
      ai_cleanup: [{ id: 'auto-source', start: 1000, end: 2000 }],
      audio_gate: [{ id: 'overlap', start: 1500, end: 2200 }],
    } });
    MaweGapRemoveUi.setGapRemoveData({ gaps: AsrGapRemoveCore.gapRangesFromProvenance(provenance) },
      { dirty: false, provenance });
    MaweMarkerEditing.afterExternalMarkersChange();
  });
  if (await page.locator('#markers-quick-toggle').getAttribute('aria-pressed') !== 'true') {
    await page.locator('#markers-quick-toggle').click();
  }
}

async function removedRanges(page) {
  return page.evaluate(() => AsrGapRemoveCore.getRemovedGapRanges(MaweGapRemoveData.getGapRemoveGaps())
    .map(({ start, end }) => ({ start, end })));
}

async function openPopup(page) {
  await page.locator('.waveform-marker-item[data-marker-id="auto"]').dblclick();
  return page.locator('.waveform-marker-quick-edit');
}

test('automatic removal restores actual audio range through popup, undo, save and reload', async ({ page }) => {
  await seed(page);
  let popup = await openPopup(page);
  const status = () => popup.locator('.markers-review-toggle');
  const action = () => popup.locator('.markers-ai-review-mute-toggle');
  await expect(status()).toHaveText('已移除');
  await expect(status()).toBeDisabled();
  await expect(action()).toHaveText('恢复');
  await page.mouse.move(0, 0);
  await popup.screenshot({ path: test.info().outputPath('auto-marker-popup-zh-removed.png') });
  const sources = await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources);
  await action().click();
  await expect(status()).toHaveText('已恢复');
  await expect(action()).toHaveText('移除');
  expect(await removedRanges(page)).toEqual([{ start: 2000, end: 2200 }]);
  expect(await page.evaluate(() => MaweGapRemoveData.getGapRemoveData(false).provenance.sources)).toEqual(sources);
  expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].disabled)).toBe(true);
  await page.locator('#undo-btn').click();
  popup = await openPopup(page);
  await expect(status()).toHaveText('已移除');
  expect(await removedRanges(page)).toEqual([{ start: 1000, end: 2200 }]);
  await page.locator('#redo-btn').click();
  popup = await openPopup(page);
  await expect(status()).toHaveText('已恢复');
  await action().click();
  await expect(status()).toHaveText('已移除');
  expect(await removedRanges(page)).toEqual([{ start: 1000, end: 2200 }]);
  await action().click();
  await page.evaluate(() => MaweMarkerEditing.updateMarkerFields('auto', {
    note: '人工改写', color: '#ffffff', name: '改名',
  }));
  const response = page.waitForResponse(res => res.url().endsWith('/api/project') && res.request().method() === 'POST');
  await page.locator('#save-project').click();
  expect((await response).ok()).toBe(true);
  await page.reload();
  popup = await openPopup(page);
  await expect(status()).toHaveText('已恢复');
  await expect(action()).toHaveText('移除');
  expect(await page.evaluate(() => MaweMarkerEditing.findMarker('auto').cleanup_action)).toBe('remove');
  expect(await removedRanges(page)).toEqual([{ start: 2000, end: 2200 }]);
  await action().click();
  await expect(status()).toHaveText('已移除');
});

test('English popup stays inside the right edge when keyboard undo widens its status', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    MAWE_I18N.applyLanguage('en');
    const row = document.querySelector('.waveform-marker-item[data-marker-id="auto"]').closest('.waveform-row');
    const rowStart = Number(row.dataset.startMs);
    const span = Number(row.dataset.endMs) - rowStart;
    const start = Math.round(rowStart + span * 0.92);
    const end = Math.round(rowStart + span * 0.97);
    MaweMarkerEditing.updateMarkerFields('auto', { start, end });
    const provenance = AsrGapRemoveCore.normalizeGapRemoveProvenance({ sources: {
      ai_cleanup: [{ start: Math.round((start + end) / 2), end }],
    } });
    MaweGapRemoveUi.setGapRemoveData({ gaps: AsrGapRemoveCore.gapRangesFromProvenance(provenance) },
      { dirty: false, provenance });
  });
  const popup = await openPopup(page);
  const status = popup.locator('.markers-review-toggle');
  await expect(status).toHaveText('Partially removed');
  await popup.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(status).toHaveText('Restored');
  // Reopen at the right edge with the narrower label, as a user would.
  await page.keyboard.press('Escape');
  await openPopup(page);
  await expect(status).toHaveText('Restored');
  const geometry = () => popup.evaluate(element => {
    const content = element.parentElement;
    const contentRight = content.getBoundingClientRect().left + content.clientLeft + content.clientWidth;
    const rect = element.getBoundingClientRect();
    const deleteRight = element.querySelector('.markers-item-actions .danger').getBoundingClientRect().right;
    return { width: rect.width, rightInset: contentRight - rect.right, deleteInset: contentRight - deleteRight };
  });
  await expect.poll(async () => (await geometry()).rightInset).toBeGreaterThanOrEqual(3);
  const before = await geometry();
  expect(before.rightInset).toBeLessThanOrEqual(5);
  expect(before.deleteInset).toBeGreaterThan(0);
  const originalPopup = await popup.elementHandle();
  await popup.getByRole('button', { name: 'Remove', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(status).toHaveText('Partially removed');
  expect(await originalPopup.evaluate(element => element.isConnected)).toBe(true);
  await expect.poll(async () => (await geometry()).rightInset, {
    message: 'the expanded popup must stay inside the waveform',
  }).toBeGreaterThanOrEqual(3);
  const after = await geometry();
  expect(after.width).toBeGreaterThan(before.width);
  expect(after.deleteInset).toBeGreaterThan(after.rightInset);
  await popup.screenshot({ path: test.info().outputPath('auto-marker-popup-en-after-undo.png') });
});

test('partial and edited regions use current coverage; existing actions and measured layout stay coherent', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    MaweGapRemoveUi.commitManualGapRemoveChange(MaweGapRemoveData.getGapRemoveData(true),
      [{ start: 1000, end: 1500, removed: false }]);
  });
  const popup = await openPopup(page);
  const action = popup.locator('.markers-ai-review-mute-toggle');
  await expect(popup.locator('.markers-review-toggle')).toHaveText('部分移除');
  await expect(action).toHaveText('恢复');
  await action.click();
  await expect(popup.locator('.markers-review-toggle')).toHaveText('已恢复');
  await page.locator('#markers-manage').click();
  const row = page.locator('.markers-item[data-marker-id="auto"]');
  await row.locator('.markers-item-edit').click();
  await expect(row.locator('.markers-review-toggle')).toHaveText('已恢复');
  await expect(row.locator('.markers-ai-review-mute-toggle')).toHaveText('移除');
  for (const language of ['zh', 'en']) {
    await page.evaluate(language => MAWE_I18N.applyLanguage(language), language);
    await expect(row.locator('.markers-review-toggle')).toHaveText(language === 'zh' ? '已恢复' : 'Restored');
    await expect(row.locator('.markers-ai-review-mute-toggle')).toHaveText(language === 'zh' ? '移除' : 'Remove');
    const geometry = await row.locator('.markers-item-actions').evaluate(actions => {
      const status = actions.querySelector('.markers-review-toggle').getBoundingClientRect();
      const action = actions.querySelector('.markers-ai-review-mute-toggle').getBoundingClientRect();
      const previous = actions.previousElementSibling.getBoundingClientRect();
      return { vertical: actions.getBoundingClientRect().top - previous.bottom,
        horizontal: action.left - status.right, topDifference: action.top - status.top };
    });
    expect(geometry.vertical).toBeGreaterThanOrEqual(8);
    expect(geometry.horizontal).toBeGreaterThanOrEqual(8);
    expect(Math.abs(geometry.topDifference)).toBeLessThanOrEqual(1);
    await test.info().attach(`manager-spacing-${language}`, {
      body: Buffer.from(JSON.stringify(geometry)), contentType: 'application/json',
    });
  }
  await page.mouse.move(0, 0);
  await page.locator('#markers-panel').screenshot({ path: test.info().outputPath('auto-marker-manager-en.png') });
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await page.locator('.markers-item[data-marker-id="human"] .markers-item-edit').click();
  await expect(page.locator('.markers-item[data-marker-id="human"] .markers-ai-review-mute-toggle')).toBeHidden();
  await page.locator('.markers-item[data-marker-id="review"] .markers-item-edit').click();
  await expect(page.locator('.markers-item[data-marker-id="review"] .markers-ai-review-mute-toggle')).toHaveText('设静音');
  await page.locator('#markers-manage').click();
  await openPopup(page);
  for (const language of ['zh', 'en']) {
    await page.evaluate(language => MAWE_I18N.applyLanguage(language), language);
    await expect(action).toHaveText(language === 'zh' ? '移除' : 'Remove');
    const geometry = await popup.evaluate(element => {
      const swatches = element.querySelector('.markers-color-swatches').getBoundingClientRect();
      const actions = element.querySelector('.markers-item-actions').getBoundingClientRect();
      const outer = element.getBoundingClientRect();
      const input = element.querySelector('input').getBoundingClientRect();
      const status = element.querySelector('.markers-review-toggle').getBoundingClientRect();
      const action = element.querySelector('.markers-ai-review-mute-toggle').getBoundingClientRect();
      return { spacing: actions.top - swatches.bottom, rightInset: outer.right - actions.right,
        inputInset: outer.right - input.right, horizontal: action.left - status.right,
        topDifference: action.top - status.top };
    });
    expect(geometry.spacing).toBeGreaterThanOrEqual(8);
    expect(geometry.rightInset).toBeGreaterThanOrEqual(9);
    expect(geometry.inputInset).toBeGreaterThanOrEqual(9);
    expect(geometry.horizontal).toBeGreaterThanOrEqual(8);
    expect(Math.abs(geometry.topDifference)).toBeLessThanOrEqual(1);
    await test.info().attach(`popup-spacing-${language}`, {
      body: Buffer.from(JSON.stringify(geometry)), contentType: 'application/json',
    });
  }
  await page.mouse.move(0, 0);
  await popup.screenshot({ path: test.info().outputPath('auto-marker-popup-en.png') });
  await page.evaluate(() => {
    MAWE_I18N.applyLanguage('zh');
    MaweMarkerEditing.updateMarkerFields('auto', { start: 1800, end: 2400 });
  });
  await openPopup(page);
  await expect(action).toHaveText('恢复');
  await action.click();
  expect(await removedRanges(page)).toEqual([]);
  await action.click();
  expect(await removedRanges(page)).toEqual([{ start: 1800, end: 2400 }]);
});
