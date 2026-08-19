// FCP 7 XML 导出 UI 的浏览器回归。
// 通过 mock showSaveFilePicker / anchor 下载验证：弹窗默认值、封闭选项、
// 导出计划、取消/失败/已发起的差异化提示、
// 无媒体时长时不出现假成功。纯序列化正确性由 tests/test_editor_utils.mjs 覆盖。
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  disableOnboarding,
  findFreePort,
  generateWaveformPayload,
  generateWav,
  makeTempDir,
  startServer,
} from './helpers.mjs';

// 与计划基线一致的 6 秒单媒体工程：移除 [1000,1600) 与 [4000,4500)，
// 输出行长 4900ms；含禁用人、跨越切口、完全落入切口的字幕与一张贴纸。
const FCP7_DURATION_MS = 6_000;

function generateFcp7ProjectJson(filePath) {
  const project = {
    media: 'synthetic.wav',
    gap_remove: {
      gaps: [
        { start: 1000, end: 1600, removed: true },
        { start: 4000, end: 4500, removed: true },
      ],
    },
    segments: [
      { start: 0, end: 900, text: 'Alpha', items: [{ start: 0, end: 900, text: 'Alpha' }],
        sticker: { name: 'Star', rel: 'stickers/star.png', start: 0, end: 900 } },
      { start: 1050, end: 1500, text: 'InsideGap', items: [{ start: 1050, end: 1500, text: 'InsideGap' }] },
      { start: 2000, end: 2500, text: 'Beta', disabled: true, items: [{ start: 2000, end: 2500, text: 'Beta' }] },
      { start: 3500, end: 4700, text: 'Crossing', items: [{ start: 3500, end: 4700, text: 'Crossing' }] },
      { start: 5000, end: 5900, text: 'After', items: [{ start: 5000, end: 5900, text: 'After' }] },
    ],
    waveform: generateWaveformPayload(FCP7_DURATION_MS),
  };
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
  return filePath;
}

// 每个用例前安装可编程的保存面：'save' 记录内容，'abort' 模拟用户取消，
// 'fail' 模拟写入失败；顺序消费，未配置时默认 'save'。
async function stubSavePicker(page) {
  await page.addInitScript(() => {
    window.__exportSaves = [];
    window.__exportPickerCalls = 0;
    window.showSaveFilePicker = async (options) => {
      window.__exportPickerCalls += 1;
      const behavior = (window.__exportPickerBehavior || []).shift() || 'save';
      if (behavior === 'abort') {
        const error = new Error('user cancelled');
        error.name = 'AbortError';
        throw error;
      }
      if (behavior === 'fail') throw new Error('disk full');
      return {
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
      };
    };
  });
}

async function openFcp7Modal(page) {
  await page.locator('#extra-export-btn').click();
  await page.locator('#download-fcp7-export').click();
  await expect(page.locator('#fcp7-export-modal')).toHaveClass(/show/);
}

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('fcp7-export');
  const mediaPath = join(tempDir, 'synthetic.wav');
  const projectPath = join(tempDir, 'project.json');
  generateWav(mediaPath, FCP7_DURATION_MS / 1000);
  generateFcp7ProjectJson(projectPath);
  server = await startServer(projectPath, mediaPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

test('opens the export modal with native text unchecked and closed choices only', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await expect(page.locator('#download-fcp7-export')).toBeAttached();

  await openFcp7Modal(page);
  await expect(page.locator('#fcp7-export-native-text')).not.toBeChecked();
  await expect(page.locator('#fcp7-export-timeline-mode')).toHaveValue('gap_removed');
  await expect(page.locator('#fcp7-export-fps')).toHaveValue('30');

  const fpsValues = await page.locator('#fcp7-export-fps option').evaluateAll(
    (options) => options.map((option) => option.value),
  );
  expect(fpsValues).toEqual(['24', '25', '30', '30000/1001', '50', '60', '60000/1001']);
  const trackOptions = page.locator('#fcp7-export-subtitle-tracks option');
  expect(await trackOptions.evaluateAll((options) => options.map((option) => option.value)))
    .toEqual(['main', 'main_and_extension']);
  // 工程没有扩展轨：组合选项被禁用而不是悄悄猜测。
  await expect(page.locator('#fcp7-export-subtitle-tracks option[value="main_and_extension"]'))
    .toBeDisabled();
  await expect(page.locator('#fcp7-export-subtitle-tracks')).toHaveValue('main');

  await page.locator('#fcp7-export-cancel').click();
  await expect(page.locator('#fcp7-export-modal')).not.toHaveClass(/show/);
});

