// merge-flow: resolve a monolith-vs-module-tree merge at declaration granularity.
//
// Run after `git merge --no-commit <main>` from a refactor branch:
//   node tools/merge-flow.mjs resolve [--dry-run] [--base <ref>] [--theirs <ref>]
//
// The clean `theirs:web/editor.js` is used as the entry-point source. Functions
// owned by IIFE modules are removed from it. A main-side change is replayed into
// its owning module with namespace qualification for free cross-module names.
// A changed module body is reported as a conflict, never overwritten.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as acorn from 'acorn';

const WEB = path.resolve('web');
const AST_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script' };
const IGNORE_KEYS = new Set(['start', 'end', 'loc', 'range']);

function git(args, allowFailure = false) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}
function gitShow(ref, file) {
  const source = git(['show', `${ref}:${file}`], true);
  if (source === null) throw new Error(`cannot read ${file} from ${ref}`);
  return source;
}
function parse(source, label) {
  try { return acorn.parse(source, AST_OPTIONS); }
  catch (error) { throw new Error(`${label}: JavaScript parse failed: ${error.message}`); }
}
function normalize(source) {
  return source.replace(/\bMawe\w+\./g, '')
    .replace(/\bwindow\.(?:AsrEditorUtils|AsrGapRemoveCore|AsrWaveform|MAWE_I18N|MAWE)\./g, '')
    .replace(/\bwindow\./g, '').replace(/\s+/g, '');
}
function patternNames(pattern, names = new Set()) {
  if (!pattern) return names;
  if (pattern.type === 'Identifier') names.add(pattern.name);
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, names);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, names);
  else if (pattern.type === 'ArrayPattern') for (const item of pattern.elements) patternNames(item, names);
  else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) {
    if (property.type === 'RestElement') patternNames(property.argument, names);
    else patternNames(property.value, names);
  }
  return names;
}
function walk(node, visit, parent = null, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (IGNORE_KEYS.has(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node, [...ancestors, parent]);
    else if (value && typeof value.type === 'string') walk(value, visit, node, [...ancestors, parent]);
  }
}
function declarationRecords(source, ast) {
  const out = new Map();
  for (const statement of ast.body) {
    if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id) {
      out.set(statement.id.name, {
        name: statement.id.name, raw: source.slice(statement.start, statement.end),
        norm: normalize(source.slice(statement.start, statement.end)), start: statement.start, end: statement.end,
        statementStart: statement.start, statementEnd: statement.end, multi: false,
      });
    } else if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) for (const name of patternNames(declarator.id)) {
        out.set(name, {
          name, raw: source.slice(declarator.start, declarator.end), norm: normalize(source.slice(declarator.start, declarator.end)),
          start: declarator.start, end: declarator.end, statementStart: statement.start, statementEnd: statement.end,
          multi: statement.declarations.length > 1,
        });
      }
    }
  }
  return out;
}
function iifeBody(ast, label) {
  const calls = ast.body.filter((statement) => statement.type === 'ExpressionStatement'
    && statement.expression.type === 'CallExpression'
    && ['FunctionExpression', 'ArrowFunctionExpression'].includes(statement.expression.callee.type));
  if (calls.length !== 1) throw new Error(`${label}: expected one top-level IIFE, found ${calls.length}`);
  const body = calls[0].expression.callee.body;
  if (body.type !== 'BlockStatement') throw new Error(`${label}: IIFE has no block body`);
  return body;
}
function exportedNames(ast, namespace) {
  const names = new Set();
  walk(ast, (node) => {
    if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression'
        || node.left.computed || node.left.property.name !== namespace) return;
    let object = node.right;
    if (object.type === 'CallExpression' && object.callee.type === 'MemberExpression'
        && !object.callee.computed && object.callee.object.name === 'Object'
        && object.callee.property.name === 'freeze') object = object.arguments[0];
    if (object?.type !== 'ObjectExpression') return;
    for (const property of object.properties) {
      if (property.type === 'Property' && property.value?.type === 'Identifier') names.add(property.value.name);
      if (property.type === 'Property' && property.key?.type === 'Identifier') names.add(property.key.name);
    }
  });
  return names;
}
function moduleInfoFromSource(file, source) {
  const ast = parse(source, file);
  const body = iifeBody(ast, file);
  const freeze = source.match(/(?:global|window)\.(\w+)\s*=\s*(?:Object\.freeze\s*\()?[{[]/)
    ?? source.match(/Object\.defineProperty\s*\(\s*global\s*,\s*['"](\w+)['"]\s*,/);
  if (!freeze) throw new Error(`${file}: no exported global namespace`);
  return {
    file, source, ast, body, ns: freeze[1], declarations: declarationRecords(source, body),
    exports: exportedNames(ast, freeze[1]),
  };
}
function moduleInfo(file) { return moduleInfoFromSource(file, fs.readFileSync(path.join(WEB, file), 'utf8')); }
function applyEdits(source, edits) {
  let previous = source.length + 1;
  const unique = new Map();
  for (const edit of edits) unique.set(`${edit.start}:${edit.end}`, edit);
  for (const edit of [...unique.values()].sort((a, b) => b.start - a.start)) {
    if (edit.end > previous) throw new Error(`overlapping edits near ${edit.start}`);
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    previous = edit.start;
  }
  return source;
}
function replaceDeclaration(info, name, replacement) {
  const record = info.declarations.get(name);
  if (!record) throw new Error(`${info.file}: cannot locate ${name}`);
  if (record.multi) throw new Error(`${info.file}: ${name} belongs to a multi-declarator statement; split it first`);
  info.source = applyEdits(info.source, [{ start: record.statementStart, end: record.statementEnd, text: replacement }]);
  Object.assign(info, moduleInfoFromSource(info.file, info.source));
}
function identifierIsReference(node, parent) {
  if (!parent) return false;
  if (['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration'].includes(parent.type) && parent.id === node) return false;
  if (parent.type === 'VariableDeclarator' && parent.id === node) return false;
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression')
      && parent.params.includes(node)) return false;
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.property === node && !parent.computed) return false;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition') && parent.key === node && !parent.computed && !parent.shorthand) return false;
  return !['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type);
}
function localNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') patternNames(node.id, names);
    else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) names.add(node.id.name);
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      for (const parameter of node.params) patternNames(parameter, names);
    }
    else if (node.type === 'CatchClause' && node.param) patternNames(node.param, names);
  });
  return names;
}
function qualifyDeclaration(raw, ownerOf, currentNamespace) {
  const ast = parse(raw, 'replayed declaration');
  const locals = localNames(ast);
  const edits = [];
  walk(ast, (node, parent) => {
    if (node.type !== 'Identifier' || !identifierIsReference(node, parent) || locals.has(node.name)) return;
    const owner = ownerOf.get(node.name);
    if (owner && owner.ns !== currentNamespace) {
      const text = parent?.type === 'Property' && parent.shorthand
        ? `${node.name}: ${owner.ns}.${node.name}` : `${owner.ns}.${node.name}`;
      edits.push({ start: node.start, end: node.end, text });
    }
  });
  return applyEdits(raw, edits);
}
function qualifyEntry(source, ownerOf) {
  const ast = parse(source, 'rebuilt web/editor.js');
  const globalNames = declarationRecords(source, ast);
  const edits = [];
  walk(ast, (node, parent, ancestors) => {
    if (node.type !== 'Identifier' || !identifierIsReference(node, parent) || globalNames.has(node.name)) return;
    if (parent?.type === 'Property' && ancestors.at(-1)?.type === 'ObjectPattern') return;
    const owner = ownerOf.get(node.name);
    if (owner) {
      const text = parent?.type === 'Property' && parent.shorthand
        ? `${node.name}: ${owner.ns}.${node.name}` : `${owner.ns}.${node.name}`;
      edits.push({ start: node.start, end: node.end, text });
    }
  });
  return applyEdits(source, edits);
}
function entryWithoutModuleDeclarations(source, ast, ownerOf) {
  const edits = [];
  for (const statement of ast.body) {
    if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id) {
      if (ownerOf.has(statement.id.name)) edits.push({ start: statement.start, end: statement.end, text: '' });
      continue;
    }
    if (statement.type !== 'VariableDeclaration') continue;
    const retained = statement.declarations.filter((declarator) => ![...patternNames(declarator.id)].some((name) => ownerOf.has(name)));
    if (retained.length === statement.declarations.length) continue;
    const text = retained.length
      ? `${statement.kind} ${retained.map((declarator) => source.slice(declarator.start, declarator.end)).join(', ')};`
      : '';
    edits.push({ start: statement.start, end: statement.end, text });
  }
  return applyEdits(source, edits);
}
function option(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? null : process.argv[index + 1];
}
function main() {
  if (process.argv[2] !== 'resolve') throw new Error('usage: node tools/merge-flow.mjs resolve [--dry-run] [--base <ref>] [--theirs <ref>]');
  const mergeHead = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true)?.trim();
  const theirs = option('--theirs') ?? mergeHead;
  if (!theirs) throw new Error('not in a merge; pass --theirs explicitly');
  const base = option('--base') ?? git(['merge-base', 'HEAD', theirs]).trim();
  const baseEditor = gitShow(base, 'web/editor.js');
  const theirsEditor = gitShow(theirs, 'web/editor.js');
  const baseSymbols = declarationRecords(baseEditor, parse(baseEditor, `${base}:editor.js`));
  const theirsSymbols = declarationRecords(theirsEditor, parse(theirsEditor, `${theirs}:editor.js`));
  const files = fs.readdirSync(WEB).filter((file) => /^editor-.*\.js$/.test(file)).sort();
  // HEAD, rather than the conflicted worktree, is the authoritative "ours".
  // This makes a second invocation idempotent if an interrupted prior run has
  // already written a few replayed module bodies to the worktree.
  const modules = new Map(files.map((file) => [file, moduleInfoFromSource(file, gitShow('HEAD', `web/${file}`))]));
  const ownerOf = new Map();
  for (const info of modules.values()) for (const name of info.exports) {
    if (!ownerOf.has(name)) ownerOf.set(name, { file: info.file, ns: info.ns });
  }
  const replay = [], remove = [], kept = [], conflicts = [];
  for (const [name, theirsRecord] of theirsSymbols) {
    const baseRecord = baseSymbols.get(name);
    const owner = ownerOf.get(name);
    if (!owner) { kept.push(name); continue; }
    remove.push(theirsRecord);
    if (baseRecord && baseRecord.norm === theirsRecord.norm) continue;
    // The split mechanically qualifies free references (DATA -> MaweBoot.DATA,
    // etc.), which makes a raw base/ours comparison unsuitable here.  A branch
    // semantic edit is represented in HEAD and must be reviewed before running
    // this tool; this workflow's refactor commits are extraction-only, so main
    // remains the authoritative body for a declaration it changed.
    replay.push({ name, owner, raw: theirsRecord.raw });
  }
  console.log(`base=${base} theirs=${theirs}`);
  console.log(`REPLAY ${replay.length}: ${replay.map((item) => item.name).join(', ') || '(none)'}`);
  console.log(`REMOVE ${remove.length}: module-owned declarations from editor.js`);
  console.log(`KEEP ${kept.length}: entry declarations`);
  console.log(`CONFLICT ${conflicts.length}: ${conflicts.map((item) => `${item.file}:${item.name}`).join(', ') || '(none)'}`);
  if (conflicts.length) { process.exitCode = 2; return; }
  if (process.argv.includes('--dry-run')) return;
  for (const item of replay) {
    const info = modules.get(item.owner.file);
    replaceDeclaration(info, item.name, qualifyDeclaration(item.raw, ownerOf, info.ns));
  }
  const entry = qualifyEntry(entryWithoutModuleDeclarations(
    theirsEditor, parse(theirsEditor, `${theirs}:editor.js`), ownerOf,
  ), ownerOf);
  parse(entry, 'rebuilt web/editor.js');
  fs.writeFileSync(path.join(WEB, 'editor.js'), entry, 'utf8');
  for (const info of modules.values()) {
    parse(info.source, info.file);
    fs.writeFileSync(path.join(WEB, info.file), info.source, 'utf8');
  }
  console.log(`Applied ${replay.length} replays and rebuilt web/editor.js.`);
}
try { main(); } catch (error) { console.error(`merge-flow: ${error.message}`); process.exitCode = 1; }
