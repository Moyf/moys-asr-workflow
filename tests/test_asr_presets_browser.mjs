import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MAW_TEST_PLAYWRIGHT || 'playwright');

test('recognition presets restore all fields without changing the model', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    const url = pathToFileURL(path.resolve('web/launcher/index.html')).href;
    await page.goto(url);
    await page.waitForFunction(() => window.MAWLauncher?.config?.providers?.length);
    const config = await page.evaluate(() => window.MAWLauncher.config);
    await page.addInitScript(config => {
      window.presetMode = 'ok';
      window.pywebview = { api: new Proxy({}, { get: (_, name) => name === 'then' ? undefined : async payload => {
        if (name === 'get_config') return config;
        if (name === 'recognition_preset') {
          if (window.presetMode === 'cancel') return { ok: true, cancelled: true };
          if (window.presetMode === 'invalid') return { ok: false, detail: 'Invalid preset' };
          if (payload.action === 'save') window.savedPreset = structuredClone(payload.options);
          return { ok: true, options: structuredClone(window.savedPreset), path: 'Interview.json', missingHotwords: true };
        }
        if (name === 'poll_events') return [];
        return { ok: true };
      } }) };
    }, config);
    await page.reload();
    await page.waitForFunction(() => window.MAWLauncher?.config?.providers?.length);
    const originalModel = await page.locator('#model').inputValue();
    assert.ok((await page.locator('#modelNote .model-note-text').textContent()).length);
    assert.match(await page.locator('#modelNote .price-note').textContent(), /阿里云百炼参考价/);
    assert.match(await page.locator('#advancedCard').getAttribute('class'), /collapsed/);
    await page.locator('#saveAsrPreset').click();
    await page.waitForFunction(() => window.savedPreset);
    assert.match(await page.locator('#advancedCard').getAttribute('class'), /collapsed/);
    await page.evaluate(() => {
      window.savedPreset.qwenAudioContext = '技术背景\n第二行';
      window.savedPreset.qwenAudioHotwords = '术语: 50\n产品';
      window.savedPreset.qwenAudioHotwordsMode = 'file';
      window.savedPreset.qwenAudioHotwordsFile = 'missing.txt';
      window.savedPreset.qwenAudioHotwordWeight = '50';
      window.savedPreset.language = 'zh,en';
      window.savedPreset.debugRaw = true;
      window.savedPreset.testRun = true;
      window.savedPreset.qwenAudioKeepDialect = true;
      window.savedPreset.sonioxContextText = '跨供应商背景';
      window.expectedPreset = structuredClone(window.savedPreset);
    });
    await page.locator('#loadAsrPreset').click();
    await page.waitForFunction(() => document.querySelector('#qwenAudioContext').value === '技术背景\n第二行');
    assert.equal(await page.locator('#model').inputValue(), originalModel);
    assert.equal(await page.locator('#debugRaw').isChecked(), true);
    assert.equal(await page.locator('#testRun').isChecked(), true);
    assert.equal(await page.locator('#qwenAudioKeepDialect').isChecked(), true);
    assert.match(await page.locator('#asrPresetStatus').textContent(), /热词文件不存在/);
    await page.locator('#provider').selectOption('soniox');
    assert.deepEqual(await page.locator('#language').evaluate(el =>
      Array.from(el.selectedOptions, option => option.value).sort()), ['en', 'zh']);
    assert.match(await page.locator('#modelNote .price-note').textContent(), /Soniox 参考价/);
    await page.locator('#saveAsrPreset').click();
    await page.waitForFunction(() => document.querySelector('#asrPresetStatus').textContent.startsWith('预设已保存'));
    assert.deepEqual(await page.evaluate(() => window.savedPreset), await page.evaluate(() => window.expectedPreset));
    for (const mode of ['cancel', 'invalid']) {
      await page.evaluate(mode => { window.presetMode = mode; }, mode);
      await page.locator('#loadAsrPreset').click();
      await page.waitForFunction(() => !document.querySelector('#loadAsrPreset').disabled);
      assert.equal(await page.locator('#qwenAudioContext').inputValue(), '技术背景\n第二行');
    }
    await page.locator('#advancedToggle').click();
    if (process.env.MAW_PRESET_SCREENSHOT) await page.screenshot({ path: process.env.MAW_PRESET_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 520, height: 850 });
    assert.equal(await page.locator('#saveAsrPreset').isVisible(), true);
    assert.equal(await page.locator('#loadAsrPreset').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
