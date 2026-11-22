import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForAssFonts } from './ass-font-readiness.mjs';
import { DURATION_MS, cleanupTempDir, disableOnboarding, findFreePort, generateProjectJson, generateWav, makeTempDir, openSettingsPage, startServer } from './helpers.mjs';

const editor = test.extend({
  libraryEditor: async ({ page }, use) => {
    const directory = makeTempDir('ass-library-interchange');
    let server;
    try {
      const media = join(directory, 'synthetic.wav');
      generateWav(media, DURATION_MS / 1000);
      const projectPath = generateProjectJson(join(directory, 'project.mosp'));
      const project = JSON.parse(readFileSync(projectPath, 'utf8'));
      project.styles = [{ id: 'saved-track', name: 'Saved track style', fontSize: 67 }];
      for (const track of project.tracks) track.style = { style_id: 'saved-track', forked: true };
      project.tracks.find(track => track.role === 'main').segments[0].assStyle = {
        id: 'ass', name: 'Saved cue style', fontSize: 73,
      };
      writeFileSync(projectPath, JSON.stringify(project), 'utf8');
      server = await startServer(projectPath, media, await findFreePort());
      await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
      await disableOnboarding(page);
      await page.goto(server.url);
      await openSettingsPage(page, 'subtitle-style');
      await page.locator('#ass-style-manager-open').click();
      await expect(page.locator('#ass-style-library-status')).toContainText('已与用户级配置同步');
      await use({ page, projectPath });
    } finally {
      await server?.stop();
      cleanupTempDir(directory);
    }
  },
});

async function currentLibrary(page) {
  return page.evaluate(async () => {
    const library = await (await fetch('/api/ass-styles')).json();
    delete library._revision;
    return library;
  });
}

async function restoreLibrary(page, file, { warnsAboutKaraoke = false } = {}) {
  const dialog = page.locator('#ass-style-import-dialog');
  await page.locator('#ass-style-import-file').setInputFiles(file);
  await expect(dialog).toBeVisible();
  if (warnsAboutKaraoke) {
    await expect(dialog.locator('#ass-style-import-preview')).toContainText('逐字换色设置会随样式库保留');
  }
  await dialog.locator('input[value="restore"]').check();
  await dialog.locator('#ass-style-import-confirm').click();
  await expect(dialog).not.toBeVisible();
}

async function changeFontSize(page, styleId, size) {
  await page.locator(`#ass-style-list [data-ass-selection-id="${styleId}"]`).click();
  await page.locator('#ass-style-font-size').fill(String(size));
  await page.locator('#ass-style-save').click();
  await expect.poll(async () => (await currentLibrary(page)).styles.find(style => style.id === styleId)?.fontSize).toBe(size);
}

async function roundTrip(page, expected, path) {
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('#ass-style-export-library').click(),
  ]);
  await download.saveAs(path);
  const exported = JSON.parse(readFileSync(path, 'utf8'));
  expect(exported.schema).toBe('moy.asr.ass_styles.transfer.v1');
  expect(exported.library).toEqual(expected);
  const style = expected.styles.find(item => item.id === expected.assignments.srtBurnStyleId);
  await changeFontSize(page, style.id, style.fontSize + 1);
  await restoreLibrary(page, path);
  await expect.poll(() => currentLibrary(page)).toEqual(expected);
}

