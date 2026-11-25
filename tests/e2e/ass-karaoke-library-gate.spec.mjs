import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { publishFixtureBindings } from '../helpers/editor-fixture-bindings.mjs';

test('secondary color follows karaoke and library editability in the DOM', async ({ page }) => {
  await page.setContent(`
    <form id="ass-style-form">
      <input id="ass-style-font" data-ass-style-field="fontName">
      <div id="ass-style-karaoke-row">
        <input id="ass-style-secondary-color" type="color" data-ass-style-field="secondaryColor">
      </div>
    </form>
  `);
  const source = readFileSync(new URL('../../web/editor/styles/editor-wiring-ass-manager.js', import.meta.url), 'utf8');
  const initializer = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'initAssManagerWiring').declaration;
  const body = publishFixtureBindings(source).slice(initializer.body.start + 1, initializer.body.end - 1);
  await page.addScriptTag({ content: `(() => {
    const state = window.gateFixture = {
      editable: true,
      library: { assignments: { assExportProfileId: 'ass' },
        assProfiles: [{ id: 'ass', animations: { karaoke: { enabled: false } } }] },
    };
    const getMaweDomPanels = () => ({ assStyleForm: document.getElementById('ass-style-form'), assInlineTextToggles: [] });
    const getAssStyleLibrary = () => state.library;
    const canEditAssStyleLibrary = () => state.editable;
    const MaweState = { onProjectDirtyChange() {} };
    const MaweSettings = { EDITOR_SETTINGS: {} };
    const MAWE_I18N = { translateText: text => text };
    const managerService = {};
    window.AsrEditorUtils = { normalizeAssStyle: style => style };
    window.MaweFloatingPanel = { createFloatingPanel: () => ({ isOpen: () => false }) };
    ${body}
  })();` });

  const secondary = page.locator('#ass-style-secondary-color');
  const row = page.locator('#ass-style-karaoke-row');
  for (const [editable, karaoke, disabled] of [
    [true, false, true], [true, true, false], [false, true, true],
    [false, false, true], [true, false, true], [true, true, false],
  ]) {
    await page.evaluate(({ editable, karaoke }) => {
      window.gateFixture.editable = editable;
      window.gateFixture.library.assProfiles[0].animations.karaoke.enabled = karaoke;
      window.syncAssStyleForm({ id: 'ass', fontName: 'Arial', secondaryColor: '#ffffff' });
    }, { editable, karaoke });
    if (disabled) {
      await expect(secondary).toBeDisabled();
      await expect(row).toHaveClass(/is-disabled/);
    } else {
      await expect(secondary).toBeEnabled();
      await expect(row).not.toHaveClass(/is-disabled/);
    }
    if (editable) await expect(page.locator('#ass-style-font')).toBeEnabled();
    else await expect(page.locator('#ass-style-font')).toBeDisabled();
  }
});
