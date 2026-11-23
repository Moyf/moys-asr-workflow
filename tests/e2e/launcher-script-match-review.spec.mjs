import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';

test('script match completion points to the comparison tools and keeps diagnostics in the log', async ({ page }, testInfo) => {
  await page.goto(new URL('../../web/launcher/index.html', import.meta.url).href);
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

test('compare tools open from the artifact chain with the source preloaded', async ({ page }) => {
  await page.goto(new URL('../../web/launcher/index.html', import.meta.url).href);
  await completeStaticLauncherDiscovery(page);
  await page.locator('#toolboxFab').click();
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.compareCalls = [];
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'open_compare_tool') {
        window.compareCalls.push(payload);
        return { ok: true };
      }
      return original(method, payload);
    };
    const list = document.getElementById('toolboxChainList');
    const item = document.createElement('div');
    item.className = 'toolbox-chain-item';
    const files = document.createElement('div');
    files.className = 'toolbox-chain-files';
    const artifact = document.createElement('button');
    artifact.dataset.artifactKind = 'project';
    artifact.dataset.artifactPath = 'D:\\Demo\\source.文稿匹配.mosp';
    files.append(artifact);
    item.append(files);
    list.append(item);
    document.getElementById('toolboxChain').classList.remove('hidden');
  });
  await page.locator('#toolboxInputPath').fill('D:\\Demo\\source.mosp');
  const spacing = await page.locator('.toolbox-compare-row').evaluate(row => row.getBoundingClientRect().top - document.getElementById('toolboxChainList').getBoundingClientRect().bottom);
  expect(spacing).toBeGreaterThanOrEqual(8);
  await page.getByRole('button', { name: '转写对比' }).click();
  await expect.poll(() => page.evaluate(() => window.compareCalls.length)).toBe(1);
  await page.getByRole('button', { name: '时间码对比' }).click();
  await expect.poll(() => page.evaluate(() => window.compareCalls.length)).toBe(2);
  const payloads = await page.evaluate(() => window.compareCalls);
  expect(payloads.map(payload => payload.tool)).toEqual(['transcript', 'timestamp']);
  for (const payload of payloads) {
    expect(payload.paths).toEqual(['D:\\Demo\\source.mosp', 'D:\\Demo\\source.文稿匹配.mosp']);
    expect(payload.lang).toBe('zh-CN');
  }
  await page.evaluate(() => {
    document.getElementById('toolboxChainList').replaceChildren();
    const input = document.getElementById('toolboxInputPath');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: '转写对比' }).click();
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.compareCalls.length)).toBe(2);
  await expect(page.locator('#toolboxInputPathError')).not.toHaveText('');
});
