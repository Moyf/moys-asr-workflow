import { test, expect } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const launcherUrl = pathToFileURL(path.resolve('web/launcher/index.html')).href;
async function open(page) {
  await page.goto(launcherUrl);
  await page.waitForFunction(() => document.body.dataset.workflowReady === 'true' && window.MAWLauncher?.rememberRecentProject);
}
async function toolbox(page, id) {
  await page.locator('#navToolbox').click();
  await page.locator(`#${id}`).click();
}

test('configuration drawer moves the same form, traps focus and restores it on Escape', async ({ page }) => {
  await open(page);
  await page.locator('#autoPostprocessEnabled').check();
  await page.locator('#configureAutoReplace').click();
  await expect(page.locator('#postprocessSheet')).toBeVisible();
  await expect(page.locator('#postprocessSheet #postprocessReplacements')).toHaveCount(1);
  await page.locator('#postprocessReplacements').fill('old => new');
  await expect(page.locator('#postprocessSheetEnabled')).toBeChecked();
  await page.locator('#postprocessSheetDone').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#postprocessSheetClose')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#postprocessSheet')).toBeHidden();
  await expect(page.locator('#configureAutoReplace')).toBeFocused();
  await toolbox(page, 'toolboxReplaceTab');
  await expect(page.locator('#postprocessReplacements')).toHaveValue('old => new');
  expect(await page.evaluate(() => [...document.querySelectorAll('[id]')].map(n => n.id).filter((id, i, a) => a.indexOf(id) !== i))).toEqual([]);
});

test('hiding an automatic step disables execution and survives reload', async ({ page }) => {
  await open(page);
  await toolbox(page, 'toolboxReplaceTab');
  await page.locator('#postprocessReplacements').fill('old => new');
  await page.locator('#navTranscribe').click();
  await page.locator('#autoPostprocessEnabled').check();
  await page.locator('#autoStepReplace').check();
  await toolbox(page, 'toolboxReplaceTab');
  await page.locator('#toolboxAutoAvailable').uncheck();
  const plan = await page.evaluate(() => window.MAWLauncher.getAutoPostprocessPayload());
  expect(plan.steps.find(step => step.id === 'replace').enabled).toBe(false);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.workflowReady === 'true');
  await page.locator('#autoPostprocessEnabled').check();
  await expect(page.locator('[data-auto-step-row="replace"]')).toBeHidden();
});

test('AI tools have independent navigation and prompts without a task dropdown', async ({ page }) => {
  await open(page);
  await toolbox(page, 'toolboxProofreadTab');
  await expect(page.locator('#postprocessOperation')).toBeHidden();
  await expect(page.locator('#toolboxProofreadTab')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#postprocessPrompt').fill('proofread notes');
  await page.locator('#toolboxResegmentTab').click();
  await expect(page.locator('#postprocessResegmentOptions')).toBeVisible();
  await page.locator('#postprocessPrompt').fill('split notes');
  await page.locator('#toolboxProofreadTab').click();
  await expect(page.locator('#postprocessPrompt')).toHaveValue('proofread notes');
  await expect(page.locator('#postprocessResegmentOptions')).toBeHidden();
  await page.locator('#toolboxCustomTab').click();
  await expect(page.locator('#toolboxAutoAvailable')).toBeHidden();
});

test('translation settings use one synchronized plan and preserve bilingual order', async ({ page }) => {
  await open(page);
  await toolbox(page, 'toolboxLlmTab');
  await page.locator('#toolboxTranslateTarget').selectOption('en');
  await page.locator('#postprocessMergeBilingual').check();
  await page.locator('#postprocessBilingualOrder').selectOption('translation_first');
  const step = await page.evaluate(() => window.MAWLauncher.getAutoPostprocessPayload().steps.find(s => s.id === 'translate'));
  expect(step.target).toBe('en'); expect(step.mergeBilingual).toBe(true); expect(step.bilingualLineOrder).toBe('translation_first');
  await page.locator('#postprocessBackfill').check();
  await expect(page.locator('#postprocessMergeBilingual')).not.toBeChecked();
  const updated = await page.evaluate(() => window.MAWLauncher.getAutoPostprocessPayload().steps.find(s => s.id === 'translate'));
  expect(updated.embedTranslations).toBe(true); expect(updated.mergeBilingual).toBe(false);
});

test('tool-specific shared inputs and output modes match the prototype', async ({ page }) => {
  await open(page);
  await toolbox(page, 'toolboxBurnSubtitleTab');
  await expect(page.locator('#toolboxUtilityMediaDropZone')).toBeVisible();
  await expect(page.locator('#toolboxInputDropZone')).toBeHidden();
  await expect(page.locator('#toolboxOutputField')).toBeHidden();
  await page.locator('#toolboxAlignmentTab').click();
  await expect(page.locator('#toolboxUtilityMediaDropZone')).toBeHidden();
  await expect(page.locator('#toolboxAlignmentProjectDropZone')).toBeVisible();
  await page.locator('#toolboxTimestampsTab').click();
  await expect(page.locator('#toolboxTimestampsPanel #toolboxInputDropZone')).toBeVisible();
  await expect(page.locator('#toolboxPostprocessView #toolboxInputDropZone')).toHaveCount(0);
  await page.locator('#toolboxReplaceTab').click();
  await expect(page.locator('#toolboxInputDropZone')).toBeVisible();
  await expect(page.locator('#toolboxOutputField')).toBeVisible();
});

test('batch has a separate page, multi-file drop routes there and completed rows settle', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({ type: 'dropMediaBatch', paths: ['D:\\Demo\\one.mp4', 'D:\\Demo\\two.wav'] }));
  await expect(page.locator('#pageBatch')).toBeVisible();
  await expect(page.locator('#workflowReadiness')).toContainText('2');
  await expect(page.locator('#recognitionCard')).toBeHidden();
  await expect(page.locator('.batch-row')).toHaveCount(2);
  await page.locator('#batchEditSettings').click();
  await expect(page.locator('#pageTranscribe')).toBeVisible();
  await expect(page.locator('#recognitionSettingsBody')).toBeVisible();
  await page.locator('#apiKey').fill('test-key');
  await page.locator('#navBatch').click();
  await page.locator('#startBatch').click();
  await expect(page.locator('#navBatchCount')).toBeVisible();
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({ type: 'batchDone', status: 'failed', outcomes: [] }));
  await expect(page.locator('.batch-row.queued, .batch-row.running')).toHaveCount(0);
  await expect(page.locator('#navBatchCount')).toBeHidden();
});

