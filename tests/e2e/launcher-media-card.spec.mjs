import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const url = pathToFileURL(path.resolve('web/launcher/index.html')).href;
async function open(page) {
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.workflowReady === 'true');
}

test('empty media card matches the prototype geometry and keeps old fields out of the empty state', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await open(page);
  await expect(page.locator('#dropZone .media-drop-title')).toHaveText('拖入视频或音频');
  await expect(page.locator('#dropZone .media-drop-choose')).toHaveText('点击选择文件');
  await expect(page.locator('#mediaDropHint')).toContainText('一次拖入多个文件会自动转到批量');
  await expect(page.locator('#singleMediaFields')).toBeHidden();
  await expect(page.locator('#transcriptionArtwork')).toBeHidden();
  const actual = await page.locator('#mediaCard').evaluate(card => {
    const drop = card.querySelector('#dropZone');
    const art = card.querySelector('.media-drop-art');
    const head = card.querySelector('.media-card-header');
    const rect = node => node.getBoundingClientRect();
    return {
      width: rect(card).width, height: rect(card).height,
      paddingTop: parseFloat(getComputedStyle(card).paddingTop), paddingLeft: parseFloat(getComputedStyle(card).paddingLeft),
      headerGap: rect(drop).top - rect(head).bottom,
      artWidth: rect(art).width, artHeight: rect(art).height,
      copyGap: rect(card.querySelector('.media-drop-copy')).left - rect(art).right,
    };
  });
  const prototype = await page.context().newPage();
  try {
    await prototype.goto(pathToFileURL(path.resolve('docs/plans/launcher-redesign/prototype.html')).href);
    const referenceCard = prototype.locator('#page-transcribe .card').filter({ has: prototype.locator('h2', { hasText: /^选择媒体$/ }) });
    // 比较组件本身，不通过扩大其他页面的内容列来掩盖差异。
    await referenceCard.evaluate((node, width) => { node.style.width = `${width}px`; }, actual.width);
    const reference = await referenceCard.evaluate(card => {
      const rect = node => node.getBoundingClientRect();
      const drop = card.querySelector('.mascot-drop'); const art = card.querySelector('.drop-art');
      return {
        width: rect(card).width, height: rect(card).height,
        paddingTop: parseFloat(getComputedStyle(card).paddingTop), paddingLeft: parseFloat(getComputedStyle(card).paddingLeft),
        headerGap: rect(drop).top - rect(card.querySelector('.card-head')).bottom,
        artWidth: rect(art).width, artHeight: rect(art).height,
        copyGap: rect(card.querySelector('.drop-tx')).left - rect(art).right,
      };
    });
    for (const [key, value] of Object.entries(reference)) expect(Math.abs(actual[key] - value), key).toBeLessThanOrEqual(1);
    await referenceCard.screenshot({ path: testInfo.outputPath('prototype-media.png'), animations: 'disabled' });
    await page.locator('#mediaCard').screenshot({ path: testInfo.outputPath('actual-media.png'), animations: 'disabled' });
    await testInfo.attach('media-card-measurements', { body: JSON.stringify({ actual, reference }, null, 2), contentType: 'application/json' });
    const directory = process.env.MAW_MEDIA_CARD_ARTIFACT_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      await referenceCard.screenshot({ path: path.join(directory, 'prototype-light.png'), animations: 'disabled' });
      await page.locator('#mediaCard').screenshot({ path: path.join(directory, 'actual-light.png'), animations: 'disabled' });
      writeFileSync(path.join(directory, 'measurements.json'), JSON.stringify({ actual, reference }, null, 2) + '\n');
    }
  } finally { await prototype.close(); }
});

test('the drop card and keyboard choose media while preserving path, tracks, output and replacement', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.__mediaChoices = 0;
    document.getElementById('pickMedia').addEventListener('click', () => { window.__mediaChoices += 1; });
  });
  await page.locator('#dropZone').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#selectedMediaName')).toHaveText('clip.mp4');
  await expect(page.locator('#singleMediaFields')).toBeVisible();
  await expect(page.locator('#audioTrack')).toBeVisible();
  await expect(page.locator('#srtPath')).not.toHaveValue('');
  expect(await page.evaluate(() => window.__mediaChoices)).toBe(1);
  await page.locator('#replaceMedia').click();
  expect(await page.evaluate(() => window.__mediaChoices)).toBe(2);
});

test('batch entry, multiple-file drop and language switching do not erase the drop card markup', async ({ page }) => {
  await open(page);
  await page.locator('#mediaOpenBatch').click();
  await expect(page.locator('#pageBatch')).toBeVisible();
  await page.locator('#navTranscribe').click();
  await expect(page.locator('#dropZone .media-drop-art svg use')).toHaveAttribute('href', '#i-upload');
  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(page.locator('#mediaDropTitle')).toHaveText('Drop video or audio');
  await expect(page.locator('#dropZone .media-drop-art')).toBeVisible();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([], 'one.mp4'));
    transfer.items.add(new File([], 'two.wav'));
    document.getElementById('dropZone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator('#pageBatch')).toBeVisible();
  await expect(page.locator('.batch-row')).toHaveCount(2);
});

test('media card remains usable in both themes and narrow windows', async ({ page }) => {
  await open(page);
  for (const dark of [false, true]) {
    if (dark) await page.locator('#themeToggle').click();
    for (const width of [1000, 884, 700, 414, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.locator('#mediaCard').evaluate(card => {
        const drop = card.querySelector('#dropZone');
        const title = card.querySelector('#mediaTitle');
        const batch = card.querySelector('.media-batch-entry');
        return {
          cardOverflow: card.scrollWidth - card.clientWidth,
          rootOverflow: document.documentElement.scrollWidth - innerWidth,
          headerGap: drop.getBoundingClientRect().top - card.querySelector('.media-card-header').getBoundingClientRect().bottom,
          headerItemsOverlap: title.getBoundingClientRect().right > batch.getBoundingClientRect().left && title.getBoundingClientRect().bottom > batch.getBoundingClientRect().top,
        };
      });
      expect(layout.cardOverflow).toBeLessThanOrEqual(1);
      expect(layout.rootOverflow).toBeLessThanOrEqual(1);
      expect(layout.headerGap).toBeGreaterThanOrEqual(14);
      expect(layout.headerItemsOverlap).toBe(false);
      const directory = process.env.MAW_MEDIA_CARD_ARTIFACT_DIR;
      if (directory && [884, 375].includes(width)) {
        mkdirSync(directory, { recursive: true });
        await page.locator('#mediaCard').screenshot({ path: path.join(directory, `${dark ? 'dark' : 'light'}-${width}.png`), animations: 'disabled' });
      }
    }
  }
});
