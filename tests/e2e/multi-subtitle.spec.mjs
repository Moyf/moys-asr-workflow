// 多重字幕 MVP 的浏览器回归：导入/匹配、列表开关、联动拆分和双 lane 操作。
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  findFreePort,
  generateWaveformPayload,
  makeTempDir,
  startStaticServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('multi-subtitle');
  // blank-editor.html 已由源码变更后的验证步骤生成；这里直接复用它，
  // 避免每个 E2E worker 再次触发 uv 的依赖解析和本机缓存权限问题。
  const blankPath = join(process.cwd(), 'blank-editor.html');
  server = await startStaticServer(blankPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

function srtSpec(name, text) {
  return { name, type: 'text/plain', base64: Buffer.from(text, 'utf8').toString('base64') };
}

async function dropFiles(page, specs) {
  const dataTransfer = await page.evaluateHandle((fileSpecs) => {
    const dt = new DataTransfer();
    for (const spec of fileSpecs) {
      const bytes = Uint8Array.from(atob(spec.base64), (char) => char.charCodeAt(0));
      dt.items.add(new File([bytes], spec.name, { type: spec.type }));
    }
    return dt;
  }, specs);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

const mainSrt = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  'Hello world.',
  '',
  '2',
  '00:00:03,000 --> 00:00:05,000',
  'Second line.',
  '',
].join('\n');

const extensionSrt = [
  '1',
  '00:00:00,050 --> 00:00:01,950',
  '你好，世界。',
  '',
  '2',
  '00:00:03,050 --> 00:00:04,950',
  '第二句。',
  '',
  '3',
  '00:00:08,000 --> 00:00:09,000',
  'unmatched',
  '',
].join('\n');

async function importPair(page) {
  await page.goto(server.url);
  await dropFiles(page, [srtSpec('main.srt', mainSrt)]);
  await expect(page.locator('#cues-container > .cue')).toHaveCount(2);
  await dropFiles(page, [srtSpec('translation.srt', extensionSrt)]);
  await expect(page.locator('#multi-subtitle-import-modal')).toHaveClass(/show/);
  return page;
}

async function openMultiSubtitleSettings(page) {
  await page.locator('#multi-subtitle-settings-toggle').click();
  await expect(page.locator('#multi-subtitle-settings-menu')).toBeVisible();
}

async function waitForLayoutBox(locator, message) {
  let latestBox = null;
  await expect.poll(async () => {
    latestBox = await locator.boundingBox();
    return Boolean(latestBox && latestBox.width > 0 && latestBox.height > 0);
  }, { timeout: 5000, message }).toBe(true);
  if (!latestBox) throw new Error(message);
  return latestBox;
}

async function moveWaveformPointerToTime(page, blockLocator, timeMs) {
  const blockBox = await waitForLayoutBox(blockLocator, '波形字幕块没有布局');
  const row = blockLocator.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " waveform-row ")][1]');
  const rowBox = await row.boundingBox();
  const rowStart = Number(await row.getAttribute('data-start-ms'));
  const rowEnd = Number(await row.getAttribute('data-end-ms'));
  expect(rowBox).not.toBeNull();
  expect(rowEnd).toBeGreaterThan(rowStart);
  const ratio = (timeMs - rowStart) / (rowEnd - rowStart);
  await page.mouse.move(
    rowBox.x + rowBox.width * Math.max(0, Math.min(1, ratio)),
    blockBox.y + blockBox.height / 2,
  );
}

test('defaults the waveform shape source to ReaPeaks', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#waveform-settings-toggle').click();
  await expect(page.locator('#waveform-settings-panel')).toBeVisible();
  await expect(page.locator('#waveform-shape-source')).toHaveValue('reapeaks');
});

test('explains where to configure automatic timecode splitting', async ({ page }) => {
  await page.goto(server.url);
  await page.locator('#editor-settings-toggle').click();
  const hint = page.locator('#split-use-word-timestamps-hint');
  await expect(hint).toContainText('开启时，有可用字词时间码的主字幕会自动按时间码拆分');
  await expect(hint).not.toContainText('右上角「🔧 设置 → 拆分与合并」');
});

test('offers importing a second SRT when enabling multiple subtitles without an extension track', async ({ page }) => {
  await page.goto(server.url);
  await dropFiles(page, [srtSpec('main.srt', mainSrt)]);

  await expect(page.locator('#multi-subtitle-controls')).toBeVisible();
  await expect(page.locator('#multi-subtitle-toggle')).not.toBeDisabled();
  await expect(page.locator('#multi-subtitle-settings-toggle')).toBeHidden();
  await expect(page.locator('#multi-subtitle-toggle-label'))
    .toHaveAttribute('title', '当前工程如果有大于1条字幕，可以开启多重字幕模式，用于双语字幕编辑等。');
  expect(await page.locator('#multi-subtitle-toggle-label').evaluate((element) => (
    element.nextElementSibling?.id
  ))).toBe('multi-subtitle-settings-dropdown');

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe('是否选择导入第二条字幕以开启多重字幕模式？');
    dialog.dismiss();
  });
  await page.locator('#multi-subtitle-toggle').click();
  await expect(page.locator('#multi-subtitle-toggle')).not.toBeChecked();

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe('是否选择导入第二条字幕以开启多重字幕模式？');
    dialog.accept();
  });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#multi-subtitle-toggle').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'translation.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from(extensionSrt, 'utf8'),
  });
  await expect(page.locator('#multi-subtitle-import-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-toggle')).not.toBeChecked();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await expect(page.locator('#multi-subtitle-toggle')).toBeChecked();
  await expect(page.locator('#multi-subtitle-settings-toggle')).toBeVisible();
});

test('waveform extension cue double-click focuses the extension editor', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 0, end: 2000, text: 'main cue' }],
    waveform: generateWaveformPayload(3000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [{ id: 'extension-001', start: 0, end: 2000, text: 'extension cue' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'waveform-extension-focus.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const cue = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]').first();
  await expect(cue).toBeVisible();
  await cue.scrollIntoViewIfNeeded();
  await cue.dblclick();
  await expect(page.locator('#cue-panel-target')).toHaveText('副字幕');
  await expect(page.locator('#cue-panel-text')).toBeFocused();
});

test('extension list clicks auto-scroll and double-click places the caret at the pointer', async ({ page }) => {
  const segments = Array.from({ length: 30 }, (_, index) => ({
    id: `main-${index + 1}`,
    start: index * 10000,
    end: index * 10000 + 5000,
    text: `main ${index + 1}`,
    items: [],
  }));
  const extensionSegments = segments.map((segment, index) => ({
    id: `extension-${index + 1}`,
    start: segment.start,
    end: segment.end,
    text: `extension ${index + 1}`,
    items: [],
  }));
  const project = {
    segments,
    waveform: generateWaveformPayload(300000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: extensionSegments,
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'extension-list-edit-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const autoScroll = page.locator('#cue-list-auto-scroll-on-click');
  await page.locator('#editor-settings-toggle').click();
  await autoScroll.check();
  const list = page.locator('#cues-container');
  const target = page.locator('.multi-dual-cue[data-ext-idx="20"] .multi-cue-column.extension');
  const targetRow = page.locator('.multi-dual-cue[data-ext-idx="20"]');
  const mainRow = page.locator('.multi-dual-cue[data-main-idx="20"]');
  await expect(target).toHaveCount(1);
  await list.evaluate((element) => { element.scrollTop = 0; });
  const before = await list.evaluate((element) => element.scrollTop);

  // dispatchEvent 不会先替 Playwright 自动滚动目标，能验证应用自己的点击滚动逻辑。
  await target.dispatchEvent('pointerdown', { bubbles: true, button: 0, clientX: 120, clientY: 120 });
  await target.dispatchEvent('click', { bubbles: true, clientX: 120, clientY: 120 });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
  await expect.poll(async () => {
    const [listBox, targetBox, mainBox] = await Promise.all([
      list.boundingBox(), targetRow.boundingBox(), mainRow.boundingBox(),
    ]);
    if (!listBox || !targetBox || !mainBox) return false;
    const listCenter = listBox.y + listBox.height / 2;
    const targetDistance = Math.abs(targetBox.y + targetBox.height / 2 - listCenter);
    const mainDistance = Math.abs(mainBox.y + mainBox.height / 2 - listCenter);
    return targetDistance < mainDistance;
  }).toBe(true);
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const viewportHeight = await page.evaluate(() => innerHeight);
    return Boolean(box && box.y >= 0 && box.y + box.height <= viewportHeight);
  }).toBe(true);
  await target.scrollIntoViewIfNeeded();

  const text = target.locator('.text');
  const point = await text.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 5);
    range.setEnd(node, 5);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.dblclick(point.x, point.y);
  await expect(target).toHaveClass(/editing/);
  await expect.poll(() => page.evaluate(() => {
    const element = document.querySelector(
      '.multi-dual-cue[data-ext-idx="20"] .multi-cue-column.extension .text',
    );
    const selection = window.getSelection();
    if (!element || !selection?.rangeCount || !selection.anchorNode) return null;
    if (!element.contains(selection.anchorNode)) return null;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return selection.isCollapsed ? range.toString().length : -1;
  })).toBe(5);
});

test('uses the same text editor box styling in single and dual-column modes', async ({ page }) => {
  await page.goto(server.url);
  await dropFiles(page, [srtSpec('main.srt', mainSrt)]);

  const readEditorStyle = (element) => {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      backgroundColor: style.backgroundColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      padding: style.padding,
      whiteSpace: style.whiteSpace,
      boxSizing: style.boxSizing,
      cursor: style.cursor,
    };
  };
  const singleText = page.locator('#cues-container > .cue[data-idx="0"] .text');
  await singleText.dblclick();
  await expect(singleText).toHaveAttribute('contenteditable', 'plaintext-only');
  const singleStyle = await singleText.evaluate(readEditorStyle);
  await page.keyboard.press('Escape');

  await dropFiles(page, [srtSpec('translation.srt', extensionSrt)]);
  await expect(page.locator('#multi-subtitle-import-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const dualMainText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text');
  await dualMainText.dblclick();
  const dualMainStyle = await dualMainText.evaluate(readEditorStyle);
  await page.keyboard.press('Escape');

  const dualExtensionText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.extension .text');
  await dualExtensionText.dblclick();
  const dualExtensionStyle = await dualExtensionText.evaluate(readEditorStyle);

  expect(dualMainStyle).toEqual(singleStyle);
  expect(dualExtensionStyle).toEqual(singleStyle);
});

test('uses the main cue-row layout when displaying only the extension track', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await openMultiSubtitleSettings(page);

  const heightSetting = page.locator('#multi-subtitle-extension-row-height-setting');
  const settingBoxes = await heightSetting.evaluate((element) => {
    const label = element.querySelector(':scope > span');
    const select = element.querySelector('select');
    return {
      labelRight: label?.getBoundingClientRect().right ?? 0,
      selectLeft: select?.getBoundingClientRect().left ?? 0,
      selectWidth: select ? getComputedStyle(select).width : '',
    };
  });
  expect(settingBoxes.selectLeft).toBeGreaterThanOrEqual(settingBoxes.labelRight);
  expect(settingBoxes.selectWidth).toBe('108px');

  await page.locator('#multi-subtitle-display-mode').selectOption('main');
  const mainCue = page.locator('#cues-container > .cue[data-idx="0"]');
  const readCueLayout = (element) => {
    const read = (node) => {
      const style = getComputedStyle(node);
      return {
        display: style.display,
        alignItems: style.alignItems,
        gap: style.gap,
        padding: style.padding,
        margin: style.margin,
        borderLeftWidth: style.borderLeftWidth,
        borderLeftStyle: style.borderLeftStyle,
        borderRadius: style.borderRadius,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      };
    };
    return {
      children: Array.from(element.children).map((child) => ({
        className: child.className,
        style: read(child),
      })),
      style: read(element),
    };
  };
  const mainLayout = await mainCue.evaluate(readCueLayout);

  await page.locator('#multi-subtitle-display-mode').selectOption('extension');
  const extensionCue = page.locator('#cues-container > .multi-extension-cue').first();
  await expect(extensionCue.locator('.text')).toHaveText('你好，世界。');
  await expect(extensionCue.locator('.index')).toHaveText('1');
  await expect(extensionCue.locator('.time-start')).toHaveText('00:00.050');
  await expect(extensionCue.locator('.charcount')).toBeVisible();
  expect(await extensionCue.evaluate(readCueLayout)).toEqual(mainLayout);
});

test('raises both subtitle lanes moderately in basic waveform mode', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 1000, end: 2000, text: '主字幕一', items: [] },
      { id: 'main-002', start: 6000, end: 7000, text: '主字幕二', items: [] },
    ],
    waveform: generateWaveformPayload(10000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1',
        role: 'extension',
        name: 'English',
        language: 'English',
        split_mode: 'word',
        source_name: 'translation.srt',
        segments: [
          { id: 'extension-001', start: 1050, end: 1950, text: 'translation one' },
          { id: 'extension-002', start: 6050, end: 6950, text: 'translation two' },
        ],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'multi-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);
  await expect(page.locator('.waveform-row.multi-subtitle-row')).not.toHaveCount(0);
  await page.locator('[data-waveform-mode="basic"]').click();

  const laneHeights = await page.locator('.waveform-row.multi-subtitle-row').first().evaluate((row) => ({
    main: parseFloat(getComputedStyle(row.querySelector('[data-track="main"]')).height),
    extension: parseFloat(getComputedStyle(row.querySelector('[data-track="extension"]')).height),
  }));
  expect(laneHeights.main).toBeGreaterThan(35);
  expect(laneHeights.main).toBeLessThan(72);
  expect(laneHeights.extension).toBe(laneHeights.main);
});

test('keeps main and secondary language types independent and reuses them for counts', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await openMultiSubtitleSettings(page);

  await expect(page.locator('#multi-subtitle-main-language-mode')).toHaveValue('word');
  await expect(page.locator('#multi-subtitle-extension-language-mode')).toHaveValue('continuous');
  await expect(page.locator('.multi-subtitle-setting-hint')).toContainText('单词型');
  await expect(page.locator('.multi-subtitle-setting-hint')).toContainText('字符型');

  await page.locator('#multi-subtitle-display-mode').selectOption('main');
  await expect(page.locator('#cues-container > .cue').first().locator('.charcount')).toHaveText('2');
  await page.locator('#multi-subtitle-main-language-mode').selectOption('continuous');
  await expect(page.locator('#cues-container > .cue').first().locator('.charcount')).toHaveText('10');

  await page.locator('#multi-subtitle-display-mode').selectOption('extension');
  await expect(page.locator('#cues-container > .cue').first().locator('.charcount')).toHaveText('4');
  await page.locator('#multi-subtitle-extension-language-mode').selectOption('word');
  await expect(page.locator('#cues-container > .cue').first().locator('.charcount')).toHaveText('1');
});

test('switches the active subtitle track with the up and down arrows', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const firstRow = page.locator('.multi-dual-cue').first();
  await firstRow.locator('.multi-cue-column.main .text').click();
  await expect(page.locator('#cue-panel-target')).toHaveText('主字幕');

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#cue-panel-target')).toHaveText('副字幕');
  await expect(page.locator('#sel-count')).toHaveText('2');

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#cue-panel-target')).toHaveText('主字幕');
  await expect(firstRow).toHaveClass(/selected/);
});

