import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { disableOnboarding } from './helpers.mjs';


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const launcherUrl = pathToFileURL(path.join(repoRoot, 'web', 'launcher', 'index.html')).href;
const blankEditorUrl = pathToFileURL(path.join(repoRoot, 'blank-editor.html')).href;


async function openLauncher(page) {
  await page.goto(launcherUrl);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
}


test('keeps the Launcher action bar outside the scrolling content and highlights script drops', async ({ page }) => {
  await openLauncher(page);

  const layout = await page.evaluate(() => {
    const scroll = document.querySelector('.shell-scroll');
    const actions = document.querySelector('.actions');
    const style = actions ? getComputedStyle(actions) : null;
    const scrollStyle = scroll ? getComputedStyle(scroll) : null;
    const scrollRect = scroll?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      pageCanScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      scrollOverflowY: scroll ? getComputedStyle(scroll).overflowY : '',
      actionsPosition: style?.position || '',
      actionsBottom: style?.bottom || '',
      actionsInsideScroll: Boolean(scroll?.contains(actions)),
      scrollPaddingBottom: scrollStyle?.paddingBottom || '',
      scrollBottom: scrollRect?.bottom || 0,
      actionsTop: actionsRect?.top || 0,
      actionsBottomEdge: actionsRect?.bottom || 0,
    };
  });
  expect(layout.pageCanScroll).toBe(false);
  expect(layout.scrollOverflowY).toBe('auto');
  expect(layout.actionsPosition).toBe('static');
  expect(layout.actionsBottom).toBe('auto');
  expect(layout.actionsInsideScroll).toBe(false);
  expect(layout.scrollPaddingBottom).toBe('20px');
  expect(Math.abs(layout.scrollBottom - layout.actionsTop)).toBeLessThanOrEqual(1);
  expect(layout.actionsBottomEdge).toBeLessThanOrEqual(layout.viewportHeight + 1);

  const scrollbarState = await page.evaluate(() => {
    const preview = document.querySelector('#postprocessScriptPreviewText');
    const previewCard = preview?.closest('.script-preview');
    if (preview && previewCard) {
      previewCard.classList.remove('hidden');
      preview.textContent = 'preview line\n'.repeat(80);
    }
    const elements = [
      document.querySelector('.shell-scroll'),
      preview,
      document.querySelector('#log'),
      document.querySelector('textarea'),
    ];
    return elements.map((element) => ({
      scrollbarWidth: element ? getComputedStyle(element).scrollbarWidth : '',
      webkitWidth: element ? getComputedStyle(element, '::-webkit-scrollbar').width : '',
    }));
  });
  for (const state of scrollbarState) {
    expect(state.scrollbarWidth).toBe('thin');
    expect(state.webkitWidth).toBe('6px');
  }

  const dropState = await page.evaluate(() => {
    const input = document.getElementById('postprocessScriptPath');
    const mediaInput = document.getElementById('mediaPath');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['script'], 'script.txt', { type: 'text/plain' }));
    input.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    const scriptStyle = getComputedStyle(input);
    const mediaStyle = getComputedStyle(mediaInput);
    return {
      scriptHasHighlight: input.classList.contains('drag-over'),
      mediaHasHighlight: mediaInput.classList.contains('drag-over'),
      scriptBorder: scriptStyle.borderTopColor,
      mediaBorder: mediaStyle.borderTopColor,
      scriptBackground: scriptStyle.backgroundColor,
    };
  });
  expect(dropState.scriptHasHighlight).toBe(true);
  expect(dropState.mediaHasHighlight).toBe(false);
  expect(dropState.scriptBorder).not.toBe(dropState.mediaBorder);
  expect(dropState.scriptBackground).not.toBe('rgba(0, 0, 0, 0)');
});


test('shows the installed OCR settings hint and highlights video drops', async ({ page }) => {
  await openLauncher(page);

  const state = await page.evaluate(() => {
    const config = window.MAWLauncher.config;
    config.ocrRuntime = { ...(config.ocrRuntime || {}), status: 'ready', ready: true };
    config.ocrModels = (config.ocrModels || []).map((model) => ({ ...model, installed: true, status: 'installed' }));
    window.MAWLauncher.onOcrRuntimeChanged();

    const field = document.getElementById('ocrVideoPathField');
    const before = getComputedStyle(field);
    const transfer = new DataTransfer();
    transfer.items.add(new File(['video'], 'video.mp4', { type: 'video/mp4' }));
    field.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    const after = getComputedStyle(field);
    return {
      settingsHint: document.getElementById('openOcrSettings')?.textContent || '',
      status: document.getElementById('ocrModelStatus')?.textContent || '',
      hasHighlight: field.classList.contains('drag-over'),
      borderChanged: before.borderTopColor !== after.borderTopColor,
      backgroundChanged: before.backgroundColor !== after.backgroundColor,
    };
  });

  expect(state.settingsHint).toBe('在 ⚙️ 设置中查看');
  expect(state.status).toBe('已安装，可直接使用');
  expect(state.hasHighlight).toBe(true);
  expect(state.borderChanged).toBe(true);
  expect(state.backgroundChanged).toBe(true);
});


test('keeps every Editor settings gear visible while left toolbar content shrinks', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(blankEditorUrl);
  await page.waitForSelector('#editor-workspace');

  for (const width of [620, 480, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await page.waitForSelector('#editor-workspace');
    const gears = await page.evaluate(() => [
      ['.player-toolbar', '#subtitle-preview-settings-toggle'],
      ['.cue-editor-toolbar', '#cue-editor-settings-toggle'],
      ['.waveform-toolbar', '#waveform-settings-toggle'],
      ['.cue-list-toolbar', '#cue-list-settings-toggle'],
    ].map(([toolbarSelector, buttonSelector]) => {
      const toolbar = document.querySelector(toolbarSelector);
      const button = document.querySelector(buttonSelector);
      const toolbarRect = toolbar?.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      return {
        buttonWidth: buttonRect?.width || 0,
        buttonRight: buttonRect?.right || 0,
        toolbarLeft: toolbarRect?.left || 0,
        toolbarRight: toolbarRect?.right || 0,
        gearFlexShrink: button?.parentElement ? getComputedStyle(button.parentElement).flexShrink : '',
      };
    }));
    for (const gear of gears) {
      expect(gear.buttonWidth).toBeGreaterThan(0);
      expect(gear.buttonRight).toBeLessThanOrEqual(gear.toolbarRight + 1);
      expect(gear.buttonRight).toBeGreaterThan(gear.toolbarLeft);
      expect(gear.gearFlexShrink).toBe('0');
    }
  }

  const editorScrollbarState = await page.evaluate(() => [
    '.cues-container',
    '.waveform-scroll',
    '.subtitle-preview-settings-panel',
    '.multi-subtitle-import-preview',
  ].map((selector) => {
    const element = document.querySelector(selector);
    return {
      selector,
      scrollbarWidth: element ? getComputedStyle(element).scrollbarWidth : '',
      webkitWidth: element ? getComputedStyle(element, '::-webkit-scrollbar').width : '',
    };
  }));
  for (const state of editorScrollbarState) {
    expect(state.scrollbarWidth, state.selector).toBe('thin');
    expect(state.webkitWidth, state.selector).toBe('6px');
  }
});
