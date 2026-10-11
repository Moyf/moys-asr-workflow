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
  startServer, closeSettingsPanels, openSettingsPage, setProjectTrackEnabled } from './helpers.mjs';

const DURATION_MS = 4_000;

test('sample Canvas contains scaled and rotated glyphs without edge clipping', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => window.MaweAssCanvas?.renderSample);
  const results = await page.evaluate(() => [0, 45, 90].map(angle => {
    const canvas = document.createElement('canvas');
    window.MaweAssCanvas.renderSample(canvas, { fontName: 'Arial', fontSize: 32, scaleX: 200, scaleY: 150,
      angle, primaryColor: '#ffffff', outline: 4, outlineColor: '#ff0000', outlineOpacity: 100,
      shadow: 4, backColor: '#000000', backOpacity: 100 }, 'Sample 字幕');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0, edge = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (!pixels[(y * canvas.width + x) * 4 + 3]) continue;
      painted++;
      if (x === 0 || y === 0 || x === canvas.width - 1 || y === canvas.height - 1) edge++;
    }
    return { angle, painted, edge };
  }));
  for (const result of results) {
    expect(result.painted, `angle ${result.angle}`).toBeGreaterThan(100);
    expect(result.edge, `angle ${result.angle}`).toBe(0);
  }
});

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

test('style form groups basic controls and labels background box fields consistently', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await openSettingsPage(page, 'subtitle-style');
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await expect(page.locator('#ass-style-extended-heading')).toHaveCount(0);
  await expect(page.locator('#ass-style-primary-color').locator('..')).toContainText('字幕颜色');
  await page.locator('#ass-style-border-style').selectOption('3');
  await expect(page.locator('#ass-style-border-style option:checked')).toHaveText('背景底框');
  await expect(page.locator('#ass-style-outline-label')).toHaveText('底框宽度');
  await expect(page.locator('#ass-style-outline-opacity-label')).toHaveText('底框不透明度');
  await expect(page.locator('#ass-style-outline-color-label')).toHaveText('底框颜色');
  const layout = await page.locator('#ass-style-form').evaluate((form) => {
    const bounds = (id) => form.querySelector(`#${id}`).closest('label').getBoundingClientRect();
    const shadow = bounds('ass-style-shadow');
    const opacity = bounds('ass-style-back-opacity');
    const outline = bounds('ass-style-outline');
    const fields = form.querySelector('.ass-style-fields-extended');
    const section = form.querySelector('[aria-labelledby="ass-style-basic-heading"]');
    return { shadowWidth: shadow.width, outlineWidth: outline.width,
      sameRow: Math.abs(shadow.y - opacity.y), horizontalGap: opacity.left - shadow.right,
      basicContainsFont: section.contains(fields),
      fontGap: fields.getBoundingClientRect().top - fields.previousElementSibling.getBoundingClientRect().bottom };
  });
  expect(layout.sameRow).toBeLessThan(2);
  expect(layout.horizontalGap).toBeGreaterThanOrEqual(8);
  expect(layout.shadowWidth).toBeCloseTo(layout.outlineWidth, 0);
  expect(layout.basicContainsFont).toBe(true);
  expect(layout.fontGap).toBeGreaterThanOrEqual(8);
  await page.locator('#ass-style-form').screenshot({ path: test.info().outputPath('ass-basic-box.png') });
  await page.locator('#ass-style-border-style').selectOption('1');
  await expect(page.locator('#ass-style-outline-label')).toHaveText('描边宽度');
  await expect(page.locator('#ass-style-outline-opacity-label')).toHaveText('描边不透明度');
  await expect(page.locator('#ass-style-outline-color-label')).toHaveText('描边颜色');
});

test('exports ASS from the default profile style and keeps enabled subtitle text', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);

  await openSettingsPage(page, 'subtitle-style');
  await openSettingsPage(page, 'subtitle-style');
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

  await closeSettingsPanels(page);
  await page.locator('#subtitle-export-btn').click();
  await expect(page.locator('#download-full-ass')).toHaveText('ASS（带样式）');
  await page.locator('#download-full-ass').click();

  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const save = await page.evaluate(() => window.__exportSaves[0]);
  expect(save.suggestedName).toMatch(/\.ass$/);
  // 工程没有视频分辨率元数据，PlayRes 回退 1920×1080；
  // 默认方案关联的库样式（默认字体 86 @1080p 参考）按 1:1 输出。
  // 默认 ASS 字体按操作系统选择，从页面读取期望值保持测试平台无关。
  const assDefaultFont = await page.evaluate(() => window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE.fontName);
  expect(save.content).toContain(
    `Style: Default,${assDefaultFont},86,&H00FFFFFF,&H00FFFFFF,`,
  );
  expect(save.content).not.toContain('SimHei');
  expect(save.content).not.toContain('#12abef');
  expect(save.content).toContain(
    'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\fad(250,250)}第一行\\NSecond, \\{literal\\}\\\\path',
  );
  expect(save.content).not.toContain('不应导出');
  // 本次换行策略只调整播放器预览；ASS 导出仍保持原来的 WrapStyle。
  expect(save.content).toContain('WrapStyle: 0');
});