test('keeps track badges optional and uses striped disabled styling for secondary cues', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-badge-001', start: 1000, end: 2000, text: 'main cue' }],
    waveform: generateWaveformPayload(7000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-badge-1', role: 'extension', name: 'English', language: 'English',
        split_mode: 'word', source_name: 'translation.srt',
        segments: [{ id: 'extension-badge-001', start: 1000, end: 2000, text: 'secondary cue' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'badge-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);
  const firstRow = page.locator('.multi-dual-cue').first();
  const firstWaveformRow = page.locator('.waveform-row.multi-subtitle-row').first();

  await openMultiSubtitleSettings(page);
  await expect(page.locator('#multi-subtitle-show-track-badges')).not.toBeChecked();
  await expect(firstWaveformRow).not.toHaveClass(/show-track-badges/);
  await page.locator('#multi-subtitle-show-track-badges').check();
  await expect(firstWaveformRow).toHaveClass(/show-track-badges/);
  await page.locator('#multi-subtitle-show-track-badges').uncheck();
  await expect(firstWaveformRow).not.toHaveClass(/show-track-badges/);
  await page.locator('#multi-subtitle-settings-toggle').click();

  const main = page.locator('.multi-cue-column.main:not(.multi-cue-empty)').first();
  await main.click({ modifiers: ['Alt'] });
  await expect(main).toHaveClass(/disabled/);
  await expect(main).toHaveCSS('background-image', 'none');

  await firstRow.locator('.multi-cue-column.extension').click({ modifiers: ['Alt'] });
  await expect(firstRow.locator('.multi-cue-column.extension')).toHaveClass(/disabled/);
  await expect(firstRow.locator('.multi-cue-column.extension')).toHaveCSS(
    'background-image',
    /repeating-linear-gradient/,
  );
});

test('disabling a main cue disables its bound extension cue, while extension disabling stays independent', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-disable-001', start: 1000, end: 3000, text: 'main cue' }],
    waveform: generateWaveformPayload(7000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-disable-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [{ id: 'extension-disable-001', start: 1000, end: 3000, text: 'extension cue' }],
      }],
      bindings: [{
        id: 'binding-disable-001',
        track_id: 'extension-disable-1',
        main_segment_ids: ['main-disable-001'],
        extension_segment_ids: ['extension-disable-001'],
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'disable-bound-pair.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);
  const firstRow = page.locator('.multi-dual-cue').first();
  const main = firstRow.locator('.multi-cue-column.main');
  const extension = firstRow.locator('.multi-cue-column.extension');

  await main.click({ modifiers: ['Alt'] });
  await expect(main).toHaveClass(/disabled/);
  await expect(extension).toHaveClass(/disabled/);
  const disabledBackground = await page.locator('.waveform-cue-block[data-track="extension"]').first()
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(disabledBackground).toMatch(/repeating-linear-gradient/);

  await extension.click({ modifiers: ['Alt'] });
  await expect(main).toHaveClass(/disabled/);
  await expect(extension).not.toHaveClass(/disabled/);
});

test('Ctrl-clicking an extension waveform cue keeps the extension as the active editor target', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 0, end: 2000, text: 'main one' },
      { id: 'main-002', start: 3000, end: 5000, text: 'main two' },
    ],
    waveform: generateWaveformPayload(6000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [
          { id: 'extension-001', start: 0, end: 2000, text: 'extension one' },
          { id: 'extension-002', start: 3000, end: 5000, text: 'extension two' },
        ],
      }],
      bindings: [
        { id: 'binding-001', track_id: 'extension-1', main_segment_ids: ['main-001'], extension_segment_ids: ['extension-001'] },
        { id: 'binding-002', track_id: 'extension-1', main_segment_ids: ['main-002'], extension_segment_ids: ['extension-002'] },
      ],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'ctrl-extension.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);
  const main = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  const extension = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="1"]').first();
  await expect(main).toBeVisible();
  await expect(extension).toBeVisible();
  await main.click();
  await extension.click({ modifiers: ['Control'] });
  await expect(page.locator('#cue-panel-target')).toHaveText('副字幕');
  expect(await page.evaluate(() => DATA.multi_subtitle.tracks[0].segments[1].id))
    .toBe('extension-002');
});

test('undoing an auto-synced binding restores the extension timing as well as the binding', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-bind-001', start: 1000, end: 3000, text: 'main cue' }],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-bind-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [{ id: 'extension-bind-001', start: 1200, end: 2200, text: 'extension cue' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'binding-auto-sync-undo.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);
  const main = page.locator('.multi-cue-column.main').first();
  const extension = page.locator('.multi-cue-column.extension[data-ext-idx="0"]').first();
  await main.click();
  await expect(page.locator('#sel-count')).toHaveText('1');
  await extension.click({ button: 'right' });
  await expect(page.locator('#ctxmenu')).toHaveClass(/show/);
  await page.locator('#ctxmenu .item').filter({ hasText: '与选中的主字幕绑定' }).click();
  const waveformExtension = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  expect(await page.evaluate(() => ({
    range: [DATA.multi_subtitle.tracks[0].segments[0].start, DATA.multi_subtitle.tracks[0].segments[0].end],
    bindings: DATA.multi_subtitle.bindings.length,
  }))).toEqual({ range: [1000, 3000], bindings: 1 });
  await expect(waveformExtension).toHaveAttribute('data-start', '1000');
  await expect(waveformExtension).toHaveAttribute('data-end', '3000');

  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => ({
    range: [DATA.multi_subtitle.tracks[0].segments[0].start, DATA.multi_subtitle.tracks[0].segments[0].end],
    bindings: DATA.multi_subtitle.bindings.length,
  }))).toEqual({ range: [1200, 2200], bindings: 0 });
  await expect(waveformExtension).toHaveAttribute('data-start', '1200');
  await expect(waveformExtension).toHaveAttribute('data-end', '2200');
});

test('uses the secondary language split mode and caret position for list B splitting', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await openMultiSubtitleSettings(page);
  await page.locator('#multi-subtitle-extension-language-mode').selectOption('continuous');
  await page.locator('#multi-subtitle-settings-toggle').click();

  const extensionText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.extension .text');
  await extensionText.click();
  const splitPoint = await extensionText.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 3);
    range.setEnd(node, 3);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);
  await page.keyboard.press('b');

  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择副字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeHidden();
  await expect(page.locator('#multi-subtitle-split-text .multi-subtitle-split-gap.active'))
    .toHaveAttribute('data-offset', '3');
  await page.keyboard.press('Escape');
});

test('marquee selection includes secondary waveform cues', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-marquee-001', start: 1000, end: 2000, text: 'main cue' }],
    waveform: generateWaveformPayload(7000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-marquee-1', role: 'extension', name: 'English', language: 'English',
        split_mode: 'word', source_name: 'translation.srt',
        segments: [{ id: 'extension-marquee-001', start: 4000, end: 5000, text: 'secondary cue' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'marquee-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  const extensionBox = await waitForLayoutBox(extensionBlock, '副字幕波形块没有布局');
  const row = extensionBlock.locator('xpath=ancestor::*[contains(@class, "waveform-row")]');
  const rowBox = await waitForLayoutBox(row, '多重字幕波形行没有布局');
  await page.keyboard.down('Shift');
  await page.mouse.move(Math.max(rowBox.x + 4, extensionBox.x - 32), extensionBox.y + extensionBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(extensionBox.x + extensionBox.width / 2, extensionBox.y + extensionBox.height / 2);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(extensionBlock).toHaveClass(/selected/);
});

test('shows and edits the last clicked main or extension cue in the current subtitle editor', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const panelText = page.locator('#cue-panel-text');
  const panelTarget = page.locator('#cue-panel-target');
  const firstRow = page.locator('.multi-dual-cue').first();
  const mainText = firstRow.locator('.multi-cue-column.main .text');
  const extensionText = firstRow.locator('.multi-cue-column.extension .text');

  await mainText.click();
  await expect(panelTarget).toHaveText('主字幕');
  await expect(panelText).toHaveValue('Hello world.');

  await extensionText.click();
  await expect(panelTarget).toHaveText('副字幕');
  await expect(panelText).toHaveValue('你好，世界。');
  await panelText.fill('你好，世界！');
  await expect(extensionText).toHaveText('你好，世界！');

  await mainText.click();
  await expect(panelTarget).toHaveText('主字幕');
  await expect(panelText).toHaveValue('Hello world.');

  await page.locator('.multi-dual-cue').nth(1).locator('.multi-cue-column.extension .text').click();
  await expect(panelTarget).toHaveText('副字幕');
  await expect(panelText).toHaveValue('第二句。');
});

test('selects bound subtitle pairs without changing the current editor target', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await openMultiSubtitleSettings(page);

  const pairToggle = page.locator('#multi-subtitle-select-bound-pair');
  await expect(pairToggle).toBeChecked();
  await page.locator('#multi-subtitle-settings-toggle').click();
  const panelTarget = page.locator('#cue-panel-target');
  const panelText = page.locator('#cue-panel-text');
  const firstRow = page.locator('.multi-dual-cue').first();
  const mainText = firstRow.locator('.multi-cue-column.main .text');
  const extensionText = firstRow.locator('.multi-cue-column.extension .text');

  await extensionText.click();
  await expect(page.locator('#sel-count')).toHaveText('2');
  await expect(panelTarget).toHaveText('副字幕');
  await page.locator('#media-controls').hover();
  await page.keyboard.press('Enter');
  await expect(panelTarget).toHaveText('副字幕');
  await expect(panelText).toBeFocused();
  await mainText.click();
  await expect(page.locator('#sel-count')).toHaveText('2');
  await expect(panelTarget).toHaveText('主字幕');
  await page.locator('#media-controls').hover();
  await page.keyboard.press('Enter');
  await expect(panelTarget).toHaveText('主字幕');
  await expect(panelText).toBeFocused();

  await mainText.click();
  await expect(page.locator('#sel-count')).toHaveText('2');
  await expect(panelTarget).toHaveText('主字幕');

  await extensionText.click();
  await expect(page.locator('#sel-count')).toHaveText('2');
  await expect(panelTarget).toHaveText('副字幕');

  await openMultiSubtitleSettings(page);
  await pairToggle.uncheck();
  await page.locator('#multi-subtitle-settings-toggle').click();
  await page.keyboard.press('Escape');
  await extensionText.click();
  await expect(page.locator('#sel-count')).toHaveText('1');
  await expect(panelTarget).toHaveText('副字幕');

  await openMultiSubtitleSettings(page);
  await pairToggle.check();
  await page.locator('#multi-subtitle-settings-toggle').click();
  await page.keyboard.press('Escape');
  await extensionText.click();
  await expect(page.locator('#sel-count')).toHaveText('2');
  await expect(panelTarget).toHaveText('副字幕');
});

test('ends dual-column inline editing when clicking outside the text input', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const row = page.locator('.multi-dual-cue').first();
  const mainText = row.locator('.multi-cue-column.main .text');
  await mainText.dblclick();
  await expect(mainText).toHaveAttribute('contenteditable', 'plaintext-only');
  await expect.poll(() => mainText.evaluate((element) => getComputedStyle(element).cursor)).toBe('text');
  await row.locator('.multi-cue-column.main .multi-cue-column-header').click();
  await expect(mainText).not.toHaveAttribute('contenteditable');
  await expect(row).not.toHaveClass(/editing/);

  const extensionText = row.locator('.multi-cue-column.extension .text');
  await extensionText.dblclick();
  await expect(extensionText).toHaveAttribute('contenteditable', 'plaintext-only');
  await expect.poll(() => extensionText.evaluate((element) => getComputedStyle(element).cursor)).toBe('text');
  await row.locator('.multi-cue-column.extension .multi-cue-column-header').click();
  await expect(extensionText).not.toHaveAttribute('contenteditable');
  await expect(row.locator('.multi-cue-column.extension')).not.toHaveClass(/editing/);
});

test('keeps inline edits after switching to another dual-column subtitle', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const firstRow = page.locator('.multi-dual-cue').first();
  const secondRow = page.locator('.multi-dual-cue').nth(1);
  const mainText = firstRow.locator('.multi-cue-column.main .text');
  const extensionText = firstRow.locator('.multi-cue-column.extension .text');

  await mainText.dblclick();
  await mainText.fill('主轨修改后保留');
  await secondRow.locator('.multi-cue-column.main .text').click();
  await expect(mainText).toHaveText('主轨修改后保留');
  expect(await page.evaluate(() => DATA.segments[0].text)).toBe('主轨修改后保留');

  await extensionText.dblclick();
  await extensionText.fill('副轨修改后保留');
  await secondRow.locator('.multi-cue-column.extension .text').click();
  await expect(extensionText).toHaveText('副轨修改后保留');
  expect(await page.evaluate(() => DATA.multi_subtitle.tracks[0].segments[0].text))
    .toBe('副轨修改后保留');
});

test('imports an extension SRT with 300ms preview, dual columns, split dialog, and pair deletion undo', async ({ page }) => {
  await importPair(page);
  await expect(page.locator('#multi-subtitle-import-description')).toHaveText('请选择你要执行的行为：');
  await expect(page.locator('#multi-subtitle-import-preview')).toContainText('自动绑定 2 条');
  await expect(page.locator('#multi-subtitle-import-result-confirm')).toBeEnabled();
  await expect(page.locator('#multi-subtitle-import-extension')).not.toHaveClass(/primary/);
  await expect(page.locator('#multi-subtitle-import-extension')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#multi-subtitle-import-preview')).toContainText('未绑定 1 条');
  await page.locator('#multi-subtitle-import-result-confirm').click();

  await expect(page.locator('#multi-subtitle-toggle')).toBeChecked();
  await expect(page.locator('#cues-container > .multi-dual-cue')).toHaveCount(3);
  await expect(page.locator('#cues-container .multi-cue-column.extension.unbound')).toHaveCount(1);

  await openMultiSubtitleSettings(page);
  await expect(page.locator('#multi-subtitle-cross-track-snap')).toBeChecked();
  await page.locator('#multi-subtitle-display-mode').selectOption('main');
  await expect(page.locator('#cues-container > .multi-dual-cue')).toHaveCount(0);
  await expect(page.locator('#cues-container > .cue[data-idx]')).toHaveCount(2);
  await page.locator('#multi-subtitle-display-mode').selectOption('extension');
  await expect(page.locator('#cues-container > .multi-extension-cue')).toHaveCount(3);
  await page.locator('#multi-subtitle-display-mode').selectOption('both');
  await expect(page.locator('#cues-container > .multi-dual-cue')).toHaveCount(3);

  // 主轨双击进入编辑后按 Enter，绑定状态应打开联动拆分弹窗。
  const mainText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text');
  await mainText.dblclick();
  await mainText.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 6);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-text span')).not.toHaveCount(0);
  await expect(page.locator('#multi-subtitle-split-confirm')).toBeEnabled();
  const splitText = page.locator('#multi-subtitle-split-text');
  const splitBox = await splitText.boundingBox();
  if (!splitBox) throw new Error('拆分弹窗文本区域没有布局');
  const charBoxes = await splitText.locator('.multi-subtitle-split-char').evaluateAll((elements) => (
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    })
  ));
  const leftX = charBoxes[1].right - 1;
  const rightX = charBoxes[4].right - 1;
  const splitY = charBoxes[1].y;
  await page.mouse.move(leftX, splitY);
  const leftSplitMeta = await page.locator('#multi-subtitle-split-meta').textContent();
  await page.mouse.move(rightX, splitY);
  const rightSplitMeta = await page.locator('#multi-subtitle-split-meta').textContent();
  expect(rightSplitMeta).not.toBe(leftSplitMeta);
  await page.mouse.click(rightX, splitY);
  await expect(splitText).toHaveClass(/locked/);
  await expect(splitText).toHaveAttribute('title', '拆分点已锁定，点击或按空格解锁');
  await expect(page.locator('#multi-subtitle-split-preview')).toHaveClass(/locked/);
  await page.mouse.move(leftX, splitY);
  await expect(page.locator('#multi-subtitle-split-meta')).toHaveText(rightSplitMeta);
  await page.mouse.click(leftX, splitY);
  await expect(splitText).not.toHaveClass(/locked/);
  await page.mouse.move(charBoxes[2].right - 1, splitY);
  await expect(page.locator('#multi-subtitle-split-confirm')).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await expect(page.locator('.multi-cue-column.extension .text').filter({ hasText: '你好' })).toHaveCount(1);
  await expect(page.locator('.multi-cue-column.extension .text').filter({ hasText: '世界' })).toHaveCount(1);

  // 默认主轨使用字词时间码，拓展轨的近似拆分不应反向改写主轨。
  const splitTimings = await page.locator('.multi-cue-column').evaluateAll((elements) => (
    elements.map((element) => ({
      kind: element.classList.contains('main') ? 'main' : 'extension',
      text: element.querySelector('.text')?.textContent.trim() || '',
      start: element.dataset.start,
      end: element.dataset.end,
    }))
  ));
  const mainSegments = splitTimings.filter((entry) => entry.kind === 'main' && entry.start != null);
  const extensionSegments = splitTimings.filter((entry) => entry.kind === 'extension' && entry.start != null);
  expect(mainSegments[0].end).toBe(extensionSegments[0].end);
  expect(mainSegments[0].end).toBe(mainSegments[1].start);
  expect(extensionSegments[0].end).toBe(extensionSegments[1].start);

  // 清空主轨选择后只选中一条已绑定扩展字幕，Delete 必须成对删除；Ctrl+Z 恢复。
  await page.keyboard.press('Escape');
  await page.locator('.multi-dual-cue').first().locator('.multi-cue-column.extension').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('#cues-container > .multi-dual-cue')).toHaveCount(3);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#cues-container > .multi-dual-cue')).toHaveCount(4);
});

