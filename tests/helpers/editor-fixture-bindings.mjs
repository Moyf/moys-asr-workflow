import { full } from 'acorn-walk';
import MagicString from 'magic-string';
import { analyzeModule } from '../../scripts/refactor-tools/scope-core.mjs';

const privateFacades = new Set([
  'MaweCuePanel', 'MaweKeyboardTargets', 'MaweSplitContext', 'MaweSplitMode', 'MaweSplitTrim',
  'MaweTextCleanup', 'MaweTimedTextEdit',
]);
export const isPrivateFixtureFacade = name => privateFacades.has(name);

const fixtureNamespaces = new Map([
  ['editor/cues/editor-add-cue.js', 'MaweAddCue'],
  ['editor/cues/editor-binding-align.js', 'MaweBindingAlign'],
  ['editor/cues/editor-cue-events.js', 'MaweCueEvents'],
  ['editor/media/editor-ass-preview-refresh.js', 'MaweAssPreviewRefresh'],
  ['editor/state/editor-project-settings.js', 'MaweProjectSettings'],
]);
export const editorFixtureNamespace = file => fixtureNamespaces.get(file);

export function publishFixtureBindings(source, edit = new MagicString(source), { liveFacadeBindings = false, file } = {}) {
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
      const live = liveFacadeBindings && alias === name && variable.kind === 'let';
      published.set(name, { alias, live });
      if (live) {
        // Browser spies that replace a facade must reach its actual ESM callers.
        edit.appendLeft(statement.end, `; Object.defineProperty(globalThis, ${JSON.stringify(alias)}, {
          configurable: true, enumerable: true,
          get: () => ${name}, set: value => { ${name} = value; },
        });`);
      } else if (declaration.init) {
        edit.appendRight(declaration.init.start, assignment(alias));
      }
    }
  }
  const writes = new Set([...published.keys()].flatMap(name => variables.get(name).references
    .filter(reference => reference.isWrite()).map(reference => reference.identifier)));
  full(ast, node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=' && writes.has(node.left)) {
      const { alias, live } = published.get(node.left.name);
      if (!live) edit.appendRight(node.right.start, assignment(alias));
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
  const namespace = editorFixtureNamespace(file);
  if (namespace) {
    const members = ast.body.filter(node => node.type === 'ExportNamedDeclaration')
      .flatMap(node => node.declaration?.declarations?.map(({id}) => id.name) ?? [node.declaration?.id?.name])
      .filter(name => name && !/^init[A-Z]/.test(name));
    const getters = members.map(name => `get ${name}() { return ${name}; }`).join(', ');
    edit.append(`\n${assignment(namespace)}Object.freeze({ ${getters} });\n`);
  }
  return edit;
}

function fixtureAlias(name, exported) {
  if (name === 'activeBurnVideoTask') return '__maweBurnVideoTask';
  if (name === 'activeGapRemovedVideoTask') return '__maweGapRemovedVideoTask';
  if (isPrivateFixtureFacade(name)) return name;
  if (exported && /^(?:Mawe[A-Z]\w*|Asr(?:EditorUtils|Waveform|GapRemoveCore)|MAWE_(?:I18N|EDITOR_BRIDGE)|ASR_EDITOR_PALETTE)$/.test(name ?? '')) return name;
  return null;
}

function assignment(name) {
  return `(globalThis.window ?? globalThis).${name} = globalThis.${name} = `;
}