test('ASS preview preserves explicit line breaks without container wrapping', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);

  const preview = await page.evaluate(() => {
    MaweBoot.DATA.segments = [{
      start: 0,
      end: 4000,
      text: '第一行\nAnd **Jev can solve these two problems**',
    }];
    MaweDom.playerStage.style.cssText = 'flex: 0 0 auto; width: 180px; height: 90px;';
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const style = getComputedStyle(document.getElementById('overlay-main-text'));
    const main = window.MaweAssCanvas.lastRender.tracks[0];
    const items = main.lines.flatMap((line) => line.items);
    return {
      lineCount: main.lines.length,
      lineTexts: main.lines.map((line) => line.items.map((item) => item.text).join('')),
      maxWidth: style.maxWidth,
      whiteSpace: style.whiteSpace,
      wordBreak: style.wordBreak,
      nativeFontSize: main.nativeFontSize,
      emphasisRatio: items.find((item) => item.emphasized).cssSize
        / items.find((item) => !item.emphasized).cssSize,
    };
  });
  expect(preview.lineCount).toBe(2);
  expect(preview.lineTexts[0]).toBe('第一行');
  expect(preview.lineTexts[1]).toBe('And Jev can solve these two problems');
  expect(preview.maxWidth).toBe('none');
  expect(preview.whiteSpace).toBe('pre');
  expect(preview.wordBreak).toBe('normal');
  expect(preview.nativeFontSize).toBe(86);
  expect(preview.emphasisRatio).toBeCloseTo(Math.round(86 * 1.3) / 86, 2);

  await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay-main-text')).toHaveCSS('white-space', 'pre-wrap');
  await expect(page.locator('#overlay-main-text')).toHaveCSS('word-break', 'break-word');
});

