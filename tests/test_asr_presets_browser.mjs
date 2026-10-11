import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MAW_TEST_PLAYWRIGHT || 'playwright');

test('ASR preset library manages metadata and options independently with keyboard and narrow layouts', async () => {
  const browser = await chromium.launch({ executablePath: process.env.MAW_E2E_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    const url = pathToFileURL(path.resolve('web/launcher/index.html')).href;
    await page.goto(url);
    await page.waitForFunction(() => window.MAWLauncher?.config?.providers?.length);
    const rawConfig = await page.evaluate(() => window.MAWLauncher.config);
    const config = { ...rawConfig, asrPresetRoot: 'C:/Users/test/AppData/Local/MAW/asr-presets', asrPresetRootConfigured: true };
    await page.addInitScript(config => {
      window.presetStore = new Map();
      window.trash = [];
      window.presetCalls = [];
      window.openedPreset = '';
      window.pywebview = { api: new Proxy({}, { get: (_, name) => name === 'then' ? undefined : async payload => {
        window.presetCalls.push({ name, payload: structuredClone(payload || {}) });
        if (name === 'get_config') return config;
        if (name === 'asr_preset_library') return {
          ok: true,
          root: config.asrPresetRoot,
          items: [
            ...Array.from(window.presetStore.values(), item => ({ name: item.name, description: item.description, modified: item.modified, valid: true, detail: '' })),
            { name: 'damaged', description: '', modified: 0, valid: false, detail: 'Unsupported preset format' },
          ],
        };
        if (name === 'asr_preset_migration_preview') return { ok: true, root: payload.path || config.asrPresetRoot, source: 'C:/legacy', files: ['old.json'], invalid: [], conflicts: [] };
        if (name === 'set_asr_preset_root') { config.asrPresetRoot = payload.path || 'C:/Users/test/AppData/Local/MAW/asr-presets'; return { ok: true, root: config.asrPresetRoot, configured: true, migrated: payload.migrate ? ['old.json'] : [], sourceRemaining: [] }; }
        if (name === 'open_asr_preset_folder') return { ok: true };
        if (name === 'open_asr_preset_file') { window.openedPreset = payload.name; return { ok: true }; }
        if (name === 'choose_folder') return { ok: true, path: 'C:/custom-presets' };
        if (name === 'recognition_presets') {
          const { action, name: sourceName, newName } = payload;
          const source = window.presetStore.get(sourceName);
          if (action === 'create') {
            if (Array.from(window.presetStore.keys()).some(key => key.toLocaleLowerCase() === payload.name.toLocaleLowerCase())) return { ok: false, detail: 'Preset already exists' };
            window.presetStore.set(payload.name, { name: payload.name, description: payload.description || '', options: structuredClone(payload.options), modified: Date.now() / 1000 });
            return { ok: true, name: payload.name };
          }
          if (action === 'preview') return source ? { ok: true, options: structuredClone(source.options) } : { ok: false, detail: 'Preset not found' };
          if (action === 'load') {
            if (!source) return { ok: false, detail: 'Preset not found' };
            const reordered = {};
            for (const key of Object.keys(source.options).reverse()) reordered[key] = source.options[key];
            return { ok: true, name: source.name, description: source.description, options: reordered, missingHotwords: false };
          }
          if (action === 'save_info') {
            if (!source) return { ok: false, detail: 'Preset not found' };
            if (newName !== sourceName && Array.from(window.presetStore.keys()).some(key => key.toLocaleLowerCase() === newName.toLocaleLowerCase())) return { ok: false, detail: 'Preset already exists' };
            window.presetStore.delete(sourceName);
            source.name = newName; source.description = payload.description || ''; source.modified = Date.now() / 1000;
            window.presetStore.set(newName, source);
            return { ok: true, name: newName };
          }
          if (action === 'update') { source.options = structuredClone(payload.options); source.modified = Date.now() / 1000; return { ok: true, name: sourceName }; }
          if (action === 'copy') {
            if (!source) return { ok: false, detail: 'Preset not found' };
            const base = `${sourceName} ${payload.suffix}`;
            let copyName = base;
            let index = 2;
            while (window.presetStore.has(copyName)) copyName = `${base} (${index++})`;
            window.presetStore.set(copyName, { ...structuredClone(source), name: copyName, options: structuredClone(source.options), modified: Date.now() / 1000 });
            return { ok: true, name: copyName };
          }
          if (action === 'delete') { window.trash.push(sourceName); window.presetStore.delete(sourceName); return { ok: true, name: sourceName }; }
        }
        if (name === 'poll_events') return [];
        return { ok: true };
      } }) };
    }, config);
    await page.reload();
    await page.waitForFunction(() => window.MAWLauncher?.config?.providers?.length);
    const originalModel = await page.locator('#model').inputValue();
    assert.equal(await page.locator('#currentAsrPresetName').textContent(), '当前未选择预设');
    assert.equal(await page.locator('#currentAsrPresetPrefix').isVisible(), false);

    await page.locator('#advancedToggle').click();
    await page.locator('#qwenAudioContext').fill('保存时的上下文');
    assert.equal(await page.locator('#openaiPrompt').inputValue(), '保存时的上下文', 'prompt/context inputs share one value');
    assert.equal(await page.locator('#sonioxContextText').inputValue(), '保存时的上下文', 'soniox text context shares the same value');
    await page.locator('#manageAsrPresets').click();
    await page.waitForFunction(() => !document.querySelector('#asrPresetModal').classList.contains('hidden'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'asrPresetSearch');
    await page.locator('#asrPresetName').fill('访谈');
    await page.locator('#asrPresetDescription').fill('安静环境的中文访谈');
    await page.locator('#saveAsrPreset').click();
    await page.waitForFunction(() => window.presetStore.has('访谈'));
    await page.waitForFunction(() => document.activeElement?.id === 'asrPresetName', undefined, { timeout: 5_000 });
    const createdOptions = await page.evaluate(() => window.presetStore.get('访谈').options);
    assert.equal(createdOptions.promptContext, '保存时的上下文');
    assert.equal('qwenAudioContext' in createdOptions, false);
    assert.equal('openaiPrompt' in createdOptions, false);
    assert.equal('sonioxContextText' in createdOptions, false);
    await page.waitForFunction(() => !document.querySelector('#asrPresetOptionsPreview').classList.contains('hidden'));
    assert.match(await page.locator('#asrPresetPreviewList').textContent(), /提示词保存时的上下文/u);
    assert.match(await page.locator('#asrPresetModifiedDate').textContent(), /修改时间/u);
    assert.ok(await page.locator('#loadAsrPreset').evaluate(el => Boolean(el.closest('.asr-preset-modal-actions'))), 'action buttons live under the modal grid');
    assert.equal(await page.locator('#asrPresetOptionsPreview').evaluate(el => getComputedStyle(el).maxHeight), 'none', 'the preview grows with the freed space');
    assert.equal(await page.locator('#deleteAsrPreset').getAttribute('title'), '将选中预设移入系统回收站', 'action buttons explain themselves on hover');
    assert.equal(await page.locator('.asr-preset-list-header .hint').textContent(), '双击可直接加载预设');
    const hintGap = await page.locator('.asr-preset-list-header').evaluate(header => {
      const title = header.querySelector('h3').getBoundingClientRect();
      const hint = header.querySelector('.hint').getBoundingClientRect();
      return { gap: hint.left - title.right, sameRow: Math.abs(title.top - hint.top) < 4 };
    });
    assert.ok(hintGap.sameRow && hintGap.gap >= 8 && hintGap.gap <= 40, `the dblclick hint sits beside the list title, got gap ${hintGap.gap}px`);
    assert.equal(await page.locator('#saveAsrPreset').textContent(), '将当前配置存为新预设');
    assert.equal(await page.locator('#updateAsrPreset').textContent(), '更新该预设', 'the active preset shows the update label');
    assert.notEqual(await page.locator('.asr-preset-modal-actions').evaluate(el => getComputedStyle(el).marginTop), '0px', 'the action row keeps distance from the grid above');
    assert.match(await page.locator('.asr-preset-root-hint').textContent(), /预设文件夹：.*（可在.*设置.*中更改）/u);
    assert.equal(await page.locator('#asrPresetRootInModal').textContent(), config.asrPresetRoot);

    await page.locator('#asrPresetClose').click();
    await page.locator('#qwenAudioContext').fill('页面当前未保存值');
    await page.locator('#manageAsrPresets').click();
    await page.waitForFunction(() => !document.querySelector('#asrPresetModal').classList.contains('hidden'));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.presetName), '访谈', 'opening the manager focuses the currently loaded preset');
    const previewsBeforeReclick = await page.evaluate(() => window.presetCalls.filter(call => call.name === 'recognition_presets' && call.payload.action === 'preview').length);
    await page.getByRole('option', { name: /访谈/ }).click();
    const previewsAfterReclick = await page.evaluate(() => window.presetCalls.filter(call => call.name === 'recognition_presets' && call.payload.action === 'preview').length);
    assert.equal(previewsAfterReclick, previewsBeforeReclick, 're-clicking the selected preset must not refetch or flash its preview');
    assert.equal(await page.locator('#qwenAudioContext').inputValue(), '页面当前未保存值', 'selecting a list item must not load it');
    await page.getByRole('option', { name: /访谈/ }).dblclick();
    await page.waitForFunction(() => document.querySelector('#asrPresetModal').classList.contains('hidden'));
    assert.equal(await page.locator('#qwenAudioContext').inputValue(), '保存时的上下文');
    assert.equal(await page.locator('#openaiPrompt').inputValue(), '保存时的上下文');
    assert.equal(await page.locator('#sonioxContextText').inputValue(), '保存时的上下文');
    assert.equal(await page.locator('#model').inputValue(), originalModel, 'loading a preset must not switch models');
    assert.equal(await page.locator('#currentAsrPresetName').textContent(), '访谈');
    assert.equal(await page.locator('#currentAsrPresetModified').isVisible(), false);
    assert.equal(await page.locator('#asrPresetStatus').textContent(), '', 'loading shows no redundant status next to the current-preset label');
    assert.equal(await page.locator('#asrPresetStatus').evaluate(el => el.classList.contains('hidden')), true);

    await page.locator('#qwenAudioContext').fill('双击前的临时修改');
    await page.locator('#manageAsrPresets').click();
    await page.waitForFunction(() => !document.querySelector('#asrPresetModal').classList.contains('hidden'));
    await page.getByRole('option', { name: /访谈/ }).dblclick();
    await page.waitForFunction(() => document.querySelector('#asrPresetModal').classList.contains('hidden'), undefined, { timeout: 5_000 });
    assert.equal(await page.locator('#qwenAudioContext').inputValue(), '保存时的上下文', 'double-clicking a list item loads the preset');

    await page.locator('#qwenAudioContext').fill('当前表单修改');
    assert.equal(await page.locator('#currentAsrPresetModified').isVisible(), true);
    assert.equal(await page.locator('#currentAsrPresetName').evaluate(el => getComputedStyle(el).fontStyle), 'italic');
    assert.equal(await page.locator('#updateCurrentAsrPreset').isVisible(), true);
    assert.equal(await page.locator('#updateCurrentAsrPreset').textContent(), '更新预设');
    await page.locator('#updateCurrentAsrPreset').click();
    await page.waitForFunction(() => window.presetStore.get('访谈')?.options.promptContext === '当前表单修改');
    assert.equal(await page.evaluate(() => document.querySelector('#batchConfirmModal').classList.contains('hidden')), true, 'updating the current preset from the form must not ask for confirmation');
    assert.equal(await page.locator('#currentAsrPresetModified').isVisible(), false);
    assert.equal(await page.locator('#updateCurrentAsrPreset').isVisible(), false);
    await page.locator('#qwenAudioContext').fill('当前表单修改');
    await page.locator('#manageAsrPresets').click();
    await page.getByRole('option', { name: /访谈/ }).click();
    await page.locator('#updateAsrPreset').click();
    await page.waitForFunction(() => window.presetStore.get('访谈')?.options.promptContext === '当前表单修改');
    assert.equal(await page.evaluate(() => document.querySelector('#batchConfirmModal').classList.contains('hidden')), true, 'updating the active preset from the modal needs no confirmation');

    const savedOptions = await page.evaluate(() => structuredClone(window.presetStore.get('访谈').options));
    await page.locator('#asrPresetName').fill('采访');
    await page.locator('#asrPresetName').blur();
    await page.waitForFunction(() => window.presetStore.has('采访') && !window.presetStore.has('访谈'));
    assert.deepEqual(await page.evaluate(() => window.presetStore.get('采访').options), savedOptions, 'saving metadata must not update options');
    assert.equal(await page.locator('#currentAsrPresetName').textContent(), '采访');
    assert.match(await page.locator('#asrPresetManagerStatus').textContent(), /预设资料已保存/u);
    await page.locator('#asrPresetDescription').fill('');
    await page.locator('#asrPresetDescription').blur();
    await page.waitForFunction(() => window.presetStore.get('采访')?.description === '');

    await page.locator('#copyAsrPreset').click();
    await page.waitForFunction(() => window.presetStore.has('采访 副本'));
    assert.equal(await page.locator('#asrPresetName').inputValue(), '采访 副本', 'copy creates and selects a duplicate before the user renames it');
    assert.deepEqual(await page.evaluate(() => window.presetStore.get('采访 副本').options), savedOptions, 'copy must clone stored options, not the current form');
    assert.equal(await page.locator('#qwenAudioContext').inputValue(), '当前表单修改');
    await page.locator('#asrPresetName').fill('采访副本');
    await page.locator('#asrPresetName').blur();
    await page.waitForFunction(() => window.presetStore.has('采访副本') && !window.presetStore.has('采访 副本'));

    await page.locator('#qwenAudioContext').fill('覆盖副本的值');
    assert.equal(await page.locator('#updateAsrPreset').textContent(), '覆盖至预设', 'a non-active preset shows the overwrite label');
    await page.locator('#updateAsrPreset').click();
    await page.waitForFunction(() => !document.querySelector('#batchConfirmModal').classList.contains('hidden'));
    assert.match(await page.locator('#batchConfirmMessage').textContent(), /采访副本/);
    await page.locator('#batchConfirmNo').click();
    await page.waitForFunction(() => window.presetStore.get('采访副本')?.options.promptContext === '当前表单修改', undefined, { timeout: 5_000 });
    await page.locator('#updateAsrPreset').click();
    await page.waitForFunction(() => !document.querySelector('#batchConfirmModal').classList.contains('hidden'));
    await page.locator('#batchConfirmYes').click();
    await page.waitForFunction(() => window.presetStore.get('采访副本')?.options.promptContext === '覆盖副本的值');

    await page.locator('#asrPresetSearch').fill('副本');
    assert.equal(await page.getByRole('option', { name: /采访副本/ }).count(), 1);
    await page.locator('#asrPresetSearch').fill('damaged');
    assert.match(await page.locator('#asrPresetList').textContent(), /不可用.*预设格式不受支持/);
    await page.locator('#asrPresetSearch').fill('');
    await page.getByRole('option', { name: /采访副本/ }).click();
    await page.locator('#deleteAsrPreset').click();
    await page.waitForFunction(() => !document.querySelector('#batchConfirmModal').classList.contains('hidden'));
    assert.match(await page.locator('#batchConfirmMessage').textContent(), /采访副本/);
    assert.match(await page.locator('#batchConfirmMessage').textContent(), /回收站/);
    await page.locator('#batchConfirmYes').click();
    await page.waitForFunction(() => !window.presetStore.has('采访副本'));
    assert.deepEqual(await page.evaluate(() => window.trash), ['采访副本']);

    assert.equal(await page.locator('#loadAsrPreset').isDisabled(), true, 'load is disabled without a selection');
    assert.equal(await page.locator('#loadAsrPreset').textContent(), '加载预设', 'the load button keeps a single label');
    await page.locator('#saveAsrPreset').click();
    await page.waitForFunction(() => window.presetStore.has('未命名预设'));
    await page.waitForFunction(() => document.activeElement?.id === 'asrPresetName', undefined, { timeout: 5_000 });
    assert.equal(await page.locator('#asrPresetName').inputValue(), '未命名预设');
    assert.equal(await page.locator('#loadAsrPreset').isDisabled(), false);
    await page.getByRole('option', { name: /采访/ }).click();
    await page.locator('#loadAsrPreset').click();
    await page.waitForFunction(() => document.querySelector('#asrPresetModal').classList.contains('hidden'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'manageAsrPresets');
    await page.locator('#settingsButton').click();
    assert.equal(await page.locator('#asrPresetRoot').inputValue(), config.asrPresetRoot);
    assert.equal(await page.locator('#asrPresetRootCurrent').textContent(), config.asrPresetRoot);
    assert.ok(await page.locator('#resetAsrPresetRoot').evaluate(el => el.closest('.preset-root-current') !== null), 'restore default sits on the current-folder row');
    await page.locator('#pickAsrPresetRoot').click();
    await page.waitForFunction(() => !document.querySelector('#batchConfirmModal').classList.contains('hidden'));
    assert.match(await page.locator('#batchConfirmMessage').textContent(), /1 个预设/);
    await page.locator('#batchConfirmYes').click();
    await page.waitForFunction(() => document.querySelector('#asrPresetRoot').value === 'C:/custom-presets');
    await page.locator('#resetAsrPresetRoot').click();
    await page.waitForFunction(() => !document.querySelector('#batchConfirmModal').classList.contains('hidden'));
    assert.match(await page.locator('#batchConfirmMessage').textContent(), /1 个预设/);
    await page.locator('#batchConfirmNo').click();
    await page.waitForFunction(() => document.querySelector('#asrPresetRoot').value === 'C:/Users/test/AppData/Local/MAW/asr-presets');

    await page.locator('#langEn').click();
    assert.equal(await page.locator('#manageAsrPresets').textContent(), 'Manage presets');
    await page.locator('#settingsClose').click();
    await page.locator('#manageAsrPresets').click();
    await page.waitForFunction(() => document.activeElement.dataset.presetName === '采访');
    const activeItem = await page.locator('#asrPresetList [data-preset-name="采访"]').evaluate(el => ({
      active: el.classList.contains('active'),
      selected: el.getAttribute('aria-selected') === 'true',
      badge: el.querySelector('.asr-preset-item-badge')?.textContent || '',
    }));
    assert.ok(activeItem.active && activeItem.selected && activeItem.badge === 'Active', 'the loaded preset shows the active state together with the selected state');
    assert.equal(await page.locator('#asrPresetList [data-preset-name="未命名预设"]').evaluate(el => el.classList.contains('active')), false, 'other presets are not marked active');
    assert.equal(await page.locator('#updateAsrPreset').textContent(), 'Update this preset', 'the active preset shows the update label in English too');
    const modalSize = await page.locator('.asr-preset-modal-card').evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
    assert.ok(modalSize.width <= 780 && modalSize.width >= 720, `unexpected modal width: ${modalSize.width}`);
    assert.ok(modalSize.height <= 620 && modalSize.height >= 560, `unexpected modal height: ${modalSize.height}`);
    assert.equal(await page.locator('#refreshAsrPresets').evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
    const backgroundScroll = await page.evaluate(() => {
      const element = document.querySelector('.shell-scroll');
      element.scrollTop = Math.min(200, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    await page.mouse.move(8, 8);
    await page.mouse.wheel(0, 400);
    assert.equal(await page.evaluate(() => document.querySelector('.shell-scroll').scrollTop), backgroundScroll, 'wheel scrolling must not reach the launcher behind the modal');
    await page.locator('#asrPresetSearch').fill('damaged');
    assert.match(await page.locator('#asrPresetList').textContent(), /Unavailable.*Unsupported preset format/);
    await page.locator('#asrPresetSearch').fill('');
    await page.locator('#asrPresetSettingsLink').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'asrPresetClose');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#asrPresetModal').classList.contains('hidden'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'manageAsrPresets');
    await page.setViewportSize({ width: 520, height: 850 });
    await page.locator('#manageAsrPresets').click();
    const columns = await page.locator('.asr-preset-manager-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns);
    assert.equal(columns.trim().split(/\s+/u).length, 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.equal(await page.locator('#saveAsrPreset').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
