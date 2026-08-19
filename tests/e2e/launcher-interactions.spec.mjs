import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

async function openLauncher(page) {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#toolboxFab').click();
}

async function runReplacement(page, { outputMode = 'both' } = {}) {
  const previousCount = await page.locator('.toolbox-chain-item').count();
  await page.locator('#toolboxReplaceTab').click();
  await page.locator('#toolboxInputPath').fill('D:\\Demo\\source.mosp');
  await page.locator('#postprocessOutputMode').selectOption(outputMode);
  await page.locator('#postprocessReplacements').fill('old => new');
  await page.locator('#runFixedProcess').click();
  await expect(page.locator('.toolbox-chain-item')).toHaveCount(previousCount + 1);
}

test('artifact rows localize type labels while preserving MOSP-first and SRT-only selection', async ({ page }) => {
  await openLauncher(page);
  await runReplacement(page);

  const artifacts = page.locator('.toolbox-chain-file');
  await expect(artifacts).toHaveCount(2);
  await expect(artifacts.nth(0)).toHaveText('MOSP 工程');
  await expect(artifacts.nth(1)).toHaveText('SRT 字幕');
  await expect(artifacts.nth(0)).toHaveClass(/selected/);
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\source.replace.mosp');
  await expect(artifacts.nth(0)).toHaveAttribute('title', 'source.replace.mosp\nD:\\Demo\\source.replace.mosp');
  await expect(artifacts.nth(0)).toHaveAttribute('aria-label', /MOSP 工程.*source\.replace\.mosp.*D:\\Demo\\source\.replace\.mosp/);

  await page.locator('#langToggle').click();
  await expect(artifacts.nth(0)).toHaveText('MOSP project');
  await expect(artifacts.nth(1)).toHaveText('SRT subtitles');

  await artifacts.nth(1).click();
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\clip.replace.srt');
  await expect(page.locator('#jsonPath')).toHaveValue('D:\\Demo\\source.replace.mosp');
  await expect(page.locator('#srtPath')).toHaveValue('D:\\Demo\\clip.replace.srt');

  await runReplacement(page, { outputMode: 'srt' });
  const srtOnly = page.locator('.toolbox-chain-item').nth(1).locator('.toolbox-chain-file');
  await expect(srtOnly).toHaveCount(1);
  await expect(srtOnly).toHaveText('SRT subtitles');
  await expect(srtOnly).toHaveClass(/selected/);
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\clip.replace.srt');
});

test('artifact context menu exposes exactly three actions and closes on every required path', async ({ page }) => {
  await openLauncher(page);
  await runReplacement(page);
  await page.locator('#langToggle').click();
  await page.evaluate(() => {
    window.__artifactCalls = [];
    const callBackend = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (['open_file', 'open_containing_folder'].includes(method)) {
        window.__artifactCalls.push({ method, payload });
        return { ok: true };
      }
      return callBackend(method, payload);
    };
  });

  const project = page.locator('.toolbox-chain-file').nth(0);
  const srt = page.locator('.toolbox-chain-file').nth(1);
  await srt.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Artifact actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  await expect(menu.getByRole('menuitem').nth(0)).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Set as processing target' }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\clip.replace.srt');

  await srt.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open containing folder' }).click();
  await srt.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open file', exact: true }).click();
  expect(await page.evaluate(() => window.__artifactCalls)).toEqual([
    { method: 'open_containing_folder', payload: { path: 'D:\\Demo\\clip.replace.srt' } },
    { method: 'open_file', payload: { path: 'D:\\Demo\\clip.replace.srt' } },
  ]);

  await srt.click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(srt).toBeFocused();

  await srt.click({ button: 'right' });
  await page.locator('#toolboxTitle').click();
  await expect(menu).toBeHidden();

  await srt.click({ button: 'right' });
  await project.click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(1);
  await expect(menu).toBeVisible();

  const nativeContext = await page.locator('#toolboxTitle').evaluate((element) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(nativeContext).toBe(false);
});

test('artifact context menu remains inside the viewport and reports failed bridge actions', async ({ page }) => {
  await openLauncher(page);
  await runReplacement(page);
  await page.locator('#langToggle').click();
  await page.evaluate(() => {
    window.MAWLauncher.callBackend = async (method) => (
      method === 'open_file' ? { ok: false, error: 'File does not exist' } : { ok: true }
    );
  });

  const artifact = page.locator('.toolbox-chain-file').nth(0);
  await artifact.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: window.innerWidth - 1,
      clientY: window.innerHeight - 1,
    }));
  });
  const menu = page.getByRole('menu', { name: 'Artifact actions' });
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);

  await menu.getByRole('menuitem', { name: 'Open file', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#toolboxResult')).toContainText('File does not exist');
  await expect(artifact).toHaveClass(/selected/);
});