test('auto-submits a linked split after both subtitle lanes are confirmed', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const mainText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text');
  await mainText.dblclick();
  await mainText.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 6);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-auto-submit')).toBeChecked();

  await page.locator('#multi-subtitle-split-main-text .multi-subtitle-split-gap').first()
    .evaluate((element) => element.click());
  await expect(page.locator('#multi-subtitle-split-main-text')).toHaveClass(/locked/);
  await page.locator('#multi-subtitle-split-text .multi-subtitle-split-gap').first()
    .evaluate((element) => element.click());
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await expect(page.locator('.multi-cue-column.main .text')).toHaveCount(3);
  await expect(page.locator('.multi-cue-column.extension .text')).toHaveCount(4);
});

async function placeCaret(element, offset) {
  await element.evaluate((node, caretOffset) => {
    const range = document.createRange();
    range.setStart(node.firstChild, caretOffset);
    range.setEnd(node.firstChild, caretOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, offset);
}

function selectedSnapshot() {
  return Array.from(document.querySelectorAll('.selected'))
    .map((element) => element.textContent.trim().slice(0, 40));
}

test('moves the split point with WASD, switches lanes with Tab and confirms with Space', async ({ page }) => {
  await page.goto(server.url);
  await dropFiles(page, [srtSpec('main.srt', [
    '1',
    '00:00:00,000 --> 00:00:04,000',
    'One two three four.',
    '',
  ].join('\n'))]);
  await expect(page.locator('#cues-container > .cue')).toHaveCount(1);
  await dropFiles(page, [srtSpec('translation.srt', [
    '1',
    '00:00:00,050 --> 00:00:03,950',
    '这是一条用来测试键盘上下移动功能的很长很长的副字幕文本应该会自动折行成多行显示',
    '',
  ].join('\n'))]);
  await expect(page.locator('#multi-subtitle-import-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const firstMain = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text');
  await firstMain.dblclick();
  await placeCaret(firstMain, 4);
  await page.keyboard.press('Enter');

  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  // 弹窗打开即聚焦主 lane，带虚线边框标识。
  const mainLane = page.locator('#multi-subtitle-split-main-text');
  await expect(mainLane).toBeFocused();
  expect(await mainLane.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('dashed');
  const mainActiveGap = mainLane.locator('.multi-subtitle-split-gap.active');
  await expect(mainActiveGap).toHaveAttribute('data-offset', '4');

  // D/→ 按字词边界步进，A/← 回退；期间不得触发全局的字幕选择跳转。
  const selectedBefore = await page.evaluate(selectedSnapshot);
  await page.keyboard.press('d');
  await expect(mainActiveGap).toHaveAttribute('data-offset', '8');
  await page.keyboard.press('ArrowRight');
  await expect(mainActiveGap).toHaveAttribute('data-offset', '14');
  await page.keyboard.press('a');
  await expect(mainActiveGap).toHaveAttribute('data-offset', '8');
  await page.keyboard.press('ArrowLeft');
  await expect(mainActiveGap).toHaveAttribute('data-offset', '4');
  expect(await page.evaluate(selectedSnapshot)).toEqual(selectedBefore);

  // Tab 切到副 lane；多行文本支持上下移动，单行边界外不动作。
  await page.keyboard.press('Tab');
  const extensionLane = page.locator('#multi-subtitle-split-text');
  await expect(extensionLane).toBeFocused();
  const extensionActiveGap = extensionLane.locator('.multi-subtitle-split-gap.active');
  const firstRowOffset = Number(await extensionActiveGap.getAttribute('data-offset'));
  await page.keyboard.press('ArrowDown');
  const secondRowOffset = Number(await extensionActiveGap.getAttribute('data-offset'));
  expect(secondRowOffset - firstRowOffset).toBeGreaterThan(5);
  await page.keyboard.press('ArrowUp');
  const backRowOffset = Number(await extensionActiveGap.getAttribute('data-offset'));
  expect(Math.abs(backRowOffset - firstRowOffset)).toBeLessThanOrEqual(2);

  // Space 确认锁定当前断点，再按一次解锁以便继续移动。
  await page.keyboard.press('Space');
  await expect(extensionLane).toHaveClass(/locked/);
  await page.keyboard.press('Space');
  await expect(extensionLane).not.toHaveClass(/locked/);

  // 两个 lane 都用 Space 确认后按默认设置自动提交。
  await page.keyboard.press('Tab');
  await expect(mainLane).toBeFocused();
  await page.keyboard.press('Space');
  await expect(mainLane).toHaveClass(/locked/);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#cues-container > .multi-dual-cue')).toHaveCount(2);
});

test('keeps the timecode-anchored main lane out of Tab lane switching', async ({ page }) => {
  const projectPath = join(tempDir, 'kbd-timecode-locked-project.json');
  const project = {
    media: '', language: 'English', model: '',
    segments: [{
      id: 'main-kbd-001', start: 0, end: 2000, text: 'One two three.',
      items: [
        { start: 0, end: 700, text: 'One' },
        { start: 700, end: 1200, text: 'two' },
        { start: 1200, end: 2000, text: 'three.' },
      ],
    }],
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{
        id: 'extension-kbd-1', role: 'extension', name: 'Translation', language: '',
        split_mode: 'continuous', source_name: 'translation.srt',
        segments: [{ id: 'extension-kbd-001', start: 50, end: 1950, text: '你好时间码锁定测试' }],
      }],
      bindings: [{
        id: 'binding-kbd-001', track_id: 'extension-kbd-1',
        main_segment_ids: ['main-kbd-001'], extension_segment_ids: ['extension-kbd-001'],
        start_offset_ms: 50, end_offset_ms: -50,
      }],
    },
  };
  writeFileSync(projectPath, JSON.stringify(project), 'utf8');
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'kbd-timecode-locked-project.json',
    type: 'application/json',
    base64: readFileSync(projectPath).toString('base64'),
  }]);

  const mainText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text');
  await mainText.dblclick();
  await placeCaret(mainText, 4);
  await page.keyboard.press('Enter');

  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  // 主轨被 ⌚️ 时间码锚定：不可交互，初始焦点落到副 lane。
  const mainLane = page.locator('#multi-subtitle-split-main-text');
  await expect(mainLane).toHaveClass(/timestamp-locked/);
  const extensionLane = page.locator('#multi-subtitle-split-text');
  await expect(extensionLane).toBeFocused();

  // Tab 不把焦点切到主 lane；副 lane 仍可用 D 步进断点。
  await page.keyboard.press('Tab');
  await expect(mainLane).not.toBeFocused();
  const extensionActiveGap = extensionLane.locator('.multi-subtitle-split-gap.active');
  const startOffset = Number(await extensionActiveGap.getAttribute('data-offset'));
  await page.keyboard.press('d');
  expect(Number(await extensionActiveGap.getAttribute('data-offset'))).toBe(startOffset + 1);
  await page.keyboard.press('Escape');
});

function kbdProjectFileName(name) {
  return join(tempDir, name);
}

test('flashes the border and hints when moving a locked split lane', async ({ page }) => {
  const projectPath = kbdProjectFileName('kbd-locked-move-project.json');
  const project = {
    media: '', language: '', model: '',
    segments: [{ id: 'main-kbd-lock-001', start: 0, end: 2000, text: 'One two three.', items: [] }],
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{
        id: 'extension-kbd-lock-1', role: 'extension', name: 'Translation', language: '',
        split_mode: 'continuous', source_name: 'translation.srt',
        segments: [{ id: 'extension-kbd-lock-001', start: 50, end: 1950, text: '锁定移动测试文本' }],
      }],
      bindings: [{
        id: 'binding-kbd-lock-001', track_id: 'extension-kbd-lock-1',
        main_segment_ids: ['main-kbd-lock-001'], extension_segment_ids: ['extension-kbd-lock-001'],
        start_offset_ms: 50, end_offset_ms: -50,
      }],
    },
  };
  writeFileSync(projectPath, JSON.stringify(project), 'utf8');
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'kbd-locked-move-project.json',
    type: 'application/json',
    base64: readFileSync(projectPath).toString('base64'),
  }]);

  const mainText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text');
  await mainText.dblclick();
  await placeCaret(mainText, 4);
  await page.keyboard.press('Enter');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);

  const mainLane = page.locator('#multi-subtitle-split-main-text');
  await expect(mainLane).toBeFocused();
  await page.keyboard.press('Space');
  await expect(mainLane).toHaveClass(/locked/);

  // 锁定后按移动键：断点不动、边缘闪烁并出现解锁提示。
  const mainActiveGap = mainLane.locator('.multi-subtitle-split-gap.active');
  const lockedOffset = await mainActiveGap.getAttribute('data-offset');
  await page.keyboard.press('d');
  await expect(mainActiveGap).toHaveAttribute('data-offset', lockedOffset);
  await expect(mainLane).toHaveClass(/lane-move-blocked/);
  await expect(page.locator('#hint-stack')).toContainText('请先按空格解除锁定，然后再进行移动');
  await expect(mainLane).not.toHaveClass(/lane-move-blocked/);

  // 解锁后同一按键恢复移动。
  await page.keyboard.press('Space');
  await expect(mainLane).not.toHaveClass(/locked/);
  await page.keyboard.press('d');
  await expect(mainActiveGap).not.toHaveAttribute('data-offset', lockedOffset);
  await page.keyboard.press('Escape');
});

test('splits only the main subtitle and unbinds when the extension cannot be split', async ({ page }) => {
  const projectPath = kbdProjectFileName('kbd-main-only-fallback-project.json');
  const project = {
    media: '', language: '', model: '',
    segments: [{ id: 'main-kbd-fallback-001', start: 0, end: 2000, text: '主字幕可以正常拆分', items: [] }],
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{
        // 副字幕总时长 120ms < 200ms：无论怎么钳制都无法两侧各留 100ms。
        id: 'extension-kbd-fallback-1', role: 'extension', name: 'Translation', language: '',
        split_mode: 'continuous', source_name: 'translation.srt',
        segments: [{ id: 'extension-kbd-fallback-001', start: 940, end: 1060, text: '过短副字幕' }],
      }],
      bindings: [{
        id: 'binding-kbd-fallback-001', track_id: 'extension-kbd-fallback-1',
        main_segment_ids: ['main-kbd-fallback-001'], extension_segment_ids: ['extension-kbd-fallback-001'],
        start_offset_ms: 940, end_offset_ms: -940,
      }],
    },
  };
  writeFileSync(projectPath, JSON.stringify(project), 'utf8');
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'kbd-main-only-fallback-project.json',
    type: 'application/json',
    base64: readFileSync(projectPath).toString('base64'),
  }]);

  const mainText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text');
  await mainText.dblclick();
  // 光标放在第 5 个字符后：主字幕可以｜正常拆分。
  await placeCaret(mainText, 5);
  await page.keyboard.press('Enter');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);

  // 副字幕救不回来时不再阻塞：错误文案说明降级，拆分按钮保持可用。
  await expect(page.locator('#multi-subtitle-split-error'))
    .toContainText('确认后只拆分主字幕，并解除与副字幕的绑定');
  await expect(page.locator('#multi-subtitle-split-confirm')).toBeEnabled();
  await page.keyboard.press('Enter');

  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => DATA.segments.map((segment) => segment.text)))
    .toEqual(['主字幕可以', '正常拆分']);
  // 副字幕保持原样且已解绑。
  expect(await page.evaluate(() => ({
    bindings: DATA.multi_subtitle.bindings.length,
    extensionCount: DATA.multi_subtitle.tracks[0].segments.length,
  }))).toEqual({ bindings: 0, extensionCount: 1 });
  await expect(page.locator('.multi-cue-column.extension.unbound')).toHaveCount(1);
  await expect(page.locator('#hint-stack')).toContainText('为了拆分主字幕，已解除绑定');
});

test('focuses the main lane first when both lanes are interactive', async ({ page }) => {
  const projectPath = kbdProjectFileName('kbd-pointer-focus-project.json');
  const project = {
    media: '', language: '', model: '',
    segments: [{ id: 'main-kbd-focus-001', start: 0, end: 2000, text: 'One two three four.', items: [] }],
    waveform: generateWaveformPayload(2500),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{
        id: 'extension-kbd-focus-1', role: 'extension', name: 'Translation', language: '',
        split_mode: 'continuous', source_name: 'translation.srt',
        segments: [{ id: 'extension-kbd-focus-001', start: 50, end: 1950, text: '指针入口聚焦测试' }],
      }],
      bindings: [{
        id: 'binding-kbd-focus-001', track_id: 'extension-kbd-focus-1',
        main_segment_ids: ['main-kbd-focus-001'], extension_segment_ids: ['extension-kbd-focus-001'],
        start_offset_ms: 50, end_offset_ms: -50,
      }],
    },
  };
  writeFileSync(projectPath, JSON.stringify(project), 'utf8');
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'kbd-pointer-focus-project.json',
    type: 'application/json',
    base64: readFileSync(projectPath).toString('base64'),
  }]);

  // 波形右键「按音频位置拆分」入口没有文字光标位置；主轨可交互时应先聚焦主 lane。
  const mainBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  await mainBlock.click({ button: 'right', position: { x: 150, y: 10 } });
  await page.locator('#ctxmenu .item').filter({ hasText: '按音频位置拆分' }).click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-main-text')).toBeFocused();
  await page.keyboard.press('Escape');
});


test('keeps the dual-column index and timecode on the same header row', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const header = page.locator('.multi-dual-cue').first()
    .locator('.multi-cue-column.main .multi-cue-column-header');
  await expect(header.locator('.index')).toHaveText('主字幕 1');
  await expect(page.locator('.multi-dual-cue').first()
    .locator('.multi-cue-column.extension .multi-cue-column-header .index')).toHaveText('副字幕 1');
  const [indexBox, timeBox] = await Promise.all([
    header.locator('.index').boundingBox(),
    header.locator('.time').boundingBox(),
  ]);
  if (!indexBox || !timeBox) throw new Error('双列列头没有布局');
  expect(Math.abs((indexBox.y + indexBox.height / 2) - (timeBox.y + timeBox.height / 2))).toBeLessThan(4);
});

