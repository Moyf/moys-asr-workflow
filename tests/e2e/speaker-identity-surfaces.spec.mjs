import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { buildBrowserEditorFixture, cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload,
  makeTempDir, startStaticServer } from './helpers.mjs';

let dir;
let server;
test.beforeAll(async () => {
  dir = makeTempDir('speaker-surfaces');
  server = await startStaticServer(buildBrowserEditorFixture(join(dir, 'editor.html')), await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(dir); });
test.beforeEach(async ({ page }) => { await disableOnboarding(page); });

async function openProject(page) {
  await page.goto(server.url);
  const project = {
    schema: 'moy.asr.project.v2', annotation_mode: 'color', palette_size: 5,
    speakers: [
      { id: 'a', name: '同名', color: '#808080' },
      { id: 'b', name: '同名', color: '#808080' },
    ], speaker_shortcuts: {},
    tracks: [
      { id: 'main', role: 'main', name: '主字幕', enabled: true, segments: [
        { id: 'm1', start: 0, end: 1000, text: '主一', speaker: 'a', items: [] },
        { id: 'm2', start: 2000, end: 3000, text: '主二', speaker: 'b', items: [] },
        { id: 'm3', start: 4000, end: 5000, text: '主三', items: [] },
      ] },
      { id: 'secondary', role: 'secondary', name: '副字幕', enabled: true, segments: [
        { id: 's1', start: 0, end: 1000, text: '副一', speaker: 'b', items: [] },
      ] },
      { id: 'overlay', role: 'overlay', name: '叠加字幕', enabled: true, segments: [
        { id: 'o1', start: 1000, end: 1800, text: '叠一', speaker: 'a', items: [] },
      ] },
    ], bilingual: { display_mode: 'both', active_track_id: 'secondary' }, bindings: [],
    subtitle_groups: { next_id: 1, color: [], sticker: [] }, waveform: generateWaveformPayload(6000),
  };
  const transfer = await page.evaluateHandle(base64 => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'speakers.mosp', { type: 'application/json' }));
    return dt;
  }, Buffer.from(JSON.stringify(project)).toString('base64'));
  await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect.poll(() => page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA)?.segments?.[0]?.id)).toBe('m1');
  await expect(page.locator('.cue-speaker-badge').first()).toBeVisible();
}

test('identity is visible in color mode and filters distinguish same-name same-color people across tracks', async ({ page }) => {
  await openProject(page);
  const titles = await page.locator('.cue-speaker-badge').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-title') || node.title));
  expect(titles, JSON.stringify(titles)).toEqual(expect.arrayContaining(['说话人：同名（a）', '说话人：同名（b）']));
  expect(titles.filter(title => title.includes('（a）'))).toHaveLength(2);
  expect(titles.filter(title => title.includes('（b）'))).toHaveLength(2);
  await expect(page.locator('.cue-speaker-badge.unassigned')).toHaveCount(1);
  await page.locator('#color-filter-btn').click();
  await page.locator('.speaker-filter-item').filter({ hasText: '同名（b）' }).locator('.color-name').click();
  const visible = await page.locator('.cue:not(.hidden)').allTextContents();
  expect(visible.join(' ')).toContain('副一');
  expect(visible.join(' ')).toContain('主二');
  expect(visible.join(' ')).not.toContain('叠一');
  await page.getByRole('button', { name: '清除说话人过滤' }).click();
  await expect(page.locator('.overlay-track-cue')).not.toHaveClass(/hidden/);
});

test('panel and context menus assign or clear only the targeted track', async ({ page }) => {
  await openProject(page);
  await page.evaluate(() => MaweCuePanel.setCuePanelTarget('overlay', 0));
  await page.locator('#cue-panel-text').fill('叠一已编辑');
  await page.locator('.cue-panel-speaker select').selectOption('b');
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.tracks.find(t => t.id === 'overlay').segments[0].speaker)).toBe('b');
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.tracks.find(t => t.id === 'overlay').segments[0].text)).toBe('叠一已编辑');
  await page.evaluate(() => MaweContextMenus.showExtensionContextMenu(100, 100, 0));
  await page.locator('.speaker-context-menu .ctxmenu-submenu-toggle').click();
  await page.locator('.speaker-context-menu .ctxmenu-submenu-list button').filter({ hasText: '清除说话人' }).click();
  const identities = await page.evaluate(() => Object.fromEntries(MaweBoot.DATA.tracks.map(t => [t.id, t.segments.map(s => s.speaker ?? null)])));
  expect(identities).toEqual({ main: ['a', 'b', null], secondary: [null], overlay: ['b'] });
  await page.evaluate(() => MaweCuePanel.setCuePanelTarget('main', 0));
  await expect(page.locator('.cue-panel-speaker select')).toHaveValue('a');
});

test('main context assignment acts on the selected cues without changing other tracks', async ({ page }) => {
  await openProject(page);
  await page.evaluate(() => {
    MaweSelection.clearSelection({ silent: true });
    MaweState.selection.add('main', 0);
    MaweState.selection.add('main', 2);
    MaweContextMenus.showContextMenu(100, 100, 0);
  });
  await page.locator('.speaker-context-menu .ctxmenu-submenu-toggle').click();
  await page.locator('.speaker-context-menu .ctxmenu-submenu-list button').filter({ hasText: '同名（a）' }).click();
  const identities = await page.evaluate(() => Object.fromEntries(MaweBoot.DATA.tracks.map(t => [t.id, t.segments.map(s => s.speaker ?? null)])));
  expect(identities).toEqual({ main: ['a', 'b', 'a'], secondary: ['b'], overlay: ['a'] });
});

test('English speaker controls preserve project names and translate unassigned on language changes', async ({ page }) => {
  await openProject(page);
  await page.evaluate(() => {
    MaweBoot.DATA.speakers[0].name = '删除';
    MaweBoot.DATA.speaker_shortcuts['1'] = 'a';
    MaweBoot.DATA.annotation_mode = 'speaker';
    MaweCuePanel.renderAll({ waveform: 'none' });
    MaweCuePanel.setCuePanelTarget('main', 0);
    window.MAWE_I18N.applyLanguage('en');
  });
  await expect(page.locator('.cue-speaker-badge').filter({ hasText: '删除' })).toHaveCount(2);
  await expect(page.locator('.cue-speaker-badge.unassigned')).toHaveText('Unassigned');
  await expect(page.locator('.cue-panel-speaker select option[value="a"]')).toHaveText('删除（a）');
  await expect(page.locator('.cue-panel-speaker select option[value=""]')).toHaveText('Unassigned');
  await page.locator('#color-filter-btn').click();
  await expect(page.locator('.speaker-filter-item .color-name').filter({ hasText: '删除（a）' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => MaweContextMenus.showContextMenu(100, 100, 0));
  await expect(page.locator('.speaker-context-slot-name').first()).toHaveText('删除');
  await page.locator('.speaker-context-menu .ctxmenu-submenu-toggle').click();
  await expect(page.locator('.speaker-context-menu .ctxmenu-submenu-list button').filter({ hasText: '删除（a）' })).toHaveCount(1);
  await page.evaluate(() => window.MAWE_I18N.applyLanguage('zh'));
  await expect(page.locator('.cue-speaker-badge.unassigned')).toHaveText('未分配');
  await page.evaluate(() => window.MAWE_I18N.applyLanguage('en'));
  await expect(page.locator('.cue-speaker-badge.unassigned')).toHaveText('Unassigned');
  await expect(page.locator('.speaker-context-slot-name').first()).toHaveText('删除');
  await expect(page.locator('.cue-panel-speaker select option[value="a"]')).toHaveText('删除（a）');
});
