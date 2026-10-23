import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';
import { test, expect } from '@playwright/test';

const launcherUrl = new URL('../../web/launcher/index.html', import.meta.url).href;

test('automatic processing reports skipped AI steps at the end', async ({ page }, testInfo) => {
  await page.goto(launcherUrl);
  await completeStaticLauncherDiscovery(page);
  await page.waitForFunction(() => window.MAWLauncher?.onPostprocessPipeline);
  await page.locator('#toolboxFab').click();
  await page.evaluate(() => window.MAWLauncher.onPostprocessPipeline({
    stage: 'done', skippedSteps: ['cleanup'], warnings: ['AI 整理失败，已沿用上一步字幕；失败资料已保留。'],
  }));
  await expect(page.locator('#toolboxResult')).toContainText('AI 整理失败');
  await expect(page.locator('#toolboxResult')).toContainText('失败资料已保留');
  await page.locator('#toolboxDrawer').screenshot({ path: testInfo.outputPath('automatic-ai-failure-report.png') });
});

test('cleanup review defaults off, persists and reaches requests; reports never become processing targets', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const dispatch = window.dispatchEvent.bind(window);
    window.dispatchEvent = event => {
      if (event.type === 'mawlauncherready') {
        const saved = localStorage.getItem('test.cleanup.plan');
        if (saved) window.MAWLauncher.config.postprocessAutoPlan = JSON.parse(saved);
      }
      return dispatch(event);
    };
  });
  await page.goto(launcherUrl);
  await completeStaticLauncherDiscovery(page);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  await page.evaluate(() => window.MAWLauncher.openToolboxAiProcessing());
  await page.locator('#postprocessOperation').selectOption('ai_cleanup');
  await expect(page.locator('#postprocessCleanupReviewEnabled')).not.toBeChecked();
  await page.evaluate(() => {
    window.__cleanupRequests = [];
    window.__artifactCalls = [];
    Object.assign(window.MAWLauncher.config.postprocessProviders.find(p => p.id === 'deepseek'), { verified: true, hasApiKey: true, hasBaseUrl: true, hasModel: true });
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'save_postprocess_plan') {
        localStorage.setItem('test.cleanup.plan', JSON.stringify(payload.plan));
        return { ok: true, plan: payload.plan };
      }
      if (method === 'run_ai_cleanup') {
        window.__cleanupRequests.push(payload);
        return { ok: true, projectPath: 'D:\\Demo\\clean.mosp', srtPath: 'D:\\Demo\\clean.srt', comparisonPath: 'D:\\Demo\\comparison.html', diagnosticPath: 'D:\\Demo\\record.md' };
      }
      if (['open_file', 'open_path_parent'].includes(method)) {
        window.__artifactCalls.push({ method, payload });
        return { ok: true };
      }
      return original(method, payload);
    };
  });
  await page.locator('#postprocessProvider').selectOption('deepseek');
  await page.locator('#toolboxInputPath').fill('D:\\Demo\\source.mosp');
  await page.locator('#runLlmPostprocess').click();
  await expect.poll(() => page.evaluate(() => window.__cleanupRequests[0]?.reviewEnabled)).toBe(false);
  await expect(page.locator('#toolboxChainList > :first-child')).toHaveId('toolboxChainOriginal');
  await expect(page.locator('#toolboxChainOriginal')).toHaveText('原始输入MOSP 工程');
  await expect(page.locator('.toolbox-chain-item .toolbox-chain-label').first()).toHaveText('[口播整理]');
  await page.locator('#postprocessCleanupReviewEnabled').check();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test.cleanup.plan') || '{}').steps?.find(s => s.id === 'cleanup')?.reviewEnabled)).toBe(true);
  const spacing = await page.locator('label[for="postprocessCleanupReviewEnabled"]').evaluate(label => ({
    marginTop: parseFloat(getComputedStyle(label).marginTop),
    gap: label.getBoundingClientRect().top - label.previousElementSibling.getBoundingClientRect().bottom,
    hintGap: label.nextElementSibling.getBoundingClientRect().top - label.getBoundingClientRect().bottom,
  }));
  expect(spacing.marginTop).toBeGreaterThanOrEqual(8);
  expect(spacing.gap).toBeGreaterThanOrEqual(8);
  expect(spacing.hintGap).toBeGreaterThanOrEqual(8);
  console.log('cleanup review spacing', JSON.stringify(spacing));
  await page.locator('#toolboxDrawer').screenshot({ path: testInfo.outputPath('cleanup-review.png') });
  await page.locator('#runLlmPostprocess').click();
  await expect.poll(() => page.evaluate(() => window.__cleanupRequests.at(-1)?.reviewEnabled)).toBe(true);
  const input = await page.locator('#toolboxInputPath').inputValue();
  for (const kind of ['comparison', 'record']) {
    const artifact = page.locator(`[data-artifact-kind="${kind}"]`).last();
    await artifact.click();
    await expect(page.locator('#toolboxInputPath')).toHaveValue(input);
    await artifact.click({ button: 'right' });
    await expect(page.locator('#artifactSetTarget')).toBeHidden();
    await expect(page.locator('#artifactOpenFile')).toBeVisible();
    await expect(page.locator('#artifactOpenFolder')).toBeVisible();
    // A stale or programmatic select action must also leave the target alone.
    await page.evaluate(() => document.getElementById('artifactSetTarget').click());
    await expect(page.locator('#toolboxInputPath')).toHaveValue(input);
  }
  const comparison = page.locator('[data-artifact-kind="comparison"]').last();
  await comparison.click({ button: 'right' });
  await page.locator('#artifactContextMenu').screenshot({ path: testInfo.outputPath('comparison-menu.png') });
  await page.locator('#artifactOpenFolder').click();
  for (const kind of ['project', 'srt']) {
    await page.locator(`[data-artifact-kind="${kind}"]`).last().click({ button: 'right' });
    await expect(page.locator('#artifactSetTarget')).toBeVisible();
    await page.locator('#artifactSetTarget').click();
    await expect(page.locator('#toolboxInputPath')).toHaveValue(kind === 'project' ? 'D:\\Demo\\clean.mosp' : 'D:\\Demo\\clean.srt');
  }
  await page.reload();
  await completeStaticLauncherDiscovery(page);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  await page.evaluate(() => window.MAWLauncher.openToolboxAiProcessing());
  await page.locator('#postprocessOperation').selectOption('ai_cleanup');
  await expect(page.locator('#postprocessCleanupReviewEnabled')).toBeChecked();
  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(page.locator('label[for="postprocessCleanupReviewEnabled"]')).toHaveText('Run additional AI review');
  expect(errors).toEqual([]);
});

