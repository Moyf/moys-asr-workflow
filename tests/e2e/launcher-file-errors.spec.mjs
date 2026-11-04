import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

for (const language of ['zh', 'en']) {
  test(`file failures show actionable guidance and preserve raw report (${language})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: language === 'zh' ? 900 : 760, height: 880 });
    await page.goto(`file://${launcherPath}`);
    await completeStaticLauncherDiscovery(page);
    await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
    if (language === 'en') {
      await page.evaluate(() => window.MAWLauncher.openSettings());
      await page.locator('#langEn').click();
      await page.locator('#settingsClose').click();
    }
    await page.evaluate(() => {
      window.__reports = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async text => window.__reports.push(text) },
      });
      window.MAWLauncher.onBackendEvent({
        type: 'error', code: 'intermediate_path_too_long', canRetry: false,
        detail: 'OSError: [WinError 206] original diagnostic',
        originalSrtPath: 'C:/media/clip.srt', originalProjectPath: 'C:/media/clip.mosp',
      });
    });
    const message = page.locator('#errorNoticeMessage');
    await expect(message).toContainText(language === 'zh' ? '中间文件创建失败' : 'Could not create an intermediate file');
    await expect(message).toContainText(language === 'zh' ? '缩短原文件名' : 'Shorten the source filename');
    await expect(page.locator('#retryPostprocess')).toBeHidden();
    await expect(page.locator('#srtPath')).toHaveValue('C:/media/clip.srt');
    await page.locator('#errorNoticeCopy').click();
    expect(await page.evaluate(() => window.__reports[0])).toContain('[WinError 206] original diagnostic');
    await page.locator('#errorNotice').screenshot({ path: testInfo.outputPath(`file-path-${language}.png`) });
    await page.evaluate(() => window.MAWLauncher.onBackendEvent({
      type: 'error', code: 'intermediate_file_failed', detail: '[Errno 28] No space left on device', canRetry: true,
    }));
    await expect(message).toContainText(language === 'zh' ? '剩余磁盘空间' : 'free disk space');
    await expect(message).not.toContainText(language === 'zh' ? '缩短原文件名' : 'Shorten the source filename');
    await expect(page.locator('#retryPostprocess')).toBeVisible();
    await page.evaluate(() => window.MAWLauncher.onBackendEvent({
      type: 'error', code: 'file_write_failed', detail: '[Errno 13] final destination denied', canRetry: false,
    }));
    await expect(message).toContainText(language === 'zh' ? '文件创建或写入失败' : 'Could not create or write a file');
    await expect(message).not.toContainText(language === 'zh' ? '中间文件' : 'intermediate file');
    await expect(page.locator('#retryPostprocess')).toBeHidden();
    await page.locator('#errorNotice').screenshot({ path: testInfo.outputPath(`file-write-${language}.png`) });
    // A synchronous/legacy catch-all must use the same actionable text.
    await page.evaluate(() => window.MAWLauncher.onBatchError({
      ok: false, code: 'postprocess_failed', detail: '[WinError 206] filename too long',
    }));
    await expect(message).toContainText(language === 'zh' ? '缩短原文件名' : 'Shorten the source filename');
    await expect(message).not.toContainText(language === 'zh' ? '从失败步骤重试' : 'retry from the failed step');
    // The transcription pipeline keeps its own copy: first line, then the reason.
    await page.evaluate(() => window.MAWLauncher.onBackendEvent({
      type: 'error', code: 'postprocess_failed', detail: '所有非空字幕已经是中文，没有需要翻译的内容，未写出输出产物。',
    }));
    await expect(message).toContainText(language === 'zh' ? '可从失败步骤重试。' : 'retry from the failed step.');
    await expect(message).toContainText(language === 'zh' ? '失败原因：所有非空字幕已经是中文' : 'Reason: 所有非空字幕已经是中文');
    // Manual toolbox runs must not mention transcription or the automatic chain.
    await page.evaluate(() => window.MAWLauncher.onBackendEvent({
      type: 'error', code: 'toolbox_failed', detail: '所有非空字幕已经是中文，没有需要翻译的内容，未写出输出产物。',
    }));
    await expect(message).toContainText(language === 'zh' ? '处理失败，原因：所有非空字幕已经是中文' : 'Processing failed. Reason: 所有非空字幕已经是中文');
    await expect(message).not.toContainText(language === 'zh' ? '转写已完成' : 'Transcription completed');
  });
}