test('swaps main and extension subtitles from the gear menu and supports undo', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  await openMultiSubtitleSettings(page);
  await expect(page.locator('#multi-subtitle-swap')).toHaveCSS('border-style', 'solid');
  await expect(page.locator('#multi-subtitle-swap')).toHaveCSS('border-top-width', '1px');
  await page.locator('#multi-subtitle-swap').click();
  await expect(page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text'))
    .toHaveText('你好，世界。');
  await expect(page.locator('.multi-dual-cue').first().locator('.multi-cue-column.extension .text'))
    .toHaveText('Hello world.');

  await page.keyboard.press('Control+z');
  await expect(page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text'))
    .toHaveText('Hello world.');
  await expect(page.locator('.multi-dual-cue').first().locator('.multi-cue-column.extension .text'))
    .toHaveText('你好，世界。');
});

test('uses the maximum waveform row height while multiple subtitles are enabled and restores it', async ({ page }) => {
  await page.goto(server.url);
  await dropFiles(page, [srtSpec('main.srt', mainSrt)]);
  await expect(page.locator('#cues-container > .cue')).toHaveCount(2);

  await page.locator('#waveform-settings-toggle').click();
  await page.locator('#waveform-row-height').selectOption('64');
  await expect(page.locator('#waveform-row-height')).toHaveValue('64');
  await page.locator('#waveform-settings-toggle').click();

  await dropFiles(page, [srtSpec('translation.srt', extensionSrt)]);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await expect(page.locator('#multi-subtitle-extension-row-height')).toHaveValue('168');
  await expect(page.locator('#waveform-row-height')).toHaveValue('168');

  await openMultiSubtitleSettings(page);
  await page.locator('#multi-subtitle-extension-row-height').selectOption('144');
  await expect(page.locator('#waveform-row-height')).toHaveValue('144');

  await page.locator('#multi-subtitle-toggle').uncheck();
  await expect(page.locator('#waveform-row-height')).toHaveValue('64');
  await page.locator('#multi-subtitle-toggle').check();
  await expect(page.locator('#waveform-row-height')).toHaveValue('144');
});

test('auto-binds the earliest unbound main cue when an extension overlaps several cues', async ({ page }) => {
  const projectPath = join(tempDir, 'binding-overlap-project.json');
  const project = {
    media: '', language: 'English', model: '',
    segments: [
      { id: 'main-001', start: 1000, end: 1400, text: 'Main one', items: [] },
      { id: 'main-002', start: 1500, end: 2500, text: 'Main two', items: [] },
      { id: 'main-003', start: 2600, end: 3200, text: 'Main three', items: [] },
    ],
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'Translation', language: '', source_name: 'translation.srt',
        split_mode: 'word',
        segments: [
          { id: 'extension-001', start: 1050, end: 1150, text: 'Already bound' },
          { id: 'extension-002', start: 1200, end: 1400, text: 'Replace me' },
          { id: 'extension-004', start: 1600, end: 2800, text: 'Multi overlap' },
          { id: 'extension-003', start: 3100, end: 3900, text: 'Auto bind me' },
        ],
      }],
      bindings: [{
        id: 'binding-001', track_id: 'extension-1',
        main_segment_ids: ['main-001'], extension_segment_ids: ['extension-001'],
        start_offset_ms: 100, end_offset_ms: -100,
      }],
    },
  };
  writeFileSync(projectPath, JSON.stringify(project), 'utf8');
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'binding-overlap-project.json',
    type: 'application/json',
    base64: readFileSync(projectPath).toString('base64'),
  }]);
  await openMultiSubtitleSettings(page);
  await page.locator('#multi-subtitle-auto-sync-duration').uncheck();
  await page.locator('#multi-subtitle-settings-toggle').click();
  await page.keyboard.press('Control+d');

  const autoExtension = page.locator('.multi-cue-column.extension').filter({ hasText: 'Auto bind me' });
  await autoExtension.click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: '绑定到主字幕' }).click();
  await expect(autoExtension).not.toHaveClass(/unbound/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+d');

  const multiOverlapExtension = page.locator('.multi-cue-column.extension').filter({ hasText: 'Multi overlap' });
  await multiOverlapExtension.click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: '绑定到主字幕' }).click();
  await expect(multiOverlapExtension).not.toHaveClass(/unbound/);
  await expect(page.locator('#hint-stack')).toContainText('时间最早的未绑定主字幕');
  await expect(
    multiOverlapExtension.locator('xpath=ancestor::div[contains(@class,"multi-dual-cue")]')
      .locator('.multi-cue-column.main .text'),
  ).toHaveText('Main two');
  await page.keyboard.press('Control+d');

  const replaceExtension = page.locator('.multi-cue-column.extension').filter({ hasText: 'Replace me' });
  const mainOne = page.locator('.multi-cue-column.main').filter({ hasText: 'Main one' });
  await replaceExtension.click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: '绑定到主字幕' }).click();
  await expect(page.locator('#hint-stack')).toContainText('已有绑定');
  await mainOne.click();
  await expect(replaceExtension).not.toHaveClass(/unbound/);
  await expect(page.locator('.multi-cue-column.extension').filter({ hasText: 'Already bound' }))
    .toHaveClass(/unbound/);
});

test('uses B on a single selected extension cue to open the extension split dialog', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  await page.locator('.multi-dual-cue').first().locator('.multi-cue-column.extension').click();
  await page.keyboard.press('b');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择副字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-confirm')).toHaveText('拆分（Enter / B）');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeHidden();
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(3);
  await page.locator('#multi-subtitle-split-auto-submit').uncheck();
  await page.locator('#multi-subtitle-split-text .multi-subtitle-split-gap').first()
    .evaluate((element) => element.click());
  await page.keyboard.press('b');
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(4);
});

test('uses B on a waveform-selected extension cue instead of its overlapping main cue', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-waveform-001', start: 1000, end: 3000, text: 'main cue' }],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-waveform-1', role: 'extension', name: 'English', language: 'English',
        split_mode: 'word', segments: [{
          id: 'extension-waveform-001', start: 1100, end: 2900, text: 'extension cue',
        }],
      }],
      bindings: [{
        id: 'binding-waveform-001', track_id: 'extension-waveform-1',
        main_segment_ids: ['main-waveform-001'],
        extension_segment_ids: ['extension-waveform-001'],
        start_offset_ms: 100, end_offset_ms: -100,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'waveform-selected-extension-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  const extensionBox = await waitForLayoutBox(extensionBlock, '副字幕波形块没有布局');
  const mainBefore = await page.evaluate(() => DATA.segments.map((segment) => [segment.start, segment.end]));
  await page.mouse.click(
    extensionBox.x + extensionBox.width / 2,
    extensionBox.y + extensionBox.height / 2,
  );
  await expect(extensionBlock).toHaveClass(/selected/);
  await page.keyboard.press('b');

  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择副字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeHidden();
  expect(await page.evaluate(() => DATA.segments.map((segment) => [segment.start, segment.end])))
    .toEqual(mainBefore);
  await page.keyboard.press('Escape');
});

test('uses B on a waveform-selected unbound extension cue instead of an overlapping main cue', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-unbound-waveform-001', start: 1000, end: 3000, text: 'main cue' }],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-unbound-waveform-1', role: 'extension', name: 'English', language: 'English',
        split_mode: 'word', segments: [{
          id: 'extension-unbound-waveform-001', start: 1100, end: 2900, text: 'unbound extension',
        }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'waveform-selected-unbound-extension-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  const extensionBox = await waitForLayoutBox(extensionBlock, '未绑定副字幕波形块没有布局');
  const mainBefore = await page.evaluate(() => DATA.segments.map((segment) => [segment.start, segment.end]));
  await page.mouse.click(
    extensionBox.x + extensionBox.width / 2,
    extensionBox.y + extensionBox.height / 2,
  );
  await expect(extensionBlock).toHaveClass(/selected/);
  await page.keyboard.press('b');

  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择副字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeHidden();
  expect(await page.evaluate(() => DATA.segments.map((segment) => [segment.start, segment.end])))
    .toEqual(mainBefore);
  await page.keyboard.press('Escape');
});

test('uses the linked split dialog when the main cue is active with its bound extension selected', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  await page.locator('#editor-settings-toggle').click();
  await page.locator('#split-use-word-timestamps').uncheck();
  await page.locator('#editor-settings-toggle').click();

  const mainColumn = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main');
  await mainColumn.click();
  await expect(page.locator('#sel-count')).toHaveText('2');
  await page.keyboard.press('b');

  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('分别选择主字幕和副字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeVisible();
  await expect(page.locator('#multi-subtitle-split-extension-lane')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('retries a short linked split with B before forcing both tracks to 100ms', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await page.evaluate(() => {
    const main = DATA.segments[0];
    main.start = 1000;
    main.end = 5000;
    main.text = 'Alpha Bravo';
    main.items = [
      { start: 1000, end: 1050, text: 'Alpha' },
      { start: 1050, end: 5000, text: 'Bravo' },
    ];
    const extension = DATA.multi_subtitle.tracks[0].segments[0];
    extension.start = 1000;
    extension.end = 5000;
    extension.text = 'One Two';
    extension.items = [
      { start: 1000, end: 1050, text: 'One' },
      { start: 1050, end: 5000, text: 'Two' },
    ];
    renderAll({ waveform: 'none' });
  });

  const mainText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text');
  await mainText.dblclick();
  await mainText.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 5);
    range.setEnd(node, 5);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);

  await page.keyboard.press('b');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect.poll(() => page.evaluate(() => DATA.segments.length)).toBe(2);
  await expect(page.locator('.hint-card.hint-warning', {
    hasText: '请再次按 B 或 Enter 强制拆分',
  })).toBeVisible();

  await page.keyboard.press('b');
  await expect.poll(() => page.locator('.multi-dual-cue').count()).toBe(4);
  expect(await page.evaluate(() => ({
    main: DATA.segments.slice(0, 2).map((segment) => segment.end - segment.start),
    extension: DATA.multi_subtitle.tracks[0].segments.slice(0, 2)
      .map((segment) => segment.end - segment.start),
  }))).toEqual({ main: [100, 3900], extension: [100, 3900] });
});

test('shows unbind in a bound main subtitle context menu', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const main = page.locator('.multi-cue-column.main').filter({ hasText: 'Hello world.' });
  await main.click({ button: 'right' });
  const unbind = page.locator('#ctxmenu .item > span').filter({ hasText: /^解绑$/ }).locator('..');
  await expect(unbind).toBeVisible();
  await expect(unbind.locator('kbd')).toHaveText('Shift+G');
  await unbind.click();
  await expect(page.locator('.waveform-binding-marker')).toHaveCount(0);
  expect(await page.evaluate(() => DATA.multi_subtitle.bindings)).toHaveLength(1);
});

test('applies Subtitle Ninja feedback after a linked split-modal split', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ ninjaMode: true }));
  });
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main').click();
  await page.keyboard.press('b');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-split-auto-submit').uncheck();
  await page.locator('#multi-subtitle-split-main-text .multi-subtitle-split-gap').first()
    .evaluate((element) => element.click());
  await page.locator('#multi-subtitle-split-text .multi-subtitle-split-gap').first()
    .evaluate((element) => element.click());
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#ninja-slash-flash')).toHaveClass(/show/);
});

test('keeps the subtitle-list caret position as the linked main split point', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#split-use-word-timestamps').uncheck();
  await page.locator('#editor-settings-toggle').click();

  await page.evaluate(() => {
    const main = DATA.segments[0];
    main.text = '那更加离谱的就是这颗卫星上搭载了一颗';
    main.items = [
      { text: '那更加离谱的就是这', start: main.start, end: 1000 },
      { text: '颗卫星上搭载了一颗', start: 1000, end: main.end },
    ];
    DATA.multi_subtitle.main_split_mode = 'continuous';
    renderAll({ waveform: 'none' });
  });

  const mainText = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.main .text');
  await mainText.click();
  const splitPoint = await mainText.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 8); // 「就是｜这颗」
    range.setEnd(node, 8);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(splitPoint.x, splitPoint.y);
  await page.keyboard.press('b');

  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  const activeGap = page.locator('#multi-subtitle-split-main-text .multi-subtitle-split-gap.active');
  await expect(activeGap).toHaveAttribute('data-offset', '8');
  await expect(activeGap).toHaveCSS('opacity', '1');
  expect(await activeGap.evaluate((gap) => getComputedStyle(gap, '::before').content)).toBe('"✂️"');
  await expect(page.locator('#multi-subtitle-split-main-text')).not.toHaveClass(/timestamp-locked/);
  await page.keyboard.press('Escape');
});

test('binds an unbound extension cue directly from its context menu', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const mainCue = page.locator('.multi-cue-column.main .text').filter({ hasText: 'Hello world.' });
  const unboundExtension = page.locator('.multi-cue-column.extension').filter({ hasText: 'unmatched' });
  await expect(unboundExtension).toHaveCount(1);
  await expect(unboundExtension).toHaveClass(/unbound/);
  await mainCue.click();
  await expect(page.locator('#sel-count')).toHaveText('2');
  await page.evaluate(() => {
    window.__mawWaveformDraws = 0;
    const contextPrototype = window.CanvasRenderingContext2D.prototype;
    if (!contextPrototype.__mawOriginalFillRect) {
      contextPrototype.__mawOriginalFillRect = contextPrototype.fillRect;
      contextPrototype.fillRect = function (...args) {
        window.__mawWaveformDraws += 1;
        return contextPrototype.__mawOriginalFillRect.apply(this, args);
      };
    }
  });
  await unboundExtension.click({ button: 'right' });
  await expect(page.locator('#sel-count')).toHaveText('2');
  await page.locator('#ctxmenu .item').filter({ hasText: '与选中的主字幕绑定' }).click();

  await expect(unboundExtension).not.toHaveClass(/unbound/);
  expect(await page.evaluate(() => window.__mawWaveformDraws)).toBe(0);

  await unboundExtension.click({ button: 'right' });
  await page.locator('#ctxmenu .item > span').filter({ hasText: /^解绑$/ }).locator('..').click();
  await expect(unboundExtension).toHaveClass(/unbound/);
  expect(await page.evaluate(() => window.__mawWaveformDraws)).toBe(0);
});

test('uses G to bind a single extension cue and labels extension context shortcuts', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const mainCue = page.locator('.multi-cue-column.main .text').filter({ hasText: 'Hello world.' });
  const unboundExtension = page.locator('.multi-cue-column.extension').filter({ hasText: 'unmatched' });
  await unboundExtension.click({ button: 'right' });
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '在鼠标位置拆分' }).locator('kbd'))
    .toHaveText('B');
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '绑定到主字幕' }).locator('kbd'))
    .toHaveText('G');
  await page.keyboard.press('Escape');

  await openMultiSubtitleSettings(page);
  await page.locator('#multi-subtitle-select-bound-pair').uncheck();
  await page.locator('#multi-subtitle-settings-toggle').click();
  await mainCue.click();
  await unboundExtension.click({ modifiers: ['Control'] });
  await page.keyboard.press('g');
  await expect(unboundExtension).not.toHaveClass(/unbound/);

  await unboundExtension.click({ button: 'right' });
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '对齐主字幕时间范围' }).locator('kbd'))
    .toHaveText('H');
  await expect(page.locator('#ctxmenu .item > span').filter({ hasText: /^解绑$/ }).locator('..').locator('kbd'))
    .toHaveText('Shift+G');
  await page.keyboard.press('Escape');

  await unboundExtension.click();
  await page.keyboard.press('h');
  await expect(unboundExtension.locator('.time')).toHaveText('00:00.000 → 00:02.000');
  await page.keyboard.press('Shift+G');
  await expect(unboundExtension).toHaveClass(/unbound/);
});

test('normal extension clicks replace stale main selection with the clicked binding', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const mainOne = page.locator('.multi-cue-column.main .text').filter({ hasText: 'Hello world.' });
  const extensionTwo = page.locator('.multi-cue-column.extension').filter({ hasText: '第二句。' });
  const unmatchedExtension = page.locator('.multi-cue-column.extension').filter({ hasText: 'unmatched' });

  await mainOne.click();
  await expect(page.locator('#sel-count')).toHaveText('2');
  expect(await page.evaluate(() => [...window.MAWE_EDITOR_BRIDGE.selectedIdxs])).toEqual([0]);

  // 普通点击已绑定副字幕时，旧主字幕必须被替换为该副字幕实际绑定的主字幕。
  await extensionTwo.click();
  await expect(page.locator('#cue-panel-target')).toHaveText('副字幕');
  await expect(page.locator('#sel-count')).toHaveText('2');
  expect(await page.evaluate(() => [...window.MAWE_EDITOR_BRIDGE.selectedIdxs])).toEqual([1]);

  // 普通点击未绑定副字幕时，不应保留任何旧主字幕；G 不能因此误替换主字幕 2 的绑定。
  await unmatchedExtension.click();
  await expect(page.locator('#sel-count')).toHaveText('1');
  expect(await page.evaluate(() => [...window.MAWE_EDITOR_BRIDGE.selectedIdxs])).toEqual([]);
  await page.keyboard.press('g');
  await expect(page.locator('#hint-stack')).toContainText('请点击一条主字幕完成绑定');
  const extensionIds = await page.evaluate(() => Object.fromEntries(
    DATA.multi_subtitle.tracks[0].segments.map((segment) => [segment.text, segment.id]),
  ));
  expect(await page.evaluate(() => DATA.multi_subtitle.bindings.map((binding) => ({
    main: binding.main_segment_ids,
    extension: binding.extension_segment_ids,
  })))).toEqual([
    { main: ['main-001'], extension: [extensionIds['你好，世界。']] },
    { main: ['main-002'], extension: [extensionIds['第二句。']] },
  ]);
  await page.keyboard.press('Escape');
});

