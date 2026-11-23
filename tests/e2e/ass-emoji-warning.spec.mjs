import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { createUtilsModule as createProjectTracks } from '../../web/shared/utils/project-tracks.js';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';
import { stubAssFontCoverage } from './ass-font-readiness.mjs';

const plainText = '( •̀ ω •́ )y 123 # *';
const message = '字幕含有 emoji。当前 ASS 烧录不支持彩色 emoji，可能只呈单色或缺字。请用「实际画面预览」检查。';

async function openProject(page, project) {
  expect(await page.evaluate(data => MaweMultiImport.openProjectFile(
    new File([JSON.stringify(data)], 'subtitles.mosp', { type: 'application/json' }),
    { suppressMediaPrompt: true },
  ), project)).toBe(true);
}

test('ASS warns about emoji across tracks, including hidden secondary subtitles', async ({ page }, testInfo) => {
  const directory = makeTempDir('ass-emoji-warning');
  let server;
  try {
    server = await startBlankServer(await findFreePort(), join(directory, 'settings'));
    await disableOnboarding(page);
    await stubAssFontCoverage(page);
    await page.goto(server.url);
    await page.waitForFunction(() => Boolean(window.MaweMultiImport && window.MaweAssFrame));
    const warning = page.getByRole('img', { name: message });
    const quickMode = page.locator('#ass-mode-quick-toggle');
    const legacy = { segments: [{ start: 0, end: 900, text: '☀️' }] };
    await openProject(page, legacy);
    await expect(warning).toBeHidden();
    await quickMode.click();
    await expect(warning).toBeVisible();
    await quickMode.click();
    await expect(warning).toBeHidden();

    const project = createProjectTracks().makeProject([{ start: 0, end: 900, text: plainText }],
      { projectFields: { preview: { ass_mode: true } } });
    project.tracks.push({ id: 'hidden', role: 'secondary', name: 'Hidden', enabled: false,
      preview_visible: false, export: { enabled: false },
      segments: [{ id: 'emoji', start: 0, end: 900, text: '1️⃣' }] });
    project.bilingual.active_track_id = 'hidden';
    await openProject(page, project);
    const camera = page.locator('#ass-frame-quick-open');
    await expect(camera).toBeVisible();
    await expect(warning).toBeVisible();
    const warningRect = await warning.boundingBox();
    const cameraRect = await camera.boundingBox();
    const horizontalGap = cameraRect.x - warningRect.x - warningRect.width;
    expect(horizontalGap).toBeGreaterThanOrEqual(8);

    const tooltip = page.getByRole('tooltip').getByText(message, { exact: true });
    await warning.focus();
    await expect(tooltip).toBeVisible();
    const tooltipRect = await tooltip.boundingBox();
    const verticalGap = Math.max(tooltipRect.y - warningRect.y - warningRect.height,
      warningRect.y - tooltipRect.y - tooltipRect.height);
    expect(verticalGap).toBeGreaterThanOrEqual(8);
    const viewport = page.viewportSize();
    expect(tooltipRect.x).toBeGreaterThanOrEqual(0);
    expect(tooltipRect.y).toBeGreaterThanOrEqual(0);
    expect(tooltipRect.x + tooltipRect.width).toBeLessThanOrEqual(viewport.width);
    expect(tooltipRect.y + tooltipRect.height).toBeLessThanOrEqual(viewport.height);
    console.info(`ASS emoji warning spacing: ${horizontalGap}px horizontal, ${verticalGap}px vertical`);
    await page.screenshot({ path: testInfo.outputPath('ass-emoji-warning.png'), animations: 'disabled' });
    await camera.hover();
    await expect(warning).toBeFocused();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await page.keyboard.press('Tab');
    await expect(camera).toBeFocused();
    await warning.hover();
    await expect(tooltip).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();

    await page.evaluate(text => MaweCommands.run('Edit cue', () => {
      AsrEditorUtils.getTrack(MaweBoot.DATA, 'hidden').segments[0].text = text;
    }), plainText);
    await expect(warning).toBeHidden();
    await page.locator('#undo-btn').click();
    await expect(warning).toBeVisible();
    await page.locator('#redo-btn').click();
    await expect(warning).toBeHidden();
    await openProject(page, { ...legacy, preview: { ass_mode: true } });
    await expect(warning).toBeVisible();
  } finally {
    await server?.stop();
    cleanupTempDir(directory);
  }
});
