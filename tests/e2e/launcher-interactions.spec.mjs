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
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\source.fixed.mosp');
  await expect(artifacts.nth(0)).toHaveAttribute('title', 'source.fixed.mosp\nD:\\Demo\\source.fixed.mosp');
  await expect(artifacts.nth(0)).toHaveAttribute('aria-label', /MOSP 工程.*source\.fixed\.mosp.*D:\\Demo\\source\.fixed\.mosp/);

  await page.locator('#langToggle').click();
  await expect(artifacts.nth(0)).toHaveText('MOSP project');
  await expect(artifacts.nth(1)).toHaveText('SRT subtitles');

  await artifacts.nth(1).click();
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\clip.fixed.srt');
  await expect(page.locator('#jsonPath')).toHaveValue('D:\\Demo\\source.fixed.mosp');
  await expect(page.locator('#srtPath')).toHaveValue('D:\\Demo\\clip.fixed.srt');

  await runReplacement(page, { outputMode: 'srt' });
  const srtOnly = page.locator('.toolbox-chain-item').nth(1).locator('.toolbox-chain-file');
  await expect(srtOnly).toHaveCount(1);
  await expect(srtOnly).toHaveText('SRT subtitles');
  await expect(srtOnly).toHaveClass(/selected/);
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\clip.fixed.srt');
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
  await expect(page.locator('#toolboxInputPath')).toHaveValue('D:\\Demo\\clip.fixed.srt');

  await srt.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open containing folder' }).click();
  await srt.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open file', exact: true }).click();
  expect(await page.evaluate(() => window.__artifactCalls)).toEqual([
    { method: 'open_containing_folder', payload: { path: 'D:\\Demo\\clip.fixed.srt' } },
    { method: 'open_file', payload: { path: 'D:\\Demo\\clip.fixed.srt' } },
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

test('batch mode disables manuscript matching without changing its saved single-file choice', async ({ page }) => {
  // Given: manuscript matching is configured and selected for single-file transcription.
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#autoPostprocessEnabled').check();
  await page.evaluate(() => {
    const field = document.getElementById('postprocessScriptPath');
    field.value = 'D:\\Demo\\script.txt';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const match = page.locator('#autoStepMatch');
  await match.check();
  await expect(match).toBeChecked();
  await expect(page.locator('#toolboxDrawer')).toBeHidden();
  await page.evaluate(() => {
    window.__savedPlans = [];
    const callBackend = window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend = async (method, payload) => {
      if (method === 'save_postprocess_plan') window.__savedPlans.push(JSON.parse(JSON.stringify(payload.plan)));
      return callBackend(method, payload);
    };
  });

  // When: batch mode is selected and another setting is edited (which persists the plan).
  await page.locator('#batchMode').click();

  // Then: matching is visibly unavailable but the user's selection is preserved.
  await expect(match).toBeChecked();
  await expect(match).toBeDisabled();
  await expect(page.locator('[data-auto-step-row="match"]')).toHaveClass(/batch-unavailable/);
  await expect(page.locator('#batchManuscriptNotice')).toBeVisible();
  await expect(page.locator('#batchManuscriptNotice')).toHaveAttribute('role', 'note');
  await page.evaluate(() => {
    const field = document.getElementById('postprocessReplacements');
    field.value = 'old => new';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => (window.__savedPlans || []).length > 0);
  const plans = await page.evaluate(() => window.__savedPlans);
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) {
    expect(plan.steps.find((step) => step.id === 'match').enabled).toBe(true);
  }

  // When: single-file mode is restored.
  await page.locator('#singleMode').click();

  // Then: the saved single-file choice is untouched.
  await expect(match).toBeChecked();
  await expect(match).toBeEnabled();
});

test('batch start delegates output allocation and batchDone reconciles every terminal outcome', async ({ page }) => {
  // Given: three queued files and a bridge spy that leaves allocation to the batch backend.
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#batchMode').click();
  await page.evaluate(() => {
    window.__batchCalls = [];
    window.MAWLauncher.callBackend = async (method, payload) => {
      window.__batchCalls.push({ method, payload });
      return { ok: true };
    };
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [{ path: 'D:\\Demo\\first.mp3' }, { path: 'D:\\Demo\\second.mp3' }, { path: 'D:\\Demo\\third.mp3' }] },
    });
    document.getElementById('mediaCard').dispatchEvent(drop);
  });

  // When: the run starts and the backend reports one completed and one cancelled item.
  await page.locator('#startBatch').click();
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({
    type: 'batch_done',
    status: 'cancelled',
    outcomes: [
      { id: 'batch-1', status: 'done', result: { srt_path: 'D:\\Demo\\first.srt', json_path: 'D:\\Demo\\first.mosp' } },
      { id: 'batch-2', status: 'cancelled', error: 'Cancelled before start' },
    ],
  }));

  // Then: no preallocation call occurred and the single-file paths stay out of the shared settings.
  const calls = await page.evaluate(() => window.__batchCalls);
  expect(calls.map(({ method }) => method)).toEqual(['start_batch_transcription']);
  expect(calls[0].payload.items).toEqual([
    { id: 'batch-1', mediaPath: 'D:\\Demo\\first.mp3' },
    { id: 'batch-2', mediaPath: 'D:\\Demo\\second.mp3' },
    { id: 'batch-3', mediaPath: 'D:\\Demo\\third.mp3' },
  ]);
  expect(calls[0].payload.settings.mediaPath).toBeUndefined();
  expect(calls[0].payload.settings.srtPath).toBeUndefined();
  expect(calls[0].payload.settings.providerId).toBeTruthy();

  // Then: every row reaches a terminal state, including the unreported cancelled leftover.
  const rows = page.locator('.batch-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveClass(/done/);
  await expect(rows.nth(1)).toHaveClass(/cancelled/);
  await expect(rows.nth(2)).toHaveClass(/cancelled/);
  await expect(rows.nth(2).locator('.batch-status')).toHaveText('已取消');
  await expect(page.locator('.batch-row.queued')).toHaveCount(0);
  await expect(rows.nth(0).getByRole('button', { name: '打开工程' })).toBeVisible();
  await expect(rows.nth(0).getByRole('button', { name: '打开文件夹' })).toBeVisible();
});

test('batchDone fails rows that never reported when the batch was not cancelled', async ({ page }) => {
  // Given: two queued files started in batch mode.
  await page.goto(`file://${launcherPath}`);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  await page.locator('#batchMode').click();
  await page.evaluate(() => {
    window.MAWLauncher.callBackend = async () => ({ ok: true });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [{ path: 'D:\\Demo\\first.mp3' }, { path: 'D:\\Demo\\second.mp3' }] },
    });
    document.getElementById('mediaCard').dispatchEvent(drop);
  });

  // When: the batch finishes normally but only one item ever reported an outcome.
  await page.locator('#startBatch').click();
  await page.evaluate(() => window.MAWLauncher.onBackendEvent({
    type: 'batchDone',
    status: 'done',
    outcomes: [{ id: 'batch-1', status: 'done', srtPath: 'D:\\Demo\\first.srt', jsonPath: 'D:\\Demo\\first.mosp' }],
  }));

  // Then: the unreported row cannot remain queued and explains its failure.
  const rows = page.locator('.batch-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveClass(/done/);
  await expect(rows.nth(1)).toHaveClass(/failed/);
  await expect(rows.nth(1).locator('.batch-status')).toHaveText('失败');
  await expect(rows.nth(1).locator('.batch-details')).toContainText('批量结束时未收到该文件的结果');
  await expect(page.locator('.batch-row.queued')).toHaveCount(0);
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
