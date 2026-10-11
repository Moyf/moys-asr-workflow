import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  cleanupTempDir,
  disableOnboarding,
  findFreePort,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('desktop-path-menus');
  const mediaPath = generateWav(join(tempDir, 'synthetic.wav'), 0.25);
  const projectPath = generateProjectJson(join(tempDir, 'project.json'));
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('desktop path menus use the shared dropdown styling and keyboard behavior', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    for (const id of ['media-path-menu', 'project-path-menu', 'last-export-menu']) {
      const dropdown = document.getElementById(id);
      dropdown.hidden = false;
      dropdown.querySelectorAll('[role="menuitem"]').forEach((item) => { item.hidden = false; });
    }
  });

  await page.locator('#media-path-menu-btn').click();
  await expect(page.locator('#media-path-menu')).toHaveClass(/open/);
  await expect(page.locator('#media-path-menu-items')).toBeVisible();
  await expect(page.locator('#media-path-menu-btn')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#media-path-menu-btn').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-desktop-path-open="media"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#media-path-menu')).not.toHaveClass(/open/);
  await expect(page.locator('#media-path-menu-btn')).toBeFocused();

  const sharedStyles = await page.evaluate(() => {
    const mediaDropdown = document.getElementById('media-path-menu');
    const saveDropdown = document.getElementById('save-project-dropdown');
    saveDropdown.hidden = false;
    mediaDropdown.classList.add('open');
    saveDropdown.classList.add('open');
    const readStyle = (menuId) => {
      const menu = document.getElementById(menuId);
      const item = menu.querySelector('.dropdown-item');
      const menuStyle = getComputedStyle(menu);
      const itemStyle = getComputedStyle(item);
      return {
        background: menuStyle.backgroundColor,
        border: menuStyle.borderTopColor,
        radius: menuStyle.borderRadius,
        shadow: menuStyle.boxShadow,
        itemColor: itemStyle.color,
        itemPadding: itemStyle.padding,
      };
    };
    const result = {
      media: readStyle('media-path-menu-items'),
      save: readStyle('save-project-menu'),
    };
    mediaDropdown.classList.remove('open');
    saveDropdown.classList.remove('open');
    saveDropdown.hidden = true;
    return result;
  });
  expect(sharedStyles.media).toEqual(sharedStyles.save);

  await page.locator('#media-path-menu-btn').click();
  await expect(page.locator('#media-path-menu')).toHaveClass(/open/);
  await expect(page.locator('#media-path-menu-items')).toBeVisible();
  await expect(page.locator('[data-desktop-path-open="media"]')).toBeVisible();
  const menuBounds = await page.locator('#media-path-menu-items').boundingBox();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewportWidth);
  await page.screenshot({
    path: test.info().outputPath('desktop-path-menu-shared-style.png'),
    clip: { x: 0, y: 0, width: 480, height: 180 },
  });
});