test('inherits ASS track colours through inline formatting and keeps explicit emphasis colours', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(async () => {
    await loadAssStyleLibrary({ force: true });
    ASS_STYLE_LIBRARY = window.AsrEditorUtils.defaultAssStyleLibrary();
    const main = ASS_STYLE_LIBRARY.styles.find((entry) => entry.id === 'ass');
    const extension = ASS_STYLE_LIBRARY.styles.find((entry) => entry.id === 'ass-extension');
    Object.assign(main, { primaryColor: '#22cc55', emphasisStyle: 'stroke', emphasisColor: '#ff0000' });
    // Avoid the legacy built-in default colour that the style migration upgrades.
    Object.assign(extension, { primaryColor: '#f1d24c', emphasisStyle: 'stroke', emphasisColor: '#ff0000' });
    const text = '普通 **强调** __下划线__ ~~删除线~~ --缩小-- ++放大++';
    MaweBoot.DATA.segments = [{ id: 'main-colour', start: 1000, end: 3000, text }];
    MaweBoot.DATA.multi_subtitle = { enabled: true, tracks: [{ id: 'extension-colour', segments: [{ id: 'ext-colour', start: 1000, end: 3000, text }] }] };
    Object.assign(MaweSettings.EDITOR_SETTINGS, { assMode: true, assEmphasisSyntax: 'both', assSpecialSymbolRule: 'both',
      assUnderlineEnabled: true, assStrikeEnabled: true, assSmallTextEnabled: true, assLargeTextEnabled: true });
    MaweDom.overlayToggle.checked = true;
    MaweDom.extensionOverlayToggle.checked = true;
    MaweCoreState.player.currentTime = 1.5;
    MawePlaybackLoop.refreshSubtitlePreview(1500, 0);
  });
  const payload = await page.evaluate(() => {
    const summarize = (track) => {
      const items = track.lines.flatMap((line) => line.items);
      return {
        flaggedRuns: items.filter((item) => item.emphasized || item.underlined
          || item.struck || item.size).length,
        fills: items.map((item) => item.fill),
        emphasisStrokes: items.filter((item) => item.emphasisStroke).map((item) => item.emphasisStroke),
      };
    };
    const tracks = window.MaweAssCanvas.lastRender.tracks;
    return { main: summarize(tracks[0]), extension: summarize(tracks[1]) };
  });
  // 强调走 stroke 模式：所有 run 的填充保持轨道主色，强调描边用强调色。
  // 计数与旧 DOM 断言对齐：纯字号 run（缩小/放大）也计入。
  for (const [part, colour] of [['main', '#22cc55'], ['extension', '#f1d24c']]) {
    expect(payload[part].flaggedRuns).toBe(5);
    expect(payload[part].fills.every((fill) => fill === colour)).toBe(true);
    expect(payload[part].emphasisStrokes).toEqual(['#ff0000']);
  }
  await page.evaluate(() => {
    const style = ASS_STYLE_LIBRARY.styles.find((entry) => entry.id === 'ass-extension');
    Object.assign(style, { primaryColor: '#55aaff', emphasisStyle: 'text' });
    MawePlaybackLoop.refreshSubtitlePreview(1500, 0);
  });
  const extensionAfter = await page.evaluate(() => {
    const items = window.MaweAssCanvas.lastRender.tracks[1].lines.flatMap((line) => line.items);
    return {
      emphasized: items.filter((item) => item.emphasized).map((item) => item.fill),
      markedOthers: items.filter((item) => !item.emphasized
        && (item.underlined || item.struck || item.size))
        .map((item) => item.fill),
    };
  });
  expect(extensionAfter.emphasized).toEqual(['#ff0000']);
  expect(extensionAfter.markedOthers).toEqual(Array(4).fill('#55aaff'));
  const exportedColour = await page.evaluate(() => MaweExportSrt.buildAss().split('\n').find((line) => line.startsWith('Style: Extension,')).split(',')[3]);
  expect(exportedColour).toBe('&H00FFAA55');
  await page.locator('.player-stage').screenshot({ path: test.info().outputPath('ass-secondary-inline-colour.png') });
  await page.evaluate(() => { MaweSettings.EDITOR_SETTINGS.assMode = false; MawePlaybackLoop.refreshSubtitlePreview(1500, 0); });
  await expect(page.locator('#overlay-extension-text .ass-emphasis-runs')).toHaveCount(0);
});

