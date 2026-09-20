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

test('exports ASS from the default profile style and keeps enabled subtitle text', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);

  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-subtitle-style').click();
  await expect(page.locator('#editor-settings-page-subtitle-style')).toBeVisible();
  // 预览字体是带 datalist 搜索的输入框；预览设置只影响播放器画面，
  // 不应写进按样式库导出的 ASS。
  await page.locator('#subtitle-font-family').fill('黑体');
  await page.locator('#subtitle-font-family').blur();
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
  // 工程没有视频分辨率元数据，PlayRes 回退 1920×1080；
  // 默认方案关联的库样式（默认字体 72 @1080p 参考）按 1:1 输出。
  // 默认 ASS 字体按操作系统选择，从页面读取期望值保持测试平台无关。
  const assDefaultFont = await page.evaluate(() => window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE.fontName);
  expect(save.content).toContain(
    `Style: Default,${assDefaultFont},72,&H00FFFFFF,&H00FFFFFF,`,
  );
  expect(save.content).not.toContain('SimHei');
  expect(save.content).not.toContain('#12abef');
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
    DATA.media_metadata = { video_width: 3840, video_height: 2160 };
    DATA.segments = [
      { start: 0, end: 1000, text: 'red line', items: [], color: { name: 'red', value: '#f07f6f' } },
      { start: 1200, end: 2200, text: 'plain line', items: [] },
    ];
    DATA.preview.subtitle = {
      ...DATA.preview.subtitle,
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
    EDITOR_SETTINGS.exportSpeakerLabels = true;
    renderAll();
  });

  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-full-ass').click();

  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const save = await page.evaluate(() => window.__exportSaves[0]);
  expect(save.content).toContain('Title: project');
  expect(save.content).toContain('PlayResX: 3840');
  expect(save.content).toContain('PlayResY: 2160');
  // 库样式字号按 1080p 参考存储，导出时换算到 PlayResY：72 × 2160/1080 = 144。
  const assDefaultFont = await page.evaluate(() => window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE.fontName);
  expect(save.content).toContain(`Style: Default,${assDefaultFont},144,`);
  expect(save.content).toContain(`Style: YELLOW,${assDefaultFont},144,&H0019A0C4,&H0019A0C4,`);
  expect(save.content).toContain(`Style: GREEN,${assDefaultFont},144,&H006ABB66,&H006ABB66,`);
  expect(save.content).toContain(`Style: RED,${assDefaultFont},144,&H006F7FF0,&H006F7FF0,`);
  expect(save.content).toContain(`Style: PURPLE,${assDefaultFont},144,&H00E689BF,&H00E689BF,`);
  expect(save.content).toContain(`Style: BLUE,${assDefaultFont},144,&H00FAA761,&H00FAA761,`);
  expect(save.content).toContain(
    'Dialogue: 0,0:00:00.00,0:00:01.00,RED,旁白,0,0,0,,{\\c&H006F7FF0&}旁白：{\\c&H006F7FF0&}red line',
  );
});

test('exports speaker-only ASS label colour without a palette style variant', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.media_metadata = { video_width: 1920, video_height: 1080 };
    DATA.segments = [
      { start: 0, end: 1000, text: 'red line', items: [], color: { name: 'red', value: '#f07f6f' } },
    ];
    DATA.preview.subtitle = {
      ...DATA.preview.subtitle,
      ass_color_style: 'speaker',
      speaker_labels: {
        mapping_enabled: true,
        enabled: true,
        separator: '：',
        names: { yellow: '主持', green: '嘉宾', red: '旁白', purple: '现场', blue: '字幕' },
      },
    };
    EDITOR_SETTINGS.exportSpeakerLabels = true;
    renderAll();
  });

  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-full-ass').click();
  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const save = await page.evaluate(() => window.__exportSaves[0]);
  const baseColor = await page.evaluate(() => (
    window.AsrEditorUtils.assColorFromHex(window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE.primaryColor)
  ));
  const baseFont = await page.evaluate(() => window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE.fontName);

  expect(save.content).toContain(`Style: Default,${baseFont},72,`);
  expect(save.content).not.toContain('Style: RED,');
  expect(save.content).toContain(
    `Dialogue: 0,0:00:00.00,0:00:01.00,Default,旁白,0,0,0,,{\\c&H006F7FF0&}旁白：{\\c${baseColor}&}red line`,
  );
});