test('waits for a main cue when binding starts without a selected main cue', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const mainCue = page.locator('.multi-cue-column.main').filter({ hasText: 'Hello world.' });
  const unboundExtension = page.locator('.multi-cue-column.extension').filter({ hasText: 'unmatched' });
  await unboundExtension.click({ button: 'right' });
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '绑定到主字幕' })).toBeVisible();
  await page.locator('#ctxmenu .item').filter({ hasText: '绑定到主字幕' }).click();
  await expect(page.locator('#hint-stack')).toContainText('请点击一条主字幕完成绑定');
  await page.keyboard.press('Escape');
  await expect(page.locator('#hint-stack')).toContainText('已取消绑定扩展字幕');

  await unboundExtension.click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: '绑定到主字幕' }).click();
  await mainCue.click();
  await expect(unboundExtension).not.toHaveClass(/unbound/);
});

test('disables rebinding until the existing extension binding is removed', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const boundExtension = page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。' });
  await boundExtension.click({ button: 'right' });
  const rebinding = page.locator('#ctxmenu .item').filter({ hasText: '重新绑定需先解绑' });
  await expect(rebinding).toHaveClass(/disabled/);
  await expect(rebinding).toHaveAttribute('aria-disabled', 'true');
  await rebinding.click();
  await expect(boundExtension).not.toHaveClass(/unbound/);
});

test('merges selected extension cues from the context menu and C, with undo', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const first = page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。' });
  const second = page.locator('.multi-cue-column.extension').filter({ hasText: '第二句。' });
  await page.locator('.multi-cue-column.main').filter({ hasText: 'Hello world.' }).click();
  await first.click();
  await second.click({ modifiers: ['Control'] });
  await expect(page.locator('#sel-count')).toHaveText('4');
  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 0.5;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator('#overlay-extension-text')).toHaveText('你好，世界。');
  await second.click({ button: 'right' });
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '合并副字幕块' })).toBeVisible();
  await page.locator('#ctxmenu .item').filter({ hasText: '合并副字幕块' }).click();
  await expect(page.locator('#overlay-extension-text')).toHaveText('你好，世界。第二句。');
  await expect(page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。第二句。' })).toHaveCount(1);
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(2);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(3);

  await page.locator('.multi-cue-column.main').filter({ hasText: 'Hello world.' }).click();
  await page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。' }).click();
  await page.locator('.multi-cue-column.extension').filter({ hasText: '第二句。' }).click({ modifiers: ['Control'] });
  await page.keyboard.press('c');
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(3);
});

test('hides the extension preview while the playhead is in its timing gap', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 0.5;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator('#overlay-main-text')).toHaveText('Hello world.');
  await expect(page.locator('#overlay-extension-text')).toHaveText('你好，世界。');

  await page.evaluate(() => {
    const player = document.getElementById('player');
    player.currentTime = 2.5;
    player.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator('#overlay-main-text')).toHaveClass(/hidden/);
  await expect(page.locator('#overlay-extension-text')).toHaveClass(/hidden/);
  await expect(page.locator('#overlay')).toHaveClass(/hidden/);
});

test('keeps extension selection, timing, disabled, and hide shortcuts in parity with main cues', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const extensionColumn = page.locator('.multi-dual-cue').first().locator('.multi-cue-column.extension');
  await extensionColumn.click();
  const originalStart = await page.evaluate(() => (
    DATA.multi_subtitle.tracks[0].segments[0].start
  ));
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => (
    DATA.multi_subtitle.tracks[0].segments[0].start
  ))).toBe(originalStart + 50);
  await page.keyboard.press('Control+ArrowLeft');
  await expect.poll(() => page.evaluate(() => (
    DATA.multi_subtitle.tracks[0].segments[0].start
  ))).toBe(originalStart);

  await page.keyboard.press('Control+a');
  await expect(page.locator('#sel-count')).toHaveText('5');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sel-count')).toHaveText('0');

  await extensionColumn.click({ modifiers: ['Alt'] });
  await expect(extensionColumn).toHaveClass(/disabled/);
  const saved = await page.evaluate(() => JSON.parse(buildJson()));
  expect(saved.multi_subtitle.tracks[0].segments[0].disabled).toBe(true);

  await page.locator('#cue-list-settings-toggle').click();
  await page.locator('#hide-disabled-toggle').check();
  await expect(extensionColumn).toBeHidden();
  await page.locator('#hide-disabled-toggle').uncheck();
  await page.locator('#cue-list-settings-toggle').click();
  await extensionColumn.click({ modifiers: ['Alt'] });
  await expect(extensionColumn).not.toHaveClass(/disabled/);
});

test('Shift+arrow snaps selected main and secondary cues in multiple-subtitle mode', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  await page.evaluate(() => {
    DATA.segments[0].end = 2500;
    DATA.segments[1].start = 3000;
    const extension = DATA.multi_subtitle.tracks[0].segments;
    extension[0].end = 2400;
    extension[1].start = 3000;
    renderAll();
  });

  await page.locator('.multi-cue-column.main').filter({ hasText: 'Second line.' }).click();
  await expect(page.locator('#cue-panel-target')).toHaveText('主字幕');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => page.evaluate(() => DATA.segments[1].start)).toBe(2500);

  await page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。' }).click();
  await expect(page.locator('#cue-panel-target')).toHaveText('副字幕');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => page.evaluate(() => (
    DATA.multi_subtitle.tracks[0].segments[0].end
  ))).toBe(3000);
});

test('选中的主字幕与绑定副字幕一起合并并支持撤销', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await openMultiSubtitleSettings(page);
  await expect(page.locator('#multi-subtitle-auto-sync-duration')).toBeChecked();
  await page.locator('#multi-subtitle-settings-toggle').click();

  const first = page.locator('.multi-cue-column.main').filter({ hasText: 'Hello world.' });
  const second = page.locator('.multi-cue-column.main').filter({ hasText: 'Second line.' });
  await first.click();
  await second.click({ modifiers: ['Control'] });
  await page.keyboard.press('c');

  await expect(page.locator('.multi-dual-cue')).toHaveCount(2);
  const merged = page.locator('.multi-dual-cue').filter({ hasText: 'Hello world.' });
  await expect(merged.locator('.multi-cue-column.main .time')).toHaveText('00:00.000 → 00:05.000');
  await expect(merged.locator('.multi-cue-column.extension .time')).toHaveText('00:00.000 → 00:05.000');
  expect(await page.evaluate(() => DATA.multi_subtitle.bindings.map((binding) => ({
    start: binding.start_offset_ms,
    end: binding.end_offset_ms,
  })))).toEqual([{ start: 0, end: 0 }]);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.multi-dual-cue')).toHaveCount(3);
  await expect(page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。' })).toHaveCount(1);
  await expect(page.locator('.multi-cue-column.extension').filter({ hasText: '第二句。' })).toHaveCount(1);
});

test('ignores a tiny unbound extension overlap at the main merge boundary', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 1000, end: 2000, text: '主字幕一', items: [] },
      { id: 'main-002', start: 2000, end: 3000, text: '主字幕二', items: [] },
    ],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'en', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [
          { id: 'extension-001', start: 1100, end: 1900, text: '已绑定副字幕' },
          { id: 'extension-002', start: 2990, end: 3990, text: '边界副字幕' },
        ],
      }],
      bindings: [{
        id: 'binding-001', track_id: 'extension-1',
        main_segment_ids: ['main-001'], extension_segment_ids: ['extension-001'],
        start_offset_ms: 100, end_offset_ms: -100,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'tiny-merge-overlap-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  // 该用例验证未绑定的微小边界重叠仍被保留；关闭自动同步，
  // 避免把新的“绑定后按 H 整理冲突”语义混入本用例。
  await openMultiSubtitleSettings(page);
  await page.locator('#multi-subtitle-auto-sync-duration').uncheck();
  await page.locator('#multi-subtitle-settings-toggle').click();

  await page.locator('.multi-cue-column.main').filter({ hasText: '主字幕一' }).click();
  await page.locator('.multi-cue-column.main').filter({ hasText: '主字幕二' }).click({ modifiers: ['Control'] });
  await page.keyboard.press('c');

  expect(await page.evaluate(() => DATA.multi_subtitle.tracks[0].segments.map((segment) => ({
    id: segment.id,
    start: segment.start,
    end: segment.end,
    text: segment.text,
  })))).toEqual([
    { id: 'extension-001-merged', start: 1100, end: 1900, text: '已绑定副字幕' },
    { id: 'extension-002', start: 2990, end: 3990, text: '边界副字幕' },
  ]);
});

test('拼合主字幕时同步延展绑定副字幕并支持撤销', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 0, end: 1000, text: '第一句', items: [] },
      { id: 'main-002', start: 1100, end: 2000, text: '第二句', items: [] },
    ],
    waveform: generateWaveformPayload(3000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'en', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [
          { id: 'extension-001', start: 50, end: 950, text: 'first' },
          { id: 'extension-002', start: 1150, end: 1950, text: 'second' },
        ],
      }],
      bindings: [
        {
          id: 'binding-001', track_id: 'extension-1',
          main_segment_ids: ['main-001'], extension_segment_ids: ['extension-001'],
          start_offset_ms: 50, end_offset_ms: -50,
        },
        {
          id: 'binding-002', track_id: 'extension-1',
          main_segment_ids: ['main-002'], extension_segment_ids: ['extension-002'],
          start_offset_ms: 50, end_offset_ms: -50,
        },
      ],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'auto-merge-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  await page.locator('#auto-merge-manage').click();
  await page.locator('#auto-merge-gap-ms').fill('200');
  await page.locator('#auto-merge-absorb-short').uncheck();
  await page.locator('#auto-merge-run').click();

  const secondRow = page.locator('.multi-dual-cue').filter({ hasText: '第二句' });
  await expect(secondRow.locator('.multi-cue-column.main .time')).toHaveText('00:01.000 → 00:02.000');
  await expect(secondRow.locator('.multi-cue-column.extension .time')).toHaveText('00:01.050 → 00:01.950');

  await page.keyboard.press('Control+z');
  await expect(secondRow.locator('.multi-cue-column.main .time')).toHaveText('00:01.100 → 00:02.000');
  await expect(secondRow.locator('.multi-cue-column.extension .time')).toHaveText('00:01.150 → 00:01.950');

  await page.locator('#auto-merge-snap-direction').selectOption('forward');
  await page.locator('#auto-merge-run').click();
  const firstRow = page.locator('.multi-dual-cue').filter({ hasText: '第一句' });
  await expect(firstRow.locator('.multi-cue-column.main .time')).toHaveText('00:00.000 → 00:01.100');
  await expect(firstRow.locator('.multi-cue-column.extension .time')).toHaveText('00:00.050 → 00:01.050');
  await page.keyboard.press('Control+z');
});

test('shows independent extension preview controls with yellow defaults', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  await expect(page.locator('#extension-overlay-toggle-wrap')).toBeVisible();
  await expect(page.locator('#extension-overlay-toggle')).toBeChecked();
  await expect(page.locator('#overlay')).toHaveCSS('flex-direction', 'column');
  await expect(page.locator('#overlay')).toHaveCSS('gap', '0px');
  await page.locator('#subtitle-preview-settings-toggle').click();
  await expect(page.locator('#subtitle-preview-settings-panel')).toBeVisible();
  await expect(page.locator('#extension-subtitle-preview-settings')).toBeVisible();
  await expect(page.locator('#subtitle-color')).toHaveValue('#ffffff');
  await expect(page.locator('#extension-subtitle-color')).toHaveValue('#ffd34d');
  await expect(page.locator('#extension-subtitle-background-color')).toHaveValue('#000000');
  await page.locator('#extension-subtitle-font-size').selectOption('14');
  await expect(page.locator('#overlay-extension-text')).toHaveCSS('font-size', '14px');
  await page.locator('#extension-subtitle-background-color').evaluate((element) => {
    element.value = '#123456';
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#overlay-extension-text')).toHaveCSS('background-color', 'rgba(18, 52, 86, 0.65)');
  await page.locator('#extension-overlay-toggle').uncheck();
  await expect(page.locator('#extension-overlay-toggle')).not.toBeChecked();
});

test('refreshes local font options for both main and extension subtitles', async ({ page }) => {
  await page.addInitScript(() => {
    window.queryLocalFonts = async () => [
      { family: 'MAW Test Sans' },
      { family: 'MAW Test Serif' },
    ];
  });
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await page.locator('#subtitle-preview-settings-toggle').click();

  const scanButton = page.locator('#subtitle-font-family-scan');
  await expect(scanButton).toBeEnabled();
  await scanButton.click();
  await expect(page.locator('#subtitle-font-family option[value="MAW Test Sans"]')).toHaveCount(1);
  await expect(page.locator('#extension-subtitle-font-family option[value="MAW Test Sans"]')).toHaveCount(1);

  await page.locator('#subtitle-font-family').selectOption('MAW Test Sans');
  await page.locator('#extension-subtitle-font-family').selectOption('MAW Test Serif');
  const fontFamilies = await page.evaluate(() => ({
    main: document.getElementById('overlay-main-text').style.fontFamily,
    extension: document.getElementById('overlay-extension-text').style.fontFamily,
  }));
  expect(fontFamilies.main).toContain('MAW Test Sans');
  expect(fontFamilies.extension).toContain('MAW Test Serif');
});

test('aligns a bound extension cue to the main subtitle range from its context menu', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const row = page.locator('.multi-dual-cue').filter({ hasText: 'Hello world.' });
  const extensionColumn = row.locator('.multi-cue-column.extension');
  await expect(extensionColumn.locator('.time')).toHaveText('00:00.050 → 00:01.950');
  await extensionColumn.click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: '对齐主字幕时间范围' }).click();
  await expect(row.locator('.multi-cue-column.extension .time')).toHaveText('00:00.000 → 00:02.000');

  await page.keyboard.press('Control+z');
  await expect(row.locator('.multi-cue-column.extension .time')).toHaveText('00:00.050 → 00:01.950');
});

test('aligns multiple selected extension cues with H and undoes the batch once', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const first = page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。' });
  const second = page.locator('.multi-cue-column.extension').filter({ hasText: '第二句。' });
  await first.click();
  await second.click({ modifiers: ['Control'] });
  await expect(page.locator('#sel-count')).toHaveText('4');

  await page.keyboard.press('h');
  await expect(page.locator('#hint-stack')).toContainText('已批量对齐 2 条副字幕');
  await expect(first.locator('.time')).toHaveText('00:00.000 → 00:02.000');
  await expect(second.locator('.time')).toHaveText('00:03.000 → 00:05.000');

  await page.keyboard.press('Control+z');
  await expect(first.locator('.time')).toHaveText('00:00.050 → 00:01.950');
  await expect(second.locator('.time')).toHaveText('00:03.050 → 00:04.950');
});

test('keeps the main range fixed and removes a fully covered extension cue on H alignment', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 1000, end: 4000, text: '主字幕', items: [] },
      { id: 'main-002', start: 5000, end: 6000, text: '下一条主字幕', items: [] },
    ],
    waveform: generateWaveformPayload(8000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [
          { id: 'extension-001', start: 1100, end: 1900, text: 'bound extension' },
          { id: 'extension-002', start: 2500, end: 3000, text: 'overlapping extension' },
        ],
      }],
      bindings: [{
        id: 'binding-001', track_id: 'extension-1',
        main_segment_ids: ['main-001'], extension_segment_ids: ['extension-001'],
        start_offset_ms: 100, end_offset_ms: -2100,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'h-overlap-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const extension = page.locator('.multi-cue-column.extension').filter({ hasText: 'bound extension' });
  await extension.click();
  await page.keyboard.press('h');
  await expect(page.locator('#hint-stack')).toContainText('删除 1 条副字幕');
  expect(await page.evaluate(() => ({
    main: [DATA.segments[0].start, DATA.segments[0].end],
    extension: DATA.multi_subtitle.tracks[0].segments.map((segment) => [segment.start, segment.end]),
    bindings: DATA.multi_subtitle.bindings.map((binding) => binding.extension_segment_ids),
  }))).toEqual({
    main: [1000, 4000],
    extension: [[1000, 4000]],
    bindings: [['extension-001']],
  });
});

