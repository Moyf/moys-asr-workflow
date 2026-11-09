// 波形字幕块双击快速编辑气泡回归：
// 1. 双击主轨字幕块在被点击块上方弹出气泡，Enter 提交后波形标签与字幕
//    列表同步更新，Ctrl+Z 走命令事务撤销恢复原文；
// 2. Esc 关闭气泡并保留修改（与当前字幕面板默认一致）；
// 3. 跨行字幕按鼠标双击的位置在对应行的片段上方弹出。
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  cleanupTempDir,
  DURATION_MS,
  disableOnboarding,
  findFreePort,
  generateWaveformPayload,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

let tempDir;
let server;
let projectPath;

test.beforeAll(async () => {
  tempDir = makeTempDir('cuequickedit');
  const mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  // 25s–40s 的第二句横跨默认多行模式（10s/行）的 30s 行边界，
  // 双击不同行的片段时气泡必须跟随点击位置；第一句带字词时间码
  //（items），供字词码模式的字词气泡用例使用。
  writeFileSync(projectPath, JSON.stringify({
    media: 'synthetic.wav',
    segments: [
      { start: 1000, end: 5000, text: '第一句原文', items: [
        { start: 1000, end: 2500, text: '第一' },
        { start: 2500, end: 5000, text: '句原文' },
      ] },
      { start: 25000, end: 40000, text: '跨行长句需要分片显示' },
    ],
    waveform: generateWaveformPayload(DURATION_MS),
  }, null, 2), 'utf8');
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test.beforeEach(async ({ page }) => {
  await disableOnboarding(page);
  // 用例各自从磁盘夹具冷加载，已完成编辑不得写回磁盘影响下一条用例。
  await page.addInitScript(() => {
    const key = 'moy.asr.editor.settings.v1';
    const settings = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...settings, autoSaveProject: false }));
  });
});

async function openEditor(page) {
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelectorAll('.waveform-cue-block[data-track="main"]').length > 0);
}

test('快捷编辑按设置拆分并继续编辑后半句', async ({ page }) => {
  await openEditor(page);
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  await block.dblclick();
  const input = page.locator('.waveform-cue-quick-edit textarea');
  await input.fill('甲乙丙丁');
  await input.evaluate(el => el.setSelectionRange(2, 2));
  await input.press('Enter');
  await expect(input).toHaveValue('丙丁');
  await expect(input).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.MaweBoot.DATA.segments.slice(0, 2).map(s => s.text)))
    .toEqual(['甲乙', '丙丁']);
  await input.fill('后半句');
  await input.press('Control+Enter');
  await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.MaweBoot.DATA.segments[1].text)).toBe('后半句');
});

test('quick split focus setting persists and leaves no selection when disabled', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    const toggle = document.getElementById('quick-edit-split-focus-next');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.waveform-cue-block[data-track="main"]').length > 0);
  await expect(page.locator('#quick-edit-split-focus-next')).not.toBeChecked();
  await page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first().dblclick();
  const input = page.locator('.waveform-cue-quick-edit textarea');
  await input.fill('甲乙丙丁');
  await input.evaluate(el => el.setSelectionRange(2, 2));
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.MaweBoot.DATA.segments.slice(0, 2).map(s => s.text)))
    .toEqual(['甲乙', '丙丁']);
  await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => [...MaweSelection.selectedIdxs])).toEqual([]);
  await expect.poll(() => page.evaluate(() => MaweSelection.lastClickedIdx)).toBe(-1);
});

test('Ctrl+Enter 拆分设置、边界拒绝与快捷编辑帮助', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    const select = document.getElementById('split-key');
    select.value = 'ctrl-enter';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  await block.dblclick();
  const popup = page.locator('.waveform-cue-quick-edit');
  const input = popup.locator('textarea');
  await input.evaluate(el => el.setSelectionRange(0, 0));
  await input.press('Control+Enter');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('第一句原文');
  const gap = await input.evaluate(el => el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(8);
  const shotDir = resolve('.artifacts/pr354-review');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'quick-edit.png') });
  await popup.locator('.waveform-cue-quick-edit-help').click();
  await expect(page.locator('#help-tab-panel-quick-edit')).toBeVisible();
  await page.screenshot({ path: join(shotDir, 'quick-edit-help.png') });
  await expect(page.locator('#help-quick-split-key')).toHaveText('Ctrl+Enter');
  await expect(page.locator('#help-quick-confirm-key')).toHaveText('Enter');
  await page.locator('#help-tab-panel-quick-edit [data-settings-page="split-merge"]').click();
  await expect(page.locator('#editor-settings-page-split-merge')).toBeVisible();
});

