import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, findFreePort, generateWav, makeTempDir, startBlankServer, startServer } from './helpers.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('../fixtures/project-boundary.json', import.meta.url), 'utf8'));
let server, temp;
test.beforeAll(async () => {
  temp = makeTempDir('project-boundary');
  server = await startBlankServer(await findFreePort(), join(temp, 'settings'));
});
test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(temp);
});

test('real Server browser imports the shared corpus and rejects atomically', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForFunction(() => typeof window.MaweMultiImport?.openProjectFile === 'function');
  for (const c of cases) {
    const result = await page.evaluate(async (c) => {
      const before = JSON.stringify(MaweBoot.DATA);
      const accepted = await MaweMultiImport.openProjectFile(
        new File([JSON.stringify(c.input)], `${c.name}.mosp`, { type: 'application/json' }),
        { suppressMediaPrompt: true },
      );
      return { accepted, unchanged: before === JSON.stringify(MaweBoot.DATA), report: MaweJsonRepair.lastImportReport };
    }, c);
    expect(result.accepted, c.name).toBe(c.import_ok);
    if (!c.import_ok) expect(result.unchanged, `${c.name}: failed import must retain current project`).toBe(true);
    else if (c.change_paths) expect(result.report.map((v) => v.path), c.name).toEqual(c.change_paths);
  }
});

test('legal zero-width punctuation survives browser serialization and reimport', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForFunction(() => typeof window.MaweMultiImport?.openProjectFile === 'function');
  const input = cases.find((c) => c.name === 'zero-width-punctuation').input;
  const result = await page.evaluate(async (input) => {
    const open = (value) => MaweMultiImport.openProjectFile(new File([JSON.stringify(value)], 'punctuation.mosp'), { suppressMediaPrompt: true });
    if (!await open(input)) throw new Error('initial import failed');
    const first = JSON.parse(MaweJsonRepair.buildJson());
    if (!await open(first)) throw new Error('reimport failed');
    const second = JSON.parse(MaweJsonRepair.buildJson());
    const semantic = (project) => project.segments.map((s) => ({ start: s.start, end: s.end, text: s.text,
      items: s.items.map(({ start, end, text }) => ({ start, end, text })) }));
    return { first: semantic(first), second: semantic(second), report: MaweJsonRepair.lastImportReport };
  }, input);
  expect(result.first).toEqual(input.segments);
  expect(result.second).toEqual(input.segments);
  expect(result.report).toEqual([]);
});

test('Server startup exposes real repairs and save clears the report after writing', async ({ page }) => {
  const media = join(temp, 'synthetic.wav'), project = join(temp, 'repaired.mosp');
  generateWav(media, 2);
  const raw = JSON.stringify({ media: 'synthetic.wav', segments: [{ start: 0, end: 0, text: 'repair me' }] });
  fs.writeFileSync(project, raw);
  const bound = await startServer(project, media, await findFreePort());
  try {
    await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
    await page.goto(bound.url);
    await page.waitForFunction(() => typeof window.MaweProjectSave?.saveProjectToServer === 'function');
    const imported = await page.evaluate(() => ({ report: MaweJsonRepair.lastImportReport,
      dirty: MaweServerSave.hasUnsavedProjectChanges(), end: MaweBoot.DATA.segments[0].end }));
    expect(imported.end).toBe(100);
    expect(imported.dirty).toBe(true);
    expect(imported.report).toContainEqual({ path: '$.segments[0].end', kind: 'replace', before: 0, after: 100 });
    expect(fs.readFileSync(project, 'utf8')).toBe(raw);
    const guarded = await page.evaluate(() => {
      const schema = MaweBoot.DATA.schema;
      try {
        MaweBoot.DATA.schema = 'moy.asr.project.v99';
        MaweJsonRepair.buildJson();
        return false;
      } catch (_) { return true; }
      finally { MaweBoot.DATA.schema = schema; }
    });
    expect(guarded).toBe(true);
    expect(fs.readFileSync(project, 'utf8')).toBe(raw);
    expect(await page.evaluate(() => MaweProjectSave.saveProjectToServer({ silent: true }))).toBe(true);
    expect(JSON.parse(fs.readFileSync(project, 'utf8')).segments[0].end).toBe(100);
    await page.reload();
    await page.waitForFunction(() => typeof window.MaweJsonRepair?.lastImportReport !== 'undefined');
    expect(await page.evaluate(() => MaweJsonRepair.lastImportReport)).toEqual([]);
  } finally {
    await bound.stop();
  }
});