test('ASS emphasis controls drive preview and inline export color', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  await openSettingsPage(page, 'subtitle-style');
  await openSettingsPage(page, 'subtitle-style');
  await openSettingsPage(page, 'special-edit');
  await expect(page.locator('#ass-inline-text-settings')).toBeHidden();
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-mode-toggle').check();
  await openSettingsPage(page, 'special-edit');
  await expect(page.locator('#ass-inline-text-settings')).toBeVisible();
  await expect(page.locator('#ass-inline-text-settings input[type=checkbox]')).toHaveCount(5);
  await expect(page.locator('#ass-inline-text-title')).toHaveText('特殊文本');
  await expect(page.locator('#ass-special-symbol-rule')).toHaveValue('both');
  await expect(page.locator('#ass-special-symbol-rule option:checked')).toHaveText('单双皆可');
  await expect(page.locator('[data-ass-symbol="_"]')).toHaveText('_下划线_/__下划线__');
  await page.locator('#ass-special-symbol-rule').selectOption('none');
  await expect(page.locator('#ass-inline-text-options')).toBeHidden();
  await page.locator('#ass-special-symbol-rule').selectOption('double');
  await expect(page.locator('#ass-inline-text-options')).toBeVisible();
  await expect(page.locator('[data-ass-symbol="_"]')).toHaveText('__下划线__');
  await page.locator('#ass-special-symbol-rule').selectOption('both');
  await expect(page.locator('[data-ass-symbol="*"]')).toHaveText('*强调*/**强调**');
  await page.locator('#ass-special-symbol-rule').selectOption('double');
  await page.locator('#ass-special-style-edit').click();
  await page.locator('#ass-style-list [data-ass-selection-id="ass"]').click();
  await expect(page.locator('#ass-style-emphasis-syntax')).toHaveCount(0);
  await expect(page.locator('#ass-emphasis-syntax')).toBeChecked();
  await expect(page.locator('#ass-style-emphasis-heading')).toHaveText('特殊文本样式');
  await expect(page.locator('#ass-style-small-text-scale')).toHaveValue('0.8');
  await expect(page.locator('#ass-style-large-text-scale')).toHaveValue('1.5');
  await expect(page.locator('#ass-style-emphasis-scale')).toHaveValue('1.3');
  await expect(page.locator('#ass-style-emphasis-scale')).toHaveAttribute('step', '0.05');
  await expect(page.locator('#ass-style-emphasis-options')).toBeVisible();
  const gap = await page.locator('#ass-style-emphasis-options').evaluate((element) => {
    const previous = element.previousElementSibling;
    return element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(8);
  await page.locator('#ass-style-emphasis-color').fill('#ff0000');
  await page.locator('#ass-style-emphasis-scale').fill('1.25');
  await page.locator('#ass-style-emphasis-style').selectOption('text');
  await page.locator('#ass-style-window-close').click();
  await page.locator('#ass-emphasis-syntax').uncheck();
  await page.locator('#ass-special-style-edit').click();
  await expect(page.locator('#ass-style-emphasis-options')).toBeHidden();
  await page.locator('#ass-style-window-close').click();
  await page.locator('#ass-emphasis-syntax').check();
  await expect(page.locator('#ass-special-symbol-rule')).toHaveValue('double');
  await closeSettingsPanels(page);

  const preview = await page.evaluate(() => {
    MaweBoot.DATA.segments = [{ start: 0, end: 4000, text: '前 **重点** 后' }];
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const items = window.MaweAssCanvas.lastRender.tracks[0].lines.flatMap((line) => line.items);
    const emphasized = items.find((item) => item.emphasized);
    const base = items.find((item) => !item.emphasized);
    return { text: items.map((item) => item.text).join(''),
      color: emphasized.fill, scale: emphasized.cssSize / base.cssSize };
  });
  expect(preview.text).toBe('前 重点 后');
  expect(preview.color).toBe('#ff0000');
  // libass rounds the emphasized font to integer native pixels.
  expect(preview.scale).toBeCloseTo(Math.round(86 * 1.25) / 86, 2);

  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-full-ass').click();
  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const ass = await page.evaluate(() => window.__exportSaves[0].content);
  expect(ass).toMatch(/前 \{\\1c&H000000FF&\\fs\d+\}重点\{\\1c&H00FFFFFF&\\fs\d+\} 后/);

  await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay-main-text')).toHaveText('前 **重点** 后');
});

test('ASS underscore markers underline only the marked preview and export text', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  const preview = await page.evaluate(() => {
    MaweBoot.DATA.segments = [{ start: 0, end: 4000, text: '前 _下划线_ 与 _**共同**_ 后' }];
    // 单符号和双符号样例在「单双皆可」规则下均参与解析。
    MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule = 'both';
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const items = window.MaweAssCanvas.lastRender.tracks[0].lines.flatMap((line) => line.items);
    return { text: items.map((item) => item.text).join(''),
      underlined: items.filter((item) => item.underlined).map((item) => ({
        text: item.text, emphasized: item.emphasized, struck: item.struck,
      })) };
  });
  expect(preview).toEqual({ text: '前 下划线 与 共同 后', underlined: [
    { text: '下划线', emphasized: false, struck: false },
    { text: '共同', emphasized: true, struck: false },
  ] });

  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-full-ass').click();
  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const ass = await page.evaluate(() => window.__exportSaves[0].content);
  expect(ass).toMatch(/\{\\u1\}下划线\{\\u0\}/);
  expect(ass).toMatch(/\\u1\}共同\{[^}]*\\u0\}/);

  await page.evaluate(() => {
    MaweSettings.EDITOR_SETTINGS.assMode = false;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay-main-text')).toHaveText('前 _下划线_ 与 _**共同**_ 后');
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
  // 库样式字号按 1080p 参考存储，导出时换算到 PlayResY：86 × 2160/1080 = 172。
  const assDefaultFont = await page.evaluate(() => window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE.fontName);
  expect(save.content).toContain(`Style: Default,${assDefaultFont},172,`);
  expect(save.content).toContain(`Style: YELLOW,${assDefaultFont},172,&H0019A0C4,&H0019A0C4,`);
  expect(save.content).toContain(`Style: GREEN,${assDefaultFont},172,&H006ABB66,&H006ABB66,`);
  expect(save.content).toContain(`Style: RED,${assDefaultFont},172,&H006F7FF0,&H006F7FF0,`);
  expect(save.content).toContain(`Style: PURPLE,${assDefaultFont},172,&H00E689BF,&H00E689BF,`);
  expect(save.content).toContain(`Style: BLUE,${assDefaultFont},172,&H00FAA761,&H00FAA761,`);
  expect(save.content).toContain(
    'Dialogue: 0,0:00:00.00,0:00:01.00,RED,旁白,0,0,0,,{\\fad(250,250)}{\\c&H006F7FF0&}旁白：{\\c&H006F7FF0&}red line',
  );
});