test('Ctrl+Enter 拆分时，Enter 保存；拆分后继续编辑后半句', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    const select = document.getElementById('split-key');
    select.value = 'ctrl-enter';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first().dblclick();
  const input = page.locator('.waveform-cue-quick-edit textarea');
  await input.fill('甲乙丙丁');
  await input.evaluate(el => el.setSelectionRange(2, 2));
  await input.press('Control+Enter');
  await expect(input).toHaveValue('丙丁');
  await input.fill('已保存');
  await input.press('Enter');
  await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.MaweBoot.DATA.segments[1].text)).toBe('已保存');
});

for (const track of ['extension', 'overlay']) {
  test(`${track} quick split focus disabled after confirmation`, async ({ page }) => {
    await openEditor(page);
    await page.evaluate(() => {
      MaweSettings.updateEditorSettings({ quickEditSplitFocusNext: false });
      const cue = { id: 'extra-1', start: 1000, end: 5000, text: '甲乙丙丁' };
      MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
        tracks: [{ id: 'ext-1', role: 'extension', split_mode: 'continuous', segments: [{ ...cue }] }], bindings: [] };
      MaweBoot.DATA.overlay_track = { enabled: true, segments: [{ ...cue }] };
      MaweCuePanel.renderAll({ waveform: 'full' });
    });
    await page.evaluate(track => MaweCoreState.waveformEditor.openCueQuickEditAtIndex(track, 0), track);
    const input = page.locator('.waveform-cue-quick-edit textarea');
    await input.evaluate(el => el.setSelectionRange(2, 2));
    await input.press('Enter');
    await expect(page.locator('#multi-subtitle-split-modal')).toBeVisible();
    await page.locator('#multi-subtitle-split-confirm').click();
    await expect(page.locator('.waveform-cue-quick-edit')).toHaveCount(0);
    await expect.poll(() => page.evaluate(track => {
      const segments = track === 'extension' ? MaweMultiSubtitleCore.getActiveExtensionTrack().segments : MaweBoot.DATA.overlay_track.segments;
      return segments.map(s => s.text);
    }, track)).toEqual(['甲乙', '丙丁']);
    await expect.poll(() => page.evaluate(track => [...MaweState.selection.indices(track)], track)).toEqual([]);
  });
  test(`${track} 快捷编辑拆分确认后继续编辑后半句`, async ({ page }) => {
    await openEditor(page);
    await page.evaluate(() => {
      const cue = { id: 'extra-1', start: 1000, end: 5000, text: '甲乙丙丁' };
      MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
        tracks: [{ id: 'ext-1', role: 'extension', split_mode: 'continuous', segments: [{ ...cue }] }], bindings: [] };
      MaweBoot.DATA.overlay_track = { enabled: true, segments: [{ ...cue }] };
      MaweCuePanel.renderAll({ waveform: 'full' });
    });
    await page.evaluate(track => window.MaweCoreState.waveformEditor.openCueQuickEditAtIndex(track, 0), track);
    const input = page.locator('.waveform-cue-quick-edit textarea');
    await expect(input).toHaveValue('甲乙丙丁');
    await input.evaluate(el => el.setSelectionRange(2, 2));
    await input.press('Enter');
    await expect(page.locator('#multi-subtitle-split-modal')).toBeVisible();
    await page.locator('#multi-subtitle-split-confirm').click();
    await expect(input).toHaveValue('丙丁');
    await expect(input).toBeFocused();
  });

  test(`${track} 快捷编辑调整断点后时间随文字位置更新`, async ({ page }) => {
    await openEditor(page);
    await page.evaluate(track => {
      const cue = { id: 'extra-1', start: 1000, end: 5000, text: '甲乙丙丁戊己庚辛壬癸天地玄黄宇宙' };
      MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
        tracks: [{ id: 'ext-1', role: 'extension', split_mode: 'continuous', segments: [{ ...cue }] }], bindings: [] };
      MaweBoot.DATA.overlay_track = { enabled: true, segments: [{ ...cue }] };
      MaweCuePanel.renderAll({ waveform: 'full' });
      MaweCoreState.waveformEditor.openCueQuickEditAtIndex(track, 0);
    }, track);
    const input = page.locator('.waveform-cue-quick-edit textarea');
    await input.evaluate(el => el.setSelectionRange(2, 2));
    await input.press('Enter');
    await expect(page.locator('#multi-subtitle-split-modal')).toBeVisible();
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => ({
      offset: MaweSplitCore.pendingLinkedSplit.offset,
      cut: MaweSplitCore.pendingLinkedSplit.extensionCutMs,
    }))).toEqual({ offset: 12, cut: 4000 });
    await page.locator('#multi-subtitle-split-confirm').click();
    await expect.poll(() => page.evaluate(track => {
      const segments = track === 'extension' ? MaweMultiSubtitleCore.getActiveExtensionTrack().segments
        : MaweBoot.DATA.overlay_track.segments;
      return segments.map(({ start, end, text }) => ({ start, end, text }));
    }, track)).toEqual([
      { start: 1000, end: 4000, text: '甲乙丙丁戊己庚辛壬癸天地' },
      { start: 4000, end: 5000, text: '玄黄宇宙' },
    ]);
  });

  test(`${track} 波形时间入口调整文字断点仍固定时间`, async ({ page }) => {
    await openEditor(page);
    await page.evaluate(track => {
      const cue = { id: 'extra-1', start: 1000, end: 5000, text: '甲乙丙丁戊己庚辛壬癸天地玄黄宇宙' };
      MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
        tracks: [{ id: 'ext-1', role: 'extension', split_mode: 'continuous', segments: [{ ...cue }] }], bindings: [] };
      MaweBoot.DATA.overlay_track = { enabled: true, segments: [{ ...cue }] };
      MaweCuePanel.renderAll({ waveform: 'full' });
      if (track === 'extension') MaweSplitCore.openExtensionSplitModal(0, 1500, MaweMultiSubtitleCore.getActiveExtensionTrack());
      else MaweOverlaySplitMerge.openOverlaySplitModal(0, 1500);
    }, track);
    await expect(page.locator('#multi-subtitle-split-modal')).toBeVisible();
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => ({
      offset: MaweSplitCore.pendingLinkedSplit.offset,
      cut: MaweSplitCore.pendingLinkedSplit.extensionCutMs,
    }))).toEqual({ offset: 12, cut: 1500 });
  });
}

