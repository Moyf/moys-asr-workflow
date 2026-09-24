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
  startServer,
} from './helpers.mjs';

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

  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-subtitle-style').click();
  await expect(page.locator('#editor-settings-page-subtitle-style')).toBeVisible();
  await expect(page.locator('#subtitle-font-size')).toBeVisible();
  await page.locator('#editor-settings-tab-subtitle-color').click();
  const previewPanel = page.locator('#editor-settings-page-subtitle-color');
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

  await expect(page.locator('#editor-settings-panel')).toBeVisible();
  await page.locator('#editor-settings-tab-export').click();
  const exportToggle = page.locator('#export-speaker-labels');
  await expect(exportToggle).toBeChecked();
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).toContain('Host"Alpha');
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
  const exportSpeakerHint = page.locator('.editor-settings-field:has(#export-speaker-labels) .editor-settings-hint');
  await expect(exportSpeakerHint).toContainText('在导出的字幕开头加上说话人。只影响导出后的字幕，不会改动工程里的字幕文本。');
  await expect(exportSpeakerHint).toContainText('🤓👆 你可以在');
  await expect(page.locator('#export-open-subtitle-color-settings')).toHaveText('字幕颜色');
  await expect(page.locator('#export-open-subtitle-color-settings')).toHaveCSS('text-decoration-line', 'underline');
  await expect(page.locator('#export-open-subtitle-color-settings-arrow')).toHaveCount(0);
  await page.locator('#export-open-subtitle-color-settings').click();
  await expect(page.locator('#editor-settings-page-subtitle-color')).toBeVisible();
  await page.locator('#editor-settings-tab-export').click();

  await exportToggle.uncheck();
  await expect(exportToggle).not.toBeChecked();
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).not.toContain('Host"Alpha');
  expect(await page.evaluate(() => MaweExportSrt.buildSrt())).toContain('Alpha');

  await page.locator('#editor-settings-close').click();
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(() => page.evaluate(() => MaweAppearance.previewGeometryDirty)).toBe(false);

  const onDisk = JSON.parse(readFileSync(projectPath, 'utf-8'));
  expect(onDisk.preview.subtitle.speaker_labels).toEqual({
    mapping_enabled: true,
    enabled: true,
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
  await page.locator('#editor-settings-toggle').click();
  await page.locator('#editor-settings-tab-subtitle-color').click();
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
    const text = document.getElementById('overlay-main-text');
    const label = document.getElementById('overlay-main-speaker-label');
    const textStyle = getComputedStyle(text);
    const labelStyle = getComputedStyle(label);
    return {
      stageHeight: MaweDom.playerStage.getBoundingClientRect().height,
      textFontSize: textStyle.fontSize,
      labelFontSize: labelStyle.fontSize,
      textFontFamily: textStyle.fontFamily,
      labelFontFamily: labelStyle.fontFamily,
      textFontWeight: textStyle.fontWeight,
      labelFontWeight: labelStyle.fontWeight,
      textFontStyle: textStyle.fontStyle,
      labelFontStyle: labelStyle.fontStyle,
      textDecoration: textStyle.textDecorationLine,
      labelDecoration: labelStyle.textDecorationLine,
    };
  });
  expect(smallWindow.stageHeight).toBeCloseTo(540, 0);
  expect(Number.parseFloat(smallWindow.textFontSize)).toBeCloseTo(36, 0);
  expect(smallWindow.labelFontSize).toBe(smallWindow.textFontSize);
  expect(smallWindow.labelFontFamily).toBe(smallWindow.textFontFamily);
  expect(smallWindow.labelFontWeight).toBe(smallWindow.textFontWeight);
  expect(smallWindow.labelFontStyle).toBe(smallWindow.textFontStyle);
  expect(smallWindow.labelDecoration).toBe(smallWindow.textDecoration);

  await page.evaluate(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => MaweDom.playerWrap,
    });
    MaweDom.playerStage.style.height = '1080px';
    MaweDom.playerStage.style.minHeight = '1080px';
    MaweDom.playerStage.style.flexBasis = '1080px';
    MaweDom.playerWrap.style.height = '1080px';
    MaweDom.playerWrap.style.minHeight = '1080px';
    MaweDom.playerWrap.style.flexBasis = '1080px';
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const fullscreen = await page.evaluate(() => {
    const text = document.getElementById('overlay-main-text');
    const label = document.getElementById('overlay-main-speaker-label');
    return {
      stageHeight: MaweDom.playerStage.getBoundingClientRect().height,
      fullscreen: MaweDom.playerWrap.classList.contains('fullscreen-preview'),
      textFontSize: getComputedStyle(text).fontSize,
      labelFontSize: getComputedStyle(label).fontSize,
      labelFontFamily: getComputedStyle(label).fontFamily,
      labelFontWeight: getComputedStyle(label).fontWeight,
      labelFontStyle: getComputedStyle(label).fontStyle,
      labelDecoration: getComputedStyle(label).textDecorationLine,
    };
  });
  expect(fullscreen.fullscreen).toBe(true);
  expect(fullscreen.stageHeight).toBeCloseTo(1080, 0);
  expect(Number.parseFloat(fullscreen.textFontSize)).toBeCloseTo(72, 0);
  expect(fullscreen.labelFontSize).toBe(fullscreen.textFontSize);
  expect(fullscreen.labelFontFamily).toBe(smallWindow.textFontFamily);
  expect(fullscreen.labelFontWeight).toBe(smallWindow.textFontWeight);
  expect(fullscreen.labelFontStyle).toBe(smallWindow.textFontStyle);
  expect(fullscreen.labelDecoration).toBe(smallWindow.textDecoration);

  await page.evaluate(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
    MaweDom.playerStage.style.height = '540px';
    MaweDom.playerStage.style.minHeight = '540px';
    MaweDom.playerStage.style.flexBasis = '540px';
    MaweDom.playerWrap.style.height = '540px';
    MaweDom.playerWrap.style.minHeight = '540px';
    MaweDom.playerWrap.style.flexBasis = '540px';
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const windowedAgain = await page.evaluate(() => ({
    fullscreen: MaweDom.playerWrap.classList.contains('fullscreen-preview'),
    textFontSize: getComputedStyle(document.getElementById('overlay-main-text')).fontSize,
    labelFontSize: getComputedStyle(document.getElementById('overlay-main-speaker-label')).fontSize,
  }));
  expect(windowedAgain.fullscreen).toBe(false);
  expect(Number.parseFloat(windowedAgain.textFontSize)).toBeCloseTo(36, 0);
  expect(windowedAgain.labelFontSize).toBe(windowedAgain.textFontSize);
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
    const text = document.getElementById('overlay-main-text');
    const label = document.getElementById('overlay-main-speaker-label');
    return {
      text: text.textContent,
      label: label.textContent,
      textColor: getComputedStyle(text).color,
      labelColor: getComputedStyle(label).color,
      textFontFamily: getComputedStyle(text).fontFamily,
      labelFontFamily: getComputedStyle(label).fontFamily,
      textFontWeight: getComputedStyle(text).fontWeight,
      labelFontWeight: getComputedStyle(label).fontWeight,
      textFontStyle: getComputedStyle(text).fontStyle,
      labelFontStyle: getComputedStyle(label).fontStyle,
      textStroke: text.style.getPropertyValue('-webkit-text-stroke'),
      labelStroke: label.style.getPropertyValue('-webkit-text-stroke'),
    };
  });

  expect(preview.text).toBe('Host：Alpha');
  expect(preview.label).toBe('Host：');
  expect(preview.textColor).toBe('rgb(18, 52, 86)');
  expect(preview.labelColor).toBe('rgb(196, 160, 25)');
  expect(preview.labelFontFamily).toBe(preview.textFontFamily);
  expect(preview.labelFontWeight).toBe(preview.textFontWeight);
  expect(preview.labelFontStyle).toBe(preview.textFontStyle);
  expect(preview.labelStroke).toBe(preview.textStroke);
});
