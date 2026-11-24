import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { disableOnboarding, findFreePort, openSettingsPage, startBlankServer } from './helpers.mjs';

const srt = '1\n00:00:01,000 --> 00:00:02,000\nSRT cue\n';
const lrc = '[00:01.00]LRC cue\n';
const project = JSON.stringify({ media: '', segments: [{ start: 1000, end: 2000, text: 'Project cue' }] });
const assWarning = '编辑器不支持导入 ASS/SSA 字幕。可在 Launcher 的「烧录字幕」中使用。';
const primaryWarning = '请选择 SRT 或 LRC 字幕文件。';
const secondaryWarning = '请选择 SRT、LRC、JSON 或 MOSP 文件。';

let server;
test.beforeAll(async ({}, workerInfo) => {
  server = await startBlankServer(await findFreePort(), join(workerInfo.project.outputDir, 'subtitle-import-settings'));
});
test.afterAll(async () => {
  await server?.stop();
});

test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  // Keep this import test independent of the empty project's Save As flow.
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  await page.goto(server.url);
});

async function chooseFile(page, button, name, text) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(button).click()]);
  await chooser.setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
}

async function choosePrimary(page, button, name, text) {
  await page.locator('#import-btn').click();
  await chooseFile(page, button, name, text);
}

async function dropFile(page, name, text) {
  const dataTransfer = await page.evaluateHandle(([filename, content]) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], filename, { type: 'text/plain' }));
    return transfer;
  }, [name, text]);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

for (const [button, suffix, text, cue] of [
  ['#load-srt', 'SRT', srt, 'SRT cue'],
  ['#load-lrc', 'lrc', lrc, 'LRC cue'],
]) {
  test(`primary ${suffix} chooser rejects unsupported suffixes before parsing`, async ({ page }) => {
    for (const [name, warning] of [
      ['wrong.ass', assWarning],
      ['wrong.txt', primaryWarning],
      ['wrong.SSA', assWarning],
      ['wrong.JSON', primaryWarning],
      ['wrong.mosp', primaryWarning],
    ]) {
      await page.reload();
      // Give the wrong extensions parseable text to verify rejection precedes parsing.
      const hints = page.locator('#hint-stack .hint-card');
      await choosePrimary(page, button, name, srt);
      await expect(hints.last()).toHaveText(warning);
      await expect(page.locator('#cues-container > .cue')).toHaveCount(0);
    }
    await choosePrimary(page, button, `good.${suffix}`, text);
    await expect(page.locator('#cues-container > .cue')).toContainText(cue);
  });
}

test('both secondary chooser entry points reject unsupported suffixes and keep supported imports', async ({ page }) => {
  await choosePrimary(page, '#load-srt', 'main.srt', srt);
  await expect(page.locator('#cues-container > .cue')).toContainText('SRT cue');
  await openSettingsPage(page, 'multi-subtitle');

  page.on('dialog', dialog => dialog.accept());
  const [quickChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#multi-subtitle-toggle').check(),
  ]);
  await quickChooser.setFiles({ name: 'quick.ass', mimeType: 'text/plain', buffer: Buffer.from(project) });
  const hints = page.locator('#hint-stack .hint-card');
  await expect(hints.last()).toHaveText(assWarning);

  const modal = page.locator('#multi-subtitle-import-modal');
  for (const [name, warning] of [['wrong.txt', secondaryWarning], ['wrong.SSA', assWarning]]) {
    await chooseFile(page, '#multi-subtitle-import', name, project);
    await expect(hints.last()).toHaveText(warning);
    await expect(modal).not.toBeVisible();
  }
  for (const [name, text] of [['secondary.srt', srt], ['secondary.lrc', lrc], ['secondary.json', project], ['secondary.MOSP', project]]) {
    await chooseFile(page, '#multi-subtitle-import', name, text);
    await expect(modal).toBeVisible();
    await page.locator('#multi-subtitle-import-result-cancel').click();
    await expect(modal).not.toBeVisible();
  }
});

test('drop still rejects ASS and imports subtitles and project files', async ({ page }) => {
  await dropFile(page, 'wrong.ass', srt);
  await expect(page.locator('#hint-stack .hint-card').last()).toHaveText(
    '不支持的文件类型（仅支持视频 / 音频 / JSON / SRT / LRC / reapeaks）',
  );
  await dropFile(page, 'good.lrc', lrc);
  await expect(page.locator('#cues-container > .cue')).toContainText('LRC cue');
  const modal = page.locator('#multi-subtitle-import-modal');
  await dropFile(page, 'good.srt', srt);
  await expect(modal).toBeVisible();
  await page.locator('#multi-subtitle-import-result-cancel').click();
  page.on('dialog', dialog => dialog.accept());
  await dropFile(page, 'good.mosp', project);
  await expect(modal).toBeVisible();
  await page.locator('#multi-subtitle-import-replace').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await expect(page.locator('#cues-container > .cue')).toContainText('Project cue');
});
