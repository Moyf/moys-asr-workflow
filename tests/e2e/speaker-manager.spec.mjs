import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson, generateWav,
  makeTempDir, openSettingsPage, startServer } from './helpers.mjs';

test('speaker manager edits, binds and merges identities with atomic undo and save/reopen', async ({ page }, info) => {
  const directory = makeTempDir('speaker-manager');
  const path = join(directory, 'project.mosp');
  let server;
  try {
    const media = join(directory, 'synthetic.wav');
    generateProjectJson(path); generateWav(media, 2);
    server = await startServer(path, media, await findFreePort());
    await disableOnboarding(page);
    await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
    await page.goto(server.url);
    await openSettingsPage(page, 'project-color');
    await page.locator('#speaker-manager-toggle').click();
    await expect(page.locator('#speaker-manager')).toBeVisible();
    for (const slot of [6, 7, 8, 9]) await expect(page.locator(`[data-speaker-shortcut="${slot}"]`)).toBeHidden();
    for (let index = 0; index < 2; index++) {
      await page.locator('#speaker-new-name').fill('删除');
      await page.locator('#speaker-add').click();
    }
    await expect(page.locator('.speaker-manager-row')).toHaveCount(2);
    const [first, second] = await page.evaluate(() => MaweBoot.DATA.speakers.map(speaker => speaker.id));
    await page.locator('#speaker-palette-extended').check();
    await expect(page.locator('[data-speaker-shortcut="6"]')).toBeVisible();
    await page.locator('[data-speaker-shortcut="6"]').selectOption(first);
    await page.locator('#speaker-palette-extended').uncheck();
    await expect(page.locator('[data-speaker-shortcut="6"]')).toBeVisible();
    await expect(page.locator('[data-speaker-shortcut="6"]')).toHaveValue(first);
    for (const slot of [7, 8, 9]) await expect(page.locator(`[data-speaker-shortcut="${slot}"]`)).toBeHidden();
    const secondRow = page.locator('.speaker-manager-row').filter({ has: page.locator(`[data-speaker-field="name"]`) }).nth(1);
    await page.locator('[data-speaker-shortcut="2"]').selectOption(second);
    const untouched = await page.evaluate(([a, b]) => {
      const track = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
      MaweSpeakerLabels.assignIdentity([{ track_id: track.id, segment_id: track.segments[0].id }], a);
      MaweSpeakerLabels.assignIdentity([{ track_id: track.id, segment_id: track.segments[1].id }], b);
      return { items: track.segments.map(cue => cue.items), groups: MaweBoot.DATA.subtitle_groups };
    }, [first, second]);
    const snapshot = () => page.evaluate(() => MaweHistory.snapshotSegments());
    const undo = async () => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Control+z'); };
    const redo = async () => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Control+Shift+z'); };
    const beforeRename = await snapshot();
    await secondRow.locator('[data-speaker-field="name"]').fill('第二人');
    await secondRow.locator('[data-speaker-field="name"]').press('Tab');
    expect(await page.evaluate(id => MaweBoot.DATA.speakers.find(s => s.id === id).name, second)).toBe('第二人');
    await undo(); expect(await snapshot()).toEqual(beforeRename); await redo();
    const beforeColor = await snapshot();
    await secondRow.locator('[data-speaker-field="color"]').evaluate(input => {
      input.value = '#49c5c1'; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await page.evaluate(id => MaweBoot.DATA.speakers.find(s => s.id === id).color, second)).toBe('#49c5c1');
    await undo(); expect(await snapshot()).toEqual(beforeColor); await redo();
    expect(await page.evaluate(() => MaweBoot.DATA.speaker_shortcuts['2'])).toBe(second);
    const beforeMerge = await snapshot();
    await secondRow.locator('[data-speaker-field="merge-target"]').selectOption(first);
    await secondRow.getByRole('button', { name: '合并身份', exact: true }).click();
    await expect(page.locator('.speaker-manager-row')).toHaveCount(1);
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.slice(0, 2).map(cue => cue.speaker)))
      .toEqual([first, first]);
    expect(await page.evaluate(() => MaweBoot.DATA.speaker_shortcuts['2'])).toBe(first);
    await undo(); expect(await snapshot()).toEqual(beforeMerge);
    await expect(page.locator('.speaker-manager-row')).toHaveCount(2);
    await redo();
    expect(await page.evaluate(() => ({ items: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.map(cue => cue.items),
      groups: MaweBoot.DATA.subtitle_groups }))).toEqual(untouched);
    await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
    await expect(page.locator('#speaker-manager-toggle')).toHaveText('Manage speakers');
    await expect(page.locator('#subtitle-speaker-mapping-enabled').locator('..')).not.toHaveAttribute('title', /[\u3400-\u9fff]/u);
    await expect(page.locator('#subtitle-speaker-labels-settings > .editor-settings-hint')).not.toContainText(/[\u3400-\u9fff]/u);
    await expect(page.locator('.speaker-manager-row [data-speaker-field="name"]')).toHaveValue('删除');
    await expect(page.locator('[data-speaker-shortcut="2"] option:checked')).toContainText('删除');
    await page.setViewportSize({ width: 720, height: 720 });
    expect(await page.locator('.speaker-manager-row').evaluate(row => parseFloat(getComputedStyle(row).gap))).toBeGreaterThanOrEqual(8);
    expect(await page.locator('#speaker-project-controls').evaluate(row => parseFloat(getComputedStyle(row).gap))).toBeGreaterThanOrEqual(8);
    expect(await page.locator('.speaker-manager-add label').first().evaluate(label => parseFloat(getComputedStyle(label).gap))).toBeGreaterThanOrEqual(8);
    expect(await page.locator('#speaker-add').evaluate(button => getComputedStyle(button).whiteSpace)).toBe('nowrap');
    for (const theme of ['dark', 'light']) {
      await openSettingsPage(page, 'interface');
      await page.locator(`[data-editor-theme="${theme}"]`).click();
      await openSettingsPage(page, 'project-color');
      await page.locator('#speaker-manager').screenshot({ path: info.outputPath(`speaker-manager-narrow-${theme}.png`) });
    }
    expect(await page.evaluate(() => MaweProjectSave.saveCurrentProject({ silent: true }))).toBe(true);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.speakers).toHaveLength(1);
    expect(saved.speakers[0].name).toBe('删除');
    expect(saved.speaker_shortcuts['2']).toBe(first);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.MaweSpeakerManager));
    expect(await page.evaluate(() => ({ speakers: MaweBoot.DATA.speakers, slots: MaweBoot.DATA.speaker_shortcuts })))
      .toEqual({ speakers: saved.speakers, slots: saved.speaker_shortcuts });
  } finally {
    await server?.stop(); cleanupTempDir(directory);
  }
});