test('exports speaker-only ASS label colour without a palette style variant', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.media_metadata = { video_width: 1920, video_height: 1080 };
    MaweBoot.DATA.segments = [
      { start: 0, end: 1000, text: 'red line', items: [], color: { name: 'red', value: '#f07f6f' } },
    ];
    MaweBoot.DATA.preview.subtitle = {
      ...MaweBoot.DATA.preview.subtitle,
      ass_color_style: 'speaker',
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
  const baseColor = await page.evaluate(() => (
    window.AsrEditorUtils.assColorFromHex(window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE.primaryColor)
  ));
  const baseFont = await page.evaluate(() => window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE.fontName);

  expect(save.content).toContain(`Style: Default,${baseFont},86,`);
  expect(save.content).not.toContain('Style: RED,');
  expect(save.content).toContain(
    `Dialogue: 0,0:00:00.00,0:00:01.00,Default,旁白,0,0,0,,{\\fad(250,250)}{\\c&H006F7FF0&}旁白：{\\c${baseColor}&}red line`,
  );
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
    .resolves.toEqual(['SRT', 'SRT（按颜色拆分）', 'ASS（带样式）']);
});

test('exports main, secondary and combined bilingual SRT from one menu', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    MaweBoot.DATA.segments[0].text = 'Main line';
    MaweBoot.DATA.multi_subtitle = {
      schema: 'moy.asr.multi_subtitle.v1', enabled: true, display_mode: 'both', bindings: [],
      tracks: [{ id: 'extension-1', role: 'extension', name: 'English', language: 'English',
        segments: [{ id: 'ext-1', start: 1000, end: 2500, text: 'Secondary line' },
          { id: 'ext-2', start: 3000, end: 4000, text: 'Unmatched secondary' },
          { id: 'ext-3', start: 4500, end: 5000, text: 'Disabled secondary', disabled: true }] }],
    };
    MaweCuePanel.renderAll();
  });
  await page.locator('#subtitle-export-btn').click();
  const menu = page.locator('#subtitle-export-menu');
  await expect(menu.locator(':scope > .dropdown-item:visible').allTextContents())
    .resolves.toEqual(['主字幕 SRT', '副字幕 SRT', 'SRT（双语合并）', 'ASS（带样式）']);
  await expect(page.locator('.right-group > #download-multi-srt')).toHaveCount(0);
  await expect(page.locator('#subtitle-export-separator')).toBeVisible();
  const rowGaps = await menu.locator(':scope > .dropdown-item:visible').evaluateAll((items) => {
    const textBounds = items.map((item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      return range.getBoundingClientRect();
    });
    return textBounds.slice(1).map((bounds, index) => bounds.top - textBounds[index].bottom);
  });
  expect(Math.min(...rowGaps)).toBeGreaterThanOrEqual(8);
  await menu.screenshot({ path: test.info().outputPath('bilingual-export-menu.png') });
  await page.locator('#download-bilingual-srt').click();
  await expect(menu).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const combined = await page.evaluate(() => window.__exportSaves[0]);
  expect(combined.suggestedName).toMatch(/_bilingual\.srt$/);
  expect(combined.content).toBe([
    '1', '00:00:01,000 --> 00:00:02,500', 'Main line\nSecondary line', '',
    '2', '00:00:03,000 --> 00:00:04,000', 'Unmatched secondary', '',
  ].join('\n'));
  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-multi-srt').click();
  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(2);
  const secondary = await page.evaluate(() => window.__exportSaves[1]);
  expect(secondary.suggestedName).toMatch(/_extension\.srt$/);
  expect(secondary.content).toContain('Secondary line');
  expect(secondary.content).not.toContain('Main line');
  expect(secondary.content).not.toContain('Disabled secondary');
  await page.locator('#subtitle-export-btn').click();
  await page.locator('#download-full-srt').click();
  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(3);
  expect(await page.evaluate(() => window.__exportSaves[2].content)).not.toContain('Secondary line');
  await setProjectTrackEnabled(page, 'multi-subtitle-toggle', false);
  await page.locator('#subtitle-export-btn').click();
  await expect(page.locator('#download-full-srt')).toHaveText('SRT');
  await expect(page.locator('#download-multi-srt')).toBeHidden();
  await expect(page.locator('#download-bilingual-srt')).toBeHidden();
  await expect(page.locator('#subtitle-export-separator')).toBeHidden();
});

