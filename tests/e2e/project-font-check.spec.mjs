import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { findFreePort, makeTempDir, cleanupTempDir, startBlankServer, startServer, generateWav } from './helpers.mjs';

let server;
let temp;
const good = {
  schema: 'moy.asr.font_aliases.v1',
  fonts: [{ canonical: 'Good Font', family: ['Good Font'], names: ['Good Font'],
    legacy: ['Old Font'], canonicalByName: { 'old font': 'Good Font' } }],
};
const bad = { schema: good.schema, fonts: [], error: 'scan failed' };
const canonical = JSON.parse(readFileSync(new URL('../fixtures/project-tracks/legacy-three-tracks.expected.json', import.meta.url), 'utf8'));
const project = (main, extension = null) => ({
  media: '', segments: [{ start: 0, end: 1000, text: 'Hello' }],
  preview: { subtitle: { x: 0.1, y: 0.76, width: 0.8, height: 0.16, font_family: main },
    ...(extension ? { extension_subtitle: { font_family: extension } } : {}) },
});
async function open(page, data, name = 'test.mosp') {
  await page.locator('#open-project-file').setInputFiles({
    name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)),
  });
  await expect(page.locator('#json-name')).toHaveText(name);
}
test.beforeAll(async () => {
  temp = makeTempDir('project-font-check');
  server = await startBlankServer(await findFreePort(), temp);
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(temp); });

test('confirmation, cancel, replacement, undo and save/reopen', async ({ page }) => {
  await page.addInitScript(() => {
    window.showSaveFilePicker = async () => ({ name: 'saved.mosp', async getFile() { return new File([], 'saved.mosp'); }, async createWritable() {
      return { async write(blob) { window.savedProject = JSON.parse(await blob.text()); }, async close() {} };
    } });
  });
  await page.route('**/api/ass-font-aliases', route => route.fulfill({ json: good }));
  await page.goto(server.url);
  const libraryBefore = await page.evaluate(async () => (await fetch('/api/ass-styles')).json());
  await open(page, project('Old Font', 'Missing Font'));
  const box = page.locator('.project-font-check');
  await expect(box).toContainText('Old Font → Good Font');
  await expect(box).toContainText('Missing Font');
  await box.screenshot({ path: '.artifacts/project-font-check.png' });
  const spacing = await box.evaluate(element => {
    const input = element.querySelector('input').getBoundingClientRect();
    const button = [...element.querySelectorAll('button')].find(item => item.textContent === '统一替换缺失字体').getBoundingClientRect();
    const actions = element.querySelector('.project-font-check-actions').getBoundingClientRect();
    return { horizontal: button.left - input.right, vertical: actions.top - button.bottom };
  });
  expect(spacing.horizontal).toBeGreaterThanOrEqual(8);
  expect(spacing.vertical).toBeGreaterThanOrEqual(8);
  await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
  await expect(box).toContainText('Project font check');
  await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
  await box.getByText('暂时继续').click();
  expect(await page.evaluate(() => MaweBoot.DATA.preview.subtitle.font_family)).toBe('Old Font');
  await open(page, project('Old Font', 'Missing Font'));
  await box.getByText('确认并替换旧名称').click();
  await expect(box).not.toContainText('Old Font → Good Font');
  expect(await page.evaluate(() => MaweBoot.DATA.preview.subtitle.font_family)).toBe('Good Font');
  await box.getByLabel('替换为本机字体').fill('Good Font');
  await box.getByText('统一替换缺失字体').click();
  await expect(box).toHaveCount(0);
  expect(await page.evaluate(() => MaweBoot.DATA.preview.extension_subtitle.font_family)).toBe('Good Font');
  expect(await page.evaluate(async () => (await fetch('/api/ass-styles')).json())).toEqual(libraryBefore);
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => MaweBoot.DATA.preview.extension_subtitle.font_family)).toBe('Missing Font');
  await page.evaluate(() => MaweHistory.performRedo());
  await page.evaluate(() => MaweProjectSave.saveProjectAsToFile());
  const saved = await page.evaluate(() => window.savedProject);
  expect(saved.preview.extension_subtitle.font_family).toBe('Good Font');
  await open(page, saved, 'saved.mosp');
  await expect(box).toHaveCount(0);
  expect(await page.evaluate(() => MaweBoot.DATA.preview.extension_subtitle.font_family)).toBe('Good Font');
});

test('failed scan is unavailable, retry rescans, and old project results cannot appear after switching', async ({ page }) => {
  let mode = 'failed';
  let release;
  let gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/ass-font-aliases', async route => {
    if (mode === 'delayed') await gate;
    await route.fulfill({ json: mode === 'failed' ? bad : good });
  });
  await page.goto(server.url);
  await open(page, project('Missing Font'));
  const box = page.locator('.project-font-check');
  await expect(box).toContainText('暂时无法检查');
  await expect(box).not.toContainText('本机未匹配到');
  mode = 'good';
  await box.getByRole('button', { name: '重新检查' }).click();
  await expect(box).toContainText('Missing Font');
  mode = 'delayed';
  await box.getByRole('button', { name: '重新检查' }).click();
  await box.getByText('暂时继续').click();
  release();
  await page.evaluate(() => MaweAssFontAliases.reload());
  await expect(box).toHaveCount(0);
  gate = new Promise(resolve => { release = resolve; });
  mode = 'good';
  // A forced retry is delayed while a new project is opened.
  await open(page, project('Missing Font'), 'old.mosp');
  await expect(box).toContainText('Missing Font');
  mode = 'delayed';
  await box.getByRole('button', { name: '重新检查' }).click();
  await open(page, project('default'), 'new.mosp');
  release();
  await expect(box).toHaveCount(0);
  expect(await page.evaluate(() => MaweBoot.DATA.preview.subtitle.font_family || 'default')).toBe('default');
});

