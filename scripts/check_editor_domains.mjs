// Audit moved declarations/methods against the immutable pre-extraction revision.
// Unlike the mechanical split audit, this permits dependency-injection wrappers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

const web = new URL('../web/', import.meta.url);
const parseSource = source => parse(source, { ecmaVersion: 'latest', locations: true });
const slice = (source, node) => source.slice(node.start, node.end);
const inRanges = (node, ranges) => ranges.some(([a, b]) => node.loc.start.line >= a && node.loc.end.line <= b);

for (const kind of ['utils', 'waveform']) {
  const spec = JSON.parse(readFileSync(new URL(`./refactor-tools/specs/${kind}-domains.json`, import.meta.url)));
  const before = execFileSync('git', ['show', `${spec.base}:web/${spec.source}`], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  const oldBody = parseSource(before).body[0].expression.callee.body.body;
  const oldClass = oldBody.find(node => node.type === 'ClassDeclaration');
  let statements = 0, methods = 0;
  for (const module of spec.modules) {
    const file = kind === 'utils' ? `shared/utils/${module.name}.js` : `editor/media/waveform/${module.name}.js`;
    const source = readFileSync(new URL(file, web), 'utf8');
    const factory = parseSource(source).body[0].expression.arguments[1];
    const generatedBody = factory.body.body;
    const actual = module.methods
      ? generatedBody.find(node => node.type === 'ClassDeclaration').body.body
      : generatedBody.filter(node => !node.directive && node.type !== 'ReturnStatement'
        && !(node.type === 'VariableDeclaration' && node.declarations[0].id.type === 'ObjectPattern'));
    const expected = (module.methods ? oldClass.body.body : oldBody).filter(node => inRanges(node, module.ranges));
    assert.deepEqual(actual.map(node => slice(source, node)), expected.map(node => slice(before, node)), file);
    if (module.methods) methods += actual.length; else statements += actual.length;
  }
  const facade = readFileSync(new URL(spec.source, web), 'utf8');
  const facadeBody = parseSource(facade).body[0].expression.callee.body.body;
  const exportNode = body => body.find(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'AssignmentExpression'
    && node.expression.left.property?.name === (kind === 'utils' ? 'AsrEditorUtils' : 'AsrWaveform'));
  assert.equal(slice(facade, exportNode(facadeBody)), slice(before, exportNode(oldBody)), `${kind} compatibility API`);
  if (oldClass) {
    const ctor = cls => cls.body.body.find(node => node.kind === 'constructor');
    assert.equal(slice(facade, ctor(facadeBody.find(node => node.type === 'ClassDeclaration'))), slice(before, ctor(oldClass)));
    assert.equal(methods, oldClass.body.body.length - 1, 'all methods covered');
  }
  // gap-remove includes its original validation IfStatement.
  const covered = spec.modules.filter(module => !module.methods)
    .flatMap(module => oldBody.filter(node => inRanges(node, module.ranges)));
  assert.equal(new Set(covered).size, covered.length, 'no duplicate statement migration');
  assert.equal(covered.length, oldBody.length - (oldClass ? 4 : 3), 'all closure statements covered');
  console.log(`${kind}: ${statements} statements, ${methods} methods, constructor and compatibility API unchanged`);
}