test('shows disabled secondary export entries when bilingual mode has no second track', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  page.once('dialog', (dialog) => dialog.dismiss());
  await setProjectTrackEnabled(page, 'multi-subtitle-toggle', true);
  await page.locator('#subtitle-export-btn').click();
  await expect(page.locator('#download-full-srt')).toHaveText('主字幕 SRT');
  await expect(page.locator('#download-multi-srt')).toBeVisible();
  await expect(page.locator('#download-multi-srt')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#download-bilingual-srt')).toHaveAttribute('aria-disabled', 'true');
  await page.locator('#download-bilingual-srt').click({ force: true });
  expect(await page.evaluate(() => window.__exportSaves.length)).toBe(0);
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
    .resolves.toEqual(['SRT', 'SRT（按颜色拆分）', 'ASS（带样式）', '重组后视频']);
  await expect(page.locator('#gap-removed-otio-menu').locator('xpath=preceding-sibling::*[1]'))
    .toHaveText('OTIO');

  await page.locator('#download-gap-removed-ass').click();
  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const save = await page.evaluate(() => window.__exportSaves[0]);
  expect(save.suggestedName).toBe('project_去空隙.ass');
  expect(save.content).toContain(
    'Dialogue: 0,0:00:01.00,0:00:02.00,RED,,0,0,0,,{\\fad(250,250)}before gap',
  );
  expect(save.content).toContain(
    'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\fad(250,250)}after gap',
  );
});

test('keeps ASS style actions and preview-mode hints attached to the active form', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);

  await openSettingsPage(page, 'subtitle-style');
  await openSettingsPage(page, 'subtitle-style');
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
  await expect(page.locator('label[for="ass-srt-default-style"] + small'))
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

test('refreshes inline font metrics and interpolates fs tags in native resolution', async ({ page }) => {
  await page.goto(server.url);
  await page.addStyleTag({ content: '@font-face { font-family: "ASS Metric Test"; src: local("Arial"); size-adjust: 150%; }' });
  await page.evaluate(async () => { await document.fonts.load('20px "ASS Metric Test"'); });
  const ratios = await page.evaluate(() => {
    MaweBoot.DATA.media_metadata = { video_width: 640, video_height: 360 };
    MaweBoot.DATA.segments[0].text = '字幕**强调**';
    const library = window.AsrEditorUtils.defaultAssStyleLibrary();
    const style = library.styles.find((entry) => entry.id === 'ass');
    style.fontName = 'Arial'; style.fontSize = 72; style.emphasisScale = 1.1;
    ASS_STYLE_LIBRARY = library;
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MawePlaybackLoop.refreshSubtitlePreview(1500, 0);
    const baseSize = () => {
      const items = window.MaweAssCanvas.lastRender.tracks[0].lines.flatMap((line) => line.items);
      const base = items.find((item) => !item.emphasized);
      const emphasized = items.find((item) => item.emphasized);
      return { base: base.cssSize, em: emphasized ? emphasized.cssSize : 0 };
    };
    const before = baseSize();
    style.fontName = 'ASS Metric Test';
    MawePlaybackLoop.refreshSubtitlePreview(1500, 0);
    const after = baseSize();
    const ratio = after.em / after.base;
    // A 72@1080p style exports 24px at 360p. Halfway towards \fs48 is 36,
    // so the ordinary text must be 1.5x its unanimated size, not interpolated
    // between the unrelated library value 72 and the native target 48.
    MaweBoot.DATA.segments[0].text = '普通字幕';
    library.assProfiles[0].animations.t = { enabled: true, startMs: 0, endMs: 1000, accel: 1, tags: '\\fs48' };
    MawePlaybackLoop.refreshSubtitlePreview(1500, 0);
    return { before: before.base, after: after.base, ratio, animated: baseSize().base };
  });
  expect(ratios.after).toBeLessThan(ratios.before * 0.8);
  expect(ratios.ratio).toBeCloseTo(26 / 24, 2);
  expect(ratios.animated / ratios.after).toBeCloseTo(1.5, 2);
});

