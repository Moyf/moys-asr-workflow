// Dev-only Playwright regression for speaker labels in the subtitle preview.
// Proves that labels are configurable, preview-only, rendered as a separate
// colored element, persisted in the project, and independently included or
// omitted from exported SRT text.
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  cleanupTempDir,
  DURATION_MS,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer, closeSettingsPanels, openSettingsPage, toggleGlobalSettings } from './helpers.mjs';

let tempDir;
let projectPath;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('speaker-labels');
  const mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

async function revealSpeakerCue(page) {
  await page.evaluate(() => {
    const segment = MaweBoot.DATA.segments[0];
    segment.color = { name: 'yellow' };
    const media = document.getElementById('player');
    media.currentTime = 1;
    media.dispatchEvent(new Event('seeked'));
    media.dispatchEvent(new Event('timeupdate'));
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await expect(page.locator('#overlay')).toBeVisible();
}

test('configures preview-only speaker labels and independently controls SRT export', async ({ page }) => {
  await page.goto(server.url);
  await revealSpeakerCue(page);

  await toggleGlobalSettings(page);
  await openSettingsPage(page, 'subtitle-style');
  await expect(page.locator('#editor-settings-page-subtitle-style')).toBeVisible();
  await expect(page.locator('#subtitle-font-size')).toBeVisible();
  await openSettingsPage(page, 'project-color');
  const previewPanel = page.locator('#editor-settings-page-project-color');
  await expect(previewPanel).toBeVisible();
  await expect(page.locator('label.toggle.editor-settings-item:has(#subtitle-color-underline)'))
    .toHaveCount(1);
  await expect(page.locator('#subtitle-color-underline')).toBeChecked();
  await expect(page.locator('#subtitle-color-style-control')).toBeVisible();
  await expect(page.locator('#subtitle-color-style')).toHaveValue('underline');
  const colorStyleWidth = await page.locator('#subtitle-color-style').evaluate((element) => element.getBoundingClientRect().width);
  expect(colorStyleWidth).toBeLessThan(220);
  await expect(page.locator('#subtitle-color-style option[value="both"]')).toHaveCount(0);
  await expect(page.locator('#subtitle-color-style option[value="shadow"]')).toHaveCount(0);
  await expect(page.locator('#subtitle-color-style option[value="none"]')).toHaveCount(0);
  await expect(page.locator('#subtitle-color-style option[value="underline"]')).toHaveCount(1);
  await expect(page.locator('#subtitle-color-style option[value="text"]')).toHaveCount(1);
  await expect(page.locator('#subtitle-color-style option[value="stroke"]')).toHaveCount(1);
  await expect(page.locator('#subtitle-speaker-mapping-enabled')).not.toBeChecked();
  await expect(page.locator('#subtitle-speaker-labels-enabled-wrap')).toBeHidden();
  await expect(page.locator('#subtitle-speaker-labels-enabled')).toBeChecked();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeHidden();
  await expect(page.locator('#subtitle-speaker-label-separator')).toBeHidden();
  await expect(page.locator('#subtitle-speaker-label-yellow')).toHaveValue('SP1');
  await expect(page.locator('#subtitle-speaker-label-blue')).toHaveValue('SP5');

  await page.locator('#subtitle-speaker-mapping-enabled').check();
  await expect(page.locator('#subtitle-speaker-labels-enabled-wrap')).toBeVisible();
  await expect(page.locator('#subtitle-speaker-labels-enabled')).toBeChecked();
  await expect(page.locator('#export-speaker-labels')).toBeChecked();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeVisible();
  await page.locator('#subtitle-speaker-labels-enabled').check();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeVisible();
  await expect(page.locator('#subtitle-speaker-label-separator')).toBeVisible();
  const speakerLabelGrid = await page.locator('.subtitle-speaker-label-list').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      inputIds: [...element.querySelectorAll('input')].map((input) => input.id),
      columns: style.gridTemplateColumns.trim().split(/\s+/).length,
      rows: style.gridTemplateRows.trim().split(/\s+/).length,
    };
  });
  expect(speakerLabelGrid).toEqual({
    inputIds: [
      'subtitle-speaker-label-yellow',
      'subtitle-speaker-label-green',
      'subtitle-speaker-label-red',
      'subtitle-speaker-label-purple',
      'subtitle-speaker-label-blue',
      'subtitle-speaker-label-separator',
    ],
    columns: 2,
    rows: 3,
  });
  await page.locator('#subtitle-speaker-label-yellow').fill('Host');
  await expect(page.locator('#subtitle-speaker-label-separator')).toHaveValue('：');
  const previewStructure = await page.evaluate(() => {
    const label = document.getElementById('overlay-main-speaker-label');
    const parent = label.parentElement;
    return {
      color: getComputedStyle(label).color,
      fontFamily: getComputedStyle(label).fontFamily,
      parentFontFamily: getComputedStyle(parent).fontFamily,
      childNodes: [...parent.childNodes].map((node) => (
        node.nodeType === Node.ELEMENT_NODE ? node.id : node.textContent
      )),
    };
  });
  expect(previewStructure).toEqual({
    color: 'rgb(196, 160, 25)',
    fontFamily: previewStructure.parentFontFamily,
    parentFontFamily: previewStructure.parentFontFamily,
    childNodes: ['overlay-main-speaker-label', 'Alpha'],
  });
  await expect(page.locator('#overlay-main-speaker-label')).toHaveText('Host：');
  await expect(page.locator('#overlay-main-speaker-label')).toBeVisible();
  await expect(page.locator('#overlay-main-text')).toHaveText('Host：Alpha');
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].text)).toBe('Alpha');

  await page.locator('#subtitle-color-style').selectOption('text');
  await expect(page.locator('#subtitle-color-style')).toHaveValue('text');
  let colorStylePreview = await page.locator('#overlay-main-text').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      textDecorationLine: style.textDecorationLine,
      textShadow: element.style.textShadow,
      textStroke: element.style.getPropertyValue('-webkit-text-stroke'),
      paintOrder: element.style.paintOrder,
    };
  });
  expect(colorStylePreview).toEqual({
    color: 'rgb(196, 160, 25)',
    textDecorationLine: 'none',
    textShadow: '',
    textStroke: '',
    paintOrder: '',
  });
  await page.locator('#subtitle-color-style').selectOption('stroke');
  await expect(page.locator('#subtitle-color-style')).toHaveValue('stroke');
  colorStylePreview = await page.locator('#overlay-main-text').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      textDecorationLine: style.textDecorationLine,
      textShadow: element.style.textShadow,
      textStroke: element.style.getPropertyValue('-webkit-text-stroke'),
      paintOrder: element.style.paintOrder,
    };
  });
  expect(colorStylePreview.color).toBe('rgb(255, 255, 255)');
  expect(colorStylePreview.textDecorationLine).toBe('none');
  expect(colorStylePreview.textShadow).toBe('');
  expect(colorStylePreview.textStroke).toContain('rgb(196, 160, 25)');
  expect(colorStylePreview.paintOrder).toBe('stroke');
  const strokeLabelColors = await page.evaluate(() => {
    const label = document.getElementById('overlay-main-speaker-label');
    const mainText = document.getElementById('overlay-main-text');
    return {
      label: getComputedStyle(label).color,
      mainText: getComputedStyle(mainText).color,
    };
  });
  expect(strokeLabelColors.label).toBe(strokeLabelColors.mainText);
  // 下划线模式：说话人标签沿用颜色快照，不回退到字幕默认颜色。
  await page.locator('#subtitle-color-style').selectOption('underline');
  await expect(page.locator('#subtitle-color-style')).toHaveValue('underline');
  await expect(page.locator('#overlay-main-speaker-label')).toHaveCSS('color', 'rgb(196, 160, 25)');
  await page.locator('#subtitle-color-style').selectOption('stroke');
  await page.locator('#subtitle-color-underline').uncheck();
  await expect(page.locator('#subtitle-color-style-control')).toBeHidden();
  await page.locator('#subtitle-color-underline').check();
  await expect(page.locator('#subtitle-color-style-control')).toBeVisible();
  await expect(page.locator('#subtitle-color-style')).toHaveValue('stroke');

  await page.locator('#subtitle-speaker-label-separator').fill('"');
  await expect(page.locator('#overlay-main-speaker-label')).toHaveText('Host"');
  await expect(page.locator('#overlay-main-text')).toHaveText('Host"Alpha');
  await page.locator('#subtitle-speaker-label-separator').fill(' ');
  expect(await page.evaluate(() => ({
    label: document.getElementById('overlay-main-speaker-label').textContent,
    text: document.getElementById('overlay-main-text').textContent,
  }))).toEqual({ label: 'Host ', text: 'Host Alpha' });
  await page.locator('#subtitle-speaker-label-separator').fill('"');

  await page.locator('#subtitle-speaker-labels-enabled').uncheck();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeVisible();
  await expect(page.locator('#subtitle-speaker-labels-enabled-wrap')).toBeVisible();
  await expect(page.locator('#export-speaker-labels')).not.toBeChecked();
  await expect(page.locator('#overlay-main-speaker-label')).toBeHidden();
  await expect(page.locator('#overlay-main-text')).toHaveText('Alpha');
  await page.locator('#subtitle-speaker-labels-enabled').check();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeVisible();
  await expect(page.locator('#export-speaker-labels')).toBeChecked();
  await expect(page.locator('#overlay-main-text')).toHaveText('Host"Alpha');

  await page.locator('#subtitle-speaker-mapping-enabled').uncheck();
  await expect(page.locator('#subtitle-speaker-labels-enabled-wrap')).toBeHidden();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeHidden();
  await expect(page.locator('#overlay-main-speaker-label')).toBeHidden();
  await expect(page.locator('#overlay-main-text')).toHaveText('Alpha');
  await page.locator('#subtitle-speaker-mapping-enabled').check();
  await expect(page.locator('#subtitle-speaker-labels-enabled-wrap')).toBeVisible();
  await expect(page.locator('#subtitle-speaker-labels-enabled')).toBeChecked();
  await expect(page.locator('#subtitle-speaker-labels-settings')).toBeVisible();
  await expect(page.locator('#overlay-main-text')).toHaveText('Host"Alpha');

  await expect(page.locator('#project-settings-panel')).toBeVisible();
  await openSettingsPage(page, 'project-color');
  const exportToggle = page.locator('#export-speaker-labels');
  await expect(exportToggle).toBeChecked();
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).toContain('Host"Alpha');
  await openSettingsPage(page, 'export');
  const suffixToggle = page.locator('#export-speaker-names-as-suffix');
  await expect(suffixToggle).not.toBeChecked();
  await suffixToggle.check();
  const downloads = [];
  const collectDownload = (download) => downloads.push(download.suggestedFilename());
  page.on('download', collectDownload);
  const { filenameBase } = await page.evaluate(async () => {
    const previousColor = MaweBoot.DATA.segments[1].color;
    MaweBoot.DATA.segments[1].color = { name: 'green' };
    window.showSaveFilePicker = undefined;
    await MaweExportSrt.downloadColorSrts(false);
    if (previousColor) MaweBoot.DATA.segments[1].color = previousColor;
    else delete MaweBoot.DATA.segments[1].color;
    return { filenameBase: MaweBoot.FILENAME_BASE };
  });
  await expect.poll(() => downloads.length).toBe(3);
  page.off('download', collectDownload);
  expect(downloads).toEqual(expect.arrayContaining([
    `${filenameBase}_Host.srt`,
    `${filenameBase}_SP2.srt`,
    `${filenameBase}_默认.srt`,
  ]));
  await openSettingsPage(page, 'project-color');
  const exportSpeakerHint = page.locator('.editor-settings-field:has(#export-speaker-labels) .editor-settings-hint');
  await expect(exportSpeakerHint).toContainText('在导出的字幕开头加上说话人。只影响导出后的字幕，不会改动工程里的字幕文本。');
  // 颜色与说话人页提供打开调色板的反向链接。
  const paletteLink = page.locator('#editor-settings-page-project-color').locator('button', { hasText: '调色板' });
  await expect(paletteLink).toHaveCount(1);
  await paletteLink.click();
  await expect(page.locator('#editor-settings-page-subtitle-color')).toBeVisible();
  await openSettingsPage(page, 'project-color');

  await exportToggle.uncheck();
  await expect(exportToggle).not.toBeChecked();
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).not.toContain('Host"Alpha');
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).toContain('Alpha');

  await closeSettingsPanels(page);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(() => page.evaluate(() => MaweAppearance.previewGeometryDirty)).toBe(false);

  const onDisk = JSON.parse(readFileSync(projectPath, 'utf-8'));
  expect(onDisk.preview.subtitle.speaker_labels).toEqual({
    mapping_enabled: true,
    enabled: true,
    export_enabled: false,
    separator: '"',
    names: {
      yellow: 'Host',
      green: 'SP2',
      red: 'SP3',
      purple: 'SP4',
      blue: 'SP5',
    },
  });
  expect(onDisk.preview.subtitle.color_style).toBe('stroke');
  expect(onDisk.segments[0].text).toBe('Alpha');

  await page.reload();
  await revealSpeakerCue(page);
  await expect(page.locator('#overlay-main-text')).toHaveText('Host"Alpha');
  await toggleGlobalSettings(page);
  await openSettingsPage(page, 'project-color');
  await expect(page.locator('#subtitle-speaker-mapping-enabled')).toBeChecked();
  await expect(page.locator('#subtitle-speaker-label-yellow')).toHaveValue('Host');
  await expect(page.locator('#subtitle-speaker-label-separator')).toHaveValue('"');
  await expect(page.locator('#subtitle-color-style')).toHaveValue('stroke');
});

