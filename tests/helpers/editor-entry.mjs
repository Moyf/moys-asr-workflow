import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { build } from 'esbuild';

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
export const editorInitializerImports = [...imports.values()];

function executedInitializers(statements, active = new Set()) {
  const initializers = [];
  for (const statement of statements) {
    // Startup calls can also return dependencies passed to later initializers.
    const expressions = statement.type === 'ExpressionStatement' ? [statement.expression]
      : statement.type === 'VariableDeclaration' ? statement.declarations.map(item => item.init) : [];
    for (const expression of expressions) {
      if (expression?.type !== 'CallExpression' || expression.callee.type !== 'Identifier') continue;
      const name = expression.callee.name;
      if (imports.has(name)) initializers.push(imports.get(name));
      if (phases.has(name)) {
        if (active.has(name)) throw new Error(`Recursive Editor startup phase: ${name}`);
        initializers.push(...executedInitializers(phases.get(name), new Set([...active, name])));
      }
    }
  }
  return initializers;
}

export const editorInitializers = executedInitializers(tree.body);

export async function compileEditorFixture(files, {beforeEntry, exposed = {}} = {}) {
  const imports = [];
  const calls = [];
  for (const [index, file] of files.entries()) {
    const initializer = editorInitializers.find(item => item.file === file);
    const specifier = JSON.stringify('./' + file);
    if (!initializer) {
      imports.push(`import ${specifier};`);
      continue;
    }
    imports.push(`import { ${initializer.exportName} as init${index} } from ${specifier};`);
    if (file === beforeEntry) calls.push('globalThis.__mawBeforeFixture?.(window);');
    calls.push(`init${index}();`);
  }
  for (const [name, file] of Object.entries(exposed)) {
    imports.push(`import * as ${name} from ${JSON.stringify('./' + file)};`);
    calls.push(`globalThis[${JSON.stringify(name)}] = ${name};`);
  }
  const result = await build({
    stdin: {contents: [...imports, ...calls].join('\n'), resolveDir: web},
    bundle: true, format: 'iife', target: 'es2022', write: false,
  });
  return result.outputFiles[0].text;
}
