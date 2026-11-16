import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

test('PNG event names coexist with v2 manual ASS layer order', () => {
  const context = { window: {} };
  loadEditorModule(context, 'shared/editor-utils.js');
  const utils = context.window.AsrEditorUtils;
  const manual = { pos: { x: 300, y: 200 } };
  const ass = utils.buildAssPayload([{ id: 'm', start: 0, end: 1000, text: 'MAIN', assOverride: manual }], {
    pngEventNames: true, assProfile: { animations: {} }, assExtensionStyle: { fontSize: 36, alignment: 8 },
    extensionSegments: [{ id: 'e', start: 0, end: 1000, text: 'EXT', assOverride: manual }],
    overlaySegments: [{ id: 'o', start: 0, end: 1000, text: 'OVERLAY', assOverride: manual }],
  });
  const events = ass.split('\n').filter(line => line.startsWith('Dialogue:'));
  for (const [layer, role] of [[3, 'main'], [4, 'extension'], [5, 'overlay']]) {
    assert.ok(events.some(line => line.startsWith(`Dialogue: ${layer},`) && line.includes(`,maw:${role}:0,`)),
      `${role} must retain its manual layer and image-render identity: ${events.join('\n')}`);
  }
});