test('keeps ASS speaker labels in the same style across preview resizing and fullscreen', async ({ page }) => {
  await page.goto(server.url);
  await revealSpeakerCue(page);

  const smallWindow = await page.evaluate(() => {
    MaweBoot.DATA.media_metadata = { video_width: 1920, video_height: 1080 };
    MaweBoot.DATA.preview.subtitle = {
      ...MaweBoot.DATA.preview.subtitle,
      speaker_labels: {
        mapping_enabled: true,
        enabled: true,
        separator: '：',
        names: { yellow: 'Host', green: 'Guest', red: 'Narrator', purple: 'Stage', blue: 'Caption' },
      },
    };
    const library = window.AsrEditorUtils.defaultAssStyleLibrary();
    const sourceStyle = window.AsrEditorUtils.assStyleForId(library, 'ass');
    library.styles = library.styles.map((style) => style.id === 'ass'
      ? {
        ...sourceStyle,
        fontName: 'Arial',
        fontSize: 72,
        bold: true,
        italic: true,
        underline: true,
        outline: 4,
        outlineColor: '#112233',
      }
      : style);
    ASS_STYLE_LIBRARY = library;
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    MaweDom.playerWrap.style.height = '540px';
    MaweDom.playerWrap.style.minHeight = '540px';
    MaweDom.playerWrap.style.flex = '0 0 540px';
    MaweDom.playerStage.style.width = '960px';
    MaweDom.playerStage.style.height = '540px';
    MaweDom.playerStage.style.minHeight = '540px';
    MaweDom.playerStage.style.flex = '0 0 540px';
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const canvas = document.querySelector('.ass-preview-canvas');
    const track = window.MaweAssCanvas.lastRender.tracks[0];
    const items = track.lines.flatMap((line) => line.items);
    return {
      stageHeight: MaweDom.playerStage.getBoundingClientRect().height,
      canvasSize: [canvas.width, canvas.height],
      speakerText: track.speaker?.text || '',
      speakerColor: track.speaker?.color || '',
      firstItemText: items[0]?.text || '',
      firstCssSize: items[0]?.cssSize || 0,
      underlined: Boolean(items[0]?.underlined),
    };
  });
  expect(smallWindow.stageHeight).toBeCloseTo(540, 0);
  // Canvas 预览以 PlayRes 原生坐标绘制，说话人标签作为首行行首 run 与
  // 文本共用同一字号/字体（样式级下划线也作用于标签 run）。
  expect(smallWindow.canvasSize).toEqual([1920, 1080]);
  expect(smallWindow.speakerText).toBe('Host：');
  expect(smallWindow.speakerColor.toLowerCase()).toBe('#c4a019');
  expect(smallWindow.firstItemText).toBe('Host：');
  expect(smallWindow.firstCssSize).toBeGreaterThan(0);
  expect(smallWindow.underlined).toBe(true);

  const enteringFullscreen = await page.evaluate(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => MaweDom.playerWrap,
    });
    MaweDom.playerStage.style.height = '2px';
    MaweDom.playerStage.style.minHeight = '2px';
    MaweDom.playerStage.style.flexBasis = '2px';
    MaweDom.playerWrap.style.height = '1080px';
    MaweDom.playerWrap.style.minHeight = '1080px';
    MaweDom.playerWrap.style.flexBasis = '1080px';
    document.dispatchEvent(new Event('fullscreenchange'));
    // 模拟播放循环在布局过渡期间继续刷新 ASS；瞬态 2px 舞台不能压缩 Canvas。
    MawePlaybackLoop.updatePlaybackFrame();
    const transientOverlayHeight = Number.parseFloat(MaweDom.overlayEl.style.height) || 0;
    setTimeout(() => {
      MaweDom.playerStage.style.height = '1080px';
      MaweDom.playerStage.style.minHeight = '1080px';
      MaweDom.playerStage.style.flexBasis = '1080px';
    }, 40);
    return { transientOverlayHeight };
  });
  expect(enteringFullscreen.transientOverlayHeight).toBeCloseTo(540, 0);
  await page.waitForTimeout(220);
  const fullscreen = await page.evaluate(() => {
    const track = window.MaweAssCanvas.lastRender.tracks[0];
    const items = track.lines.flatMap((line) => line.items);
    const canvas = document.querySelector('.ass-preview-canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 40) if (data[i] > 0) painted++;
    return {
      stageHeight: MaweDom.playerStage.getBoundingClientRect().height,
      overlayHeight: MaweDom.overlayEl.getBoundingClientRect().height,
      fullscreen: MaweDom.playerWrap.classList.contains('fullscreen-preview'),
      cssSize: items[0]?.cssSize || 0,
      speakerText: track.speaker?.text || '',
      painted,
    };
  });
  expect(fullscreen.fullscreen).toBe(true);
  expect(fullscreen.stageHeight).toBeCloseTo(1080, 0);
  expect(fullscreen.overlayHeight).toBeCloseTo(1080, 0);
  // 原生分辨率画布与舞台缩放解耦：窗口尺寸翻倍不改变画布内的字形尺寸，
  // 只改变 CSS 呈现大小；标签与文本仍同 run 绘制。
  expect(fullscreen.cssSize).toBe(smallWindow.firstCssSize);
  expect(fullscreen.speakerText).toBe('Host：');
  expect(fullscreen.painted).toBeGreaterThan(50);

  const leavingFullscreen = await page.evaluate(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
    MaweDom.playerStage.style.height = '2px';
    MaweDom.playerStage.style.minHeight = '2px';
    MaweDom.playerStage.style.flexBasis = '2px';
    MaweDom.playerWrap.style.height = '540px';
    MaweDom.playerWrap.style.minHeight = '540px';
    MaweDom.playerWrap.style.flexBasis = '540px';
    document.dispatchEvent(new Event('fullscreenchange'));
    MawePlaybackLoop.updatePlaybackFrame();
    const transientOverlayHeight = Number.parseFloat(MaweDom.overlayEl.style.height) || 0;
    setTimeout(() => {
      MaweDom.playerStage.style.height = '540px';
      MaweDom.playerStage.style.minHeight = '540px';
      MaweDom.playerStage.style.flexBasis = '540px';
    }, 40);
    return { transientOverlayHeight };
  });
  expect(leavingFullscreen.transientOverlayHeight).toBeCloseTo(1080, 0);
  await page.waitForTimeout(220);
  const windowedAgain = await page.evaluate(() => ({
    fullscreen: MaweDom.playerWrap.classList.contains('fullscreen-preview'),
    overlayHeight: MaweDom.overlayEl.getBoundingClientRect().height,
    cssSize: window.MaweAssCanvas.lastRender.tracks[0].lines
      .flatMap((line) => line.items)[0]?.cssSize || 0,
  }));
  expect(windowedAgain.fullscreen).toBe(false);
  expect(windowedAgain.overlayHeight).toBeCloseTo(540, 0);
  expect(windowedAgain.cssSize).toBe(smallWindow.firstCssSize);
});