test('batch project output is recorded and opens through the editor bridge', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.MAWLauncher.addBatchPaths(['D:\\Demo\\one.wav']);
    window.MAWLauncher.onBackendEvent({ type: 'batchStarted', total: 1 });
    window.MAWLauncher.onBackendEvent({ type: 'batchItem', id: 'batch-1', status: 'done', result: { jsonPath: 'D:\\Demo\\batch-one.mosp' } });
    window.MAWLauncher.onBackendEvent({ type: 'batchDone', outcomes: [{ id: 'batch-1', status: 'done', jsonPath: 'D:\\Demo\\batch-one.mosp' }] });
    window.__editorOpened = 0;
    window.MAWLauncher.openServerEditor = async () => { window.__editorOpened += 1; };
  });
  await page.locator('.batch-row-actions button').first().click();
  expect(await page.evaluate(() => window.__editorOpened)).toBe(1);
  await expect(page.locator('#jsonPath')).toHaveValue('D:\\Demo\\batch-one.mosp');
  await page.locator('#navProjects').click();
  await expect(page.locator('.recent-project-row')).toContainText('batch-one.mosp');
});

test('summary chips show bare names; parenthetical notes move to tooltips', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({ type: 'dropMedia', path: 'D:\\Demo\\one.wav' }));
  const providerChip = page.locator('#recognitionSummary .summary-chip').first();
  await expect(providerChip).toHaveText('阿里云百炼');
  // 共享 tooltip 会把 title 转存为 data-title。
  expect(await providerChip.getAttribute('data-title')).toBe('阿里云百炼（千问）');
  await page.locator('#recognitionExpand').click();
  await page.locator('#provider').selectOption('openai');
  await page.locator('#model').selectOption('gpt-4o-transcribe-diarize');
  const modelChip = page.locator('#recognitionSummary .summary-chip').nth(1);
  await expect(modelChip).toHaveText('gpt-4o-transcribe-diarize');
  expect(await modelChip.getAttribute('data-title')).toBe('gpt-4o-transcribe-diarize（说话人分离）');
  const payload = await page.evaluate(() => window.MAWLauncher.getTranscriptionPayload());
  expect(payload.modelId).toBe('gpt-4o-transcribe-diarize');
});

test('unconfigured AI step switch goes to settings instead of flashing the prompt field', async ({ page }) => {
  await open(page);
  await page.locator('#autoPostprocessEnabled').check();
  // 未配置供应商时开关不允许保持勾选：点击后弹回并打开设置页定位密钥。
  await page.locator('#autoStepTranslate').click();
  await expect(page.locator('#postprocessSheet')).toBeHidden();
  await expect(page.locator('#pageSettings')).toBeVisible();
  await expect(page.locator('#llmApiKey')).toBeFocused();
  await expect(page.locator('#autoStepTranslate')).not.toBeChecked();
});

