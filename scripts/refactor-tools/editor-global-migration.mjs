import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fullAncestor } from 'acorn-walk';
import MagicString from 'magic-string';
import { analyzeModule } from './scope-core.mjs';
import { buildLauncher, readSources } from '../build-launcher.mjs';

const isFacade = name => typeof name === 'string'
  && /^(?:Mawe[A-Z]\w*|Asr(?:EditorUtils|Waveform|GapRemoveCore)|MAWE_[A-Z0-9_]+|ASR_EDITOR_PALETTE)$/.test(name);
const isAppGlobal = name => isFacade(name) || typeof name === 'string'
  && /^(?:MAW[A-Z_]\w*|__maw\w*|__MAW_\w*|CLLib|FILMSTRIP_PORTABLE|__WAVEFORM_COMPARISON__|ASS_STYLE_LIBRARY)$/.test(name);
const realmNames = new Set(['window', 'globalThis', 'self']);
const propertyName = node => node.computed
  ? (node.property.type === 'Literal' ? node.property.value : null)
  : node.property.name;

function inspect(source) {
  const { ast, scopes } = analyzeModule(source);
  const exports = new Map();
  const imports = new Map();
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      for (const entry of node.specifiers) {
        if (entry.type === 'ImportSpecifier') {
          imports.set(entry.local.name, { name: entry.imported.name, from: node.source.value });
        }
      }
    }
    if (node.type !== 'ExportNamedDeclaration' || node.source) continue;
    for (const entry of node.specifiers) exports.set(entry.exported.name ?? entry.exported.value, entry.local.name);
    for (const entry of node.declaration?.declarations ?? []) {
      if (entry.id.type === 'Identifier') exports.set(entry.id.name, entry.id.name);
    }
  }
  const references = new Map(scopes.scopes.flatMap(scope => scope.references)
    .map(reference => [reference.identifier, reference]));
  const parents = new Map();
  const identifiers = new Set();
  fullAncestor(ast, (node, _state, ancestors) => {
    parents.set(node, ancestors.at(-2));
    if (node.type === 'Identifier') identifiers.add(node.name);
  });
  return { ast, scopes, exports, imports, references, parents, identifiers };
}

export function collectOwners(sources) {
  const owners = new Map();
  for (const [file, source] of sources) {
    for (const name of inspect(source).exports.keys()) {
      if (!isFacade(name)) continue;
      if (owners.has(name)) throw new Error(`Ambiguous export ${name}: ${owners.get(name)}, ${file}`);
      owners.set(name, file);
    }
  }
  return owners;
}

function realms(node, info, seen = new Set()) {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === 'ChainExpression') return realms(node.expression, info, seen);
  if (node.type === 'MemberExpression' && realmNames.has(propertyName(node))) return realms(node.object, info, seen);
  if (node.type !== 'Identifier') return false;
  const binding = info.references.get(node)?.resolved;
  if (realmNames.has(node.name)) return !binding;
  const [definition] = binding?.defs ?? [];
  if (definition?.type === 'Variable' && definition.parent.kind === 'const'
    && definition.node.id.type === 'Identifier') return realms(definition.node.init, info, seen);
  if (definition?.type !== 'Parameter' || binding.references.some(reference => reference.isWrite())) return false;
  const callable = definition.node;
  const call = info.parents.get(callable);
  if (call?.type !== 'CallExpression' || call.callee !== callable) return false;
  const index = callable.params.indexOf(definition.name);
  const argument = call.arguments[index];
  return realms(argument, info, seen)
    || argument?.type === 'ConditionalExpression'
      && realms(argument.consequent, info, new Set(seen)) && realms(argument.alternate, info, seen);
}

