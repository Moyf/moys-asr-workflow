import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBrowserEditorFixture, cleanupTempDir, disableOnboarding, findFreePort,
  generateWaveformPayload, makeTempDir, startStaticServer } from './helpers.mjs';

let dir, server;
test.beforeAll(async () => {
  dir = makeTempDir('editor-feedback-layout');
  server = await startStaticServer(buildBrowserEditorFixture(join(dir, 'editor.html')), await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });

async function openProject(page) {
  await disableOnboarding(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('moy.asr.waveform.settings.v1')) {
      localStorage.setItem('moy.asr.waveform.settings.v1', JSON.stringify({ rowHeight: 192 }));
    }
  });
  await page.goto(server.url);
  await page.evaluate(waveform => {
    const segment = (id, text, speaker) => ({ id, text, start: 1000, end: 3000,
      ...(speaker ? { speaker } : {}), items: [{ text, start: 1000, end: 3000 }] });
    MaweProjectLoad.applyCanonicalProject({
      schema: 'moy.asr.project.v2', annotation_mode: 'speaker', palette_size: 9,
      speakers: [{ id: 'a', name: '甲', color: '#d9a300' }, { id: 'b', name: '乙', color: '#42b8bc' }],
      speaker_shortcuts: { 1: 'a', 2: 'b' },
      tracks: [
        { id: 'main', role: 'main', enabled: true, name: '主字幕', segments: [
          segment('m1', '主字幕测试', 'a'), { id: 'm2', text: '没有说话人', start: 4000, end: 5000, items: [] }] },
        { id: 'secondary', role: 'secondary', enabled: true, name: '副字幕', segments: [segment('s1', '双语副字幕测试', 'b')] },
        { id: 'overlay', role: 'overlay', enabled: true, name: '叠加字幕', segments: [segment('o1', '叠加字幕测试', 'a')] },
      ], bilingual: { display_mode: 'both', active_track_id: 'secondary' }, bindings: [],
      subtitle_groups: { next_id: 1, color: [], sticker: [] }, waveform,
    }, 'layout.mosp');
  }, generateWaveformPayload(6000));
  await expect(page.locator('.waveform-cue-block[data-track="extension"]').first()).toBeVisible();
}

test('compact five plus four staggered circles and assigned-only speaker labels', async ({ page }, info) => {
  await openProject(page);
  await expect(page.locator('.cue-speaker-badge.unassigned')).toBeHidden();
  await expect(page.locator('.cue-speaker-badge').filter({ hasText: '甲' }).first()).toBeVisible();
  const readings = [];
  for (const size of [5, 9]) {
    await page.evaluate(size => {
      MaweSpeakerLabels.setPaletteSize(size);
      MaweContextMenus.showContextMenu(100, 100, 0);
    }, size);
    const swatches = page.locator('#ctxmenu .speaker-context-swatches');
    const circles = swatches.locator('[data-speaker-context-slot]');
    await expect(circles).toHaveCount(size);
    const rects = await circles.evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    expect(rects.every(r => r.width === 22 && r.height === 22)).toBe(true);
    expect(rects.slice(0, 5).every(r => Math.abs(r.y - rects[0].y) < 1)).toBe(true);
    if (size === 9) {
      expect(rects.slice(5).every(r => r.y > rects[0].y)).toBe(true);
      for (let i = 0; i < 4; i++) {
        expect(Math.abs(rects[i + 5].x - (rects[i].x + rects[i + 1].x) / 2)).toBeLessThan(1);
      }
    }
    readings.push({ size, rects });
    await page.locator('#ctxmenu').screenshot({ path: info.outputPath(`palette-${size}.png`) });
    await page.keyboard.press('Escape');
  }
  writeFileSync(info.outputPath('circle-geometry.json'), JSON.stringify(readings, null, 2));
});

