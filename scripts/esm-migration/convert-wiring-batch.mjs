// 接线层批量转换：unwrap → 立即读门面加 import 边 → detach。
// 仅处理指定文件清单（本轮 28 个 wiring，不含 editor.js/startup）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readFileSync('.artifacts/pr3-bootstrap/wiring-list3.txt', 'utf8')
    .trim().split(String.fromCharCode(10)).filter(Boolean);
// plain 发布者映射：facade → [module, exportName|null]
const FACADES = {
  MaweBoot: ['editor/boot/editor-boot.js', 'MaweBoot'],
  MaweDom: ['editor/ui/editor-dom.js', 'MaweDom'],
  MaweSettings: ['editor/state/editor-settings.js', 'MaweSettings'],
  MaweSettingsPanels: ['editor/ui/editor-settings-panels.js', 'MaweSettingsPanels'],
  MaweHelpPanel: ['editor/ui/editor-help-panel.js', 'MaweHelpPanel'],
  MaweGapRemoveData: ['editor/ui/editor-gap-remove-data.js', 'MaweGapRemoveData'],
  MaweFloatingPanel: ['editor/ui/editor-floating-panel.js', 'MaweFloatingPanel'],
  AsrEditorUtils: ['shared/editor-utils.js', 'AsrEditorUtils'],
  AsrGapRemoveCore: ['shared/gap-remove-core.js', 'AsrGapRemoveCore'],
  AsrWaveform: ['editor/media/waveform.js', 'AsrWaveform'],
};
const facadeRe = /^(Mawe|MAWE|MAWE_|Asr)/;

const relImport = (fromFile, toFile) => {
  const fromParts = fromFile.split('/').slice(0, -1);
  const toParts = toFile.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1
    && fromParts[common] === toParts[common]) common++;
  const ups = fromParts.length - common;
  const rest = toParts.slice(common).join('/');
  return (ups ? '../'.repeat(ups) : './') + rest;
};

const root = process.cwd();
for (const file of files) {
  const full = path.join(root, 'web', file);
  const src = fs.readFileSync(full, 'utf8');
  const tool = /\}\)\((typeof window|window|globalThis)/.test(src)
    && !/legacyBindings = Object\.freeze/.test(src)
    ? 'scripts/esm-migration/unwrap-iife.mjs'
    : 'scripts/esm-migration/unwrap-bare.mjs';
  try {
    execFileSync(process.execPath, [tool, full], { stdio: 'pipe' });
  } catch (e) {
    console.log('UNWRAP-FAIL', file, (e.stderr ?? '').toString().split('\n')[0]);
    continue;
  }
  // unwrap 后扫顶层立即读
  let after = fs.readFileSync(full, 'utf8');
  const ast = (await import('acorn')).parse(after, { ecmaVersion: 16, sourceType: 'module', ranges: true });
  const need = new Set();
  const selfPublish = new Set();
  for (const stmt of ast.body) {
    (function pub(n) {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'AssignmentExpression' && n.operator === '='
        && n.left.type === 'MemberExpression' && !n.left.computed
        && ['window', 'globalThis'].includes(n.left.object?.name)
        && n.left.property?.type === 'Identifier') selfPublish.add(n.left.property.name);
      for (const [k, v] of Object.entries(n)) {
        if (['loc', 'range', 'start', 'end'].includes(k)) continue;
        if (Array.isArray(v)) v.forEach(pub);
        else if (v && typeof v === 'object' && v.type) pub(v);
      }
    })(stmt);
    (function walk(n) {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration'
        || n.type === 'ArrowFunctionExpression') return;
      if (n.type === 'MemberExpression' && !n.computed
        && n.object?.type === 'Identifier'
        && ['window', 'global', 'globalThis'].includes(n.object.name)
        && n.property?.type === 'Identifier' && FACADES[n.property.name]) {
        need.add(n.property.name);
      } else if (n.type === 'Identifier' && FACADES[n.name]) {
        need.add(n.name);
      }
      for (const [k, v] of Object.entries(n)) {
        if (['loc', 'range', 'start', 'end'].includes(k)) continue;
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object' && v.type) walk(v);
      }
    })(stmt);
  }
  const imports = [...need].filter(n => !selfPublish.has(n))
    .map(name => {
      const [mod, exp] = FACADES[name];
      if (!exp) return null;
      return 'import { ' + exp + ' } from ' + JSON.stringify(relImport(file, mod)) + ';';
    })
    .filter(Boolean);
  if (imports.length) {
    const useStrict = after.indexOf("'use strict';");
    const lineEnd = after.indexOf('\n', useStrict);
    after = after.slice(0, lineEnd + 1) + imports.join('\n') + '\n' + after.slice(lineEnd + 1);
    fs.writeFileSync(full, after, 'utf8');
  }
  // detach
  execFileSync(process.execPath, ['scripts/esm-migration/detach.mjs', file], { stdio: 'pipe' });
  console.log('converted:', file, 'imports:', imports.length);
}
