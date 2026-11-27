import { launcherFixtureUrl } from '../helpers/launcher-browser-fixture.mjs';
import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';

test('complete comparison opens from the current preview without starting a write', async ({ page }, testInfo) => {
  await page.goto(launcherFixtureUrl());
  await completeStaticLauncherDiscovery(page);
  await page.locator('#toolboxFab').click();
  await page.locator('#toolboxMatchTab').click();
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.reviewCalls = [];
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'read_script_preview') return { ok: true, preview: '这一句是文稿。' };
      if (method === 'preview_script_match') return { ok: true, preview: '1. 这一句是修正结果。', matchRate: 98, originalSegmentCount: 1, matchedSegmentCount: 1 };
      if (method === 'open_script_match_review' || method === 'run_script_match') {
        window.reviewCalls.push({ method, payload });
        return { ok: true };
      }
      return original(method, payload);
    };
  });
  await page.locator('#toolboxInputPath').fill('D:\\Demo\\source.mosp');
  await page.locator('#postprocessScriptPath').fill('D:\\Demo\\script.txt');
  const open = page.locator('#openScriptMatchReview');
  await expect(open).toBeVisible();
  const spacing = await open.evaluate(button => button.getBoundingClientRect().top - button.previousElementSibling.getBoundingClientRect().bottom);
  expect(spacing).toBeGreaterThanOrEqual(8);
  const screenshots = process.env.MAW_REVIEW_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await page.locator('#toolboxMatchPanel').screenshot({ path: screenshots ? path.join(screenshots, 'launcher-entry.png') : testInfo.outputPath('launcher-match-review-entry.png') });
  console.log(`Preview → full comparison button spacing: ${spacing}px`);
  await open.click();
  await expect.poll(() => page.evaluate(() => window.reviewCalls.length)).toBe(1);
  await page.locator('#postprocessMatchMode').selectOption('text');
  await expect(page.locator('#postprocessSplitPreviewLabel')).toContainText('更正预览');
  await open.click();
  await expect.poll(() => page.evaluate(() => window.reviewCalls.length)).toBe(2);
  const calls = await page.evaluate(() => window.reviewCalls);
  expect(calls.map(call => call.method)).toEqual(['open_script_match_review', 'open_script_match_review']);
  expect(calls[0].payload).toMatchObject({ projectPath: 'D:\\Demo\\source.mosp', scriptPath: 'D:\\Demo\\script.txt', matchMode: 'script', cleanMarkdownSymbols: true });
  expect(calls[1].payload.matchMode).toBe('text');
});

test('match preview shows a pending hint until the current result is ready', async ({ page }, testInfo) => {
  await page.goto(launcherFixtureUrl());
  await completeStaticLauncherDiscovery(page);
  await page.locator('#toolboxFab').click();
  await page.locator('#toolboxMatchTab').click();
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.matchPreviewResolvers = {};
    window.MAWLauncher.callBackend = (method, payload) => {
      if (method === 'read_script_preview') return Promise.resolve({ ok: true, preview: '文稿已读取。' });
      if (method === 'preview_script_match') {
        return new Promise(resolve => { window.matchPreviewResolvers[payload.matchMode] = resolve; });
      }
      return original(method, payload);
    };
  });
  await page.locator('#toolboxInputPath').fill('D:\\Demo\\source.mosp');
  const script = page.locator('#postprocessScriptPath');
  await script.fill('D:\\Demo\\script.txt');
  const hint = page.locator('#postprocessSplitPreviewPending');
  const open = page.locator('#openScriptMatchReview');
  await expect(page.locator('#postprocessScriptPreviewText')).toHaveText('文稿已读取。');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('正在匹配文稿与字幕，生成预览…');
  await expect(open).toBeHidden();
  const spacing = await hint.evaluate(node => node.getBoundingClientRect().top - node.previousElementSibling.getBoundingClientRect().bottom);
  expect(spacing).toBeGreaterThanOrEqual(8);
  const screenshots = process.env.MAW_REVIEW_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await page.locator('.match-previews').screenshot({ path: screenshots ? path.join(screenshots, 'launcher-match-pending.png') : testInfo.outputPath('launcher-match-pending.png') });

  await page.locator('#postprocessMatchMode').selectOption('text');
  await page.waitForFunction(() => Boolean(window.matchPreviewResolvers.text));
  await page.evaluate(() => window.matchPreviewResolvers.script({ ok: true, preview: '旧预览' }));
  await expect(hint).toBeVisible();
  await expect(open).toBeHidden();
  await page.evaluate(() => window.matchPreviewResolvers.text({ ok: true, preview: '最新预览', matchRate: 98 }));
  await expect(hint).toBeHidden();
  await expect(page.locator('#postprocessSplitPreviewText')).toHaveText('最新预览');
  await expect(open).toBeEnabled();

  await page.locator('#postprocessMatchMode').selectOption('script');
  await expect(hint).toBeVisible();
  await page.evaluate(() => window.matchPreviewResolvers.script({ ok: false, errorCode: 'preview_failed' }));
  await expect(hint).toBeHidden();
  await expect(page.locator('#postprocessMatchStats')).toBeVisible();

  await script.fill('D:\\Demo\\other.txt');
  await expect(hint).toBeVisible();
  await script.clear();
  await expect(hint).toBeHidden();
});