test('artifact context menu restores artifact focus after each action closes it', async ({ page }) => {
  // Given: a generated artifact with successful native artifact actions.
  await openLauncher(page);
  await runReplacement(page);
  await page.evaluate(() => {
    const callBackend = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => (
      ['open_file', 'open_containing_folder'].includes(method)
        ? { ok: true }
        : callBackend(method, payload)
    );
  });

  const artifact = page.locator('.toolbox-chain-file').nth(1);
  const menu = page.getByRole('menu');
  for (const action of ['设为处理目标', '打开所在文件夹', '打开文件']) {
    // When: an artifact menu action closes the menu.
    await artifact.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: action, exact: true }).click();

    // Then: focus returns to the originating artifact, never the hidden menu.
    await expect(menu).toBeHidden();
    await expect(artifact).toBeFocused();
  }
});

test('Escape closes an artifact context menu while postprocess is busy', async ({ page }) => {
  // Given: an open artifact menu while a postprocess request remains pending.
  await openLauncher(page);
  await runReplacement(page);
  await page.evaluate(() => {
    const callBackend = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = (method, payload) => (
      method === 'run_fixed_process'
        ? new Promise(() => {})
        : callBackend(method, payload)
    );
  });
  const artifact = page.locator('.toolbox-chain-file').nth(0);
  const menu = page.getByRole('menu');
  await page.locator('#runFixedProcess').click();
  await expect(page.locator('#toolboxProgress')).toBeVisible();
  await artifact.click({ button: 'right' });
  await expect(menu).toBeVisible();

  // When: Escape is pressed while the busy guard is active.
  const escapeConsumed = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });

  // Then: Escape is consumed, the menu closes, and focus returns to the artifact.
  expect(escapeConsumed).toBe(true);
  await expect(menu).toBeHidden();
  await expect(artifact).toBeFocused();
});

test('artifact context menu opens at the viewport pointer after Launcher zoom', async ({ page }) => {
  // Given: generated artifacts and Launcher CSS zoom at 125%.
  await openLauncher(page);
  await runReplacement(page);
  await page.evaluate(() => {
    document.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100,
    }));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('105%');
  for (let index = 0; index < 4; index += 1) {
    await page.evaluate(() => {
      document.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
      }));
    });
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('125%');

  // When: the artifact context menu is opened at a known viewport point.
  const pointer = { x: 420, y: 260 };
  await page.locator('.toolbox-chain-file').first().evaluate((element, point) => {
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
    }));
  }, pointer);

  // Then: the rendered menu rect starts at the event client point within pixel tolerance.
  const bounds = await page.getByRole('menu').boundingBox();
  expect(Math.abs(bounds.x - pointer.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(bounds.y - pointer.y)).toBeLessThanOrEqual(2);
});

test('toolbox resize preserves the other axis and converts pointer deltas through CSS zoom', async ({ page }) => {
  // Given: an open toolbox at 125% zoom with a stable explicit size.
  await openLauncher(page);
  await page.evaluate(() => {
    for (let index = 0; index < 5; index += 1) {
      document.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
      }));
    }
    const drawer = document.getElementById('toolboxDrawer');
    drawer.style.width = '480px';
    drawer.style.blockSize = '400px';
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('125%');
  const before = await page.locator('#toolboxDrawer').evaluate((element) => ({
    cssWidth: Number.parseFloat(getComputedStyle(element).width),
    cssHeight: Number.parseFloat(getComputedStyle(element).height),
  }));

  // When: height grows by 50 viewport pixels, then width grows by 50 viewport pixels.
  const heightHandle = page.locator('#toolboxResizeY');
  const heightBox = await heightHandle.boundingBox();
  await page.mouse.move(heightBox.x + heightBox.width / 2, heightBox.y + heightBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(heightBox.x + heightBox.width / 2, heightBox.y + heightBox.height / 2 - 50);
  await page.mouse.up();
  const afterHeight = await page.locator('#toolboxDrawer').evaluate((element) => ({
    cssWidth: Number.parseFloat(getComputedStyle(element).width),
    cssHeight: Number.parseFloat(getComputedStyle(element).height),
  }));

  const widthHandle = page.locator('#toolboxResizeX');
  const widthBox = await widthHandle.boundingBox();
  await page.mouse.move(widthBox.x + widthBox.width / 2, widthBox.y + widthBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(widthBox.x + widthBox.width / 2 - 50, widthBox.y + widthBox.height / 2);
  await page.mouse.up();
  const afterWidth = await page.locator('#toolboxDrawer').evaluate((element) => ({
    cssWidth: Number.parseFloat(getComputedStyle(element).width),
    cssHeight: Number.parseFloat(getComputedStyle(element).height),
  }));

  // Then: 50 viewport pixels become 40 CSS pixels and each drag leaves its other axis unchanged.
  expect(afterHeight.cssWidth).toBeCloseTo(before.cssWidth, 0);
  expect(afterHeight.cssHeight - before.cssHeight).toBeCloseTo(40, 0);
  expect(afterWidth.cssWidth - afterHeight.cssWidth).toBeCloseTo(40, 0);
  expect(afterWidth.cssHeight).toBeCloseTo(afterHeight.cssHeight, 0);
});
