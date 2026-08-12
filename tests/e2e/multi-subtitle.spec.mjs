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

test('imports an extension SRT with 300ms preview, dual columns, split dialog, and pair deletion undo', async ({ page }) => {
  await importPair(page);
  await expect(page.locator('#multi-subtitle-import-description')).toHaveText('请选择你要执行的行为：');
  await expect(page.locator('#multi-subtitle-import-preview')).toBeHidden();
  await expect(page.locator('#multi-subtitle-import-result-confirm')).toBeDisabled();
  await expect(page.locator('#multi-subtitle-import-extension')).not.toHaveClass(/primary/);
  await expect(page.locator('#multi-subtitle-import-extension')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#multi-subtitle-import-extension').click();
  await expect(page.locator('#multi-subtitle-import-extension')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#multi-subtitle-import-preview')).toContainText('自动绑定 2 条');
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

  // 主轨双击进入编辑后按 Ctrl+Enter，绑定状态应打开联动拆分弹窗。
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
  await page.keyboard.press('Control+Enter');
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
  await expect(splitText).toHaveAttribute('title', '拆分点已锁定，再次点击后解锁');
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

test('swaps main and extension subtitles from the gear menu and supports undo', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  await openMultiSubtitleSettings(page);
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

test('auto-binds an overlapping unbound main cue and asks before replacing an existing binding', async ({ page }) => {
  const projectPath = join(tempDir, 'binding-overlap-project.json');
  const project = {
    media: '', language: 'English', model: '',
    segments: [
      { id: 'main-001', start: 1000, end: 2000, text: 'Main one', items: [] },
      { id: 'main-002', start: 3000, end: 4000, text: 'Main two', items: [] },
    ],
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{
        id: 'extension-1', role: 'extension', name: 'Translation', language: '', source_name: 'translation.srt',
        split_mode: 'word',
        segments: [
          { id: 'extension-001', start: 1100, end: 1900, text: 'Already bound' },
          { id: 'extension-002', start: 1200, end: 1800, text: 'Replace me' },
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

  const autoExtension = page.locator('.multi-cue-column.extension').filter({ hasText: 'Auto bind me' });
  await autoExtension.click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: '绑定到主字幕' }).click();
  await expect(autoExtension).not.toHaveClass(/unbound/);
  await page.keyboard.press('Escape');

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
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择拓展字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeHidden();
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
  await expect(page.locator('#sel-count')).toHaveText('1');
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
  await expect(page.locator('#sel-count')).toHaveText('1');
  await page.locator('#ctxmenu .item').filter({ hasText: '与选中的主字幕绑定' }).click();

  await expect(unboundExtension).not.toHaveClass(/unbound/);
  expect(await page.evaluate(() => window.__mawWaveformDraws)).toBe(0);

  await unboundExtension.click({ button: 'right' });
  await page.locator('#ctxmenu .item').filter({ hasText: /^解绑$/ }).click();
  await expect(unboundExtension).toHaveClass(/unbound/);
  expect(await page.evaluate(() => window.__mawWaveformDraws)).toBe(0);
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
  await first.click();
  await second.click({ modifiers: ['Control'] });
  await expect(page.locator('#sel-count')).toHaveText('2');
  await second.click({ button: 'right' });
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '合并副字幕块' })).toBeVisible();
  await page.locator('#ctxmenu .item').filter({ hasText: '合并副字幕块' }).click();
  await expect(page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。 / 第二句。' })).toHaveCount(0);
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(2);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(3);

  await page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。' }).click();
  await page.locator('.multi-cue-column.extension').filter({ hasText: '第二句。' }).click({ modifiers: ['Control'] });
  await page.keyboard.press('c');
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.multi-cue-column.extension:not(.multi-cue-empty)')).toHaveCount(3);
});

test('选中的主字幕与绑定副字幕一起合并并支持撤销', async ({ page }) => {
  await importPair(page);
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const first = page.locator('.multi-cue-column.main').filter({ hasText: 'Hello world.' });
  const second = page.locator('.multi-cue-column.main').filter({ hasText: 'Second line.' });
  await first.click();
  await second.click({ modifiers: ['Control'] });
  await page.keyboard.press('c');

  await expect(page.locator('.multi-dual-cue')).toHaveCount(2);
  const merged = page.locator('.multi-dual-cue').filter({ hasText: 'Hello world.' });
  await expect(merged.locator('.multi-cue-column.main .time')).toHaveText('00:00.000 → 00:05.000');
  await expect(merged.locator('.multi-cue-column.extension .time')).toHaveText('00:00.050 → 00:04.950');

  await page.keyboard.press('Control+z');
  await expect(page.locator('.multi-dual-cue')).toHaveCount(3);
  await expect(page.locator('.multi-cue-column.extension').filter({ hasText: '你好，世界。' })).toHaveCount(1);
  await expect(page.locator('.multi-cue-column.extension').filter({ hasText: '第二句。' })).toHaveCount(1);
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
  await page.locator('#extension-subtitle-font-size').selectOption('14');
  await expect(page.locator('#overlay-extension-text')).toHaveCSS('font-size', '14px');
  await page.locator('#extension-overlay-toggle').uncheck();
  await expect(page.locator('#extension-overlay-toggle')).not.toBeChecked();
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
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择拓展字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeHidden();
  await expect(page.locator('#multi-subtitle-split-preview')).toContainText('✂️');
  await expect(page.locator('#multi-subtitle-split-preview')).not.toContainText(' / ');
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(page.locator('#multi-subtitle-split-modal')).not.toHaveClass(/show/);
  await expect(page.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(2);
  await expect(page.locator('.multi-cue-column.extension.unbound')).toHaveCount(2);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(1);
  await expect(page.locator('.multi-cue-column.extension.unbound')).toHaveCount(0);
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

  const row = page.locator('.waveform-row.multi-subtitle-row').first();
  const box = await row.boundingBox();
  if (!box) throw new Error('双 lane 波形行没有布局');
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height - 2, { button: 'right' });
  await expect(page.locator('#ctxmenu .item').filter({ hasText: '创建拓展字幕' })).toBeVisible();
  await page.locator('#ctxmenu .item').filter({ hasText: '创建拓展字幕' }).click();
  await expect(page.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(1);
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

  await openMultiSubtitleSettings(page);
  await page.locator('#multi-subtitle-toggle').uncheck();
  await expect(page.locator('#multi-subtitle-toggle')).not.toBeChecked();
  await expect(page.locator('.waveform-row.multi-subtitle-row')).toHaveCount(0);
  await expect(page.locator('#download-multi-srt')).toBeHidden();
  await page.locator('#multi-subtitle-toggle').check();
  await expect(page.locator('.waveform-row.multi-subtitle-row')).not.toHaveCount(0);
  await page.locator('#multi-subtitle-settings-toggle').click();
  await expect(page.locator('#multi-subtitle-settings-menu')).toBeHidden();

  const mainBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]');
  const extensionBlock = page.locator('.waveform-cue-block[data-track="extension"][data-ext-idx="0"]');
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
  expect(laneBadgeContent).toEqual({ main: '"主"', secondary: '"副"' });
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

  // Alt 有位移时只调整当前主轨，绑定关系仍在；没有位移的 Alt 点击则切换禁用。
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
  expect(Math.abs(afterAlt[1] - beforeAlt[1])).toBeLessThan(0.01);

  const clickBox = await mainBlock.boundingBox();
  if (!clickBox) throw new Error('主字幕 waveform block 没有布局');
  await page.keyboard.down('Alt');
  await page.mouse.click(clickBox.x + clickBox.width / 2, clickBox.y + clickBox.height / 2);
  await page.keyboard.up('Alt');
  await expect(mainBlock).toHaveClass(/disabled/);
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
  const deltaMs = -70;
  const deltaPx = (deltaMs / (rowGeometry.endMs - rowGeometry.startMs)) * rowGeometry.width;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + deltaPx, centerY, { steps: 3 });
  await page.mouse.up();
  await expect(extensionBlock).toHaveAttribute('data-start', '2000');

  await page.keyboard.press('Control+z');
  await expect(extensionBlock).toHaveAttribute('data-start', '2100');
  await openMultiSubtitleSettings(page);
  await page.locator('#multi-subtitle-cross-track-snap').uncheck();
  await page.locator('#multi-subtitle-settings-toggle').click();
  await expect(page.locator('#multi-subtitle-settings-menu')).toBeHidden();

  const resetBox = await extensionBlock.boundingBox();
  if (!resetBox) throw new Error('撤销后扩展字幕波形块没有布局');
  const resetCenterX = resetBox.x + resetBox.width / 2;
  const resetCenterY = resetBox.y + resetBox.height / 2;
  await page.mouse.move(resetCenterX, resetCenterY);
  await page.mouse.down();
  await page.mouse.move(resetCenterX + deltaPx, resetCenterY, { steps: 3 });
  await page.mouse.up();
  await expect(extensionBlock).toHaveAttribute('data-start', '2030');
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
  await expect(page.locator('#multi-subtitle-controls')).toBeHidden();
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
  const box = await block.boundingBox();
  if (!box) throw new Error('主字幕波形块没有布局');
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height / 2);
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择主字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-preview')).toContainText('主：');
  await expect(page.locator('#multi-subtitle-split-preview')).toContainText('✂️');
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(page.locator('#cues-container > .cue')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#cues-container > .cue')).toHaveCount(1);
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
  const box = await block.boundingBox();
  if (!box) throw new Error('SRT 主字幕波形块没有布局');
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height / 2);
  await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-split-title')).toHaveText('选择主字幕拆分点');
  await expect(page.locator('#multi-subtitle-split-main-lane')).toBeVisible();
  await expect(page.locator('#multi-subtitle-split-preview')).toContainText('✂️');
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(page.locator('#cues-container > .cue')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#cues-container > .cue')).toHaveCount(1);
});
