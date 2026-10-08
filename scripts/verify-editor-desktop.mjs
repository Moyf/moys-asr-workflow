// Execute the actual Rust page renderer. Stub only the external SDK build hook;
// this is an assembly/browser check, not a complete Tauri application build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { checkEditor } from './build-editor.mjs';

const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../',import.meta.url)));
const python = process.argv[3];
if (!python) throw new Error('Usage: verify-editor-desktop.mjs ROOT PYTHON');
const output = path.join(root,'.worktrees/editor-validation/rust');
fs.mkdirSync(output,{recursive:true});
const stub = path.join(output,'tauri_build_stub.rs'), library = path.join(output,'libtauri_build.rlib');
const exe = path.join(output,process.platform === 'win32' ? 'render.exe' : 'render');
fs.writeFileSync(stub,'pub fn build() {}\n');
execFileSync('rustc',['--crate-name','tauri_build','--crate-type','rlib',stub,'-o',library],{windowsHide:true});
execFileSync('rustc',['--edition=2021',path.join(root,'desktop/src-tauri/build.rs'),
  '--extern',`tauri_build=${library}`,'-o',exe],{windowsHide:true});
execFileSync(exe,[],{windowsHide:true,env:{...process.env,CARGO_MANIFEST_DIR:path.join(root,'desktop/src-tauri')},stdio:'pipe'});
const built = await checkEditor(root), htmlPath = path.join(root,'desktop/src/index.html');
const html = fs.readFileSync(htmlPath,'utf8');
assert.ok(html.includes(built.identity));
const sourceText = ['editor-template.html',...built.sourceFiles]
  .map(file => fs.readFileSync(path.join(root,'web',file),'utf8')).join('\n');
for (const token of new Set(sourceText.match(/__[A-Z][A-Z0-9_]+__/g))) assert.ok(!html.includes(token),token);
const palette = JSON.parse(execFileSync(path.resolve(python),['-c','import edit; print(edit.build_palette_json())'],
  {cwd:root,windowsHide:true,encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}}));
const browser = await chromium.launch(), page = await browser.newPage(), errors = [];
page.on('pageerror',error => errors.push(error.message));
try {
  await page.goto(pathToFileURL(htmlPath).href);
  await page.waitForFunction(() => Boolean(window.MAWE_EDITOR_BRIDGE && window.MaweCoreState?.waveformEditor));
  const actual = await page.evaluate(() => ({palette:window.ASR_EDITOR_PALETTE,
    trace:window.__mawEsmInitializationTrace,host:window.MaweHost.files.hasSavePicker()}));
  assert.deepEqual(actual.palette,palette);
  assert.deepEqual(actual.trace,built.sourceFiles);
  assert.deepEqual(errors,[]);
  const verdict = {ok:true,artifactIdentity:built.identity,initialized:actual.trace.length,
    paletteMatchesPython:true,errors,scope:'actual Rust renderer + browser; external Tauri SDK hook stubbed'};
  fs.writeFileSync(path.join(output,'verdict.json'),JSON.stringify(verdict,null,2)+'\n');
  console.log(JSON.stringify(verdict,null,2));
} finally { await browser.close(); }
