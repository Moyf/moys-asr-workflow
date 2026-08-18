import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/launcher/index.html');

test('Launcher Ctrl+wheel zoom is bounded, persisted, and leaves ordinary wheel alone', async ({ page }) => {
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.zoomPercent === 100);

  const zoom = async (deltaY) => page.evaluate((delta) => {
    document.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: delta }));
  }, deltaY);

  await zoom(-100);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('105%');
  for (let index = 0; index < 10; index += 1) await zoom(100);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('80%');
  for (let index = 0; index < 20; index += 1) await zoom(-100);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('150%');

  const ordinaryWheel = await page.evaluate(() => {
    const before = document.documentElement.style.zoom;
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    document.dispatchEvent(event);
    return { before, after: document.documentElement.style.zoom, prevented: event.defaultPrevented };
  });
  expect(ordinaryWheel).toEqual({ before: '150%', after: '150%', prevented: false });

  await page.locator('#toolboxFab').click();
  const toolboxWheel = await page.locator('.toolbox-content').first().evaluate((element) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, zoom: document.documentElement.style.zoom };
  });
  expect(toolboxWheel).toEqual({ prevented: false, zoom: '150%' });

  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForFunction(() => window.MAWLauncher?.config?.zoomPercent === 150);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('150%');
});

test('Launcher keyboard zoom supports equals, plus, minus, and reset without stealing native controls', async ({ page }) => {
  // Given: a fresh Launcher at the default zoom.
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.zoomPercent === 100);

  // When: the supported Ctrl keyboard variants are pressed on the document.
  const shortcuts = await page.evaluate(() => {
    const dispatch = (key, code, shiftKey = false) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        shiftKey,
        key,
        code,
      });
      document.body.dispatchEvent(event);
      return { prevented: event.defaultPrevented, zoom: document.documentElement.style.zoom };
    };
    return [
      dispatch('=', 'Equal'),
      dispatch('+', 'Equal', true),
      dispatch('-', 'Minus'),
      dispatch('0', 'Digit0'),
      dispatch('a', 'KeyA'),
    ];
  });

  // Then: only recognized shortcuts are prevented and zoom changes in 5% steps before reset.
  expect(shortcuts).toEqual([
    { prevented: true, zoom: '105%' },
    { prevented: true, zoom: '110%' },
    { prevented: true, zoom: '105%' },
    { prevented: true, zoom: '100%' },
    { prevented: false, zoom: '100%' },
  ]);

  const nativeControls = await page.evaluate(() => {
    const input = document.getElementById('mediaPath');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.append(editable);
    return [input, editable].map((target) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: '=',
        code: 'Equal',
      });
      target.dispatchEvent(event);
      return { prevented: event.defaultPrevented, zoom: document.documentElement.style.zoom };
    });
  });
  expect(nativeControls).toEqual([
    { prevented: false, zoom: '100%' },
    { prevented: false, zoom: '100%' },
  ]);
});
