import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const launcherUrl = pathToFileURL(fileURLToPath(new URL('../../web/launcher/index.html', import.meta.url))).href;
const headings = ['mediaTitle', 'settingsTitle', 'autoPostprocessTitle', 'logTitle', 'serverTitle'];
const labels = {
  zh: ['选择媒体', '识别设置', '转写后自动处理', '日志', '编辑器'],
  en: ['Choose media', 'Recognition Settings', 'Post-transcription processing', 'Logs', 'Editor'],
};

test('section badges survive language changes and follow light/dark themes with measured spacing', async ({ page }, testInfo) => {
  await page.goto(launcherUrl);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  const measurements = [];
  for (const theme of ['dark', 'light']) {
    for (const language of ['zh', 'en']) {
      await page.locator('#settingsButton').click();
      await page.locator(theme === 'dark' ? '#themeDark' : '#themeLight').click();
      await page.locator(language === 'zh' ? '#langZh' : '#langEn').click();
      await page.keyboard.press('Escape');
      for (const [index, id] of headings.entries()) {
        const heading = page.locator(`#${id}`);
        await expect(heading.locator('span[data-i18n]')).toHaveText(labels[language][index]);
        await expect(heading.locator('svg.keycap use')).toHaveAttribute('href', `#keycap-${index + 1}`);
        const geometry = await heading.evaluate(element => {
          const badge = element.querySelector('svg.keycap'), text = element.querySelector('span');
          const badgeRect = badge.getBoundingClientRect(), textRect = text.getBoundingClientRect();
          const headingRect = element.getBoundingClientRect();
          let next = element.nextElementSibling;
          while (next && !next.getClientRects().length) next = next.nextElementSibling;
          const style = getComputedStyle(element), keycapStyle = getComputedStyle(badge);
          const symbol = document.querySelector(badge.querySelector('use').getAttribute('href'));
          return {
            width: badgeRect.width, height: badgeRect.height,
            textGap: textRect.left - badgeRect.right,
            nextGap: next ? next.getBoundingClientRect().top - headingRect.bottom : null,
            marginBottom: parseFloat(style.marginBottom),
            fill: getComputedStyle(symbol.querySelector('.keycap-bg')).fill,
            numberFill: getComputedStyle(symbol.querySelector('.keycap-num')).fill,
            accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
            marginRight: parseFloat(keycapStyle.marginRight),
            hidden: badge.getAttribute('aria-hidden'),
          };
        });
        expect(geometry.width).toBeGreaterThan(16);
        expect(geometry.height).toBeGreaterThan(16);
        expect(geometry.textGap).toBeGreaterThanOrEqual(6);
        expect(geometry.marginBottom).toBeGreaterThanOrEqual(8);
        if (geometry.nextGap !== null) expect(geometry.nextGap, id).toBeGreaterThanOrEqual(8);
        // 改版品牌色：暗色黑橙（#f09a50，深色数字）、亮色红白（#c84545，与编辑器红一致，白色数字）。
        expect(geometry.fill).toBe(theme === 'dark' ? 'rgb(240, 154, 80)' : 'rgb(200, 69, 69)');
        expect(geometry.numberFill).toBe(theme === 'dark' ? 'rgb(28, 15, 5)' : 'rgb(255, 255, 255)');
        expect(geometry.hidden).toBe('true');
        measurements.push({theme, language, id, ...geometry});
        await heading.locator('..').screenshot({path:testInfo.outputPath(`section-${index + 1}-${language}-${theme}.png`)});
      }
    }
  }
  const measurementPath = testInfo.outputPath('keycap-measurements.json');
  fs.writeFileSync(measurementPath, JSON.stringify(measurements, null, 2) + '\n');
  await testInfo.attach('keycap-measurements', {path:measurementPath, contentType:'application/json'});
  expect(await page.locator('style[data-emoji-font]').count()).toBe(0);
});
