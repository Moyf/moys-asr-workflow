import { test, expect } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';

const launcherUrl = pathToFileURL(path.resolve('web/launcher/index.html')).href;
async function open(page) {
  await page.goto(launcherUrl);
  await completeStaticLauncherDiscovery(page);
  await page.waitForFunction(() => document.body.dataset.workflowReady === 'true');
}

test('upstream standalone script alignment remains a visible keyboard-accessible tool', async ({ page }) => {
  await open(page);
  await page.locator('#navToolbox').click();
  const nav = page.locator('#toolboxToolNav');
  await expect(nav.locator('#toolboxScriptAlignmentTab')).toBeVisible();
  await nav.locator('#toolboxScriptAlignmentTab').click();
  await expect(page.locator('#toolboxScriptAlignmentPanel')).toBeVisible();
  await expect(page.locator('#toolboxTimestampScriptInputs')).toBeVisible();
  await expect(page.locator('#toolboxUtilityMediaDropZone')).toBeVisible();
  await expect(page.locator('#toolboxOutputField')).toBeHidden();
  await page.locator('#toolboxScriptAlignmentTab').press('ArrowDown');
  await expect(page.locator('#toolboxBurnSubtitleTab')).toBeFocused();
});

test('leaving settings by sidebar invalidates delayed automatic-step verification', async ({ page }) => {
  await open(page);
  await page.locator('#autoPostprocessEnabled').check();
  // Unconfigured steps intentionally revert the click before opening settings.
  await page.locator('#autoStepTranslate').click();
  await expect(page.locator('#pageSettings')).toBeVisible();
  await page.locator('#llmApiKey').fill('demo-key');
  await page.locator('#llmBaseUrl').fill('https://demo.example/v1');
  await page.locator('#llmModel').fill('demo-model');
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = (method, payload) => {
      if (method !== 'test_postprocess_connection') return original(method, payload);
      return new Promise(resolve => { window.finishLateVerification = () => resolve({
        ok: true, saved: true, verified: true, baseUrl: payload.baseUrl, model: payload.model,
        maskedApiKey: 'demo-***', apiKeyRequired: true,
      }); });
    };
  });
  await page.locator('#testLlmConnection').click();
  await page.waitForFunction(() => typeof window.finishLateVerification === 'function');
  await page.locator('#navTranscribe').click();
  await page.evaluate(() => window.finishLateVerification());
  await expect(page.locator('#testLlmConnection')).toBeEnabled();
  await expect(page.locator('#autoStepTranslate')).not.toBeChecked();
  expect(await page.evaluate(() => window.MAWLauncher.getAutoPostprocessPayload().steps.find(s => s.id === 'translate').enabled)).toBe(false);
});