test('uses outline colour for sample boxes and preserves zero scaling', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await openSettingsPage(page, 'subtitle-style');
  await openSettingsPage(page, 'subtitle-style');
  await page.locator('#ass-style-manager-open').click();
  await page.evaluate(async () => {
    await loadAssStyleLibrary({ force: true });
    assStyleManagerSetSelection('style', 'ass');
    updateAssStyleManagerLibrary((library) => {
      const style = library.styles.find((entry) => entry.id === 'ass');
      Object.assign(style, { fontName: 'Arial', fontSize: 40, borderStyle: 3,
        outline: 4, outlineColor: '#ff0000', outlineOpacity: 50, backColor: '#0000ff', scaleX: 100 });
    }, { persist: false });
  });
  const sample = page.locator('#ass-style-preview-sample');
  // 样例画布像素断言：BorderStyle 3 底框吃描边色与 50% 不透明度。
  const sampleStats = () => page.evaluate(() => {
    const canvas = document.querySelector('#ass-style-preview-sample');
    if (!canvas || !canvas.width) return { painted: 0, red50: 0 };
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const near = (value, target) => Math.abs(value - target) <= 3;
    const stats = { painted: 0, red50: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2]; const a = data[i + 3];
      if (a > 0) stats.painted++;
      if (a > 90 && a < 170 && near(r, 255) && near(g, 0) && near(b, 0)) stats.red50++;
    }
    return stats;
  });
  expect((await sampleStats()).red50).toBeGreaterThan(100);
  const spacing = await sample.evaluate((element) => {
    const label = document.querySelector('.ass-style-preview-label');
    return element.getBoundingClientRect().top - label.getBoundingClientRect().bottom;
  });
  expect(spacing).toBeGreaterThanOrEqual(8);
  await sample.scrollIntoViewIfNeeded();
  await sample.locator('..').screenshot({ path: test.info().outputPath('ass-style-sample.png') });
  await page.evaluate(() => {
    MaweBoot.DATA.segments = [{ start: 0, end: 4000, text: '字幕**强调**' }];
    const style = ASS_STYLE_LIBRARY.styles.find((entry) => entry.id === 'ass');
    style.emphasisStyle = 'stroke';
    style.emphasisColor = '#00ff00';
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    MawePlaybackLoop.refreshSubtitlePreview(1500, 0);
  });
  // Canvas 像素断言：画布自身透明底。注意 getImageData 返回非预乘值：
  // 不透明图层 × 0.5 合成后 readback 通道保持原值、alpha 减半（如强调
  // 描边 (0,255,0,128)）；半透明绘制叠在半透明底上才是通道混色
  //（如 BorderStyle 3 强调色块叠底框 (85,170,0,~192)）。
  const canvasStats = () => page.evaluate(() => {
    const canvas = document.querySelector('.ass-preview-canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const near = (value, target) => Math.abs(value - target) <= 3;
    const stats = { painted: 0, red50: 0, greenOverRed: 0, greenStroke: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2]; const a = data[i + 3];
      if (a > 0) stats.painted++;
      if (a > 90 && a < 170 && near(r, 255) && near(g, 0) && near(b, 0)) stats.red50++;
      if (a > 160 && near(r, 85) && near(g, 170) && near(b, 0)) stats.greenOverRed++;
      if (a > 90 && a < 170 && near(r, 0) && near(g, 255) && near(b, 0)) stats.greenStroke++;
    }
    return stats;
  });
  const emphasizedPayload = () => page.evaluate(() => {
    const items = window.MaweAssCanvas.lastRender.tracks[0].lines.flatMap((line) => line.items);
    return items.filter((item) => item.emphasized)
      .map((item) => ({ box: item.emphasisBox, stroke: item.emphasisStroke }));
  });
  // BorderStyle 3：底框吃描边色（含 50% 不透明度），文字无描边；强调
  // stroke 模式转为强调色块叠在底框上。
  expect((await canvasStats()).red50).toBeGreaterThan(200);
  await expect(emphasizedPayload()).resolves.toEqual([{ box: '#00ff00', stroke: '' }]);
  expect((await canvasStats()).greenOverRed).toBeGreaterThan(20);
  await page.evaluate(() => {
    const style = ASS_STYLE_LIBRARY.styles.find((entry) => entry.id === 'ass');
    style.borderStyle = 1;
    syncAssStyleForm(style);
    MawePlaybackLoop.refreshSubtitlePreview(1500, 0);
  });
  // BorderStyle 1：描边层吃同一描边色与不透明度；强调描边与主描边同形
  // 叠加，层内覆盖为纯强调色，整层合成后呈混色。
  const borderOne = await canvasStats();
  expect(borderOne.red50).toBeGreaterThan(200);
  expect(borderOne.greenStroke).toBeGreaterThan(20);
  await expect(emphasizedPayload()).resolves.toEqual([{ box: '', stroke: '#00ff00' }]);
  await page.evaluate(() => {
    const style = ASS_STYLE_LIBRARY.styles.find((entry) => entry.id === 'ass');
    style.scaleX = 0;
    syncAssStyleForm(style);
    MawePlaybackLoop.refreshSubtitlePreview(1500, 0);
  });
  // 零缩放：主字幕与样式窗样例画布都不再占据任何像素。
  expect((await canvasStats()).painted).toBe(0);
  expect((await sampleStats()).painted).toBe(0);
});

