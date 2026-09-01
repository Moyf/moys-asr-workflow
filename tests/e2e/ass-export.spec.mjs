// ASS 导出 UI 回归：验证编辑器当前选中的字体、字号和颜色确实写进保存的文件。
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  disableOnboarding,
  findFreePort,
  generateWav,
  generateWaveformPayload,
  makeTempDir,
  startServer,
} from './helpers.mjs';

const DURATION_MS = 4_000;

function generateAssProjectJson(filePath) {
  const project = {
    media: 'synthetic.wav',
    segments: [
      { start: 1000, end: 2500, text: '第一行\nSecond, {literal}\\path' },
      { start: 3000, end: 3500, text: '不应导出', disabled: true },
    ],
    preview: {
      subtitle: {
        x: 0.1,
        y: 0.76,
        width: 0.8,
        height: 0.16,
        font_size: 32,
        font_family: 'yahei',
        color: '#123456',
      },
    },
    waveform: generateWaveformPayload(DURATION_MS),
  };
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
  return filePath;
}

async function stubSavePicker(page) {
  await page.addInitScript(() => {
    window.__exportSaves = [];
    window.showSaveFilePicker = async (options) => ({
      name: options.suggestedName,
      async createWritable() {
        return {
          async write(blob) {
            window.__exportSaves.push({
              suggestedName: options.suggestedName,
              content: await blob.text(),
            });
          },
          async close() {},
        };
      },
    });
  });
}

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('ass-export');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, DURATION_MS / 1000);
  generateAssProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('exports ASS with the current font, size, color and enabled subtitle text', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);

  await page.locator('#subtitle-preview-settings-toggle').click();
  await expect(page.locator('#subtitle-preview-settings-panel')).toBeVisible();
  await page.locator('#subtitle-font-family').selectOption('hei');
  await page.locator('#subtitle-font-size').selectOption('40');
  await page.locator('#subtitle-color').evaluate((input) => {
    input.value = '#12abef';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await page.locator('#subtitle-export-btn').click();
  await expect(page.locator('#download-full-ass')).toHaveText('完整字幕（ASS）');
  await page.locator('#download-full-ass').click();

  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const save = await page.evaluate(() => window.__exportSaves[0]);
  expect(save.suggestedName).toMatch(/\.ass$/);
  expect(save.content).toContain(
    'Style: Default,SimHei,40,&H00EFAB12,&H00EFAB12,',
  );
  expect(save.content).toContain(
    'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,第一行\\NSecond, \\{literal\\}\\\\path',
  );
  expect(save.content).not.toContain('不应导出');
});
