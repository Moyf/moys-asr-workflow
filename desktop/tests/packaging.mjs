import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import config from '../electron-builder.config.cjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('native build resources and document associations are internally consistent', () => {
  for (const association of config.mac.fileAssociations) {
    assert.equal(association.ext, 'mosp');
    assert.ok(existsSync(path.resolve(desktop, association.icon)));
  }
  const declared = config.mac.extendInfo.UTExportedTypeDeclarations[0].UTTypeIdentifier;
  assert.deepEqual(config.mac.extendInfo.CFBundleDocumentTypes[0].LSItemContentTypes, [declared]);
  assert.equal(config.linux.fileAssociations[0].mimeType, 'application/x-mose-project');
  assert.deepEqual(config.linux.executableArgs, ['%f']);
  assert.ok(!config.linux.desktop.entry.Exec); // builder supplies an absolute executable.
  assert.ok(config.linux.extraResources[0].filter.some((pattern) => pattern.includes('libstdc++')));
  assert.equal(config.win.target[0].target, 'dir'); // Windows uses the existing suite installer.
  assert.equal(config.extraResources.some((entry) => entry.to.startsWith('backend')), false);
});
