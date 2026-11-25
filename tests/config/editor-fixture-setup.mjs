import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEditor } from '../../scripts/build-editor.mjs';
import { publishFixtureBindings } from '../helpers/editor-fixture-bindings.mjs';
import { buildLauncherBrowserFixture } from '../helpers/launcher-browser-fixture.mjs';

export default async function setupEditorFixture() {
  const fixture = await buildEditor(undefined, {
    transform: (file, source) => /\.[cm]?js$/.test(file)
      ? publishFixtureBindings(source, undefined, { liveFacadeBindings: true }).toString()
      : source,
  });
  const directory = mkdtempSync(join(tmpdir(), 'maw-editor-fixture-'));
  const file = join(directory, 'editor.js');
  writeFileSync(file, fixture.code, { flag: 'wx' });
  const launcher = await buildLauncherBrowserFixture(directory);
  process.env.MAW_E2E_EDITOR_FIXTURE = file;
  process.env.MAW_E2E_LAUNCHER_FIXTURE = launcher.url;
  return () => {
    delete process.env.MAW_E2E_EDITOR_FIXTURE;
    delete process.env.MAW_E2E_LAUNCHER_FIXTURE;
    launcher.cleanup();
    unlinkSync(file);
    rmdirSync(directory);
  };
}