test('keeps the longer remaining side and restores extension time order after H alignment', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 2000, end: 3000, text: '主字幕', items: [] }],
    waveform: generateWaveformPayload(6000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [
          { id: 'extension-001', start: 1000, end: 4500, text: 'longer remaining side' },
          { id: 'extension-002', start: 5000, end: 5500, text: 'bound extension' },
        ],
      }],
      bindings: [{
        id: 'binding-001', track_id: 'extension-1',
        main_segment_ids: ['main-001'], extension_segment_ids: ['extension-002'],
        start_offset_ms: 3000, end_offset_ms: 2500,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'h-order-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  await page.locator('.multi-cue-column.extension').filter({ hasText: 'bound extension' }).click();
  await page.keyboard.press('h');
  await expect(page.locator('#hint-stack')).toContainText('挤压 1 条副字幕');
  expect(await page.evaluate(() => ({
    extension: DATA.multi_subtitle.tracks[0].segments.map((segment) => [segment.id, segment.start, segment.end]),
    bindings: DATA.multi_subtitle.bindings.map((binding) => binding.extension_segment_ids),
  }))).toEqual({
    extension: [
      ['extension-002', 2000, 3000],
      ['extension-001', 3000, 4500],
    ],
    bindings: [['extension-002']],
  });
});

test('keeps the main range fixed when its extension follower hits another extension cue', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 1000, end: 3000, text: '主字幕', items: [] }],
    waveform: generateWaveformPayload(6000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [
          { id: 'extension-001', start: 1000, end: 2000, text: 'bound extension' },
          { id: 'extension-002', start: 2500, end: 4000, text: 'blocking extension' },
        ],
      }],
      bindings: [{
        id: 'binding-001', track_id: 'extension-1',
        main_segment_ids: ['main-001'], extension_segment_ids: ['extension-001'],
        start_offset_ms: 0, end_offset_ms: -1000,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'main-follower-overlap-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const mainBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  const handle = mainBlock.locator('.waveform-cue-handle.right');
  const row = mainBlock.locator('xpath=ancestor::*[contains(@class, "waveform-row")]');
  const [handleBox, rowBox, rowStart, rowEnd] = await Promise.all([
    handle.boundingBox(),
    row.boundingBox(),
    row.getAttribute('data-start-ms'),
    row.getAttribute('data-end-ms'),
  ]);
  if (!handleBox || !rowBox || rowStart == null || rowEnd == null) {
    throw new Error('主字幕右边界没有有效波形布局');
  }
  const targetMs = 3800;
  const targetX = rowBox.x + ((targetMs - Number(rowStart)) / (Number(rowEnd) - Number(rowStart))) * rowBox.width;
  const centerY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(handleBox.x + handleBox.width / 2, centerY);
  await page.mouse.down();
  await page.mouse.move(targetX, centerY, { steps: 4 });
  await page.mouse.up();

  await expect(page.locator('#hint-stack')).toContainText('挤压 1 条副字幕');
  const timing = await page.evaluate(() => ({
    main: [DATA.segments[0].start, DATA.segments[0].end],
    extension: DATA.multi_subtitle.tracks[0].segments.map((segment) => [segment.start, segment.end]),
  }));
  expect(timing.main[0]).toBe(1000);
  expect(timing.main[1]).toBeGreaterThan(3000);
  expect(timing.extension[0][0]).toBe(1000);
  expect(timing.extension[0][1]).toBe(timing.extension[1][0]);
  expect(timing.extension[1][1]).toBe(4000);
  expect(timing.extension[0][1]).toBe(timing.main[1] - 1000);
});

test('lets an extension drag move only the extension cue beyond the main-track boundary', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 1000, end: 3000, text: '主字幕', items: [] },
      { id: 'main-002', start: 3200, end: 5000, text: '下一条主字幕', items: [] },
    ],
    waveform: generateWaveformPayload(6000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [{ id: 'extension-001', start: 1000, end: 2000, text: 'bound extension' }],
      }],
      bindings: [{
        id: 'binding-001', track_id: 'extension-1',
        main_segment_ids: ['main-001'], extension_segment_ids: ['extension-001'],
        start_offset_ms: 0, end_offset_ms: -1000,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'extension-boundary-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const block = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  const handle = block.locator('.waveform-cue-handle.right');
  const row = block.locator('xpath=ancestor::*[contains(@class, "waveform-row")]');
  const [handleBox, rowBox, rowStart, rowEnd] = await Promise.all([
    handle.boundingBox(),
    row.boundingBox(),
    row.getAttribute('data-start-ms'),
    row.getAttribute('data-end-ms'),
  ]);
  if (!handleBox || !rowBox || rowStart == null || rowEnd == null) {
    throw new Error('副字幕右边界没有有效波形布局');
  }
  const targetMs = 4000;
  const targetX = rowBox.x + ((targetMs - Number(rowStart)) / (Number(rowEnd) - Number(rowStart))) * rowBox.width;
  const centerY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(handleBox.x + handleBox.width / 2, centerY);
  await page.mouse.down();
  await page.mouse.move(targetX, centerY, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => page.evaluate(() => [DATA.segments[0].start, DATA.segments[0].end]))
    .toEqual([1000, 3000]);
  const timing = await page.evaluate(() => ({
    main: [DATA.segments[0].start, DATA.segments[0].end],
    extension: [DATA.multi_subtitle.tracks[0].segments[0].start, DATA.multi_subtitle.tracks[0].segments[0].end],
  }));
  expect(timing.main).toEqual([1000, 3000]);
  expect(timing.extension[0]).toBe(1000);
  expect(timing.extension[1]).toBeGreaterThan(3000);
  await expect(page.locator('#hint-stack')).not.toContainText('限制副字幕拖动');
});

test('opens the extension-only split dialog from the waveform context menu and undoes it', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 1000, end: 3000, text: 'Main sentence.', items: [] },
    ],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: '中文', language: 'zh', split_mode: 'continuous',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-001', start: 1050, end: 2950, text: '这是一条拓展字幕。' }],
      }],
      bindings: [{
        id: 'binding-001', track_id: 'extension-1',
        main_segment_ids: ['main-001'], extension_segment_ids: ['extension-001'],
        start_offset_ms: 50, end_offset_ms: -50,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'extension-split-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  await expect(extensionBlock).toBeVisible();
  await extensionBlock.click({ button: 'right', position: { x: 150, y: 10 } });
  await page.locator('#ctxmenu .item').filter({ hasText: '在鼠标位置拆分' }).click();

  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择副字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeHidden();
  await expect(page.locator('#multi-subtitle-split-preview')).toContainText(' / ');
  await expect(page.locator('#multi-subtitle-split-preview')).toContainText('副：');
  await expect(page.locator('#multi-subtitle-split-preview')).not.toContainText('✂️');
  await expect(page.locator('#multi-subtitle-split-auto-submit')).toBeChecked();
  await page.locator('#multi-subtitle-split-text .multi-subtitle-split-gap').first().evaluate((element) => element.click());
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await expect(page.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(2);
  await expect(page.locator('.multi-cue-column.extension.unbound')).toHaveCount(2);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(1);
  await expect(page.locator('.multi-cue-column.extension.unbound')).toHaveCount(0);
});

test('renders one scissors marker per word-space split and trims the split text', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-word-001', start: 1000, end: 3000, text: '主字幕' }],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-word-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-word-001', start: 1000, end: 3000, text: 'A B C' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'word-split-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  await expect(extensionBlock).toBeVisible();
  await extensionBlock.click({ button: 'right', position: { x: 120, y: 10 } });
  await page.locator('#ctxmenu .item').filter({ hasText: '在鼠标位置拆分' }).click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  const splitText = page.locator('#multi-subtitle-split-text');
  await expect(splitText.locator('.multi-subtitle-split-gap')).toHaveCount(2);
  expect(await splitText.evaluate((element) => element.textContent)).toBe('A B C');
  expect(await splitText.locator('.multi-subtitle-split-gap').evaluateAll((gaps) => gaps.map((gap) => ({
    text: gap.textContent,
    active: gap.classList.contains('active'),
  })))).toEqual([
    { text: ' ', active: true },
    { text: ' ', active: false },
  ]);
  expect(await splitText.locator('.multi-subtitle-split-gap').first().evaluate((gap) => {
    const style = getComputedStyle(gap, '::before');
    return { content: style.content, color: style.color, opacity: style.opacity };
  })).toMatchObject({ content: '"✂️"', opacity: '1' });

  await splitText.locator('.multi-subtitle-split-gap').first().evaluate((element) => element.click());
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => DATA.multi_subtitle.tracks[0].segments.map((segment) => segment.text)))
    .toEqual(['A', 'B C']);
});

test('renders a scissors marker for a symbol-connected word split', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-symbol-001', start: 1000, end: 3000, text: '主字幕' }],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-symbol-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-symbol-001', start: 1000, end: 3000, text: 'the story—you' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'symbol-split-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  await extensionBlock.click({ button: 'right', position: { x: 120, y: 10 } });
  await page.locator('#ctxmenu .item').filter({ hasText: '在鼠标位置拆分' }).click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  const splitText = page.locator('#multi-subtitle-split-text');
  const gaps = splitText.locator('.multi-subtitle-split-gap');
  await expect(gaps).toHaveCount(3);
  expect(await splitText.evaluate((element) => element.textContent)).toBe('the story—you');
  expect(await gaps.evaluateAll((elements) => elements.map((gap) => ({
    offset: Number(gap.dataset.offset), text: gap.textContent,
  })))).toEqual([
    { offset: 4, text: ' ' },
    { offset: 9, text: '' },
    { offset: 10, text: '' },
  ]);
  const symbolGap = splitText.locator('.multi-subtitle-split-gap[data-offset="10"]');
  await expect(symbolGap).not.toHaveClass(/active/);
  const inactiveBox = await symbolGap.boundingBox();
  await symbolGap.hover();
  await expect(symbolGap).toHaveClass(/active/);
  const activeBox = await symbolGap.boundingBox();
  if (!inactiveBox || !activeBox) throw new Error('连接符断点没有可测量的布局盒子');
  expect(activeBox.width).toBeGreaterThan(inactiveBox.width * 2);
  expect(await symbolGap.evaluate((gap) => {
    const style = getComputedStyle(gap, '::before');
    return { content: style.content, opacity: style.opacity };
  })).toEqual({ content: '"✂️"', opacity: '1' });

  await symbolGap.evaluate((element) => element.click());
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => DATA.multi_subtitle.tracks[0].segments.map((segment) => segment.text)))
    .toEqual(['the story—', 'you']);
});

test('renders a post-period word split without dropping the period', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-period-001', start: 1000, end: 3000, text: '主字幕' }],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-period-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-period-001', start: 1000, end: 3000, text: 'quickly.And' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'period-split-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  await extensionBlock.click({ button: 'right', position: { x: 120, y: 10 } });
  await page.locator('#ctxmenu .item').filter({ hasText: '在鼠标位置拆分' }).click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  const splitText = page.locator('#multi-subtitle-split-text');
  const gaps = splitText.locator('.multi-subtitle-split-gap');
  await expect(gaps).toHaveCount(1);
  expect(await gaps.evaluateAll((elements) => elements.map((gap) => Number(gap.dataset.offset))))
    .toEqual([8]);
  expect(await splitText.evaluate((element) => element.textContent)).toBe('quickly.And');

  await gaps.first().click();
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => DATA.multi_subtitle.tracks[0].segments.map((segment) => segment.text)))
    .toEqual(['quickly.', 'And']);
});

test('renders one scissors marker for a continuous split across repeated spaces', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-continuous-001', start: 1000, end: 3000, text: '主字幕' }],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-continuous-1', role: 'extension', name: '中文', language: 'zh', split_mode: 'continuous',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-continuous-001', start: 1000, end: 3000, text: '甲  乙' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'continuous-split-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  await extensionBlock.click({ button: 'right', position: { x: 120, y: 10 } });
  await page.locator('#ctxmenu .item').filter({ hasText: '在鼠标位置拆分' }).click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  const splitText = page.locator('#multi-subtitle-split-text');
  await expect(splitText.locator('.multi-subtitle-split-gap')).toHaveCount(1);
  expect(await splitText.evaluate((element) => element.textContent)).toBe('甲  乙');
  expect(await splitText.locator('.multi-subtitle-split-gap').textContent()).toBe('  ');
  await expect(splitText.locator('.multi-subtitle-split-gap').first()).toHaveClass(/active/);
  expect(await splitText.locator('.multi-subtitle-split-gap').first().evaluate((gap) => {
    const style = getComputedStyle(gap, '::before');
    return { content: style.content, opacity: style.opacity };
  })).toEqual({ content: '"✂️"', opacity: '1' });

  await splitText.locator('.multi-subtitle-split-gap').first().evaluate((element) => element.click());
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => DATA.multi_subtitle.tracks[0].segments.map((segment) => segment.text)))
    .toEqual(['甲', '乙']);
});

test('keeps only the left text in the first main cue after a linked word split', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-word-linked-001', start: 1000, end: 5000, text: '说实话 那是因为确实如此' }],
    waveform: generateWaveformPayload(8000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      main_split_mode: 'word',
      tracks: [{
        id: 'extension-word-linked-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-word-linked-001', start: 1000, end: 5000, text: 'to be honest because it is.' }],
      }],
      bindings: [{
        id: 'binding-word-linked-001', track_id: 'extension-word-linked-1',
        main_segment_ids: ['main-word-linked-001'], extension_segment_ids: ['extension-word-linked-001'],
        start_offset_ms: 0, end_offset_ms: 0,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'linked-word-split-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const mainBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  await mainBlock.click({ button: 'right', position: { x: 150, y: 10 } });
  await page.locator('#ctxmenu .item').filter({ hasText: '按音频位置拆分' }).click();
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-split-auto-submit').uncheck();
  await page.locator('#multi-subtitle-split-main-text .multi-subtitle-split-gap').first().click();
  await page.locator('#multi-subtitle-split-text .multi-subtitle-split-gap').first().click();
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => DATA.segments.map((segment) => segment.text)))
    .toEqual(['说实话', '那是因为确实如此']);
});

test('offers extension cue creation on the empty extension lane and makes it undoable', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-001', start: 1000, end: 2000, text: '主字幕', items: [] },
    ],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-001', start: 1050, end: 1950, text: 'translation' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'extension-create-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  await page.locator('.multi-cue-column.extension').filter({ hasText: 'translation' }).click();
  await expect(page.locator('#cue-panel-target')).toHaveText('副字幕');
  const row = page.locator('.waveform-row.multi-subtitle-row').first();
  const box = await row.boundingBox();
  if (!box) throw new Error('双 lane 波形行没有布局');
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height - 2, { button: 'right' });
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '创建副字幕' })).toBeVisible();
  await page.locator('#ctxmenu .item').filter({ hasText: '创建副字幕' }).click();
  await expect(page.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(1);
});

test('uses the waveform lane to choose blank-area context-menu semantics', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-001', start: 1000, end: 3000, text: '主字幕', items: [] }],
    waveform: generateWaveformPayload(7000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-001', start: 4000, end: 5000, text: '副字幕' }],
      }],
      bindings: [],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'blank-lane-semantics-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const row = page.locator('.waveform-row.multi-subtitle-row').first();
  const box = await waitForLayoutBox(row, '双 lane 波形行没有布局');
  const rowStart = Number(await row.getAttribute('data-start-ms'));
  const rowEnd = Number(await row.getAttribute('data-end-ms'));
  const extensionBlock = await waitForLayoutBox(
    row.locator('.waveform-cue-block[data-track="extension"]').first(),
    '副字幕波形块没有布局',
  );
  const mainBlock = await waitForLayoutBox(
    row.locator('.waveform-cue-block[data-track="main"]').first(),
    '主字幕波形块没有布局',
  );
  if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd)) {
    throw new Error('双 lane 波形行没有有效布局');
  }
  const x = box.x + ((2000 - rowStart) / (rowEnd - rowStart)) * box.width;
  const extensionY = extensionBlock.y + extensionBlock.height / 2;

  // 右键落在副字幕 lane 的空白处时，创建动作按当前 lane 判定；两条轨道
  // 的拆分入口则按鼠标时间分别显示，当前没有对应字幕时置灰。
  await page.mouse.click(x, extensionY, { button: 'right' });
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '创建副字幕' })).toBeVisible();
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '按音频位置拆分主字幕' })).toBeVisible();
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '按音频位置拆分主字幕' })).not.toHaveClass(/disabled/);
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '按音频位置拆分副字幕' })).toHaveClass(/disabled/);
  await page.keyboard.press('Escape');

  // 同一行的主字幕 lane 空白处仍按主轨处理；两条轨道仍保留拆分入口，
  // 但当前位置没有字幕时不可用。
  const mainBlankX = box.x + ((3500 - rowStart) / (rowEnd - rowStart)) * box.width;
  const mainY = mainBlock.y + mainBlock.height / 2;
  await page.mouse.click(mainBlankX, mainY, { button: 'right' });
  const mainSplitItem = page.locator('#ctxmenu .item').filter({ hasText: '按音频位置拆分主字幕' });
  await expect(mainSplitItem).toHaveClass(/disabled/);
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '按音频位置拆分副字幕' })).toHaveClass(/disabled/);
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '创建字幕' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => DATA.segments.length)).toBe(1);
});