test('server refresh requires its request token and returns the actual scan result', async ({ page }) => {
  await page.goto(server.url);
  const result = await page.evaluate(async () => {
    const url = MaweBoot.SERVER_CONFIG.assFontAliasesUrl;
    const post = async requestToken => {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestToken }) });
      return { status: response.status, body: await response.json() };
    };
    return { denied: await post('wrong'), accepted: await post(MaweBoot.SERVER_CONFIG.requestToken) };
  });
  expect(result.denied.status).toBe(403);
  expect(result.accepted.status).toBe(200);
  expect(result.accepted.body.schema).toBe(good.schema);
  expect(result.accepted.body.error).toBeUndefined();
  expect(result.accepted.body.fonts.length).toBeGreaterThan(0);
});

test('server-started project is checked after startup', async ({ page }) => {
  const path = join(temp, 'startup.mosp');
  const media = generateWav(join(temp, 'startup.wav'), 1);
  writeFileSync(path, JSON.stringify(project('Old Font')));
  const bound = await startServer(path, media, await findFreePort());
  try {
    await page.route('**/api/ass-font-aliases', route => route.fulfill({ json: good }));
    await page.goto(bound.url);
    await expect(page.locator('.project-font-check')).toContainText('Old Font → Good Font');
  } finally { await bound.stop(); }
});

test('only explicit fonts are checked and mapping covers track, cue and preview in one undo', async ({ page }) => {
  await page.route('**/api/ass-font-aliases', route => route.fulfill({ json: good }));
  await page.goto(server.url);
  const noFonts = structuredClone(canonical);
  noFonts.media = '';
  await open(page, noFonts, 'default.mosp');
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.tracks[0].style?.font_default)).toBe(true);
  await expect(page.locator('.project-font-check')).toHaveCount(0);
  const savedDefault = await page.evaluate(() => JSON.parse(MaweJsonRepair.buildJson()));
  expect(savedDefault.tracks[0].style.font_default).toBe(true);
  await open(page, savedDefault, 'default-saved.mosp');
  await page.waitForTimeout(500);
  await expect(page.locator('.project-font-check')).toHaveCount(0);
  const explicit = structuredClone(noFonts);
  explicit.styles = [{ id: 'custom', name: 'custom', fontName: 'Missing Font' }];
  explicit.tracks[0].style = { style_id: 'custom' };
  explicit.tracks[0].segments[0].assStyle = { fontName: 'Missing Font' };
  explicit.preview = { ...(explicit.preview || {}), subtitle: { x: 0.1, y: 0.76, width: 0.8, height: 0.16, font_family: 'Missing Font' } };
  const validation = await page.evaluate(data => MaweProjectValidation.prepareProject(data), explicit);
  expect(validation.errors).toEqual([]);
  await open(page, explicit, 'explicit.mosp');
  const box = page.locator('.project-font-check');
  await expect(box).toContainText('Missing Font');
  await box.getByLabel('替换为本机字体').fill('Good Font');
  await box.getByText('统一替换缺失字体').click();
  await expect(box).toHaveCount(0);
  const fontNames = () => page.evaluate(() => ({
    track: MaweBoot.DATA.styles.find(style => style.id === MaweBoot.DATA.tracks[0].style.style_id).fontName,
    cue: MaweBoot.DATA.tracks[0].segments[0].assStyle.fontName,
    preview: MaweBoot.DATA.preview.subtitle.font_family,
  }));
  expect(await fontNames()).toEqual({ track: 'Good Font', cue: 'Good Font', preview: 'Good Font' });
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await fontNames()).toEqual({ track: 'Missing Font', cue: 'Missing Font', preview: 'Missing Font' });
  await page.evaluate(() => MaweHistory.performRedo());
  expect(await fontNames()).toEqual({ track: 'Good Font', cue: 'Good Font', preview: 'Good Font' });
});

test('legacy font name replacement covers track and cue styles', async ({ page }) => {
  await page.route('**/api/ass-font-aliases', route => route.fulfill({ json: good }));
  await page.goto(server.url);
  const data = structuredClone(canonical);
  data.media = '';
  data.styles = [{ id: 'old', name: 'old', fontName: 'Old Font' }];
  data.tracks[0].style = { style_id: 'old' };
  data.tracks[0].segments[0].assStyle = { fontName: 'Old Font' };
  await open(page, data);
  const box = page.locator('.project-font-check');
  await expect(box).toContainText('Old Font → Good Font');
  await box.getByText('确认并替换旧名称').click();
  await expect(box).toHaveCount(0);
  expect(await page.evaluate(() => [MaweBoot.DATA.styles.find(style => style.id === 'old').fontName,
    MaweBoot.DATA.tracks[0].segments[0].assStyle.fontName])).toEqual(['Good Font', 'Good Font']);
  await page.evaluate(() => MaweHistory.performUndo());
  expect(await page.evaluate(() => [MaweBoot.DATA.styles.find(style => style.id === 'old').fontName,
    MaweBoot.DATA.tracks[0].segments[0].assStyle.fontName])).toEqual(['Old Font', 'Old Font']);
});
