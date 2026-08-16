// 拖入打开工程回归：空编辑器中同时拖入工程与媒体时，媒体必须随工程
// 自动加载（不再弹出「选择关联媒体」要求重选）；仅拖入工程时仍应弹窗提示。
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDir,
  findFreePort,
  generateBlankEditor,
  generateProjectJson,
  generateWav,
  makeTempDir,
  startStaticServer,
} from './helpers.mjs';

let tempDir;
let server;
let projectPath;
let mediaPath;

test.beforeAll(async () => {
  tempDir = makeTempDir('opendrop');
  mediaPath = join(tempDir, 'synthetic.wav');
  projectPath = join(tempDir, 'project.json');
  // 短媒体即可：只验证加载链路，不校验波形时长一致性。
  generateWav(mediaPath, 5);
  generateProjectJson(projectPath);
  server = await startStaticServer(generateBlankEditor(join(tempDir, 'blank.html')), await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

function dropFiles(page, files) {
  return page.evaluateHandle((fileSpecs) => {
    const dt = new DataTransfer();
    for (const spec of fileSpecs) {
      const bytes = Uint8Array.from(atob(spec.base64), (char) => char.charCodeAt(0));
      dt.items.add(new File([bytes], spec.name, { type: spec.type }));
    }
    return dt;
  }, files).then((dataTransfer) => page.dispatchEvent('body', 'drop', { dataTransfer }));
}

function projectSpec(name = 'project.json') {
  return { name, type: 'application/json', base64: readFileSync(projectPath).toString('base64') };
}

function mediaSpec() {
  return { name: 'synthetic.wav', type: 'audio/wav', base64: readFileSync(mediaPath).toString('base64') };
}

test('dropping project and media together auto-loads the media without prompting', async ({ page }) => {
  await page.goto(server.url);
  await dropFiles(page, [projectSpec(), mediaSpec()]);

  await expect(page.locator('#media-name')).toHaveText('synthetic.wav');
  await expect(page.locator('#project-media-modal')).not.toHaveClass(/show/);
  const playerSrc = await page.evaluate(() => document.getElementById('player').currentSrc);
  expect(playerSrc.startsWith('blob:')).toBe(true);
});

test('dropping only a project still prompts to pick the associated media', async ({ page }) => {
  await page.goto(server.url);
  await dropFiles(page, [projectSpec()]);

  await expect(page.locator('#project-media-modal')).toHaveClass(/show/);
});

test('dropping a project over an existing project asks before offering open or extension choices', async ({ page }) => {
  await page.goto(server.url);
  await dropFiles(page, [projectSpec()]);
  await expect(page.locator('#project-media-modal')).toHaveClass(/show/);
  await page.locator('#project-media-later').click();

  await page.locator('.cue[data-idx="0"]').click();
  await page.locator('#cue-panel-text').fill('未保存改动');

  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });
  await dropFiles(page, [projectSpec('replacement.mosp')]);

  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0].type).toBe('confirm');
  expect(dialogs[0].message).toContain('是否继续处理此工程文件');
  await expect(page.locator('#multi-subtitle-import-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-import-replace')).toHaveText('打开工程');
  await expect(page.locator('#multi-subtitle-import-extension'))
    .toHaveText('使用工程字幕作为副字幕');
  await expect(page.locator('#multi-subtitle-import-result-confirm')).toBeDisabled();
  await page.locator('#multi-subtitle-import-replace').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();
  await expect(page.locator('#multi-subtitle-import-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#project-media-modal')).toHaveClass(/show/);
});

test('can use a dropped project subtitle as an extension and preserve optional items through a swap round trip', async ({ page }) => {
  const sourceProject = {
    media: '',
    segments: [{
      id: 'source-main-001',
      start: 100,
      end: 1900,
      text: '带字词时间码的副字幕',
      items: [{ text: '带字词时间码的副字幕', start: 100, end: 1900 }],
    }],
  };
  const sourceSpec = {
    name: 'translation.mosp',
    type: 'application/json',
    base64: Buffer.from(JSON.stringify(sourceProject), 'utf8').toString('base64'),
  };

  await page.goto(server.url);
  await dropFiles(page, [projectSpec()]);
  await expect(page.locator('#project-media-modal')).toHaveClass(/show/);
  await page.locator('#project-media-later').click();

  await dropFiles(page, [sourceSpec]);
  await expect(page.locator('#multi-subtitle-import-modal')).toHaveClass(/show/);
  await expect(page.locator('#multi-subtitle-import-result-confirm')).toBeDisabled();
  await page.locator('#multi-subtitle-import-extension').click();
  await page.locator('#multi-subtitle-import-result-confirm').click();

  const imported = await page.evaluate(() => JSON.parse(buildJson()));
  expect(imported.multi_subtitle.tracks[0].segments[0].items).toEqual([
    { text: '带字词时间码的副字幕', start: 100, end: 1900 },
  ]);

  await page.locator('#multi-subtitle-settings-toggle').click();
  await page.locator('#multi-subtitle-settings-menu').waitFor({ state: 'visible' });
  // 点击菜单项后齿轮菜单会关闭；交换回来需要重新打开菜单再点一次。
  await page.locator('#multi-subtitle-swap').click();
  await page.locator('#multi-subtitle-settings-toggle').click();
  await page.locator('#multi-subtitle-settings-menu').waitFor({ state: 'visible' });
  await page.locator('#multi-subtitle-swap').click();

  const roundTripped = await page.evaluate(() => JSON.parse(buildJson()));
  expect(roundTripped.multi_subtitle.tracks[0].segments[0].items).toEqual([
    { text: '带字词时间码的副字幕', start: 100, end: 1900 },
  ]);
});
