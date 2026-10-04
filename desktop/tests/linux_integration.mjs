import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installLinuxIntegration, quoteDesktopExecutable } from '../src/linux_integration.cjs';

test('AppImage integration installs MIME and icons under XDG data without replacing defaults', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mose-xdg-'));
  const assets = path.join(root, 'assets'); mkdirSync(assets);
  const appImage = path.join(root, 'MOSE 50%.AppImage'); writeFileSync(appImage, 'binary');
  for (const icon of ['maw.png', 'mosp.png']) writeFileSync(path.join(assets, icon), icon);
  const data = path.join(root, 'data');
  mkdirSync(data); writeFileSync(path.join(data, 'mimeapps.list'), 'existing default');
  const calls = [];
  const result = await installLinuxIntegration({ applicationPath: appImage, assetsPath: assets, dataHome: data,
    execFileImpl(command, args, callback) { calls.push([command, args]); callback(command === 'gtk-update-icon-cache' ? new Error('unavailable') : null); },
  });
  const desktop = readFileSync(path.join(data, 'applications/com.moy.mose.desktop'), 'utf8');
  assert.ok(desktop.includes(`Exec=${quoteDesktopExecutable(appImage)} %f`));
  assert.ok(desktop.includes('MimeType=application/x-mose-project;'));
  assert.match(readFileSync(path.join(data, 'mime/packages/com.moy.mose.xml'), 'utf8'), /pattern="\*\.mosp"/);
  assert.equal(readFileSync(path.join(data, 'icons/hicolor/256x256/mimetypes/application-x-mose-project.png'), 'utf8'), 'mosp.png');
  assert.equal(readFileSync(path.join(data, 'mimeapps.list'), 'utf8'), 'existing default');
  assert.deepEqual(result.warnings, ['gtk-update-icon-cache']);
  assert.equal(calls.length, 3);
  assert.equal(calls.some(([command]) => command === 'xdg-mime'), false);
});
