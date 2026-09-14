// ASS 导出 UI 回归：验证编辑器当前选中的字体、字号和颜色确实写进保存的文件。
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  disableOnboarding,
  findFreePort,
  generateWav,
  generateWaveformPayload,
  makeTempDir,
  startServer,
} from './helpers.mjs';

const DURATION_MS = 4_000;

function generateAssProjectJson(filePath) {
  const project = {
    media: 'synthetic.wav',
    segments: [
      { start: 1000, end: 2500, text: '第一行\nSecond, {literal}\\path' },
      { start: 3000, end: 3500, text: '不应导出', disabled: true },
    ],
    preview: {
      subtitle: {
        x: 0.1,
        y: 0.76,
        width: 0.8,
        height: 0.16,
        font_size: 32,
        font_family: 'yahei',
        color: '#123456',
      },
    },
    waveform: generateWaveformPayload(DURATION_MS),
  };
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
  return filePath;
}

async function stubSavePicker(page) {
  await page.addInitScript(() => {
    window.__exportSaves = [];
    window.showSaveFilePicker = async (options) => ({
      name: options.suggestedName,
      async createWritable() {
        return {
          async write(blob) {
            window.__exportSaves.push({
              suggestedName: options.suggestedName,
              content: await blob.text(),
            });
          },
          async close() {},
        };
      },
    });
  });
}

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('ass-export');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateAssProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('exports ASS with the current font, size, color and enabled subtitle text', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);

  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-subtitle-style').click();
  await expect(page.locator('#editor-settings-page-subtitle-style')).toBeVisible();
  await page.locator('#subtitle-font-family').selectOption('hei');
  await page.locator('#subtitle-font-size').selectOption('40');
  await page.locator('#subtitle-color').evaluate((input) => {
    input.value = '#12abef';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await page.locator('#editor-settings-close').click();
  await page.locator('#subtitle-export-btn').click();
  await expect(page.locator('#download-full-ass')).toHaveText('带样式的 ASS 字幕');
  await page.locator('#download-full-ass').click();

  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const save = await page.evaluate(() => window.__exportSaves[0]);
  expect(save.suggestedName).toMatch(/\.ass$/);
  expect(save.content).toContain(
    'Style: Default,SimHei,160,&H00EFAB12,&H00EFAB12,',
  );
  expect(save.content).toContain(
    'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,第一行\\NSecond, \\{literal\\}\\\\path',
  );
  expect(save.content).not.toContain('不应导出');
});

test('writes the project title, source resolution, palette styles and speaker names to ASS', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.media_metadata = { video_width: 3840, video_height: 2160 };
    MaweBoot.DATA.segments = [
      { start: 0, end: 1000, text: 'red line', items: [], color: { name: 'red', value: '#f07f6f' } },
      { start: 1200, end: 2200, text: 'plain line', items: [] },
    ];
    MaweBoot.DATA.preview.subtitle = {
      ...MaweBoot.DATA.preview.subtitle,
      font_size: 32,
      font_family: 'sans',
      color: '#ffffff',
      speaker_labels: {
        mapping_enabled: true,
        enabled: true,
        separator: '：',
        names: { yellow: '主持', green: '嘉宾', red: '旁白', purple: '现场', blue: '字幕' },
      },
    };
    MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels = true;
    MaweCuePanel.renderAll();
  });

  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-full-ass').click();

  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const save = await page.evaluate(() => window.__exportSaves[0]);
  expect(save.content).toContain('Title: project');
  expect(save.content).toContain('PlayResX: 3840');
  expect(save.content).toContain('PlayResY: 2160');
  expect(save.content).toContain('Style: Default,Arial,256,');
  expect(save.content).toContain('Style: YELLOW,Arial,256,&H0019A0C4,&H0019A0C4,');
  expect(save.content).toContain('Style: GREEN,Arial,256,&H006ABB66,&H006ABB66,');
  expect(save.content).toContain('Style: RED,Arial,256,&H006F7FF0,&H006F7FF0,');
  expect(save.content).toContain('Style: PURPLE,Arial,256,&H00E689BF,&H00E689BF,');
  expect(save.content).toContain('Style: BLUE,Arial,256,&H00FAA761,&H00FAA761,');
  expect(save.content).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,RED,旁白,0,0,0,,旁白：red line');
});

test('groups SRT, color-split SRT and styled ASS exports in order', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].color = { name: 'red', value: '#e74c3c', start: 1000, end: 2500 };
    MaweCuePanel.renderAll();
  });

  await page.locator('#subtitle-export-btn').click();
  await expect(page.locator('#subtitle-export-separator')).toBeVisible();
  await expect(page.locator('#subtitle-export-menu > .dropdown-item:visible').allTextContents())
    .resolves.toEqual(['完整 SRT 字幕', '按颜色拆分导出 SRT 字幕', '带样式的 ASS 字幕']);
});

test('exports a gap-removed styled ASS subtitle with shifted timing', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.segments.length = 0;
    MaweBoot.DATA.segments.push(
      { id: 'before-gap', start: 1000, end: 2000, text: 'before gap', items: [], color: { name: 'red', value: '#e74c3c', start: 1000, end: 2000 } },
      { id: 'after-gap', start: 4000, end: 5000, text: 'after gap', items: [] },
    );
    MaweBoot.DATA.gap_remove = {
      schema: 'moy.asr.gap_remove.v1',
      detector: 'audio_gate',
      minimum_ms: 500,
      threshold_db: -24,
      hysteresis_db: 2,
      lead_in_ms: 40,
      lead_out_ms: 80,
      skip_playback: true,
      operation_mode: 'boundary_drag',
      manual_corrections: false,
      gaps: [{ start: 2000, end: 3000, removed: true }],
    };
    MaweGapRemoveUi.updateGapRemoveUi();
    MaweCuePanel.renderAll();
  });

  await page.locator('#gap-removed-export-btn').click();
  await expect(page.locator('#gap-removed-subtitle-export-separator')).toBeVisible();
  await expect(page.locator('#gap-removed-export-menu > .dropdown-item:visible').allTextContents())
    .resolves.toEqual(['SRT 字幕', '按颜色拆分导出 SRT 字幕', '带样式的 ASS 字幕']);
  await expect(page.locator('#gap-removed-otio-menu').locator('xpath=preceding-sibling::*[1]'))
    .toHaveText('OpenTimelineIO');

  await page.locator('#download-gap-removed-ass').click();
  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const save = await page.evaluate(() => window.__exportSaves[0]);
  expect(save.suggestedName).toBe('project_去空隙.ass');
  expect(save.content).toContain(
    'Dialogue: 0,0:00:01.00,0:00:02.00,RED,,0,0,0,,before gap',
  );
  expect(save.content).toContain(
    'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,after gap',
  );
});