test('offsets the opaque shadow and keeps the border box shadow unclipped', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  const colourBBoxes = () => page.evaluate(() => {
    const canvas = document.querySelector('.ass-preview-canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const bbox = (match) => {
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (data[i + 3] > 90 && match(data[i], data[i + 1], data[i + 2])) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { minX, minY, maxX, maxY };
    };
    return {
      text: bbox((r, g, b) => r > 240 && g > 240 && b > 240),
      shadowBox: bbox((r, g, b) => r < 40 && g < 40 && b > 200),
      red: bbox((r, g, b) => r > 200 && g < 40 && b < 40),
    };
  });

  // BorderStyle 1：影子剪影相对文字整体偏移 (shad, shad)，右下露边。
  await page.evaluate(() => {
    MaweBoot.DATA.segments = [{ start: 0, end: 4000, text: '影子' }];
    const library = window.AsrEditorUtils.defaultAssStyleLibrary();
    const style = library.styles.find((entry) => entry.id === 'ass');
    Object.assign(style, { fontName: 'Arial', fontSize: 60, outline: 0, shadow: 20,
      primaryColor: '#ffffff', backColor: '#0000ff', backOpacity: 100 });
    ASS_STYLE_LIBRARY = library;
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  const opaque = await colourBBoxes();
  expect(opaque.shadowBox.minX).toBeGreaterThanOrEqual(opaque.text.minX + 14);
  expect(opaque.shadowBox.minY).toBeGreaterThanOrEqual(opaque.text.minY + 14);
  expect(opaque.shadowBox.maxY).toBeGreaterThan(opaque.text.maxY);

  // BorderStyle 3：底框影子偏移 pad 已计入位图外延，右/下不被截断
  //（蓝影 maxY 明显超出底框红边 maxY）。
  await page.evaluate(() => {
    const style = ASS_STYLE_LIBRARY.styles.find((entry) => entry.id === 'ass');
    Object.assign(style, { borderStyle: 3, outline: 6, outlineColor: '#ff0000', shadow: 30 });
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  const boxed = await colourBBoxes();
  expect(boxed.red.maxY).toBeGreaterThan(0);
  expect(boxed.shadowBox.maxY).toBeGreaterThanOrEqual(boxed.red.maxY + 20);
  expect(boxed.shadowBox.maxX).toBeGreaterThanOrEqual(boxed.red.maxX + 20);
});

test('collapses frx rotation through the foreshortening approximation', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  const stats = await page.evaluate(() => {
    MaweBoot.DATA.segments = [{ start: 0, end: 4000, text: '旋转' }];
    const library = window.AsrEditorUtils.defaultAssStyleLibrary();
    library.assProfiles[0].animations.t = {
      enabled: true, startMs: 0, endMs: 1000, accel: 1, tags: '\\frx90',
    };
    ASS_STYLE_LIBRARY = library;
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    const painted = () => {
      const canvas = document.querySelector('.ass-preview-canvas');
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 90) count++;
      return count;
    };
    MawePlaybackLoop.refreshSubtitlePreview(500, 0);
    const halfway = painted();
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const atNinety = painted();
    return { halfway, atNinety };
  });
  // \frx 3D 旋转以透视缩短近似：90° 时纵向压缩为 0（不可见），中途保留
  // 可见的动画表现（不静默取消，也不声称有透视斜切）。
  expect(stats.halfway).toBeGreaterThan(100);
  expect(stats.atNinety).toBe(0);
});