test('keeps one shared waveform background with two lanes, switch visibility, and Alt drag semantics', async ({ page }) => {
  const projectPath = join(tempDir, 'multi-project.json');
  const project = {
    segments: [
      { id: 'main-001', start: 1000, end: 2000, text: '主字幕一', items: [] },
      { id: 'main-002', start: 6000, end: 7000, text: '主字幕二', items: [] },
    ],
    waveform: generateWaveformPayload(10000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1',
        role: 'extension',
        name: 'English',
        language: 'English',
        split_mode: 'word',
        source_name: 'translation.srt',
        segments: [
          { id: 'extension-001', start: 1050, end: 1950, text: 'translation one' },
          { id: 'extension-002', start: 6050, end: 6950, text: 'translation two' },
        ],
      }],
      bindings: [
        {
          id: 'binding-001', track_id: 'extension-1',
          main_segment_ids: ['main-001'], extension_segment_ids: ['extension-001'],
          start_offset_ms: 50, end_offset_ms: -50,
        },
        {
          id: 'binding-002', track_id: 'extension-1',
          main_segment_ids: ['main-002'], extension_segment_ids: ['extension-002'],
          start_offset_ms: 50, end_offset_ms: -50,
        },
      ],
    },
  };
  writeFileSync(projectPath, JSON.stringify(project), 'utf8');
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'multi-project.json',
    type: 'application/json',
    base64: readFileSync(projectPath).toString('base64'),
  }]);

  await expect(page.locator('.waveform-row.multi-subtitle-row')).not.toHaveCount(0);
  await expect(page.locator('#multi-subtitle-waveform-controls')).toBeVisible();
  await expect(page.locator('.row-actions #multi-subtitle-bind')).toHaveCount(0);
  await expect(page.locator('.waveform-cue-block[data-track="main"]')).toHaveCount(2);
  await expect(page.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(2);

  const mainBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
  await page.keyboard.press('Control+d');
  await expect(mainBlock.locator('.waveform-binding-marker')).toHaveCount(0);
  await expect(extensionBlock.locator('.waveform-binding-marker')).toHaveCount(0);
  await page.locator('.multi-cue-column.main .text').first().click();
  await expect(mainBlock.locator('.waveform-binding-marker')).toHaveText('🔗');
  await expect(extensionBlock.locator('.waveform-binding-marker')).toHaveText('🔗');

  await page.locator('.multi-cue-column.extension .text').first().click();
  await expect(mainBlock.locator('.waveform-binding-marker')).toHaveText('🔗');
  await expect(extensionBlock.locator('.waveform-binding-marker')).toHaveText('🔗');

  await extensionBlock.click();
  await expect(page.locator('#cue-panel-target')).toHaveText('副字幕');
  await mainBlock.click();
  await expect(page.locator('#cue-panel-target')).toHaveText('主字幕');

  await openMultiSubtitleSettings(page);
  await page.locator('#multi-subtitle-show-track-badges').check();
  await page.locator('#multi-subtitle-toggle').uncheck();
  await expect(page.locator('#multi-subtitle-toggle')).not.toBeChecked();
  await expect(page.locator('.waveform-row.multi-subtitle-row')).toHaveCount(0);
  await expect(page.locator('#download-multi-srt')).toBeHidden();
  await page.locator('#multi-subtitle-toggle').check();
  await expect(page.locator('.waveform-row.multi-subtitle-row')).not.toHaveCount(0);
  await expect(page.locator('#multi-subtitle-settings-menu')).toBeHidden();

  const [mainRect, extensionRect] = await Promise.all([
    mainBlock.boundingBox(),
    extensionBlock.boundingBox(),
  ]);
  if (!mainRect || !extensionRect) throw new Error('双字幕 lane 没有布局');
  const laneBadgeContent = await mainBlock.evaluate((element) => {
    const row = element.closest('.waveform-row');
    return {
      main: getComputedStyle(row, '::before').content,
      secondary: getComputedStyle(row, '::after').content,
    };
  });
  expect(laneBadgeContent).toEqual({ main: '"1"', secondary: '"2"' });
  const laneBadgeColors = await mainBlock.evaluate((element) => {
    const row = element.closest('.waveform-row');
    const mainBadge = getComputedStyle(row, '::before');
    const extensionBadge = getComputedStyle(row, '::after');
    return {
      mainBackground: mainBadge.backgroundColor,
      extensionBackground: extensionBadge.backgroundColor,
      mainText: mainBadge.color,
      extensionText: extensionBadge.color,
    };
  });
  expect(laneBadgeColors.mainBackground).not.toBe(laneBadgeColors.extensionBackground);
  expect(laneBadgeColors.mainText).not.toBe(laneBadgeColors.extensionText);
  const expectedAmber = await mainBlock.evaluate((element) => {
    const row = element.closest('.waveform-row');
    const probe = document.createElement('span');
    probe.style.backgroundColor = getComputedStyle(row).getPropertyValue('--amber').trim();
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  const expectedMarkForeground = await mainBlock.evaluate((element) => {
    const row = element.closest('.waveform-row');
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(row).getPropertyValue('--mark-fg').trim();
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(laneBadgeColors.extensionBackground).toBe(expectedAmber);
  expect(laneBadgeColors.extensionText).toBe(expectedMarkForeground);
  const laneStyles = await mainBlock.evaluate((element) => {
    const row = element.closest('.waveform-row');
    const style = getComputedStyle(element);
    const extension = element.parentElement.querySelector('[data-track="extension"]');
    const extensionStyle = getComputedStyle(extension);
    const rowStyle = getComputedStyle(row);
    const mainLabelStyle = getComputedStyle(row, '::before');
    const extensionLabelStyle = getComputedStyle(row, '::after');
    return {
      mainBottom: parseFloat(style.bottom),
      mainHeight: parseFloat(style.height),
      extensionBottom: parseFloat(extensionStyle.bottom),
      extensionHeight: parseFloat(extensionStyle.height),
      mainLabelBottom: parseFloat(mainLabelStyle.bottom),
      mainLabelHeight: parseFloat(mainLabelStyle.height),
      extensionLabelBottom: parseFloat(extensionLabelStyle.bottom),
      extensionLabelHeight: parseFloat(extensionLabelStyle.height),
    };
  });
  expect(laneStyles.mainBottom).not.toBe(laneStyles.extensionBottom);
  expect(laneStyles.mainHeight).toBe(laneStyles.extensionHeight);
  expect(laneStyles.mainLabelBottom).toBeCloseTo(
    laneStyles.mainBottom + (laneStyles.mainHeight - laneStyles.mainLabelHeight) / 2,
    4,
  );
  expect(laneStyles.extensionLabelBottom).toBeCloseTo(
    laneStyles.extensionBottom + (laneStyles.extensionHeight - laneStyles.extensionLabelHeight) / 2,
    4,
  );
  expect(extensionRect.y).toBeGreaterThan(mainRect.y);
  expect(extensionRect.y).toBeGreaterThanOrEqual(mainRect.y + mainRect.height - 0.5);
  for (const block of [mainBlock, extensionBlock]) {
    const blockRect = await block.boundingBox();
    const labelRect = await block.locator('.waveform-cue-label').boundingBox();
    if (!blockRect || !labelRect) throw new Error('字幕块文字没有布局');
    expect(Math.abs(
      (labelRect.y + labelRect.height / 2) - (blockRect.y + blockRect.height / 2),
    )).toBeLessThan(2);
  }
  const before = await Promise.all([
    mainBlock.evaluate((element) => parseFloat(element.style.left)),
    extensionBlock.evaluate((element) => parseFloat(element.style.left)),
  ]);
  const box = await mainBlock.boundingBox();
  if (!box) throw new Error('主字幕 waveform block 没有布局');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, y, { steps: 4 });
  await page.mouse.up();
  const afterNormal = await Promise.all([
    mainBlock.evaluate((element) => parseFloat(element.style.left)),
    extensionBlock.evaluate((element) => parseFloat(element.style.left)),
  ]);
  expect(afterNormal[0]).toBeGreaterThan(before[0]);
  expect(afterNormal[1]).toBeGreaterThan(before[1]);

  // Alt 拖动临时允许挤压相邻字幕；主字幕拖动仍带着绑定的副字幕一起移动，
  // 没有位移的 Alt 点击则切换禁用。
  const beforeAlt = await Promise.all([
    mainBlock.evaluate((element) => parseFloat(element.style.left)),
    extensionBlock.evaluate((element) => parseFloat(element.style.left)),
  ]);
  const altBox = await mainBlock.boundingBox();
  if (!altBox) throw new Error('主字幕 waveform block 没有布局');
  await page.keyboard.down('Alt');
  await page.mouse.move(altBox.x + altBox.width / 2, altBox.y + altBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(altBox.x + altBox.width / 2 + 55, altBox.y + altBox.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const afterAlt = await Promise.all([
    mainBlock.evaluate((element) => parseFloat(element.style.left)),
    extensionBlock.evaluate((element) => parseFloat(element.style.left)),
  ]);
  expect(afterAlt[0]).toBeGreaterThan(beforeAlt[0]);
  expect(afterAlt[1]).toBeGreaterThan(beforeAlt[1]);

  const clickBox = await mainBlock.boundingBox();
  if (!clickBox) throw new Error('主字幕 waveform block 没有布局');
  await page.keyboard.down('Alt');
  await page.mouse.click(clickBox.x + clickBox.width / 2, clickBox.y + clickBox.height / 2);
  await page.keyboard.up('Alt');
  await expect(mainBlock).toHaveClass(/disabled/);
});

test('restores squeezed bound extension subtitles when an Alt drag is pulled back', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-squeeze-1', start: 1000, end: 3000, text: '主字幕一', items: [] },
      { id: 'main-squeeze-2', start: 3200, end: 5000, text: '主字幕二', items: [] },
    ],
    waveform: generateWaveformPayload(10000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-squeeze', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [
          { id: 'extension-squeeze-1', start: 1000, end: 3000, text: 'first', items: [] },
          { id: 'extension-squeeze-2', start: 3200, end: 5000, text: 'second', items: [] },
        ],
      }],
      bindings: [
        {
          id: 'binding-squeeze-1', track_id: 'extension-squeeze',
          main_segment_ids: ['main-squeeze-1'], extension_segment_ids: ['extension-squeeze-1'],
        },
        {
          id: 'binding-squeeze-2', track_id: 'extension-squeeze',
          main_segment_ids: ['main-squeeze-2'], extension_segment_ids: ['extension-squeeze-2'],
        },
      ],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'squeeze-restore-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const mainBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  const row = mainBlock.locator('xpath=ancestor::*[contains(@class, "waveform-row")]');
  const box = await waitForLayoutBox(mainBlock, '主字幕挤压恢复测试没有波形块');
  const rowGeometry = await row.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    startMs: Number(element.dataset.startMs),
    endMs: Number(element.dataset.endMs),
  }));
  const deltaPx = (500 / (rowGeometry.endMs - rowGeometry.startMs)) * rowGeometry.width;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.keyboard.down('Alt');
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + deltaPx, centerY, { steps: 4 });
  await page.mouse.move(centerX, centerY, { steps: 4 });
  await page.waitForTimeout(50);
  await page.mouse.up();
  await page.keyboard.up('Alt');

  expect(await page.evaluate(() => ({
    main: DATA.segments.map(({ id, start, end }) => ({ id, start, end })),
    extension: DATA.multi_subtitle.tracks[0].segments.map(({ id, start, end }) => ({ id, start, end })),
  }))).toEqual({
    main: [
      { id: 'main-squeeze-1', start: 1000, end: 3000 },
      { id: 'main-squeeze-2', start: 3200, end: 5000 },
    ],
    extension: [
      { id: 'extension-squeeze-1', start: 1000, end: 3000 },
      { id: 'extension-squeeze-2', start: 3200, end: 5000 },
    ],
  });
});

test('keeps bound extensions synced when a main shared boundary is dragged independently', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-shared-1', start: 1000, end: 2000, text: '主字幕一', items: [] },
      { id: 'main-shared-2', start: 2000, end: 3000, text: '主字幕二', items: [] },
    ],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-shared', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        segments: [
          { id: 'extension-shared-1', start: 1000, end: 2000, text: 'first', items: [] },
          { id: 'extension-shared-2', start: 2000, end: 3000, text: 'second', items: [] },
        ],
      }],
      bindings: [
        {
          id: 'binding-shared-1', track_id: 'extension-shared',
          main_segment_ids: ['main-shared-1'], extension_segment_ids: ['extension-shared-1'],
        },
        {
          id: 'binding-shared-2', track_id: 'extension-shared',
          main_segment_ids: ['main-shared-2'], extension_segment_ids: ['extension-shared-2'],
        },
      ],
    },
  };
  // 该测试验证同轨独立拖动路径，显式关闭自动吸附（默认已开启）。
  await page.addInitScript(() => {
    localStorage.setItem(
      'moy.asr.editor.settings.v1',
      JSON.stringify({ autoSnapAdjacentCues: false }),
    );
  });
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'main-shared-boundary-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const readRanges = () => page.evaluate(() => ({
    main: DATA.segments.map((segment) => [segment.start, segment.end]),
    extension: DATA.multi_subtitle.tracks[0].segments.map((segment) => [segment.start, segment.end]),
  }));
  const dragHandleBy = async (selector, deltaMs) => {
    const handle = page.locator(selector);
    const handleBox = await waitForLayoutBox(handle, '主字幕共享边界手柄没有布局');
    const row = handle.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " waveform-row ")][1]');
    const rowBox = await waitForLayoutBox(row, '共享边界所在波形行没有布局');
    const rowStart = Number(await row.getAttribute('data-start-ms'));
    const rowEnd = Number(await row.getAttribute('data-end-ms'));
    const y = handleBox.y + handleBox.height / 2;
    const startX = handleBox.x + handleBox.width / 2;
    const targetX = startX + (deltaMs / (rowEnd - rowStart)) * rowBox.width;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(targetX, y, { steps: 4 });
    await page.mouse.up();
  };

  // 自动吸附已显式关闭：同轨相邻主字幕保持独立，但绑定副字幕仍跟随主字幕边界。
  await dragHandleBy(
    '.waveform-cue-block[data-track="main"][data-idx="0"] .waveform-cue-handle.right',
    -200,
  );
  await expect.poll(readRanges).toEqual({
    main: [[1000, 1800], [2000, 3000]],
    extension: [[1000, 1800], [2000, 3000]],
  });

  await page.evaluate(() => {
    DATA.segments[0].end = 2000;
    DATA.segments[1].start = 2000;
    DATA.multi_subtitle.tracks[0].segments[0].end = 2000;
    DATA.multi_subtitle.tracks[0].segments[1].start = 2000;
    renderAll();
  });

  await dragHandleBy(
    '.waveform-cue-block[data-track="main"][data-idx="1"] .waveform-cue-handle.left',
    200,
  );
  await expect.poll(readRanges).toEqual({
    main: [[1000, 2000], [2200, 3000]],
    extension: [[1000, 2000], [2200, 3000]],
  });
});

