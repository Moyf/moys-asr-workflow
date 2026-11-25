import { full } from 'acorn-walk';
import MagicString from 'magic-string';
import { analyzeModule } from '../../scripts/refactor-tools/scope-core.mjs';

export function publishFixtureBindings(source, edit = new MagicString(source)) {
  const { ast, scopes } = analyzeModule(source);
  const variables = scopes.scopes.find(scope => scope.type === 'module').set;
  const published = new Map();
  for (const statement of ast.body) {
    const variable = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (variable?.type !== 'VariableDeclaration') continue;
    for (const declaration of variable.declarations) {
      const name = declaration.id.name;
      const alias = fixtureAlias(name, statement.type === 'ExportNamedDeclaration');
      if (!alias) continue;
      published.set(name, alias);
      if (declaration.init) edit.appendRight(declaration.init.start, assignment(alias));
    }
  }
  const writes = new Set([...published.keys()].flatMap(name => variables.get(name).references
    .filter(reference => reference.isWrite()).map(reference => reference.identifier)));
  full(ast, node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=' && writes.has(node.left)) {
      edit.appendRight(node.right.start, assignment(published.get(node.left.name)));
      if (node.left.name === 'MaweAssManagerWiring') {
        edit.appendLeft(node.end, `; Object.assign(globalThis.window ?? globalThis, {
          assStyleManagerSetSelection, updateAssStyleManagerLibrary, syncAssStyleForm
        })`);
      } else if (node.left.name === 'MaweAssStorageWiring') {
        edit.appendLeft(node.end, `; Object.defineProperty(globalThis.window ?? globalThis, 'ASS_STYLE_LIBRARY', {
          configurable: true,
          get: () => ASS_STYLE_LIBRARY,
          set: value => { ASS_STYLE_LIBRARY = value; },
        }); (globalThis.window ?? globalThis).loadAssStyleLibrary = loadAssStyleLibrary`);
      }
    }
  });
  return edit;
}

function fixtureAlias(name, exported) {
  if (name === 'activeBurnVideoTask') return '__maweBurnVideoTask';
  if (name === 'activeGapRemovedVideoTask') return '__maweGapRemovedVideoTask';
  if (exported && /^(?:Mawe[A-Z]\w*|Asr(?:EditorUtils|Waveform|GapRemoveCore)|MAWE_(?:I18N|EDITOR_BRIDGE)|ASR_EDITOR_PALETTE)$/.test(name ?? '')) return name;
  return null;
}

function assignment(name) {
  return `(globalThis.window ?? globalThis).${name} = globalThis.${name} = `;
}
