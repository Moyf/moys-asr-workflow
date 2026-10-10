import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server, projectPath;
const python = process.env.MAW_E2E_PYTHON;
test.beforeAll(async () => {
  tempDir = makeTempDir('agent-interface');
  const media = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'agent.mosp');
  generateWav(media, 3);
  writeFileSync(projectPath, JSON.stringify({ schema: 'moy.asr.project.v1', media: 'synthetic.wav',
    preserve_punctuation: true, waveform: generateWaveformPayload(3000),
    segments: [
      { id: 'a', start: 0, end: 1000, text: '你好', speaker: 'Alice', items: [
        { start: 0, end: 500, text: '你' }, { start: 500, end: 1000, text: '好' }] },
      { id: 'b', start: 1500, end: 2500, text: 'outside', speaker: 'Bob' },
    ] }));
  server = await startServer(projectPath, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

async function exportSnapshot(page, name) {
  await page.locator('#open-project-menu-btn').click();
  const download = page.waitForEvent('download');
  await page.locator('#agent-export').click();
  const path = join(tempDir, name);
  await (await download).saveAs(path);
  return path;
}
function cli(args) {
  return JSON.parse(execFileSync(python, ['-m', 'maw.agent', ...args], { encoding: 'utf8', timeout: 15000 }));
}

test('real CLI to editor: snapshot selection, review, cancel, apply, undo, save and conflict', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.autoSaveProject = false;
    MaweState.selection.replace('main', [0]);
    MaweBoot.DATA.segments[1].runtimeOnly = 'keep';
  });
  const beforeFile = readFileSync(projectPath, 'utf8');
  const snapshotPath = await exportSnapshot(page, 'snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  expect(snapshot.context.selected_ids).toEqual(['a']);
  expect(snapshot.context.selected_range).toEqual([0, 1000]);
  const edits = join(tempDir, 'edits.json');
  const proposalPath = join(tempDir, 'proposal.json');
  writeFileSync(edits, JSON.stringify([{ id: 'a', text: '您好' }]));
  expect(cli(['propose-text', snapshotPath, '--edits', edits, '--reason', '修正称谓', '--output', proposalPath]).ok).toBe(true);
  await page.locator('#agent-proposal-file').setInputFiles(proposalPath);
  await expect(page.locator('#agent-review')).toBeVisible();
  await expect(page.locator('#agent-review-report')).toContainText('您好');
  expect(readFileSync(projectPath, 'utf8')).toBe(beforeFile);
  const spacing = await page.locator('#agent-review-apply').evaluate(el => {
    const bar = el.parentElement;
    const report = document.getElementById('agent-review-report');
    return bar.getBoundingClientRect().top - report.getBoundingClientRect().bottom;
  });
  expect(spacing).toBeGreaterThanOrEqual(8);
  console.log(`Agent review action spacing: ${spacing}px`);
  await page.screenshot({ path: testInfo.outputPath('agent-review.png'), fullPage: true });
  await page.locator('#agent-review-cancel').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('你好');
  await page.locator('#agent-proposal-file').setInputFiles(proposalPath);
  await page.locator('#agent-review-apply').click();
  expect(await page.evaluate(() => [MaweBoot.DATA.segments[0].text, MaweBoot.DATA.segments[0].items[0].text,
    MaweBoot.DATA.segments[1].runtimeOnly])).toEqual(['您好', '您', 'keep']);
  await page.locator('#undo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('你好');
  await page.locator('#redo-btn').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('您好');
  await page.locator('#save-project').click();
  await expect.poll(() => JSON.parse(readFileSync(projectPath, 'utf8')).segments[0].text).toBe('您好');
  await page.locator('#agent-proposal-file').setInputFiles(proposalPath);
  await expect(page.locator('#agent-review')).not.toBeVisible();
  await expect(page.locator('#hint-stack')).toContainText('工程已变化');
  expect(errors).toEqual([]);
});

test('English review translates controls while preserving proposal reason and subtitle content', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  const path = await exportSnapshot(page, 'english-snapshot.json');
  const base = JSON.parse(readFileSync(path, 'utf8')).project;
  const proposalPath = join(tempDir, 'english-proposal.json');
  writeFileSync(proposalPath, JSON.stringify({
    schema: 'moy.asr.agent.proposal.v1', reason: '保存工程', base,
    operation: { type: 'text', edits: [{ id: 'a', text: '再见' }] },
  }));
  await page.locator('#agent-proposal-file').setInputFiles(proposalPath);
  await expect(page.locator('#agent-review h2')).toHaveText('Review Agent proposal');
  await expect(page.locator('#agent-review-apply')).toHaveText('Apply proposal');
  await expect(page.locator('#agent-review-report strong').first()).toHaveText('Before');
  await expect(page.locator('#agent-review-report p').first()).toHaveText('保存工程');
  await expect(page.locator('#agent-review-report pre').last()).toContainText('再见');
  await expect(page.locator('#agent-review-report pre').last()).toContainText('Word timings');
  await page.locator('#agent-review-cancel').click();
});

test('range replacement and review-time conflict preserve outside subtitles', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => { MaweSettings.EDITOR_SETTINGS.autoSaveProject = false; });
  const snapshotPath = await exportSnapshot(page, 'range-snapshot.json');
  const replacement = join(tempDir, 'replacement.mosp');
  const proposalPath = join(tempDir, 'range-proposal.json');
  writeFileSync(replacement, JSON.stringify({ segments: [
    { start: 100, end: 450, text: '拆分一', speaker: 'Alice' },
    { start: 500, end: 950, text: '拆分二', speaker: 'Alice' },
  ] }));
  expect(cli(['propose-range', snapshotPath, '--start', '0', '--end', '1000', '--replacement', replacement,
    '--reason', '分段测试', '--output', proposalPath]).ok).toBe(true);
  const outside = await page.evaluate(() => JSON.stringify(MaweBoot.DATA.segments[1]));
  await page.locator('#agent-proposal-file').setInputFiles(proposalPath);
  await page.locator('#agent-review-apply').click();
  expect(await page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(3);
  expect(await page.evaluate(() => JSON.stringify(MaweBoot.DATA.segments[2]))).toBe(outside);
  await page.locator('#undo-btn').click();
  await page.locator('#agent-proposal-file').setInputFiles(proposalPath);
  await expect(page.locator('#agent-review')).toBeVisible();
  await page.evaluate(() => { MaweBoot.DATA.segments[1].text = 'changed during review'; });
  await page.locator('#agent-review-apply').click();
  await expect(page.locator('#hint-stack')).toContainText('工程已变化');
  expect(await page.evaluate(() => MaweBoot.DATA.segments.length)).toBe(2);
  await page.locator('#agent-review-cancel').click();
  await page.evaluate(() => { MaweBoot.DATA.segments[0].end = 0; });
  await page.locator('#agent-proposal-file').setInputFiles(proposalPath);
  await expect(page.locator('#agent-review')).not.toBeVisible();
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].end)).toBe(0);
});