test('the automatic post-processing card mirrors the prototype layout', async ({ page }, testInfo) => {
  await open(page);
  await expect(page.locator('.auto-card-head #autoPostprocessSummary')).toContainText('自动处理未启用');
  await page.locator('#autoPostprocessEnabled').check();
  await expect(page.locator('.auto-card-head #autoPostprocessSummary')).toContainText('勾选需要的工序');
  // 固定替换默认显示但未配置；先写入共享表单让它就绪，再勾选。
  await page.evaluate(() => {
    const el = document.getElementById('postprocessReplacements');
    el.value = 'old => new';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#autoStepReplace').check();
  await expect(page.locator('.auto-card-head #autoPostprocessSummary')).toContainText('按顺序执行 · 已启用 1 项');
  await expect(page.locator('[data-auto-step-row="translate"] > button')).toContainText('去配置');
  const rows = page.locator('#autoPostprocessSteps .auto-step-row:visible');
  const layout = await rows.first().evaluate(row => {
    const rect = node => node.getBoundingClientRect();
    return {
      columns: getComputedStyle(row).gridTemplateColumns.split(' ').length,
      num: rect(row.querySelector('.auto-step-num')).width,
      configureBeforeSwitch: rect(row.querySelector('button')).right <= rect(row.querySelector('input[type="checkbox"]')).left,
    };
  });
  expect(layout.columns).toBe(4);
  expect(layout.num).toBeCloseTo(22, 0);
  expect(layout.configureBeforeSwitch).toBe(true);
  // LLM 徽章挂在 AI 步骤上；校对同时带「慎用」。
  expect(await page.locator('[data-auto-step-row="translate"] .auto-step-badge').allTextContents()).toEqual(['LLM']);
  expect(await page.locator('[data-auto-step-row="proofread"] .auto-step-badge').allTextContents()).toEqual(['LLM', '慎用']);
  await page.locator('#autoPostprocessCard').screenshot({ path: testInfo.outputPath('auto-card.png'), animations: 'disabled' });
  // 抽屉带滑入动效：打开后 transform 复位，关闭后回到屏外。
  // （未配置的翻译入口此刻会去设置页，属于上一条用例的契约。）
  await page.locator('#configureAutoReplace').click();
  await expect(page.locator('#postprocessSheet')).toBeVisible();
  await expect(page.locator('#postprocessSheet')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#postprocessSheet')).toBeHidden();
  await expect(page.locator('#postprocessSheet')).not.toHaveClass(/open/);
});

test('transcription states show truthful results and invalidate them for new media', async ({ page }) => {
  await open(page);
  await expect(page.locator('#start')).toBeDisabled();
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({ type: 'dropMedia', path: 'D:\\Demo\\one.wav' }));
  await expect(page.locator('#selectedMediaName')).toHaveText('one.wav');
  await page.locator('#recognitionExpand').click();
  await page.locator('#apiKey').fill('test-key');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#start').click();
  await expect(page.locator('#transcriptionArtwork')).toHaveAttribute('data-state', 'running');
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({ type: 'done', result: { jsonPath: 'D:\\Demo\\one.mosp', srtPath: 'D:\\Demo\\one.srt' } }));
  await expect(page.locator('#transcriptionResult')).toBeVisible();
  await expect(page.locator('#reviewTranscription')).toBeVisible();
  await expect(page.locator('#transcriptionResultFiles')).toContainText('one.mosp');
  await expect(page.locator('#transcriptionResultMeta')).not.toContainText('条字幕');
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({ type: 'dropMedia', path: 'D:\\Demo\\two.wav' }));
  await expect(page.locator('#transcriptionResult')).toBeHidden();
});

test('recent projects can search, fill Toolbox, disable recording and clear without deleting files', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.MAWLauncher.rememberRecentProject('D:\\Demo\\subtitle.mosp'));
  await page.locator('#navProjects').click();
  await expect(page.locator('.recent-project-row')).toHaveCount(1);
  await page.locator('#recentProjectSearch').fill('unmatched');
  await expect(page.locator('.recent-project-row')).toHaveCount(0);
  await page.locator('#recentProjectSearch').fill('subtitle');
  await page.getByRole('button', { name: '用作工具箱输入', exact: true }).click();
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\subtitle.mosp');
  await page.locator('#settingsButton').click();
  await page.locator('#recordRecentProjects').uncheck();
  await expect(page.locator('#recordRecentProjects')).toBeEnabled();
  await page.evaluate(() => window.MAWLauncher.rememberRecentProject('D:\\Demo\\ignored.mosp'));
  await page.locator('#clearRecentProjects').click();
  await page.locator('#batchConfirmYes').click();
  await page.locator('#navProjects').click();
  await expect(page.locator('.recent-project-row')).toHaveCount(0);
});

test('new layouts have measurable spacing, no overflow, and readable themes', async ({ page }) => {
  await open(page);
  for (const width of [1000, 700, 414, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const nav of ['navTranscribe', 'navBatch', 'navToolbox', 'navProjects', 'settingsButton']) {
      await page.locator(`#${nav}`).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1000, height: 900 });
  await toolbox(page, 'toolboxReplaceTab');
  const spacing = await page.locator('.toolbox-pin-footer').evaluate(node => ({ margin: parseFloat(getComputedStyle(node).marginTop), padding: parseFloat(getComputedStyle(node).paddingTop) }));
  expect(spacing.margin).toBeGreaterThanOrEqual(8);
  expect(spacing.padding).toBeGreaterThanOrEqual(8);
  await page.locator('#themeToggle').click();
  await expect(page.locator('#toolboxReplacePanel')).toBeVisible();
});