test('绑定的主副字幕拆分确认后继续编辑主字幕后半句', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].id = 'main-1';
    MaweBoot.DATA.multi_subtitle = { schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{ id: 'ext-1', role: 'extension', split_mode: 'continuous',
        segments: [{ id: 'ext-cue', start: 1000, end: 5000, text: '甲乙丙丁' }] }],
      bindings: [{ id: 'pair', track_id: 'ext-1', main_segment_ids: ['main-1'],
        extension_segment_ids: ['ext-cue'], start_offset_ms: 0, end_offset_ms: 0 }] };
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweCoreState.waveformEditor.openCueQuickEditAtIndex('main', 0);
  });
  const input = page.locator('.waveform-cue-quick-edit textarea');
  await expect(input).toHaveValue('第一句原文');
  await input.evaluate(el => el.setSelectionRange(2, 2));
  await input.press('Enter');
  await expect(page.locator('#multi-subtitle-split-modal')).toBeVisible();
  await page.locator('#multi-subtitle-split-confirm').click();
  await expect(input).toHaveValue('句原文');
  await expect(input).toBeFocused();
});

test('横向与纵向滚动后按实际视口定位气泡', async ({ page }) => {
  await openEditor(page);
  await page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first().dblclick();
  const geometry = await page.evaluate(() => {
    const editor = MaweCoreState.waveformEditor;
    editor.content.style.minWidth = '2400px';
    editor.scroll.style.overflowX = 'auto';
    editor.scroll.scrollTop = 200;
    editor.scroll.scrollLeft = 300;
    const view = editor.scroll.getBoundingClientRect();
    const content = editor.content.getBoundingClientRect();
    const state = editor.cueQuickEdit;
    state.anchor = { pointerX: view.left - content.left + 30,
      blockTop: view.top - content.top + 12, blockBottom: view.top - content.top + 32 };
    editor.positionCueQuickEdit();
    const popup = state.element.getBoundingClientRect();
    return { left: popup.left - view.left, top: popup.top - view.top,
      scrollLeft: editor.scroll.scrollLeft, scrollTop: editor.scroll.scrollTop };
  });
  expect(geometry.scrollLeft).toBeGreaterThan(0);
  expect(geometry.scrollTop).toBeGreaterThan(0);
  expect(geometry.left).toBeGreaterThanOrEqual(3);
  expect(geometry.left).toBeLessThan(7);
  expect(geometry.top).toBeGreaterThanOrEqual(39);
  expect(geometry.top).toBeLessThanOrEqual(41);
});