test('waveform gaps and opt-in secondary color work in both modes', async ({ page }, info) => {
  await openProject(page);
  const readings = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => MaweTheme.applyTheme(theme), theme);
    for (const mode of ['multi', 'basic']) {
      await page.locator(`[data-waveform-mode="${mode}"]`).click();
      await page.locator('.waveform-cue-block[data-track="main"]').first().click({ position: { x: 25, y: 10 } });
      const geometry = await page.evaluate(() => {
        const read = track => {
          const element = document.querySelector(`.waveform-cue-block[data-track="${track}"]`);
          const r = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { top: r.top, bottom: r.bottom,
            outline: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset),
            outer: Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) };
        };
        return { main: read('main'), extension: read('extension'), overlay: read('overlay') };
      });
      expect(geometry.extension.top - geometry.main.bottom).toBeCloseTo(3, 1);
      expect(geometry.main.outline).toBe(2);
      expect(geometry.main.offset).toBe(0);
      expect(geometry.extension.top - geometry.extension.outer - geometry.main.bottom - geometry.main.outer).toBeCloseTo(0, 1);
      expect(geometry.main.top - geometry.overlay.bottom).toBeGreaterThanOrEqual(3);
      readings.push({ theme, mode, ...geometry });
      await page.locator('#waveform-settings-toggle').click();
      const tooltip = page.getByLabel('悬浮显示完整字幕文本', { exact: true });
      const color = page.getByLabel('双语副字幕显示颜色', { exact: true });
      await expect(tooltip).not.toBeChecked();
      await expect(color).not.toBeChecked();
      const extension = page.locator('.waveform-cue-block[data-track="extension"]').first();
      const before = await extension.evaluate(el => getComputedStyle(el).backgroundColor);
      await color.check();
      await expect.poll(() => extension.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(before);
      await expect(extension).toHaveClass(/has-subtitle-color/);
      const margins = await tooltip.locator('..').evaluate(el => ({
        top: getComputedStyle(el).marginTop, bottom: getComputedStyle(el).marginBottom,
      }));
      expect(margins).toEqual({ top: '0px', bottom: '0px' });
      await page.locator('#waveform-settings-panel').screenshot({ path: info.outputPath(`settings-${theme}-${mode}.png`) });
      await page.locator('#waveform-settings-toggle').click();
      await page.locator('#waveform-pane').screenshot({ path: info.outputPath(`waveform-${theme}-${mode}.png`) });
      await page.locator('#waveform-settings-toggle').click();
      await color.uncheck();
      await page.locator('#waveform-settings-toggle').click();
    }
  }
  await page.locator('#waveform-settings-toggle').click();
  await page.getByLabel('双语副字幕显示颜色', { exact: true }).check();
  await page.reload();
  await page.locator('#waveform-settings-toggle').click();
  await expect(page.getByLabel('双语副字幕显示颜色', { exact: true })).toBeChecked();
  writeFileSync(info.outputPath('waveform-geometry.json'), JSON.stringify(readings, null, 2));
});

test('compact and normal row heights retain safe overlay bounds with word timing', async ({ page }, info) => {
  await openProject(page);
  await page.locator('[data-waveform-mode="multi"]').click();
  const readings = [];
  for (const words of [false, true]) {
    if (words) await page.locator('#word-timing-quick-toggle').click();
    for (const height of [64, 96, 120, 144, 192]) {
      await page.evaluate(height => MaweCoreState.waveformEditor.setRowHeight(height), height);
      const geometry = await page.locator('.waveform-row.multi-subtitle-row').first().evaluate(row => {
        const rowRect = row.getBoundingClientRect();
        const read = selector => {
          const el = row.querySelector(selector), r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return { top: r.top - rowRect.top - row.clientTop,
            bottom: r.bottom - rowRect.top - row.clientTop,
            outer: Math.max(0, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset)) };
        };
        return { available: row.clientHeight,
          cover: row.querySelector('.waveform-overlay-block').classList.contains('overlay-cover-mode'),
          main: read('[data-track="main"]'), extension: read('[data-track="extension"]'),
          overlay: read('[data-track="overlay"]') };
      });
      readings.push({ words, height, ...geometry });
      expect(geometry.extension.top - geometry.main.bottom).toBeCloseTo(3, 1);
      expect(geometry.overlay.top).toBeGreaterThanOrEqual(0);
      expect(geometry.overlay.bottom).toBeLessThanOrEqual(geometry.available);
      if (!geometry.cover) {
        expect(geometry.overlay.top - geometry.overlay.outer).toBeGreaterThanOrEqual(0);
        expect(geometry.main.top - geometry.overlay.bottom).toBeCloseTo(3, 1);
      }
      await page.locator('#waveform-pane').screenshot({ path: info.outputPath(`height-${height}-words-${words}.png`) });
    }
  }
  writeFileSync(info.outputPath('height-geometry.json'), JSON.stringify(readings, null, 2));
});