test('groups SRT, color-split SRT and styled ASS exports in order', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.segments[0].color = { name: 'red', value: '#e74c3c', start: 1000, end: 2500 };
    renderAll();
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
    DATA.segments.length = 0;
    DATA.segments.push(
      { id: 'before-gap', start: 1000, end: 2000, text: 'before gap', items: [], color: { name: 'red', value: '#e74c3c', start: 1000, end: 2000 } },
      { id: 'after-gap', start: 4000, end: 5000, text: 'after gap', items: [] },
    );
    DATA.gap_remove = {
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
    updateGapRemoveUi();
    renderAll();
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

test('keeps ASS style actions and preview-mode hints attached to the active form', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);

  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-subtitle-style').click();
  await page.locator('#ass-style-manager-open').click();
  await expect(page.locator('#ass-style-window')).toBeVisible();
  await expect(page.locator('.ass-style-editor-toolbar')).toHaveCount(0);
  await expect(page.locator('#ass-style-form #ass-style-delete')).toBeAttached();
  await expect(page.locator('#ass-style-list .ass-style-list-preview-hint')).toHaveCount(0);
  await expect(page.locator('#ass-style-preview-mode-hint'))
    .toBeVisible();
  await expect(page.locator('.ass-style-preview-mode-hint-prefix'))
    .toHaveText('需要启用 ASS 字幕模式来预览效果。');
  await expect(page.locator('.ass-style-preview-mode-hint-status'))
    .toHaveText('当前未启用。');
  await expect(page.locator('#ass-style-preview-mode-hint'))
    .toHaveAttribute('data-ass-preview-mode', 'disabled');
  await expect(page.locator('#ass-style-preview-mode-hint'))
    .toHaveCSS('font-size', '12px');

  await page.locator('#ass-style-list [data-ass-selection-id="default"]').click();
  await expect(page.locator('#ass-style-form-title')).toHaveText('SRT 默认');
  await expect(page.locator('#ass-style-srt-hint'))
    .toHaveText('这里用来配置 SRT 字幕默认烧录样式，用于工具箱的「烧录字幕」功能。');
  await expect(page.locator('#ass-style-srt-hint')).toBeVisible();
  await expect(page.locator('#ass-style-preview-mode-hint')).toBeHidden();
  await expect(page.locator('.ass-style-assignment-title-row')).toHaveCount(0);
  await expect(page.locator('.ass-style-assignment-card small').first())
    .toHaveText('工具箱的「烧录字幕」功能会使用这里选中的样式。');

  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await expect(page.locator('#ass-style-preview-mode-hint')).toBeVisible();

  await page.locator('#ass-style-settings-link').click();
  await expect(page.locator('#editor-settings-page-subtitle-style')).toBeVisible();
  await page.evaluate(() => {
    assModeToggle.checked = true;
    assModeToggle.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.ass-style-preview-mode-hint-prefix'))
    .toHaveText('需要启用 ASS 字幕模式来预览效果。');
  await expect(page.locator('.ass-style-preview-mode-hint-status'))
    .toHaveText('当前已启用。');
  await expect(page.locator('#ass-style-preview-mode-hint'))
    .toHaveAttribute('data-ass-preview-mode', 'enabled');

  await page.locator('#ass-profile-list [role="option"]').first().click();
  const deleteButtonParent = await page.locator('#ass-style-delete').evaluate((element) => element.parentElement?.id);
  expect(deleteButtonParent).toBe('ass-profile-delete-slot');
});