test('双击主轨字幕块：气泡在块上方弹出，Ctrl+Enter 提交并支持撤销', async ({ page }) => {
  await openEditor(page);
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  await expect(block).toBeVisible();
  const blockBox = await block.boundingBox();
  await page.mouse.dblclick(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);

  const popup = page.locator('.waveform-cue-quick-edit');
  await expect(popup).toBeVisible();
  const textarea = popup.locator('textarea');
  await expect(textarea).toHaveValue('第一句原文');
  await expect(textarea).toBeFocused();

  // 第一行片段上方空间不足时气泡翻到下方（跨行用例验证上方定位）；
  // 无论哪个方向都必须与被双击的块相邻，不能漂到别处。
  const popupBox = await popup.boundingBox();
  const above = popupBox.y + popupBox.height <= blockBox.y + 2;
  const below = popupBox.y >= blockBox.y + blockBox.height - 2;
  expect(above || below).toBe(true);
  expect(Math.abs(popupBox.x + popupBox.width / 2 - (blockBox.x + blockBox.width / 2))).toBeLessThan(8);

  await textarea.fill('第一句已改');
  await textarea.press('Control+Enter');
  await expect(popup).toHaveCount(0);
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="0"] .waveform-cue-label'))
    .toHaveText('第一句已改');
  await expect(page.locator('.cue[data-idx="0"] .text')).toContainText('第一句已改');

  // 提交走了命令事务：Ctrl+Z 撤销后波形与列表一起恢复原文。
  await page.keyboard.press('Control+z');
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="0"] .waveform-cue-label'))
    .toHaveText('第一句原文');
});

test('Esc 关闭气泡并保留修改，Shift+Enter 换行保留在文本内', async ({ page }) => {
  await openEditor(page);
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  const blockBox = await block.boundingBox();
  await page.mouse.dblclick(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);

  const popup = page.locator('.waveform-cue-quick-edit');
  const textarea = popup.locator('textarea');
  await expect(textarea).toBeFocused();
  await textarea.fill('Esc 保留');
  await textarea.press('Shift+Enter');
  await textarea.type('第二行');
  await textarea.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="0"] .waveform-cue-label'))
    .toHaveText('Esc 保留 第二行');
});

test('跨行字幕：双击哪一行片段，气泡就在那一行片段上方弹出', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => window.MaweCoreState.waveformEditor?.revealTime(35000, true));
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.waveform-row')];
    return rows.some((row) => Number(row.dataset.startMs) === 30000
      && row.querySelector('.waveform-cue-block[data-idx="1"]'));
  });
  const fragment = page.locator('.waveform-row[data-start-ms="30000"] .waveform-cue-block[data-idx="1"]');
  await expect(fragment).toBeVisible();
  const fragmentBox = await fragment.boundingBox();
  const clickX = fragmentBox.x + fragmentBox.width / 2;
  const clickY = fragmentBox.y + fragmentBox.height / 2;
  await page.mouse.dblclick(clickX, clickY);

  const popup = page.locator('.waveform-cue-quick-edit');
  await expect(popup).toBeVisible();
  await expect(popup.locator('textarea')).toHaveValue('跨行长句需要分片显示');
  // 气泡在双击命中的片段（30s–40s 行内）上方，而不是第一行片段上方。
  const popupBox = await popup.boundingBox();
  expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(fragmentBox.y + 2);
  expect(Math.abs(popupBox.x + popupBox.width / 2 - clickX)).toBeLessThan(8);
});

