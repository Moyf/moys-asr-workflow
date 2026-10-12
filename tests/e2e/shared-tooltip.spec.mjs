import { test, expect } from '@playwright/test';

const launcherUrl = new URL('../../web/launcher/index.html', import.meta.url).href;

test.beforeEach(async ({ page }) => {
  await page.goto(launcherUrl);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button id="tooltip-test" title="original" style="position:fixed;left:40px;top:40px;z-index:99999"><span id="tooltip-child">child</span><span id="tooltip-sibling">sibling</span></button>');
  });
});

test('titles are stored as data-title on insert so native bubbles have nothing to read', async ({ page }) => {
  await expect(page.locator('#tooltip-test')).toHaveAttribute('data-title', 'original');
  await expect(page.locator('#tooltip-test')).not.toHaveAttribute('title');
});

test('leaving before the delay cancels the pending tooltip', async ({ page }) => {
  await page.locator('#tooltip-child').hover();
  await page.mouse.move(5, 5);
  // Must observe beyond the delayed show, rather than assert while still hidden.
  await page.waitForTimeout(450);
  await expect(page.locator('.mawe-tooltip.show')).toHaveCount(0);
  await expect(page.locator('#tooltip-test')).toHaveAttribute('data-title', 'original');
  await expect(page.locator('#tooltip-test')).not.toHaveAttribute('title');
});

test('moving between children keeps a visible tooltip and Escape hides it while data-title stays', async ({ page }) => {
  await page.locator('#tooltip-child').hover();
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toBeVisible();
  await page.locator('#tooltip-sibling').hover();
  await page.waitForTimeout(150);
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toBeVisible();
  await expect(page.locator('.mawe-tooltip')).toHaveAttribute('aria-hidden', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('.mawe-tooltip.show')).toHaveCount(0);
  await expect(page.locator('#tooltip-test')).toHaveAttribute('data-title', 'original');
});

test('external title updates refresh the bubble and synchronous hide preserves the latest data-title', async ({ page }) => {
  await page.locator('#tooltip-child').hover();
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toBeVisible();
  await page.evaluate(() => document.getElementById('tooltip-test').setAttribute('title', 'translated'));
  await expect(page.locator('.mawe-tooltip-text')).toHaveText('translated');
  await expect(page.locator('#tooltip-test')).not.toHaveAttribute('title');
  await page.evaluate(() => {
    document.getElementById('tooltip-test').setAttribute('title', 'newest');
    window.MaweTooltip.hide();
  });
  await expect(page.locator('#tooltip-test')).toHaveAttribute('data-title', 'newest');
});

test('external set/remove does not resurrect a cleared title', async ({ page }) => {
  await page.locator('#tooltip-child').hover();
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toBeVisible();
  await page.evaluate(() => {
    const target = document.getElementById('tooltip-test');
    target.setAttribute('title', 'temporary');
    target.removeAttribute('title');
    window.MaweTooltip.hide();
  });
  // 转存读取实时 DOM：同步 set+remove 落定时 title 已不在，
  // data-title 保持原值，临时文本既不显示也不会被复活。
  await expect(page.locator('#tooltip-test')).toHaveAttribute('data-title', 'original');
  await expect(page.locator('.mawe-tooltip.show')).toHaveCount(0);
});

test('external empty-string title clears the stored data-title', async ({ page }) => {
  await page.locator('#tooltip-child').hover();
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toBeVisible();
  await page.evaluate(() => {
    document.getElementById('tooltip-test').title = '';
    window.MaweTooltip.hide();
  });
  await expect(page.locator('#tooltip-test')).not.toHaveAttribute('data-title');
  await expect(page.locator('#tooltip-test')).not.toHaveAttribute('title');
});

test('below placement anchors the bubble to the target left edge instead of its center', async ({ page }) => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button id="tooltip-wide" title="wide anchor" style="position:fixed;left:60px;top:40px;width:320px;z-index:99999">wide</button>');
  });
  await page.locator('#tooltip-wide').hover();
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toBeVisible();
  const boxes = await page.evaluate(() => {
    const target = document.getElementById('tooltip-wide').getBoundingClientRect();
    const bubble = document.querySelector('.mawe-tooltip-text').getBoundingClientRect();
    return { targetLeft: target.left, bubbleLeft: bubble.left, targetWidth: target.width };
  });
  expect(Math.abs(boxes.bubbleLeft - boxes.targetLeft)).toBeLessThanOrEqual(2);
});
