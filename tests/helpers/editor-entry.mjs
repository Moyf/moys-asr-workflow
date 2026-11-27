import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { build } from 'esbuild';
import { fixtureFacadeForExport, fixtureImports } from './editor-fixture-imports.mjs';
import { publishFixtureBindings } from './editor-fixture-bindings.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const web = path.join(root, 'web');
const entry = 'editor/boot/editor-entry.mjs';
const tree = parse(fs.readFileSync(path.join(web, entry), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
const imports = new Map();
for (const statement of tree.body.filter(node => node.type === 'ImportDeclaration')) {
  const file = path.posix.join(path.posix.dirname(entry), statement.source.value);
  for (const specifier of statement.specifiers) {
    if (specifier.type === 'ImportSpecifier') imports.set(specifier.local.name, { file, exportName: specifier.imported.name });
  }
}
const phases = new Map(tree.body.filter(node => node.type === 'FunctionDeclaration')
  .map(node => [node.id.name, node.body.body]));
export const editorInitializerImports = [...imports.values()].filter(({exportName}) => /^(?:init|bind)[A-Z]/.test(exportName));

function executedInitializers(statements, active = new Set()) {
  const initializers = [];
  for (const statement of statements) {
    if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') continue;
    const { callee } = statement.expression;
    if (callee.type !== 'Identifier') continue;
    const name = callee.name;
    if (imports.has(name)) initializers.push(imports.get(name));
    if (phases.has(name)) {
      if (active.has(name)) throw new Error(`Recursive Editor startup phase: ${name}`);
      initializers.push(...executedInitializers(phases.get(name), new Set([...active, name])));
    }
  }
  return initializers;
}

export const editorInitializers = executedInitializers(tree.body);

export async function compileEditorFixture(files, {beforeEntry, exposed = {}} = {}) {
  const imports = [];
  const calls = [];
  const sources = new Map();
  const read = file => {
    if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(web, file), 'utf8'));
    return sources.get(file);
  };
  for (const [index, file] of files.entries()) {
    const initializer = editorInitializers.find(item => item.file === file);
    const specifier = JSON.stringify('./' + file);
    if (!initializer) {
      imports.push(`import ${specifier};`);
      continue;
    }
    imports.push(`import { ${initializer.exportName} as init${index} } from ${specifier};`);
    if (file === beforeEntry) calls.push('globalThis.__mawBeforeFixture?.(window);');
    const dependencies = {
      'shared/editor-utils.js': `{
        getNavigator: () => window.MaweHost?.runtime?.getNavigator?.(),
        getProject: () => window.MaweBoot?.DATA,
        getColorByName: () => window.MaweColors?.COLOR_BY_NAME,
        getAssFontAliases: () => window.MaweAssFontAliases,
      }`,
      'shared/utils/project-validation.js': 'input => window.AsrEditorUtils.importProject(input)',
    }[file] ?? '';
    calls.push(`init${index}(${dependencies});`);
  }
  for (const [name, file] of Object.entries(exposed)) {
    imports.push(`import * as ${name} from ${JSON.stringify('./' + file)};`);
    calls.push(`globalThis[${JSON.stringify(name)}] = ${name};`);
  }
  const result = await build({
    stdin: {contents: [...imports, ...calls].join('\n'), resolveDir: web},
    bundle: true, format: 'iife', target: 'es2022', write: false,
    plugins: [{
      name: 'partial-editor-fixture-dependencies',
      setup(builder) {
        builder.onLoad({ filter: /\.(?:m?js)$/ }, args => {
          const file = path.relative(web, args.path).split(path.sep).join('/');
          if (!/^(?:editor|shared)\//.test(file)) return;
          const resolve = specifier => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
          const edit = fixtureImports(read(file), specifier => specifier.startsWith('.') && !files.includes(resolve(specifier)),
            (specifier, name) => fixtureFacadeForExport(read(resolve(specifier)), name, resolve(specifier)));
          if (files.includes(file)) publishFixtureBindings(read(file), edit, { file });
          return { contents: edit.toString(), loader: 'js' };
        });
      },
    }],
  });
  return result.outputFiles[0].text;
}