test('编辑光标跟随双击位置：点标签左侧插入句首，点右侧追加句尾', async ({ page }) => {
  await openEditor(page);
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  const label = block.locator('.waveform-cue-label');
  await expect(label).toBeVisible();
  const labelBox = await label.boundingBox();

  // 靠近标签左缘双击：光标落在句首（不是全选），输入插到最前面。
  await page.mouse.dblclick(labelBox.x + 1, labelBox.y + labelBox.height / 2);
  const popup = page.locator('.waveform-cue-quick-edit');
  const textarea = popup.locator('textarea');
  await expect(textarea).toBeFocused();
  const selection = await textarea.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd }));
  expect(selection.end - selection.start).toBe(0);
  expect(selection.start).toBeLessThanOrEqual(1);
  await textarea.type('左');
  await textarea.press('Control+Enter');
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="0"] .waveform-cue-label'))
    .toHaveText('左第一句原文');

  // 标签右侧之外（块内）双击：钳制到标签右缘，光标落在句尾，输入追加。
  const labelBoxAfter = await label.boundingBox();
  await page.mouse.dblclick(labelBoxAfter.x + labelBoxAfter.width + 30, labelBoxAfter.y + labelBoxAfter.height / 2);
  await expect(popup.locator('textarea')).toBeFocused();
  await popup.locator('textarea').type('右');
  await popup.locator('textarea').press('Control+Enter');
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="0"] .waveform-cue-label'))
    .toHaveText('左第一句原文右');
});

test('N 键创建空字幕：弹出气泡直接输入，Ctrl+Enter 保存为新字幕文本', async ({ page }) => {
  await openEditor(page);
  // 指针悬停在第二行（10–20s）的空白区，N 从指针位置创建一条空字幕。
  const row = page.locator('.waveform-row[data-start-ms="10000"]');
  await expect(row).toBeVisible();
  const rowBox = await row.boundingBox();
  await page.mouse.move(rowBox.x + rowBox.width * 0.2, rowBox.y + rowBox.height / 2);
  await page.keyboard.press('n');

  const popup = page.locator('.waveform-cue-quick-edit');
  await expect(popup).toBeVisible();
  const textarea = popup.locator('textarea');
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue('');

  await textarea.type('N 键新建');
  await textarea.press('Control+Enter');
  await expect(popup).toHaveCount(0);
  // 新字幕插在 25s 之前，成为第 2 条；波形与列表同步显示新文本。
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="1"] .waveform-cue-label'))
    .toHaveText('N 键新建');
  await expect(page.locator('.cue[data-idx="1"] .text')).toContainText('N 键新建');
});

test('气泡内 Tab / Shift+Tab 切换同轨字幕继续编辑，离开即提交', async ({ page }) => {
  await openEditor(page);
  const block = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  const box = await block.boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  const popup = page.locator('.waveform-cue-quick-edit');
  const textarea = popup.locator('textarea');
  await expect(textarea).toBeFocused();

  await textarea.fill('Tab 提交');
  await textarea.press('Tab');
  // 离开即提交：第 1 句的波形标签已更新。
  await expect(page.locator('.waveform-cue-block[data-track="main"][data-idx="0"] .waveform-cue-label'))
    .toHaveText('Tab 提交');
  // 气泡切到第 2 句（25s 起的跨行句），滚动定位后重新弹出并聚焦。
  await expect(popup).toBeVisible();
  await expect(textarea).toHaveValue('跨行长句需要分片显示');
  await expect(textarea).toBeFocused();

  // Shift+Tab 回到第 1 句，文本是刚提交过的版本。
  await textarea.press('Shift+Tab');
  await expect(textarea).toHaveValue('Tab 提交');
  await expect(textarea).toBeFocused();

  // 末句再按 Tab：没有下一句，保持当前气泡不动。
  await textarea.press('Tab');
  await expect(textarea).toHaveValue('跨行长句需要分片显示');
  await expect(textarea).toBeFocused();
});