function isWriteTarget(node, parents) {
  for (let parent = parents.get(node); parent; node = parent, parent = parents.get(node)) {
    switch (parent.type) {
      case 'AssignmentExpression':
      case 'ForInStatement':
      case 'ForOfStatement':
        return parent.left === node;
      case 'UpdateExpression':
        return parent.argument === node;
      case 'UnaryExpression':
        return parent.operator === 'delete' && parent.argument === node;
      case 'AssignmentPattern':
        if (parent.left !== node) return false;
        break;
      case 'Property':
        if (parent.value !== node || parents.get(parent)?.type !== 'ObjectPattern') return false;
        break;
      case 'ArrayPattern':
      case 'ObjectPattern':
      case 'RestElement':
        break;
      default:
        return false;
    }
  }
  return false;
}

export function migrateEditorFile(source, file, owners, { removeAliases = false, auditOnly = false, classic = false } = {}) {
  const info = inspect(source);
  const { ast, scopes, identifiers, imports, parents, references } = info;
  const edit = new MagicString(source);
  const added = new Map();
  const issues = [];
  const aliases = [];
  let replaced = 0;

  const report = (node, name, reason) => issues.push({ line: node.loc.start.line, name, reason });
  if (classic) {
    const scope = scopes.scopes.find(item => item.type === 'module');
    for (const binding of scope.variables) {
      const [identifier] = binding.identifiers;
      if (identifier) report(identifier, binding.name, 'classic script global declaration');
    }
  }
  function localName(name, owner) {
    const isShadowed = binding => scopes.scopes.some(scope => scope.type !== 'module' && scope.set.has(binding));
    const module = scopes.scopes.find(scope => scope.type === 'module');
    if (owner === file) {
      const binding = info.exports.get(name);
      return binding && module.set.has(binding) && !isShadowed(binding) ? binding : undefined;
    }
    let relative = path.posix.relative(path.posix.dirname(file), owner);
    if (!relative.startsWith('.')) relative = './' + relative;
    const present = [...imports].find(([local, entry]) => entry.name === name && entry.from === relative
      && !isShadowed(local));
    if (present) return present[0];
    if (!added.has(name)) {
      let local = name;
      if (isShadowed(local) || module.set.has(local)) {
        local = `editor${name}`;
        while (identifiers.has(local)) local += '_';
      }
      identifiers.add(local);
      added.set(name, { relative, local });
    }
    return added.get(name).local;
  }

  for (const [node, parent] of parents) {
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && realms(node.init, info)) {
      for (const property of node.id.properties) {
        const name = property.key?.type === 'Literal' ? property.key.value : property.computed ? null : property.key?.name;
        if (isAppGlobal(name) || property.type === 'RestElement' || name === null) {
          report(property, name ?? '(computed)', 'destructured browser global');
        }
      }
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const { object } = node.callee;
      const method = propertyName(node.callee);
      if (object.type === 'Identifier' && !references.get(object)?.resolved
        && ((object.name === 'Object' && ['defineProperty', 'defineProperties', 'assign'].includes(method))
          || (object.name === 'Reflect' && ['defineProperty', 'set', 'deleteProperty'].includes(method)))
        && realms(node.arguments[0], info)) {
        report(node, method, 'global mutation helper');
      }
    }
    if (node.type !== 'MemberExpression' || !realms(node.object, info)) continue;
    const name = propertyName(node);
    const isWrite = isWriteTarget(node, parents);
    if (!(auditOnly ? isAppGlobal : isFacade)(name)) {
      if (node.computed && name === null) report(node, '(computed)', 'dynamic global key');
      else if (isWrite) report(node, name, 'global write');
      continue;
    }
    const owner = owners.get(name);
    if (isWrite) {
      const statement = parents.get(parent);
      const container = parents.get(statement);
      if (owner === file && parent.type === 'AssignmentExpression' && parent.left === node
        && parent.operator === '=' && parent.right?.type === 'Identifier'
        && parent.right.name === info.exports.get(name) && references.get(parent.right)?.resolved?.scope?.type === 'module'
        && statement?.type === 'ExpressionStatement'
        && ['Program', 'BlockStatement', 'SwitchCase'].includes(container?.type)) {
        aliases.push({ line: node.loc.start.line, name });
        if (removeAliases) {
          const start = source.lastIndexOf('\n', statement.start - 1) + 1;
          const end = source.indexOf('\n', statement.end);
          const wholeLine = /^[ \t]*$/.test(source.slice(start, statement.start))
            && /^[ \t]*\r?$/.test(source.slice(statement.end, end < 0 ? source.length : end));
          if (wholeLine) edit.remove(start, end < 0 ? source.length : end + 1);
          else edit.remove(statement.start, statement.end);
        }
      } else report(node, name, 'global write');
      continue;
    }
    if (!owner) {
      report(node, name, 'missing module export');
      continue;
    }
    if (parent?.type === 'CallExpression' && parent.callee === node) {
      report(node, name, 'call uses global receiver');
      continue;
    }
    if (parent?.type === 'TaggedTemplateExpression' && parent.tag === node) {
      report(node, name, 'tagged template uses global receiver');
      continue;
    }
    const local = localName(name, owner);
    if (!local) {
      report(node, name, 'shadowed owner binding');
      continue;
    }
    edit.overwrite(node.start, node.end, local);
    replaced++;
  }

  for (const reference of scopes.globalScope.through) {
    const { identifier: node } = reference;
    if (!(auditOnly ? isAppGlobal : isFacade)(node.name)) {
      if (auditOnly && reference.isWrite()) report(node, node.name, 'assignment to undeclared binding');
      continue;
    }
    const owner = owners.get(node.name);
    if (!owner || reference.isWrite()) {
      report(node, node.name, owner ? 'bare global write' : 'missing module export');
      continue;
    }
    const local = localName(node.name, owner);
    if (!local) {
      report(node, node.name, 'shadowed owner binding');
      continue;
    }
    if (local !== node.name) {
      const parent = parents.get(node);
      const shorthand = parent?.type === 'Property' && parent.shorthand && parent.value === node;
      edit.overwrite(node.start, node.end, shorthand ? `${node.name}: ${local}` : local);
    }
    replaced++;
  }

  if (added.size) {
    const grouped = new Map();
    for (const [name, { relative, local }] of added) {
      if (!grouped.has(relative)) grouped.set(relative, []);
      grouped.get(relative).push(name === local ? name : `${name} as ${local}`);
    }
    const declarations = [...grouped].sort(([a], [b]) => a.localeCompare(b))
      .map(([from, names]) => `import { ${names.sort().join(', ')} } from '${from}';`);
    const offset = ast.body[0]?.start ?? 0;
    edit.appendLeft(offset, declarations.join('\n') + '\n');
  }
  return { source: edit.toString(), replaced, aliases, issues };
}

