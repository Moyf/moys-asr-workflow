import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir, disableOnboarding, findFreePort, generateWav,
  generateWaveformPayload, makeTempDir, startServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('bilingual-label-contrast');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, 10);
  writeFileSync(projectPath, JSON.stringify({
    media: mediaPath,
    waveform: generateWaveformPayload(10000),
    segments: [
      { id: 'main-1', start: 1000, end: 2000, text: 'Main subtitle one' },
      { id: 'main-2', start: 3000, end: 4000, text: 'Main subtitle two' },
    ],
    multi_subtitle: {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both',
      tracks: [{ id: 'translation', role: 'extension', name: 'Chinese', language: 'zh',
        split_mode: 'continuous', segments: [
          { id: 'extension-1', start: 1000, end: 2000, text: '副字幕第一句' },
          { id: 'extension-2', start: 3000, end: 4000, text: '未绑定的副字幕' },
        ] }],
      bindings: [{ id: 'pair-1', track_id: 'translation',
        main_segment_ids: ['main-1'], extension_segment_ids: ['extension-1'] }],
    },
  }), 'utf8');
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

// Resolve real computed colors, including translucent selection/hover surfaces
// and the opacity of an unbound column, against the ancestors behind each label.
async function labelContrast(page) {
  return page.locator('.multi-dual-cue .multi-cue-column-header .index').evaluateAll(labels => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v);
    };
    const composite = (front, back) => front.slice(0, 3).map((channel, i) => (
      channel * front[3] + back[i] * (1 - front[3])
    ));
    const luminance = color => color.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    return labels.map(label => {
      const ancestors = [];
      for (let node = label; node; node = node.parentElement) ancestors.unshift(node);
      let background = [255, 255, 255];
      let opacity = 1;
      for (const node of ancestors) {
        const style = getComputedStyle(node);
        opacity *= Number(style.opacity);
        const color = rgba(style.backgroundColor);
        color[3] *= opacity;
        background = composite(color, background);
      }
      const foreground = rgba(getComputedStyle(label).color);
      foreground[3] *= opacity;
      const paintedText = composite(foreground, background);
      const levels = [luminance(paintedText), luminance(background)].sort((a, b) => a - b);
      return { text: label.textContent, foreground: paintedText, background, opacity,
        ratio: (levels[1] + 0.05) / (levels[0] + 0.05),
        selected: label.closest('.cue').classList.contains('selected') };
    });
  });
}

for (const theme of ['dark', 'light']) {
  for (const language of ['zh', 'en']) {
    test(`bilingual track labels remain readable in ${theme} theme and ${language}`, async ({ page }) => {
      await disableOnboarding(page);
      await page.goto(server.url);
      await page.evaluate(({ theme, language }) => {
        MaweTheme.applyTheme(theme);
        MAWE_I18N.applyLanguage(language);
      }, { theme, language });
      const rows = page.locator('.multi-dual-cue');
      const first = rows.first();
      const labels = first.locator('.multi-cue-column-header .index');
      await expect(labels).toHaveText(language === 'zh'
        ? ['主字幕 1', '副字幕 1'] : ['Main subtitle 1', 'Secondary subtitle 1']);
      await expect(page.locator('.multi-cue-column.extension.unbound')).toHaveCount(1);
      const readings = {};
      for (const state of ['unselected', 'selected', 'selected-hover']) {
        if (state === 'selected') {
          await first.locator('.multi-cue-column.main .text').click();
          await expect(first).toHaveClass(/selected/);
        }
        if (state === 'selected-hover') await first.hover();
        else await page.mouse.move(0, 0);
        await page.locator('#cues-container').screenshot({
          path: test.info().outputPath(`bilingual-labels-${theme}-${language}-${state}.png`),
          animations: 'disabled',
        });
        readings[state] = await labelContrast(page);
      }
      const readingsPath = test.info().outputPath('bilingual-label-contrast.json');
      writeFileSync(readingsPath, JSON.stringify(readings, null, 2), 'utf8');
      await test.info().attach('bilingual-label-contrast', {
        path: readingsPath, contentType: 'application/json',
      });
      expect(readings.unselected.every(label => !label.selected)).toBe(true);
      expect(readings.selected.filter(label => label.selected)).toHaveLength(2);
      for (const [state, values] of Object.entries(readings)) {
        for (const label of values) {
          expect(label.ratio, `${state}: ${label.text} contrast`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
}
