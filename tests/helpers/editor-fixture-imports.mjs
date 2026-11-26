import { fullAncestor } from 'acorn-walk';
import MagicString from 'magic-string';
import { analyzeModule } from '../../scripts/refactor-tools/scope-core.mjs';
import { editorFixtureNamespace, isPrivateFixtureFacade } from './editor-fixture-bindings.mjs';

const isFacade = name => /^(?:Mawe[A-Z]\w*|Asr(?:EditorUtils|Waveform|GapRemoveCore)|MAWE_I18N|ASR_EDITOR_PALETTE)$/.test(name);

export function privateFixtureFacadeForExport(source, name, file) {
  if (!new RegExp(`^export (?:function|let) ${name}\\b`, 'm').test(source)) return;
  return editorFixtureNamespace(file)
    ?? [...source.matchAll(/^(?:let|const) (Mawe\w+)\b/gm)].map(match => match[1]).find(isPrivateFixtureFacade);
}

export function fixtureFacadeForExport(source, name, file) {
  const privateFacade = privateFixtureFacadeForExport(source, name, file);
  if (privateFacade) return privateFacade;
  const prefix = `export function ${name}(...args) { return `;
  const forwarder = source.split('\n').find(line => line.startsWith(prefix));
  if (forwarder) return forwarder.slice(prefix.length).match(/^(?:window\.)?(Mawe\w+)\??\./)?.[1];
  if (!source.includes(`export function ${name}(`) || !/^export const Mawe\w+ = /m.test(source)) return;
  const { ast } = analyzeModule(source);
  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') continue;
    for (const { id, init } of statement.declaration.declarations) {
      const object = init?.type === 'CallExpression' && init.callee.object?.name === 'Object'
        && init.callee.property?.name === 'freeze' ? init.arguments[0] : init;
      if (isFacade(id.name) && object?.type === 'ObjectExpression'
          && object.properties.some(property => property.shorthand && property.key.name === name)) return id.name;
    }
  }
}
const dialogStub = `({${['alert', 'confirm', 'prompt'].map(name => `
  ${name}(message, ...args) {
    const browser = globalThis.window ?? globalThis;
    const native = browser.${name} ?? globalThis.${name};
    return native.call(browser, browser.MAWE_I18N?.translateText?.(message) ?? message, ...args);
  }`).join(',')}})`;

// Partial fixtures can supply a dependency explicitly in their own VM.
// Keep real ESM bindings for any provider the fixture actually initializes.
export function fixtureImports(source, useStub = () => true, forwardedFacade = () => null, { preferNamed = false } = {}) {
  const { ast, scopes } = analyzeModule(source);
  const edit = new MagicString(source);
  const imported = scopes.scopes.find(scope => scope.type === 'module').set;
  const shorthand = new Set();
  fullAncestor(ast, node => {
    if (node.type === 'Property' && node.shorthand) shorthand.add(node.value);
  });
  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration' || !useStub(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const importedName = specifier.imported.name;
      const facade = isFacade(importedName) ? importedName : forwardedFacade(statement.source.value, importedName);
      let binding;
      if (importedName === 'editorDialogs' && statement.source.value.endsWith('/editor-dialogs.js')) {
        binding = dialogStub;
      } else {
        if (!facade) continue;
        const name = JSON.stringify(facade);
        const lookup = `(globalThis.window?.[${name}] ?? globalThis[${name}])`;
        binding = importedName === facade ? lookup : `${lookup}?.[${JSON.stringify(importedName)}]`;
        if (preferNamed && importedName !== facade) binding = `(globalThis[${JSON.stringify(importedName)}] ?? ${binding})`;
      }
      for (const { identifier } of imported.get(specifier.local.name).references) {
        const replacement = shorthand.has(identifier) ? `${identifier.name}: ${binding}` : binding;
        edit.overwrite(identifier.start, identifier.end, replacement);
      }
    }
  }
  return edit;
}