async function inspectBrowserTree() {
  const files = trackedSources(['web', 'tools', 'server-align', 'website/src'])
    .filter(file => /\.(?:m?js|html)$/.test(file)
      && !/(?:^|\/)(?:vendor|copy-review)\/|(?:\.min|\.umd|-bundle)\.js$|(?:\.test|smoke-ui|selfcheck)\.[cm]?js$/.test(file));
  const issues = [];
  let scripts = 0;
  const launcherFiles = new Set(readSources(process.cwd()).map(file => 'web/' + file));
  const htmlScripts = new Map(files.filter(file => file.endsWith('.html')).map(file => {
    const source = fs.readFileSync(file, 'utf8');
    return [file, [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map(match => ({
      attrs: match[1],
      code: match[2],
      offset: source.slice(0, match.index + match[0].indexOf('>') + 1).split('\n').length - 1,
    }))];
  }));
  const isModule = attrs => /\btype\s*=\s*["']module["']/i.test(attrs);
  const classicFiles = new Set();
  for (const [file, blocks] of htmlScripts) {
    for (const { attrs } of blocks) {
      const url = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
      if (url && !isModule(attrs) && !/^(?:[a-z]+:|\/)/i.test(url)) {
        classicFiles.add(path.posix.join(path.posix.dirname(file), url));
      }
    }
  }
  for (const file of files) {
    const blocks = file.endsWith('.html')
      ? htmlScripts.get(file)
        .filter(({ attrs }) => !/\bsrc\s*=|\btype\s*=\s*["']application\//i.test(attrs))
        .map(block => ({...block, classic: !isModule(block.attrs)}))
      : [{code:fs.readFileSync(file, 'utf8'), offset:0, classic:classicFiles.has(file)}];
    for (const { code, offset, classic } of blocks) {
      if (!code.trim()) continue;
      scripts++;
      try {
        const result = migrateEditorFile(code, file, new Map(), { auditOnly: true, classic });
        issues.push(...result.issues
          .filter(issue => !launcherFiles.has(file) || issue.reason !== 'assignment to undeclared binding')
          .map(issue => ({ ...issue, file, line: issue.line + offset })));
      } catch (error) {
        issues.push({file, line: (error.loc?.line ?? 1) + offset, reason: error.message});
      }
    }
  }
  // Launcher fragments share a bundle scope. Audit bare writes after the real
  // builder has resolved the bindings between those sources.
  const launcher = await buildLauncher(process.cwd());
  const launcherFile = 'web/launcher/boot/launcher-bundle.js';
  const result = migrateEditorFile(launcher.code, launcherFile, new Map(), {auditOnly: true, classic: true});
  issues.push(...result.issues.map(issue => ({...issue, file: launcherFile})));
  scripts++;
  return { files: files.length, scripts, issues };
}

function trackedSources(directories) {
  const git = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...directories];
  return [...new Set(execFileSync('git', git, { encoding: 'utf8' }).split('\0').filter(file => file && fs.existsSync(file)))];
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) {
    if (!['--write', '--remove-aliases', '--json', '--check', '--audit-tree'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
  }
  if (flags.has('--write') && flags.has('--check')) throw new Error('Choose --write or --check');
  if (flags.has('--audit-tree')) {
    if (flags.has('--write') || flags.has('--remove-aliases')) throw new Error('--audit-tree is read-only');
    const summary = await inspectBrowserTree();
    if (flags.has('--json')) console.log(JSON.stringify(summary, null, 2));
    else console.log(`${summary.files} files; ${summary.scripts} scripts; ${summary.issues.length} unresolved sites`);
    if (summary.issues.length) process.exitCode = 1;
    return;
  }
  const paths = trackedSources(['web/editor', 'web/shared'])
    .filter(file => /\.(?:m?js)$/.test(file) && !/(?:-bundle|\.min)\.js$/.test(file));
  const sources = new Map(paths.map(file => [file, fs.readFileSync(file, 'utf8')]));
  const owners = collectOwners(sources);
  const results = [...sources].map(([file, source]) => ({
    file, ...migrateEditorFile(source, file, owners, { removeAliases: flags.has('--remove-aliases') }),
  }));
  for (const result of results) {
    if (result.source === sources.get(result.file)) continue;
    analyzeModule(result.source);
  }
  const changed = results.filter(result => result.source !== sources.get(result.file));
  if (flags.has('--write')) {
    for (const { file, source } of changed) fs.writeFileSync(file, source);
  }
  const summary = {
    owners: owners.size,
    changedFiles: changed.map(result => result.file),
    references: results.reduce((sum, result) => sum + result.replaced, 0),
    aliases: results.reduce((sum, result) => sum + result.aliases.length, 0),
    issues: results.flatMap(({ file, issues }) => issues.map(issue => ({ file, ...issue }))),
  };
  if (flags.has('--json')) console.log(JSON.stringify(summary, null, 2));
  else console.log(`${summary.owners} owners; ${changed.length} files; ${summary.references} references; ${summary.aliases} aliases; ${summary.issues.length} unresolved sites`);
  if (flags.has('--check') && (summary.references || summary.aliases || summary.issues.length)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