for (const extension of ['mosp', 'srt']) {
  test(`original ${extension} remains first and can be reused after multiple results`, async ({ page }, testInfo) => {
    await page.goto(launcherUrl);
    await completeStaticLauncherDiscovery(page);
    await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
    await page.locator('#toolboxFab').click();
    await page.locator('#toolboxReplaceTab').click();
    const source = `D:\\Demo\\original.${extension}`;
    await page.locator('#toolboxInputPath').fill(source);
    await page.locator('#postprocessReplacements').fill('old => new');
    await page.locator('#runFixedProcess').click();
    const original = page.locator('#toolboxChainOriginal');
    await expect(original.locator('button')).toHaveText(extension === 'srt' ? 'SRT 字幕' : 'MOSP 工程');
    await expect(original.locator('button')).toHaveAttribute('data-artifact-path', source);
    await expect(page.locator('#toolboxChainList > :first-child')).toHaveId('toolboxChainOriginal');
    await expect(page.locator('.toolbox-chain-heading')).toHaveText('处理结果（点击可切换输入，或查看报告）');
    const fonts = await page.locator('.toolbox-chain-source').evaluate(element => ({
      actual: getComputedStyle(element).fontFamily,
      expected: getComputedStyle(document.body).fontFamily,
    }));
    expect(fonts.actual).toBe(fonts.expected);
    const gap = await original.evaluate(element => element.nextElementSibling.getBoundingClientRect().top - element.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(8);
    await page.locator('#toolboxDrawer').screenshot({ path: testInfo.outputPath(`original-${extension}.png`) });
    await original.locator('button').click();
    await expect(page.locator('#toolboxInputPath')).toHaveValue(source);
    await expect(original.locator('button')).toHaveClass(/selected/);
    await page.locator('#runFixedProcess').click();
    await expect(page.locator('.toolbox-chain-item')).toHaveCount(2);
    await expect(page.locator('#toolboxChainOriginal')).toHaveCount(1);
    await original.locator('button').click();
    await expect(page.locator('#toolboxInputPath')).toHaveValue(source);
  });
}
