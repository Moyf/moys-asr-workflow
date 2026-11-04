import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const launcherUrl = new URL('../../web/launcher/index.html', import.meta.url).href;

test('resegment exposes optional limits, persists the plan and measures field spacing', async ({ page }) => {
  await page.goto(launcherUrl);
  await completeStaticLauncherDiscovery(page);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length);
  await page.locator('#toolboxFab').click();
  await page.locator('#toolboxLlmTab').click();
  await page.locator('#postprocessOperation').selectOption('resegment');
  const options = page.locator('#postprocessResegmentOptions');
  const maximum = page.locator('#postprocessResegmentMaxChars');
  await expect(options).toBeVisible();
  await expect(maximum).toHaveValue('');
  await maximum.fill('18');
  const plan = await page.evaluate(() => window.MAWLauncher.getAutoPostprocessPayload());
  expect(plan.steps.find(s => s.id === 'resegment').maxChars).toBe('18');
  await page.locator('#postprocessOperation').selectOption('proofread');
  await expect(options).toBeHidden();
  await page.locator('#postprocessOperation').selectOption('resegment');
  await expect(maximum).toHaveValue('18');
  await options.scrollIntoViewIfNeeded();
  const distances = await options.evaluate(node => {
    const rect = e => e.getBoundingClientRect();
    let previous = node.previousElementSibling;
    while (previous && !rect(previous).height) previous = previous.previousElementSibling;
    const label = node.querySelector('label');
    const input = node.querySelector('input');
    const hint = node.querySelector('.hint');
    return { above: rect(node).top - rect(previous).bottom, inputAfterLabel: rect(input).top - rect(label).bottom, hintAfterInput: rect(hint).top - rect(input).bottom, below: rect(node.nextElementSibling).top - rect(node).bottom };
  });
  for (const [key, value] of Object.entries(distances)) expect(value, key).toBeGreaterThanOrEqual(8);
  const directory = process.env.MAW_RESEGMENT_ARTIFACT_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'ui-spacing.json'), JSON.stringify(distances, null, 2));
    await page.screenshot({ path: path.join(directory, 'launcher-resegment.png') });
  }
  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(page.locator('label[for="postprocessResegmentMaxChars"]')).toHaveText('Maximum characters per subtitle (optional)');
  if (directory) await page.screenshot({ path: path.join(directory, 'launcher-resegment-en.png') });
  await page.setViewportSize({ width: 720, height: 900 });
  await options.scrollIntoViewIfNeeded();
  await expect(maximum).toBeVisible();
  if (directory) await page.screenshot({ path: path.join(directory, 'launcher-resegment-narrow.png') });
});
