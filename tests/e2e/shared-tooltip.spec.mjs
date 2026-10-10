import { test, expect } from '@playwright/test';

const launcherUrl = new URL('../../web/launcher/index.html', import.meta.url).href;

test.beforeEach(async ({ page }) => {
  await page.goto(launcherUrl);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button id="tooltip-test" title="original" style="position:fixed;left:40px;top:40px;z-index:99999"><span id="tooltip-child">child</span><span id="tooltip-sibling">sibling</span></button>');
  });
});

test('leaving before the delay cancels the pending tooltip', async ({ page }) => {
  await page.locator('#tooltip-child').hover();
  await page.mouse.move(5, 5);
  // Must observe beyond the delayed show, rather than assert while still hidden.
  await page.waitForTimeout(450);
  await expect(page.locator('.mawe-tooltip.show')).toHaveCount(0);
  await expect(page.locator('#tooltip-test')).toHaveAttribute('title', 'original');
});

test('moving between children keeps a visible tooltip and Escape restores title', async ({ page }) => {
  await page.locator('#tooltip-child').hover();
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toBeVisible();
  await page.locator('#tooltip-sibling').hover();
  await page.waitForTimeout(150);
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toBeVisible();
  await expect(page.locator('.mawe-tooltip')).toHaveAttribute('aria-hidden', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('.mawe-tooltip.show')).toHaveCount(0);
  await expect(page.locator('#tooltip-test')).toHaveAttribute('title', 'original');
});

test('external title updates refresh the bubble and synchronous hide preserves the latest title', async ({ page }) => {
  await page.locator('#tooltip-child').hover();
  await expect(page.locator('.mawe-tooltip.show .mawe-tooltip-text')).toBeVisible();
  await page.evaluate(() => document.getElementById('tooltip-test').setAttribute('title', 'translated'));
  await expect(page.locator('.mawe-tooltip-text')).toHaveText('translated');
  await page.evaluate(() => {
    document.getElementById('tooltip-test').setAttribute('title', 'newest');
    window.MaweTooltip.hide();
  });
  await expect(page.locator('#tooltip-test')).toHaveAttribute('title', 'newest');
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
  await expect(page.locator('#tooltip-test')).not.toHaveAttribute('title');
  await expect(page.locator('.mawe-tooltip.show')).toHaveCount(0);
});
