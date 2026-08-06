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

function projectSpec() {
  return { name: 'project.json', type: 'application/json', base64: readFileSync(projectPath).toString('base64') };
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