test('snaps an extension cue to main-track boundaries when cross-track snapping is enabled', async ({ page }) => {
  const projectPath = join(tempDir, 'cross-track-snap-project.json');
  const project = {
    segments: [{ id: 'main-001', start: 1000, end: 2000, text: '主字幕', items: [] }],
    waveform: generateWaveformPayload(5000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1',
        role: 'extension',
        name: 'English',
        language: 'English',
        split_mode: 'word',
        segments: [{ id: 'extension-001', start: 2100, end: 2900, text: 'Extension' }],
      }],
      bindings: [],
    },
  };
  writeFileSync(projectPath, JSON.stringify(project), 'utf8');
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'cross-track-snap-project.json',
    type: 'application/json',
    base64: readFileSync(projectPath).toString('base64'),
  }]);

  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"]').first();
  await expect(extensionBlock).toBeVisible();
  await expect(page.locator('#multi-subtitle-cross-track-snap')).toBeChecked();
  const row = extensionBlock.locator('xpath=ancestor::*[contains(@class, "waveform-row")]');
  const rowGeometry = await row.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    startMs: Number(element.dataset.startMs),
    endMs: Number(element.dataset.endMs),
  }));
  const box = await extensionBlock.boundingBox();
  if (!box || !Number.isFinite(rowGeometry.width) || rowGeometry.endMs <= rowGeometry.startMs) {
    throw new Error('跨轨道吸附测试缺少有效波形布局');
  }
  const deltaMs = -150;
  const deltaPx = (deltaMs / (rowGeometry.endMs - rowGeometry.startMs)) * rowGeometry.width;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + deltaPx, centerY, { steps: 3 });
  await page.mouse.up();
  await expect(extensionBlock).toHaveAttribute('data-start', '2000');

  await openMultiSubtitleSettings(page);
  await page.locator('#multi-subtitle-cross-track-snap').uncheck();
  await page.locator('#multi-subtitle-settings-toggle').click();
  await expect(page.locator('#multi-subtitle-settings-menu')).toBeHidden();

  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'cross-track-snap-project.json',
    type: 'application/json',
    base64: readFileSync(projectPath).toString('base64'),
  }]);
  await expect(page.locator('#multi-subtitle-cross-track-snap')).not.toBeChecked();
  const resetBlock = page.locator('.waveform-cue-block[data-track="extension"]').first();
  const resetBox = await resetBlock.boundingBox();
  if (!resetBox) throw new Error('重新加载后扩展字幕波形块没有布局');
  const resetCenterX = resetBox.x + resetBox.width / 2;
  const resetCenterY = resetBox.y + resetBox.height / 2;
  await page.mouse.move(resetCenterX, resetCenterY);
  await page.mouse.down();
  await page.mouse.move(resetCenterX + deltaPx, resetCenterY, { steps: 3 });
  await page.mouse.up();
  await expect(resetBlock).toHaveAttribute('data-start', '1950');
});

test('confirms main replacement and makes both replacement paths undoable', async ({ page }) => {
  const replacementSrt = [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'Replaced subtitle.',
    '',
  ].join('\n');

  await page.goto(server.url);
  await dropFiles(page, [srtSpec('main.srt', mainSrt)]);
  await expect(page.locator('#cues-container .cue .text').first()).toHaveText('Hello world.');

  await dropFiles(page, [srtSpec('replacement.srt', replacementSrt)]);
  await expect(page.locator('#multi-subtitle-import-modal')).toHaveClass(/show/);
  await page.locator('#multi-subtitle-import-replace').click();
  await expect(page.locator('#multi-subtitle-import-result-confirm')).toBeEnabled();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await expect(page.locator('#cues-container .cue .text').first()).toHaveText('Replaced subtitle.');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#cues-container .cue .text').first()).toHaveText('Hello world.');

  await dropFiles(page, [srtSpec('translation.srt', extensionSrt)]);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await expect(page.locator('#multi-subtitle-toggle')).toBeChecked();
  await page.keyboard.press('Control+z');
  await expect(page.locator('#multi-subtitle-controls')).toBeVisible();
  await expect(page.locator('#multi-subtitle-toggle')).not.toBeDisabled();
  await expect(page.locator('#multi-subtitle-toggle-label'))
    .toHaveAttribute('title', '当前工程如果有大于1条字幕，可以开启多重字幕模式，用于双语字幕编辑等。');
  await expect(page.locator('#cues-container .multi-dual-cue')).toHaveCount(0);
  await expect(page.locator('#cues-container .cue .text').first()).toHaveText('Hello world.');
});

test('uses the split dialog for waveform main splitting when word timestamps are disabled', async ({ page }) => {
  const project = {
    segments: [{
      id: 'main-only-001',
      start: 1000,
      end: 5000,
      text: '这是一句主字幕',
      items: [
        { start: 1000, end: 2500, text: '这是一句' },
        { start: 2500, end: 5000, text: '主字幕' },
      ],
    }],
    waveform: generateWaveformPayload(8000),
  };

  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'main-only.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);
  await page.locator('#editor-settings-toggle').click();
  await expect(page.locator('#split-use-word-timestamps')).toBeChecked();
  await page.locator('#split-use-word-timestamps').uncheck();
  await page.locator('#editor-settings-toggle').click();

  await page.locator('[data-waveform-tool="razor"]').click();
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  await expect(block).toBeVisible();
  const box = await waitForLayoutBox(block, '主字幕波形块没有布局');
  const row = block.locator('xpath=ancestor::*[contains(@class, "waveform-row")]');
  const rowBox = await waitForLayoutBox(row, '主字幕波形行没有布局');
  const rowStart = Number(await row.getAttribute('data-start-ms'));
  const rowEnd = Number(await row.getAttribute('data-end-ms'));
  if (!rowBox || !Number.isFinite(rowStart) || !Number.isFinite(rowEnd)) {
    throw new Error('主字幕波形行没有有效时间范围');
  }
  const clickX = box.x + box.width * 0.62;
  const clickY = box.y + box.height / 2;
  const expectedCut = Math.round(rowStart + ((clickX - rowBox.x) / rowBox.width) * (rowEnd - rowStart));
  await page.mouse.click(clickX, clickY);
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择主字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-preview')).toContainText('主：');
  await expect(page.locator('#multi-subtitle-split-preview')).toContainText(' / ');
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(page.locator('#cues-container > .cue')).toHaveCount(2);
  expect(await page.evaluate(() => DATA.segments[0].end)).toBe(expectedCut);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#cues-container > .cue')).toHaveCount(1);
});

test('splits a timestamped main subtitle directly when automatic timecode splitting is enabled', async ({ page }) => {
  const project = {
    segments: [{
      id: 'main-direct-timestamped-001',
      start: 1000,
      end: 5000,
      text: '这是一句主字幕',
      items: [
        { start: 1000, end: 2500, text: '这是一句' },
        { start: 2500, end: 5000, text: '主字幕' },
      ],
    }],
    waveform: generateWaveformPayload(8000),
  };

  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'main-direct-timestamped.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  await page.locator('[data-waveform-tool="razor"]').click();
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  await expect(block).toBeVisible();
  const box = await waitForLayoutBox(block, '带时间码的主字幕波形块没有布局');
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height / 2);
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#cues-container > .cue')).toHaveCount(2);
  expect(await page.evaluate(() => DATA.segments[0].end)).toBe(2500);
});

test('uses the split dialog for SRT-style main subtitles without word timestamps', async ({ page }) => {
  const project = {
    segments: [{
      id: 'srt-main-001',
      start: 1000,
      end: 5000,
      text: '这是一句没有字词时间码',
    }],
    waveform: generateWaveformPayload(8000),
  };

  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'srt-style-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);
  await page.locator('#editor-settings-toggle').click();
  await expect(page.locator('#split-use-word-timestamps')).toBeChecked();
  await page.locator('#editor-settings-toggle').click();

  await page.locator('[data-waveform-tool="razor"]').click();
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  await expect(block).toBeVisible();
  const box = await waitForLayoutBox(block, 'SRT 主字幕波形块没有布局');
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height / 2);
  await expect(page.locator('#hint-stack'))
    .toContainText('没有可用的字词时间码，本次设置不生效');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择主字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeVisible();
  await expect(page.locator('#multi-subtitle-split-preview')).toContainText(' / ');
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(page.locator('#cues-container > .cue')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#cues-container > .cue')).toHaveCount(1);
});

test('keeps the waveform pointer as the absolute cut in a linked split dialog', async ({ page }) => {
  const project = {
    segments: [{ id: 'main-linked-001', start: 1000, end: 5000, text: 'main subtitle' }],
    waveform: generateWaveformPayload(8000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-linked-001', start: 1000, end: 5000, text: 'translated subtitle' }],
      }],
      bindings: [{
        id: 'binding-linked-001', track_id: 'extension-1',
        main_segment_ids: ['main-linked-001'], extension_segment_ids: ['extension-linked-001'],
        start_offset_ms: 0, end_offset_ms: 0,
      }],
    },
  };

  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'linked-pointer-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);
  await page.locator('#editor-settings-toggle').click();
  await expect(page.locator('#split-use-word-timestamps')).toBeChecked();
  await page.locator('#split-use-word-timestamps').uncheck();
  await page.locator('#editor-settings-toggle').click();

  await page.locator('[data-waveform-tool="razor"]').click();
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  await expect(block).toBeVisible();
  const blockBox = await waitForLayoutBox(block, '联动拆分主字幕波形块没有布局');
  const row = block.locator('xpath=ancestor::*[contains(@class, "waveform-row")]');
  const rowBox = await waitForLayoutBox(row, '联动拆分波形行没有布局');
  const rowStart = Number(await row.getAttribute('data-start-ms'));
  const rowEnd = Number(await row.getAttribute('data-end-ms'));
  if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd)) {
    throw new Error('联动拆分测试缺少有效波形布局');
  }
  const clickX = blockBox.x + blockBox.width * 0.62;
  const clickY = blockBox.y + blockBox.height / 2;
  const expectedCut = Math.round(rowStart + ((clickX - rowBox.x) / rowBox.width) * (rowEnd - rowStart));
  await page.mouse.click(clickX, clickY);
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeVisible();
  await expect(page.locator('#multi-subtitle-split-extension-lane')).toBeVisible();
  await expect(page.locator('#multi-subtitle-split-meta'))
    .toContainText('当前切分位置固定为波形指针位置');
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(page.locator('.multi-dual-cue')).toHaveCount(2);
  expect(await page.evaluate(() => DATA.segments[0].end)).toBe(expectedCut);
  expect(await page.evaluate(() => DATA.multi_subtitle.tracks[0].segments[0].end)).toBe(expectedCut);
});

test('labels a linked split time inferred from main word timestamps', async ({ page }) => {
  const project = {
    segments: [{
      id: 'main-timestamped-001', start: 1000, end: 5000, text: 'main subtitle',
      items: [
        { start: 1000, end: 2800, text: 'main' },
        { start: 3200, end: 5000, text: 'subtitle' },
      ],
    }],
    waveform: generateWaveformPayload(8000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-timestamped-1', role: 'extension', name: 'English', language: 'English', split_mode: 'word',
        source_name: 'translation.srt',
        segments: [{ id: 'extension-timestamped-001', start: 1000, end: 5000, text: 'translated subtitle' }],
      }],
      bindings: [{
        id: 'binding-timestamped-001', track_id: 'extension-timestamped-1',
        main_segment_ids: ['main-timestamped-001'], extension_segment_ids: ['extension-timestamped-001'],
        start_offset_ms: 0, end_offset_ms: 0,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'timestamped-linked-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const mainText = page.locator('.multi-dual-cue .multi-cue-column.main .text').first();
  await mainText.dblclick();
  await mainText.evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 5);
    range.setEnd(node, 5);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-meta'))
    .toContainText('当前切分位置由字词时间码推定');
  await expect(page.locator('#multi-subtitle-split-title'))
    .toHaveText('主字幕按时间码定位，选择副字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeVisible();
  await expect(page.locator('#multi-subtitle-split-main-lane'))
    .toHaveClass(/timestamp-locked-lane/);
  await expect(page.locator('#multi-subtitle-split-main-text'))
    .toHaveClass(/timestamp-locked/);
  await expect(page.locator('#multi-subtitle-split-main-text'))
    .toHaveAttribute('aria-readonly', 'true');
  await expect(page.locator('#multi-subtitle-split-main-lane h4'))
    .toHaveText('⌚️ 主字幕按时间码会拆在这里');
  await expect(page.locator('#multi-subtitle-split-timestamp-hint'))
    .toBeVisible();
  await expect(page.locator('#multi-subtitle-split-timestamp-hint'))
    .toContainText('右上角「🔧 设置 → 拆分与合并」');
  await page.keyboard.press('Escape');

  await page.locator('#editor-settings-toggle').click();
  await page.locator('#split-use-word-timestamps').uncheck();
  await page.locator('#editor-settings-toggle').click();
  await mainText.click();
  await page.keyboard.press('b');
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-meta'))
    .toContainText('默认位置参考主字幕字词时间码，可继续调整');
  await expect(page.locator('#multi-subtitle-split-meta'))
    .toContainText('共用绝对切点 00:03.200');
  await expect(page.locator('#multi-subtitle-split-main-lane'))
    .not.toHaveClass(/timestamp-locked-lane/);
  await expect(page.locator('#multi-subtitle-split-timestamp-hint')).toBeHidden();
  await page.keyboard.press('Escape');
});

test('Z/X adjust one main or extension cue at the pointer and ignore multi-selection', async ({ page }) => {
  const project = {
    segments: [
      { id: 'main-pointer-001', start: 1000, end: 4000, text: 'main one' },
      { id: 'main-pointer-002', start: 5000, end: 7000, text: 'main two' },
    ],
    waveform: generateWaveformPayload(8000),
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1',
      enabled: true,
      display_mode: 'both',
      tracks: [{
        id: 'extension-pointer-1', role: 'extension', name: 'English', language: 'English',
        split_mode: 'word', segments: [
          { id: 'extension-pointer-001', start: 1200, end: 3800, text: 'extension one' },
        ],
      }],
      bindings: [{
        id: 'binding-pointer-001', track_id: 'extension-pointer-1',
        main_segment_ids: ['main-pointer-001'],
        extension_segment_ids: ['extension-pointer-001'],
        start_offset_ms: 200, end_offset_ms: -200,
      }],
    },
  };
  await page.goto(server.url);
  await dropFiles(page, [{
    name: 'pointer-boundary-project.json',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  }]);

  const readRanges = () => page.evaluate(() => ({
    main: DATA.segments.map((segment) => [segment.start, segment.end]),
    extension: DATA.multi_subtitle.tracks[0].segments.map((segment) => [segment.start, segment.end]),
  }));
  const mainBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  const secondMainBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="1"]');
  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');

  // 主字幕当前面板激活时，绑定副字幕随同一边界增量调整。
  await mainBlock.click();
  await moveWaveformPointerToTime(page, mainBlock, 2000);
  await page.keyboard.press('z');
  await expect.poll(readRanges).toEqual({
    main: [[2000, 4000], [5000, 7000]],
    extension: [[2200, 3800]],
  });
  await moveWaveformPointerToTime(page, mainBlock, 3500);
  await page.keyboard.press('x');
  await expect.poll(readRanges).toEqual({
    main: [[2000, 3500], [5000, 7000]],
    extension: [[2200, 3300]],
  });

  // 副字幕当前面板激活时，即使主副同时处于选中状态，也只改变副字幕。
  await extensionBlock.click();
  await moveWaveformPointerToTime(page, extensionBlock, 2500);
  await page.keyboard.press('z');
  await expect.poll(readRanges).toEqual({
    main: [[2000, 3500], [5000, 7000]],
    extension: [[2500, 3300]],
  });
  await moveWaveformPointerToTime(page, extensionBlock, 3000);
  await page.keyboard.press('x');
  await expect.poll(readRanges).toEqual({
    main: [[2000, 3500], [5000, 7000]],
    extension: [[2500, 3000]],
  });

  // 多选时不执行，即使指针落在其中一条字幕上。
  await mainBlock.click();
  await secondMainBlock.click({ modifiers: ['Control'] });
  await moveWaveformPointerToTime(page, secondMainBlock, 6000);
  await page.keyboard.press('z');
  await expect.poll(readRanges).toEqual({
    main: [[2000, 3500], [5000, 7000]],
    extension: [[2500, 3000]],
  });
});