test('uses ASS speaker-only colour for the label while preserving the base text style', async ({ page }) => {
  await page.goto(server.url);
  await revealSpeakerCue(page);

  const preview = await page.evaluate(() => {
    MaweBoot.DATA.media_metadata = { video_width: 1920, video_height: 1080 };
    MaweBoot.DATA.preview.subtitle = {
      ...MaweBoot.DATA.preview.subtitle,
      ass_color_style: 'speaker',
      speaker_labels: {
        mapping_enabled: true,
        enabled: true,
        separator: '：',
        names: { yellow: 'Host', green: 'Guest', red: 'Narrator', purple: 'Stage', blue: 'Caption' },
      },
    };
    const library = window.AsrEditorUtils.defaultAssStyleLibrary();
    const sourceStyle = window.AsrEditorUtils.assStyleForId(library, 'ass');
    library.styles = library.styles.map((style) => style.id === 'ass'
      ? {
        ...sourceStyle,
        fontName: 'Arial',
        fontSize: 72,
        primaryColor: '#123456',
        outlineColor: '#112233',
        outline: 4,
        bold: true,
        italic: true,
      }
      : style);
    ASS_STYLE_LIBRARY = library;
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const track = window.MaweAssCanvas.lastRender.tracks[0];
    const items = track.lines.flatMap((line) => line.items);
    return {
      text: items.map((item) => item.text).join(''),
      speakerText: track.speaker?.text || '',
      speakerColor: track.speaker?.color || '',
      labelIsFirstRun: items[0]?.text === 'Host：',
      sameSize: items[0]?.cssSize === items[1]?.cssSize,
      textColor: items.find((item) => item.text === 'Alpha')?.fill || '',
    };
  });

  expect(preview.text).toBe('Host：Alpha');
  expect(preview.speakerText).toBe('Host：');
  // speaker 模式：标签跟随调色色，正文保持样式主色；两者同一 run 管线绘制。
  expect(preview.speakerColor.toLowerCase()).toBe('#c4a019');
  expect(preview.textColor.toLowerCase()).toBe('#123456');
  expect(preview.labelIsFirstRun).toBe(true);
  expect(preview.sameSize).toBe(true);
});