test('选中字幕按 Enter：弹出快速编辑气泡，Esc 后再按 Enter 重新弹出', async ({ page }) => {
  await openEditor(page);
  // 单击字幕列表第一句选中（面板目标随之切换）。
  await page.locator('.cue[data-idx="0"]').first().click();
  await page.keyboard.press('Enter');
  const popup = page.locator('.waveform-cue-quick-edit');
  await expect(popup).toBeVisible();
  const textarea = popup.locator('textarea');
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue('第一句原文');

  // Esc 关闭（焦点回到页面），再按 Enter 可重新弹出同一句。
  await textarea.press('Escape');
  await expect(popup).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(popup).toBeVisible();
  await expect(textarea).toHaveValue('第一句原文');
});

test('字词码模式：双击字词块弹出字词气泡，等长改字同步句文本与字词', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => window.MaweWordTiming.setEnabled(true));
  // 开字词码会切换行几何并恢复视口；第一句的字词条带可能落在视口上方
  // 的缓冲行里。直接滚回顶部并等字词块真正进入视口（虚拟化重建会让
  // scrollIntoViewIfNeeded 的稳定性检查超时，不能用）。
  await page.evaluate(() => { window.MaweCoreState.waveformEditor.scroll.scrollTop = 0; });
  await page.waitForFunction(() => {
    const block = document.querySelector('.waveform-word-block[data-segment-idx="0"][data-item-idx="0"]');
    if (!block) return false;
    const rect = block.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  const word = page.locator('.waveform-word-block[data-segment-idx="0"][data-item-idx="0"]').first();
  await expect(word).toBeVisible();
  const wordBox = await word.boundingBox();
  await page.mouse.dblclick(wordBox.x + wordBox.width / 2, wordBox.y + wordBox.height / 2);

  const popup = page.locator('.waveform-cue-quick-edit');
  await expect(popup).toBeVisible();
  const textarea = popup.locator('textarea');
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue('第一');

  // 等长改字 '第一' → '第A'：句文本与字词文字经既有同步一起更新。
  await textarea.fill('第A');
  await textarea.press('Enter');
  await expect(popup).toHaveCount(0);
  await expect(page.locator('.waveform-word-block[data-item-idx="0"] .waveform-word-label').first())
    .toHaveText('第A');
  await expect(page.locator('.cue[data-idx="0"] .text')).toContainText('第A句原文');

  // 字词气泡内 Tab 切到同句下一个字词，Shift+Tab 切回。
  await page.mouse.dblclick(wordBox.x + wordBox.width / 2, wordBox.y + wordBox.height / 2);
  await expect(textarea).toHaveValue('第A');
  await textarea.press('Tab');
  await expect(textarea).toHaveValue('句原文');
  await expect(popup.locator('.waveform-cue-quick-edit-caption')).toContainText('#2');

  // 末字词再按 Tab：invalid 提示，气泡保持在最后一个字词。
  await textarea.press('Tab');
  await expect(page.locator('.hint-card').last()).toContainText('当前已经是最后一个字词码，无法跳转');
  await expect(textarea).toHaveValue('句原文');
  await expect(textarea).toBeFocused();
  await textarea.press('Shift+Tab');
  await expect(textarea).toHaveValue('第A');

  // 字词码模式下整句块双击不再被拦截：弹出字幕气泡（句文本）。
  const cueBlock = page.locator('.waveform-cue-block[data-track="main"][data-idx="0"]').first();
  await expect(cueBlock).toBeVisible();
  const cueBox = await cueBlock.boundingBox();
  await page.mouse.dblclick(cueBox.x + cueBox.width / 2, cueBox.y + cueBox.height / 2);
  await expect(popup).toBeVisible();
  await expect(textarea).toHaveValue('第A句原文');
  await textarea.press('Escape');
  await expect(popup).toHaveCount(0);
});

