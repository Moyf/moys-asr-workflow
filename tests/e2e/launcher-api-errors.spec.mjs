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
  test('known missing tracks block start, failed and pending probes stay unknown (' + language + ')', async ({ page }, testInfo) => {
    await openLauncher(page, language);
    const config = await page.evaluate(() => window.MAWLauncher.config);
    await page.addInitScript(({ config, language }) => {
      window.__probeMode = 'empty';
      window.__probes = [];
      window.__probeDone = 0;
      window.__starts = [];
      window.pywebview = { api: new Proxy({}, { get(_, method) {
        if (method === 'then') return undefined;
        if (method === 'get_config') return async () => ({ ...config, guiLang: language });
        if (method === 'get_audio_tracks') return async (payload) => {
          window.__probes.push(payload.mediaPath);
          if (window.__probeMode === 'pending') return new Promise(resolve => { window.__releaseProbe = resolve; });
          window.__probeDone += 1;
          if (window.__probeMode === 'failed') return { ok: false, tracks: [], code: 'audio_tracks_unavailable' };
          if (window.__probeMode === 'invalid') return { ok: true, tracks: null };
          return { ok: true, tracks: [] };
        };
        if (method === 'start_transcription') return async (payload) => {
          window.__starts.push(payload);
          return { ok: false, code: 'transcription_cancelled' };
        };
        return async () => ({ ok: true });
      } }) };
    }, { config, language });
    await page.reload();
    await page.waitForFunction(() => window.MAWLauncher?.config?.providers?.length > 0);
    await page.locator('#apiKey').fill('sk-test');
    await page.locator('#mediaPath').fill('C:/media/no-audio.mp4');
    await expect.poll(() => page.evaluate(() => window.MAWLauncher.getTranscriptionPayload().audioTrackCount)).toBe(0);
    await page.locator('#start').click();
    await expect(page.locator('#errorNoticeMessage')).toContainText(language === 'zh' ? '没有检测到音轨' : 'No audio tracks');
    await expect(page.locator('#stop')).toBeHidden();
    expect(await page.evaluate(() => window.__starts.length)).toBe(0);
    expect(await page.evaluate(() => window.__probes.length)).toBe(1);
    expect(await page.evaluate(() => document.querySelector('#errorNoticeAction').parentElement.getBoundingClientRect().top
      - document.querySelector('#errorNoticeMessage').getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(8);
    await page.locator('#errorNotice').screenshot({ path: testInfo.outputPath('no-audio-' + language + '.png') });
    for (const [index, mode] of ['failed', 'invalid'].entries()) {
      await page.evaluate(mode => { window.__probeMode = mode; }, mode);
      await page.locator('#mediaPath').fill('C:/media/' + mode + '.mp4');
      await page.waitForFunction(count => window.__probeDone === count, index + 2);
      expect(await page.evaluate(() => window.MAWLauncher.getTranscriptionPayload().audioTrackCount)).toBeNull();
      await page.locator('#start').click();
      expect(await page.evaluate(() => window.__starts.length)).toBe(index + 1);
      await expect(page.locator('#errorNoticeMessage')).not.toContainText(language === 'zh' ? '没有检测到音轨' : 'No audio tracks');
      expect(await page.evaluate(() => window.__probes.length)).toBe(index + 2);
    }
    await page.evaluate(() => { window.__probeMode = 'pending'; });
    await page.locator('#mediaPath').fill('C:/media/pending.mp4');
    await page.waitForFunction(() => typeof window.__releaseProbe === 'function');
    expect(await page.evaluate(() => window.MAWLauncher.getTranscriptionPayload().audioTrackCount)).toBeNull();
    await page.locator('#start').click();
    expect(await page.evaluate(() => window.__starts.length)).toBe(3);
    // An old probe finishing after a file change cannot block the new file.
    await page.locator('#mediaPath').fill('C:/media/voice.mp3');
    await page.evaluate(() => window.__releaseProbe({ ok: true, tracks: [] }));
    expect(await page.evaluate(() => window.MAWLauncher.getTranscriptionPayload().audioTrackCount)).toBeNull();
    expect(await page.evaluate(() => window.__probes.length)).toBe(4);
  });

  test('empty recognition uses existing track metadata (' + language + ')', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: language === 'zh' ? 900 : 760, height: 880 });
    await openLauncher(page, language);
    await page.evaluate(() => window.MAWLauncher.onBackendEvent({
      type: 'error', code: 'asr_empty_result', detail: 'original empty ASR response',
    }));
    await expect(page.locator('#errorNoticeMessage')).toContainText(language === 'zh' ? '未能转写出任何有效文本' : 'No usable transcription text');
    await expect(page.locator('#errorNoticeMessage')).not.toContainText(language === 'zh' ? '多条音轨' : 'multiple audio tracks');
    await expect(page.locator('#errorNoticeAction')).toBeHidden();
    await page.evaluate(() => window.MAWLauncher.onBackendEvent({
      type: 'error', code: 'asr_empty_result_multitrack', detail: 'known_count=2, selected audio_index=0',
    }));
    await expect(page.locator('#errorNoticeMessage')).toContainText(language === 'zh' ? '请检查选中的音轨是否有效' : 'check whether the selected track is usable');
    await expect(page.locator('#log')).toContainText('known_count=2');
    await expect(page.locator('#errorNoticeAction')).toHaveText(language === 'zh' ? '检查音轨' : 'Check audio track');
    const gap = await page.evaluate(() => {
      const message = document.querySelector('#errorNoticeMessage').getBoundingClientRect();
      const actions = document.querySelector('#errorNoticeAction').parentElement.getBoundingClientRect();
      return actions.top - message.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(8);
    await page.locator('#errorNotice').screenshot({ path: testInfo.outputPath('empty-multitrack-' + language + '.png') });
    await page.locator('#errorNoticeAction').click();
    await expect(page.locator('#mediaPath')).toBeFocused();
    // The existing file-selection probe supplies three tracks in the demo bridge.
    await page.locator('#mediaPath').fill('C:/media/recording.mkv');
    await expect(page.locator('#audioTrack')).toBeEnabled();
    expect(await page.evaluate(() => window.MAWLauncher.getTranscriptionPayload().audioTrackCount)).toBe(3);
    await page.locator('#errorNoticeAction').click();
    await expect(page.locator('#audioTrack')).toBeFocused();
    await expect(page.locator('#audioTrack')).toHaveValue('0');
    // Changing files clears metadata immediately; do not reuse the previous count.
    await page.locator('#mediaPath').fill('C:/media/voice.mp3');
    expect(await page.evaluate(() => window.MAWLauncher.getTranscriptionPayload().audioTrackCount)).toBeNull();
  });

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