for (const variant of ['default', 'karaoke']) {
  editor(`imports an actual 1.x ${variant} export and round-trips it in 2.0`, async ({ libraryEditor }, info) => {
    const { page, projectPath } = libraryEditor;
    const initialProjectFile = readFileSync(projectPath, 'utf8');
    const cueStyle = () => page.evaluate(() => MaweBoot.DATA.tracks.find(track => track.role === 'main').segments[0].assStyle);
    const snapshot = await cueStyle();
    expect(snapshot).toMatchObject({ name: 'Saved cue style', fontSize: 73 });
    const sourcePath = fileURLToPath(new URL(`../fixtures/ass-styles/main-f345a896-${variant}.json`, import.meta.url));
    const { library: expected } = JSON.parse(readFileSync(sourcePath, 'utf8'));
    await changeFontSize(page, 'ass', 175);
    await restoreLibrary(page, sourcePath, { warnsAboutKaraoke: variant === 'karaoke' });
    await expect.poll(() => currentLibrary(page)).toEqual(expected);

    const profile = expected.assProfiles.find(item => item.id === expected.assignments.assExportProfileId);
    await expect(page.locator('#ass-ass-default-profile')).toHaveValue(profile.id);
    await expect(page.locator('#ass-srt-default-style')).toHaveValue(expected.assignments.srtBurnStyleId);
    await page.locator(`#ass-profile-list [data-ass-selection-id="${profile.id}"]`).click();
    await expect(page.locator('#ass-profile-style-id')).toHaveValue(profile.styleId);
    await page.locator('input[data-ass-animation="fad.enabled"]').check();
    await page.locator('#ass-style-save').click();
    profile.animations.fad.enabled = true;
    await expect.poll(() => currentLibrary(page)).toEqual(expected);
    await waitForAssFonts(page);
    const ass = await page.evaluate(() => MaweExportSrt.buildAss());
    expect(ass).toContain('\\fad(250,250)');
    expect(ass).not.toMatch(/\\k\d/u);
    await roundTrip(page, expected, info.outputPath('exported-in-2.0.json'));
    expect(await cueStyle()).toEqual(snapshot);
    expect(readFileSync(projectPath, 'utf8')).toBe(initialProjectFile);
  });
}

editor('restoring a library updates linked track snapshots and supports undo', async ({ libraryEditor }) => {
  const { page } = libraryEditor;
  const sourcePath = fileURLToPath(new URL('../fixtures/ass-styles/main-f345a896-default.json', import.meta.url));
  const restoredSize = JSON.parse(readFileSync(sourcePath, 'utf8')).library.styles.find(s => s.id === 'ass').fontSize;
  await changeFontSize(page, 'ass', restoredSize + 15);
  await page.evaluate(() => MaweAssManagerWiring.applyProjectStyleSelection('main', 'ass'));
  const mainStyle = () => page.evaluate(() => MaweAssManagerWiring.projectStyleOptions('main'));
  expect(await mainStyle()).toMatchObject({ status: 'linked', style: { fontSize: restoredSize + 15 } });
  await restoreLibrary(page, sourcePath);
  expect(await mainStyle()).toMatchObject({ status: 'linked', style: { fontSize: restoredSize } });
  await page.evaluate(() => MaweHistory.performUndo());
  expect((await mainStyle()).style.fontSize).toBe(restoredSize + 15);
});

editor('round-trips a new native 2.0 library and its default assignments', async ({ libraryEditor }, info) => {
  const { page } = libraryEditor;
  await page.locator('#ass-style-new').click();
  await page.locator('#ass-style-name').fill('Native 2.0 style');
  await page.locator('#ass-profile-new').click();
  await page.locator('#ass-profile-name').fill('Native 2.0 profile');
  await page.locator('#ass-profile-style-id').selectOption({ label: 'Native 2.0 style' });
  await page.locator('#ass-ass-default-profile').selectOption({ label: 'Native 2.0 profile' });
  await page.locator('#ass-srt-default-style').selectOption({ label: 'Native 2.0 style' });
  await page.locator('#ass-style-save').click();
  await expect(page.locator('#ass-style-library-status')).toContainText('已与用户级配置同步');
  const expected = await currentLibrary(page);
  const profile = expected.assProfiles.find(item => item.id === expected.assignments.assExportProfileId);
  expect(profile.name).toBe('Native 2.0 profile');
  expect(profile.styleId).toBe(expected.assignments.srtBurnStyleId);
  expect(expected.styles.find(style => style.id === profile.styleId).name).toBe('Native 2.0 style');
  await roundTrip(page, expected, info.outputPath('native-2.0.json'));
});