test('commits the active panel edit, then saves XML without exporting SRT', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);

  // 打开弹窗前仍在编辑面板文本：导出必须先提交这条编辑再构建计划。
  await page.locator('.cue[data-idx="3"]').click();
  await page.locator('#cue-panel-text').fill('Crossing edited');
  await openFcp7Modal(page);
  await expect(page.locator('#fcp7-export-native-text')).not.toBeChecked();
  await page.locator('#fcp7-export-confirm').click();

  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const saves = await page.evaluate(() => window.__exportSaves);
  expect(saves[0].suggestedName).toMatch(/\.xml$/);

  const xml = saves[0].content;
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">'))
    .toBe(true);
  // 4900ms @ 30fps → 147 帧；三条保留区间各一个视频片段，贴纸一条。
  expect(xml).toContain('<duration>147</duration>');
  expect((xml.match(/<clipitem id="video-clip-/g) || []).length).toBe(3);
  expect((xml.match(/<clipitem id="sticker-clip-/g) || []).length).toBe(1);
  expect(xml).not.toContain('generatoritem');

  await expect(page.locator('.hint-card.hint-success').last())
    .toContainText('FCP 7 XML 已保存');
});

test('emits GraphicAndType text clips only after explicit opt-in', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);

  await openFcp7Modal(page);
  await page.locator('#fcp7-export-native-text').check();
  await page.locator('#fcp7-export-confirm').click();

  await expect.poll(() => page.evaluate(() => window.__exportSaves.length)).toBe(1);
  const saves = await page.evaluate(() => window.__exportSaves);
  expect((saves[0].content.match(/<clipitem id="text-main-/g) || []).length).toBe(3);
  expect((saves[0].content.match(/<effectid>GraphicAndType<\/effectid>/g) || []).length).toBe(3);
  expect(saves[0].content).not.toContain('<generatoritem>');
  // 上一用例的面板编辑会被服务器自动保存，文本以当前工程状态为准。
  expect(saves[0].content).toMatch(/<value>[A-Za-z0-9+/=]+<\/value>/);
  await expect(page.locator('.hint-card.hint-success').last())
    .toContainText('FCP 7 XML 已保存');
});

test('cancelling the XML save reports cancellation', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  await page.evaluate(() => { window.__exportPickerBehavior = ['abort']; });

  await openFcp7Modal(page);
  await page.locator('#fcp7-export-confirm').click();

  await expect(page.locator('.hint-card.hint-invalid').last())
    .toContainText('FCP 7 XML 保存已取消');
  expect(await page.evaluate(() => window.__exportPickerCalls)).toBe(1);
  expect(await page.evaluate(() => window.__exportSaves.length)).toBe(0);
  await expect(page.locator('.hint-card.hint-success')).toHaveCount(0);
});

test('anchor fallback reports a dispatched XML download rather than a confirmed save', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  // 捕获 anchor 派发本身，验证“已发起”语义，而不依赖浏览器下载策略。
  await page.evaluate(() => {
    window.showSaveFilePicker = undefined;
    window.__anchorDispatches = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download) window.__anchorDispatches.push(this.download);
      return originalClick.apply(this, arguments);
    };
  });

  await openFcp7Modal(page);
  await page.locator('#fcp7-export-confirm').click();

  await expect.poll(() => page.evaluate(() => window.__anchorDispatches.length)).toBe(1);
  const dispatches = await page.evaluate(() => window.__anchorDispatches);
  expect(dispatches[0]).toMatch(/\.xml$/);
  await expect(page.locator('.hint-card.hint-success').last())
    .toContainText('FCP 7 XML 下载已发起');
});

test('missing media duration fails the export with no save attempt and no false success', async ({ page }) => {
  await disableOnboarding(page);
  await stubSavePicker(page);
  await page.goto(server.url);
  await page.evaluate(() => {
    DATA.waveform = null;
    // durationMs 是只读 getter：清空 payload 并让媒体时长不可读，导出计划即拒绝构建。
    if (waveformEditor) waveformEditor.payload = null;
    Object.defineProperty(player, 'duration', { configurable: true, get: () => Number.NaN });
  });

  await openFcp7Modal(page);
  await page.locator('#fcp7-export-confirm').click();

  await expect(page.locator('.hint-card.hint-warning').last())
    .toContainText('FCP 7 XML 导出失败');
  expect(await page.evaluate(() => window.__exportPickerCalls)).toBe(0);
  await expect(page.locator('#fcp7-export-confirm')).toBeEnabled();
});

test('translates the export modal into English and keeps native text unchecked', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
  await disableOnboarding(page);
  await page.goto(server.url);

  await openFcp7Modal(page);
  await expect(page.locator('#fcp7-export-title'))
    .toHaveText('Premiere FCP 7 XML (experimental)');
  await expect(page.locator('#fcp7-export-confirm')).toHaveText('Export XML');
  await expect(page.locator('#fcp7-export-modal')).toContainText('Write native subtitle text objects');
  await expect(page.locator('#fcp7-export-native-text')).not.toBeChecked();
});