test('all editor-open entries confirm before replacing the current project', async ({ page }) => {
  await open(page);
  const config = await page.evaluate(() => window.MAWLauncher.config);
  await page.addInitScript(initialConfig => {
    window.serverStarts = [];
    let runningProject = null;
    window.pywebview = { api: new Proxy({}, { get: (_, method) => method === 'then' ? undefined : async payload => {
      if (method === 'get_config') return initialConfig;
      if (method === 'start_server') {
        window.serverStarts.push(payload.jsonPath);
        runningProject = payload.jsonPath;
        return { ok: true, url: 'http://127.0.0.1:8250/' };
      }
      if (method === 'check_server_media') {
        if (window.holdMediaCheck) return new Promise(resolve => {
          window.finishMediaCheck = () => resolve({ ok: true, hasMedia: true, mediaExists: true });
        });
        return { ok: true, hasMedia: true, mediaExists: true };
      }
      if (method === 'get_server_status') return { ok: true, running: runningProject !== null, url: 'http://127.0.0.1:8250/' };
      if (method === 'get_recent_projects') return { ok: true, entries: [], enabled: true };
      return { ok: true };
    } }) };
  }, config);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.workflowReady === 'true');
  await page.evaluate(async () => {
    window.MAWLauncher.setJsonPath('D:\\Demo\\current.mosp');
    await window.MAWLauncher.openServerEditor();
  });
  await page.locator('#navProjects').click();
  await page.locator('#jsonPath').fill('D:\\Demo\\next.mosp');
  await page.locator('#projectOpenEditor').click();
  await expect(page.locator('#batchConfirmModal')).toBeVisible();
  expect(await page.evaluate(() => window.serverStarts)).toEqual(['D:\\Demo\\current.mosp']);
  await page.locator('#batchConfirmNo').click();
  await page.locator('#projectOpenSelected').click();
  await expect(page.locator('#batchConfirmModal')).toBeVisible();
  await page.locator('#batchConfirmNo').click();
  // The completed-transcription entry must use the same guard, not bypass it.
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({ type: 'done', result: { jsonPath: 'D:\\Demo\\result.mosp' } }));
  await page.locator('#navTranscribe').click();
  await page.locator('#reviewTranscription').click();
  await expect(page.locator('#batchConfirmModal')).toBeVisible();
  expect(await page.evaluate(() => window.serverStarts)).toHaveLength(1);
  await page.locator('#batchConfirmYes').click();
  await expect.poll(() => page.evaluate(() => window.serverStarts)).toEqual(['D:\\Demo\\current.mosp', 'D:\\Demo\\result.mosp']);
  // A changed target during an awaited probe must not bypass that confirmation.
  await page.locator('#navProjects').click();
  await page.locator('#jsonPath').fill('D:\\Demo\\approved.mosp');
  await page.evaluate(() => { window.holdMediaCheck = true; });
  await page.locator('#projectOpenSelected').click();
  await page.locator('#batchConfirmYes').click();
  await page.waitForFunction(() => typeof window.finishMediaCheck === 'function');
  await page.locator('#jsonPath').fill('D:\\Demo\\unapproved.mosp');
  await page.evaluate(() => { window.holdMediaCheck = false; window.finishMediaCheck(); });
  await expect(page.locator('#projectOpenEditor')).toBeEnabled();
  expect(await page.evaluate(() => window.serverStarts)).toHaveLength(2);
  await expect(page.locator('#projectServerState')).toContainText('result.mosp');
});

test('projects portable entry obeys the standalone retirement flag', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.MAWLauncher.config.standaloneEditorSupported = false;
    // Re-render all version-dependent entry points through the production language path.
    document.getElementById('langEn').click();
  });
  await page.locator('#navProjects').click();
  await expect(page.locator('#projectOpenPortable')).toBeHidden();
  await expect(page.locator('#openBlankHtml')).toBeHidden();
});

test('immediately refused automatic-postprocess retry leaves running state', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const original = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => method === 'retry_postprocess'
      ? { ok: false, code: 'postprocess_failed', detail: 'demo retry refused' } : original(method, payload);
    window.MAWLauncher.onBackendEvent({ type: 'error', code: 'postprocess_failed', canRetry: true });
  });
  await page.locator('#retryPostprocess').click();
  await expect(page.locator('#errorNotice')).toBeVisible();
  await expect(page.locator('#transcriptionArtwork')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#workflowStages')).toBeHidden();
  await expect(page.locator('#stop')).toBeHidden();
});


test('redesigned media selection retains upstream thumbnail controls and audio disable state', async ({ page }) => {
  await open(page);
  const drop = mediaPath => page.evaluate(path => window.MAWLauncher.onBackendEvent({ type: 'dropMedia', path }), mediaPath);
  await drop('D:/Demo/video.mp4');
  await page.locator('#recognitionExpand').click();
  await page.locator('#advancedToggle').click();
  const checkbox = page.locator('#generateKeyframes');
  await expect(checkbox).toBeVisible();
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeEnabled();
  await expect(page.locator('#selectedMediaName')).toHaveText('video.mp4');
  await drop('D:/Demo/audio.mp3');
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).toBeChecked();
  await expect(page.locator('#generateKeyframesField .misc-option-label')).toHaveCSS('opacity', '0.55');
  await expect(page.locator('#selectedMediaName')).toHaveText('audio.mp3');
  await drop('D:/Demo/video.mp4');
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(page.locator('#generateThumbnailsField')).toBeHidden();
  await checkbox.check();
  await expect(page.locator('#generateThumbnailsField')).toBeVisible();
  const gap = await page.evaluate(() => document.querySelector('#generateKeyframesField .misc-option-copy').getBoundingClientRect().top - document.querySelector('#speakerColorsField .misc-option-copy').getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: '.artifacts/pr235-thumbnail-controls.png', fullPage: true });
});