test('overlay track speaker labels render through the canvas in ASS mode', async ({ page }) => {
  await page.goto(server.url);
  await revealSpeakerCue(page);
  const payload = await page.evaluate(() => {
    MaweBoot.DATA.media_metadata = { video_width: 1920, video_height: 1080 };
    MaweBoot.DATA.preview.subtitle = {
      ...MaweBoot.DATA.preview.subtitle,
      speaker_labels: {
        mapping_enabled: true,
        enabled: true,
        separator: '：',
        names: { yellow: 'Host', green: 'Guest', red: 'Narrator', purple: 'Stage', blue: 'Caption' },
      },
    };
    MaweBoot.DATA.segments = [{ id: 'main-ov', start: 0, end: 4000, text: 'main cue' }];
    MaweBoot.DATA.overlay_track = {
      enabled: true,
      segments: [{ id: 'ov-1', start: 0, end: 4000, text: 'overlay cue', color: { name: 'yellow' } }],
    };
    MaweSettings.EDITOR_SETTINGS.assMode = true;
    MaweDom.overlayToggle.checked = true;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const tracks = window.MaweAssCanvas.lastRender.tracks;
    const overlay = tracks[2];
    const items = overlay?.lines?.flatMap((line) => line.items) || [];
    return {
      overlayDrawn: overlay ? overlay.skipped === false : false,
      speakerText: overlay?.speaker?.text || '',
      speakerColor: overlay?.speaker?.color || '',
      firstItemText: items[0]?.text || '',
      labelFill: items[0]?.fill || '',
      domLabelInvisible: document.querySelector('#overlay-track-text .subtitle-speaker-label')
        ?.getClientRects().length === 0,
    };
  });
  // 叠加轨 DOM 元素在 ASS 模式整体隐藏，说话人标签必须经 Canvas 合成。
  expect(payload.overlayDrawn).toBe(true);
  expect(payload.domLabelInvisible).toBe(true);
  // text 颜色模式：标签跟随调色色，画在叠加轨首行行首。
  expect(payload.speakerText).toBe('Host：');
  expect(payload.speakerColor.toLowerCase()).toBe('#c4a019');
  expect(payload.firstItemText).toBe('Host：');
  expect(payload.labelFill.toLowerCase()).toBe('#c4a019');
});