test('script match completion points to the comparison tools and keeps diagnostics in the log', async ({ page }, testInfo) => {
  await page.goto(launcherFixtureUrl());
  await completeStaticLauncherDiscovery(page);
  await page.locator('#toolboxFab').click();
  await page.locator('#toolboxMatchTab').click();
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.matchDiagnostics = [];
    window.MAWLauncher.appendLog = message => window.matchDiagnostics.push(message);
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'read_script_preview') return { ok: true, preview: '文稿' };
      if (method === 'preview_script_match') return { ok: true, preview: '匹配结果' };
      if (method === 'run_script_match') return {
        ok: true, projectPath: 'D:\\Demo\\matched.mosp',
        warnings: ['断句符号：8 个；保留：8 个。', '6 个字幕段缺少字词时间码。',
          '2 个禁用字幕与匹配结果重叠，已按原时间和词码移至叠加轨。'],
      };
      return original(method, payload);
    };
  });
  await page.locator('#toolboxInputPath').fill('D:\\Demo\\source.mosp');
  await page.locator('#postprocessScriptPath').fill('D:\\Demo\\script.txt');
  await page.locator('#runScriptMatch').click();
  const summary = page.locator('#toolboxResultText');
  await expect(summary).toContainText('2 个禁用字幕与匹配结果重叠');
  await expect(summary).toHaveText(/文稿来源：D:\\Demo\\script\.txt\s+使用上方的「转写对比」工具查看详情。/);
  await expect(summary).not.toContainText('字词时间码');
  expect(await page.evaluate(() => window.matchDiagnostics)).toContain('6 个字幕段缺少字词时间码。');
  const tools = page.locator('.toolbox-compare-row');
  await expect(tools).toContainText('对比工具');
  const screenshots = process.env.MAW_REVIEW_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const screenshotPath = name => screenshots ? path.join(screenshots, name) : testInfo.outputPath(name);
  for (const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await expect.poll(() => tools.locator('button').evaluateAll(buttons => buttons.map(button => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--info)';
      button.parentElement.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(button).color === expected;
    }))).toEqual([true, true]);
    await tools.screenshot({ path: screenshotPath(`comparison-tools-${theme}.png`) });
  }
  await page.locator('#toolboxResult').screenshot({ path: screenshotPath('match-result-summary.png') });
});

async function openLauncherComparisonFixture(page) {
  await page.goto(launcherFixtureUrl());
  await completeStaticLauncherDiscovery(page);
  await page.locator('#toolboxFab').click();
  await page.locator('#toolboxMatchTab').click();
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.comparisonFixture = { compares: [], matches: [], reviews: [] };
    window.MAWLauncher.callBackend = async (method, payload) => {
      const fixture = window.comparisonFixture;
      if (method === 'read_script_preview') return { ok: true, preview: '文稿' };
      if (method === 'preview_script_match') return { ok: true, preview: '匹配结果' };
      if (method === 'run_script_match') {
        const source = payload.projectPath || payload.srtPath;
        fixture.matches.push(source);
        if (fixture.deferMatch) await new Promise(resolve => { fixture.finishMatch = resolve; });
        const output = source.replace(/\.[^.]+$/, payload.srtPath ? '.branch' : '.match');
        return { ok: true, projectPath: `${output}.mosp`, srtPath: `${output}.srt` };
      }
      if (method === 'open_compare_tool') {
        fixture.compares.push(payload);
        return { ok: true };
      }
      if (method === 'open_script_match_review') {
        fixture.reviews.push(payload);
        return { ok: true };
      }
      return original(method, payload);
    };
  });
  await page.locator('#postprocessScriptPath').fill('D:\\Demo\\script.txt');
}

