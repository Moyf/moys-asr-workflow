import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

async function openLauncher(page, language) {
  await page.goto('file://' + launcherPath);
  await page.waitForFunction(() => window.MAWLauncher?.config?.providers?.length > 0);
  if (language === 'en') {
    await page.evaluate(() => window.MAWLauncher.openSettings());
    await page.locator('#langEn').click();
    await page.locator('#settingsClose').click();
  }
}

for (const language of ['zh', 'en']) {
  test('ASR API failures show guidance, keep diagnostics and redact reports (' + language + ')', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: language === 'zh' ? 900 : 760, height: 880 });
    await openLauncher(page, language);
    await page.evaluate(() => {
      window.__reports = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async text => window.__reports.push(text) },
      });
    });
    const cases = [
      ['asr_auth_failed', language === 'zh' ? '语音转写认证失败' : 'authentication failed'],
      ['asr_permission_denied', language === 'zh' ? '拒绝访问' : 'denied access'],
      ['asr_rate_limited', language === 'zh' ? '限流或额度限制' : 'rate or quota limit'],
      ['asr_service_unavailable', language === 'zh' ? '暂时不可用' : 'temporarily unavailable'],
      ['asr_endpoint_invalid', 'HTTP 404'],
      ['asr_request_invalid', language === 'zh' ? '请求参数' : 'request parameters'],
      ['asr_timeout', language === 'zh' ? '超时' : 'timed out'],
      ['asr_network_error', language === 'zh' ? '无法连接' : 'Could not connect'],
    ];
    for (const [code, expected] of cases) {
      await page.evaluate(code => window.MAWLauncher.onBackendEvent({
        type: 'error', code,
        detail: 'RuntimeError: HTTP 401 | code=InvalidApiKey | request_id=test-request | api_key=sk-test-only-private-9999',
      }), code);
      await expect(page.locator('#errorNoticeMessage')).toContainText(expected);
      await expect(page.locator('#log')).toContainText('request_id=test-request');
      await expect(page.locator('#log')).not.toContainText('sk-test-only-private-9999');
      if (code === 'asr_auth_failed') {
        await expect(page.locator('#errorNoticeAction')).toHaveText(language === 'zh' ? '检查 API Key' : 'Check API key');
        await page.locator('#errorNotice').screenshot({ path: testInfo.outputPath('api-auth-' + language + '.png') });
        await page.locator('#errorNoticeCopy').click();
        const report = await page.evaluate(() => window.__reports[0]);
        expect(report).toContain('InvalidApiKey');
        expect(report).toContain('test-request');
        expect(report).not.toContain('sk-test-only-private-9999');
        await page.locator('#errorNoticeAction').click();
        await expect(page.locator('#apiKey')).toBeFocused();
      } else {
        await expect(page.locator('#errorNoticeAction')).toBeHidden();
      }
    }
  });

  test('empty and pasted keys block single and batch start locally (' + language + ')', async ({ page }) => {
    await openLauncher(page, language);
    const networkRequests = [];
    page.on('request', request => { if (/^https?:/u.test(request.url())) networkRequests.push(request.url()); });
    await page.locator('#mediaPath').fill('C:/media/clip.mp3');
    await page.locator('#srtPath').fill('C:/media/clip.srt');
    for (const [key, expected] of [
      ['', language === 'zh' ? '请填写 API Key' : 'Enter an API Key'],
      ['Bearer sk-test-only-private-1234', language === 'zh' ? 'API Key 格式不正确' : 'Invalid API key format'],
      ['https://example.test/keys', language === 'zh' ? 'API Key 格式不正确' : 'Invalid API key format'],
    ]) {
      await page.locator('#apiKey').fill(key);
      await page.locator('#start').click();
      await expect(page.locator('#apiKeyError')).toContainText(expected);
      await expect(page.locator('#stop')).toBeHidden();
      await expect(page.locator('#apiKeyError')).not.toContainText('sk-test-only-private-1234');
    }
    await page.locator('#batchMode').click();
    await page.evaluate(() => {
      window.__batchStarts = 0;
      const call = window.MAWLauncher.callBackend;
      window.MAWLauncher.callBackend = async (method, payload) => {
        if (method === 'start_batch_transcription') window.__batchStarts += 1;
        return call(method, payload);
      };
      window.MAWLauncher.onBatchDrop('C:/media/batch.mp3');
    });
    for (const key of ['', 'Bearer sk-test-only-private-1234']) {
      await page.locator('#apiKey').fill(key);
      await page.locator('#startBatch').click();
      await expect(page.locator('#apiKeyError')).toContainText(language === 'zh' ? 'API Key' : 'API key');
    }
    expect(await page.evaluate(() => window.__batchStarts)).toBe(0);
    expect(networkRequests).toEqual([]);
  });
}