test('word-playback: 双击字词编辑不切换播放，随后双击空白波形仍切换播放', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    const editor = window.MaweCoreState.waveformEditor;
    window.__playbackToggleCount = 0;
    editor.options.togglePlayback = () => { window.__playbackToggleCount += 1; };
    window.MaweWordTiming.setEnabled(true);
    editor.scroll.scrollTop = 0;
  });
  const word = page.locator('.waveform-word-block[data-segment-idx="0"][data-item-idx="0"]').first();
  await expect(word).toBeVisible();
  const box = await word.boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  const popup = page.locator('.waveform-cue-quick-edit');
  await expect(popup.locator('textarea')).toHaveValue('第一');
  expect(await page.evaluate(() => window.__playbackToggleCount)).toBe(0);
  await popup.locator('textarea').press('Escape');

  const blank = await page.evaluate(() => {
    const row = document.querySelector('.waveform-word-block[data-segment-idx="0"]').closest('.waveform-row');
    const rect = row.getBoundingClientRect();
    for (let y = rect.top + 5; y < rect.bottom - 5; y += 5) {
      for (let x = rect.right - 10; x > rect.left + rect.width / 2; x -= 10) {
        const target = document.elementFromPoint(x, y);
        if (target && target.closest('.waveform-row') === row
            && !target.closest('.waveform-cue-block, .waveform-gap-block, .waveform-word-block, .waveform-word-boundary, .waveform-marker-track')) return { x, y };
      }
    }
    throw new Error('No blank waveform point');
  });
  await page.mouse.dblclick(blank.x, blank.y);
  await expect.poll(() => page.evaluate(() => window.__playbackToggleCount)).toBe(1);
});

test('滚动后贴近视口顶部的块：气泡翻到下方且完整可见，Ctrl+S 落盘气泡文字', async ({ page }) => {
  await openEditor(page);
  // 滚动波形让第二句的首个片段落在视口顶部工具栏下方一点（旧实现会按
  // 内容顶部误判「上方充足」，气泡被滚动容器裁掉）。内容在滚动容器内有
  // 内部偏移，用块的实时 rect 相对滚动，不手工换算 offsetTop。
  await page.evaluate(() => {
    const editor = window.MaweCoreState.waveformEditor;
    const block = document.querySelector('.waveform-row[data-start-ms="20000"] .waveform-cue-block[data-idx="1"]');
    const rect = block.getBoundingClientRect();
    const viewport = editor.scroll.getBoundingClientRect();
    // 下移 110px：视口最顶部被悬浮波形工具栏覆盖，块要落在工具栏下方。
    editor.scroll.scrollTop += Math.round(rect.top - viewport.top) - 110;
  });
  await page.waitForFunction(() => {
    const block = document.querySelector('.waveform-row[data-start-ms="20000"] .waveform-cue-block[data-idx="1"]');
    if (!block) return false;
    const rect = block.getBoundingClientRect();
    const viewport = document.getElementById('waveform-scroll').getBoundingClientRect();
    return rect.top >= viewport.top + 85 && rect.top <= viewport.top + 135;
  });
  const fragment = page.locator('.waveform-row[data-start-ms="20000"] .waveform-cue-block[data-idx="1"]');
  const fragmentBox = await fragment.boundingBox();
  await page.mouse.dblclick(fragmentBox.x + fragmentBox.width / 2, fragmentBox.y + fragmentBox.height / 2);

  const popup = page.locator('.waveform-cue-quick-edit');
  await expect(popup).toBeVisible();
  const textarea = popup.locator('textarea');
  await expect(textarea).toHaveValue('跨行长句需要分片显示');
  // 气泡完整落在波形滚动视口内（不被顶部裁剪）。
  const popupBox = await popup.boundingBox();
  const scrollRect = await page.evaluate(() => {
    const rect = document.getElementById('waveform-scroll').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  expect(popupBox.y).toBeGreaterThanOrEqual(scrollRect.top);
  expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(scrollRect.bottom + 2);

  // 气泡内输入后直接 Ctrl+S：保存前先提交气泡文字，磁盘工程包含新文本，
  // 气泡保持打开可继续编辑。
  await textarea.fill('滚动后已改');
  await page.keyboard.press('Control+s');
  await expect(textarea).toHaveValue('滚动后已改');
  await expect(popup).toBeVisible();
  await expect(page.locator('.waveform-cue-block[data-idx="1"] .waveform-cue-label').first())
    .toHaveText('滚动后已改');
  await expect.poll(() => readFileSync(projectPath, 'utf8'), { timeout: 10_000 })
    .toContain('滚动后已改');
});