test('both comparison tools pair each independent input with its own matching result', async ({ page }) => {
  await openLauncherComparisonFixture(page);
  const input = page.locator('#toolboxInputPath');
  const run = page.locator('#runScriptMatch');
  const transcript = page.getByRole('button', { name: '转写对比' });
  await input.fill('D:\\Demo\\A.mosp');
  await run.click();
  await expect(input).toHaveValue('D:\\Demo\\A.match.mosp');
  const spacing = await page.locator('.toolbox-compare-row').evaluate(row => row.getBoundingClientRect().top - document.getElementById('toolboxChainList').getBoundingClientRect().bottom);
  expect(spacing).toBeGreaterThanOrEqual(8);
  await transcript.click();
  await input.fill('D:\\Demo\\B.mosp');
  await run.click();
  await expect(input).toHaveValue('D:\\Demo\\B.match.mosp');
  await transcript.click();
  await page.getByRole('button', { name: '时间码对比' }).click();
  await expect.poll(() => page.evaluate(() => window.comparisonFixture.compares)).toEqual([
    { tool: 'transcript', paths: ['D:\\Demo\\A.mosp', 'D:\\Demo\\A.match.mosp'], lang: 'zh-CN' },
    { tool: 'transcript', paths: ['D:\\Demo\\B.mosp', 'D:\\Demo\\B.match.mosp'], lang: 'zh-CN' },
    { tool: 'timestamp', paths: ['D:\\Demo\\B.mosp', 'D:\\Demo\\B.match.mosp'], lang: 'zh-CN' },
  ]);
  expect(await page.evaluate(() => window.comparisonFixture.matches)).toEqual(['D:\\Demo\\A.mosp', 'D:\\Demo\\B.mosp']);
  await expect(page.locator('#toolboxChainOriginal button')).toHaveAttribute('data-artifact-path', 'D:\\Demo\\B.mosp');

  await input.fill('D:\\Demo\\unprocessed.srt');
  await transcript.click();
  await expect.poll(() => page.evaluate(() => window.comparisonFixture.compares.at(-1)?.paths)).toEqual(['D:\\Demo\\unprocessed.srt']);
  await page.evaluate(() => {
    document.getElementById('jsonPath').value = '';
    document.getElementById('srtPath').value = '';
  });
  await input.clear();
  await transcript.click();
  await expect(page.locator('#toolboxInputPathError')).not.toHaveText('');
  expect(await page.evaluate(() => window.comparisonFixture.compares.length)).toBe(4);
});

test('follow-on and branched results keep their original input, including after an input switch during processing', async ({ page }) => {
  await openLauncherComparisonFixture(page);
  const input = page.locator('#toolboxInputPath');
  const run = page.locator('#runScriptMatch');
  const transcript = page.getByRole('button', { name: '转写对比' });
  const latestComparison = () => page.evaluate(() => window.comparisonFixture.compares.at(-1)?.paths);

  await input.fill('D:\\Demo\\A.mosp');
  await run.click();
  await expect(input).toHaveValue('D:\\Demo\\A.match.mosp');
  await run.click();
  await expect(input).toHaveValue('D:\\Demo\\A.match.match.mosp');
  await transcript.click();
  await expect.poll(latestComparison).toEqual(['D:\\Demo\\A.mosp', 'D:\\Demo\\A.match.match.mosp']);

  await input.fill('D:\\Demo\\B.mosp');
  await page.evaluate(() => { window.comparisonFixture.deferMatch = true; });
  await run.click();
  await page.waitForFunction(() => Boolean(window.comparisonFixture.finishMatch));
  const firstSrt = page.locator('.toolbox-chain-item [data-artifact-kind="srt"]').first();
  await firstSrt.click();
  await expect(input).toHaveValue('D:\\Demo\\A.match.srt');
  await transcript.click();
  await expect.poll(latestComparison).toEqual(['D:\\Demo\\A.mosp', 'D:\\Demo\\A.match.mosp']);
  await page.evaluate(() => {
    window.comparisonFixture.deferMatch = false;
    window.comparisonFixture.finishMatch();
  });
  await expect(input).toHaveValue('D:\\Demo\\B.match.mosp');
  await transcript.click();
  await expect.poll(latestComparison).toEqual(['D:\\Demo\\B.mosp', 'D:\\Demo\\B.match.mosp']);

  await firstSrt.click();
  await page.getByRole('button', { name: '打开完整对照' }).click();
  await expect.poll(() => page.evaluate(() => window.comparisonFixture.reviews.at(-1)?.srtPath)).toBe('D:\\Demo\\A.match.srt');
  await run.click();
  await expect(page.locator('.toolbox-chain-item')).toHaveCount(4);
  await transcript.click();
  await expect.poll(latestComparison).toEqual(['D:\\Demo\\A.mosp', 'D:\\Demo\\A.match.branch.mosp']);
  expect(await page.evaluate(() => window.comparisonFixture.matches)).toEqual([
    'D:\\Demo\\A.mosp', 'D:\\Demo\\A.match.mosp', 'D:\\Demo\\B.mosp', 'D:\\Demo\\A.match.srt',
  ]);
});
