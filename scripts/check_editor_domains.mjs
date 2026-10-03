// Audit moved declarations/methods against the immutable pre-extraction revision.
// Unlike the mechanical split audit, this permits dependency-injection wrappers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { target: { type: 'string' } } });
const gitText = revisionPath => execFileSync('git', ['show', revisionPath], {
  encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
});
// Extraction equality is a historical claim. A later behavior change must not
// be silently added to the allowed substitutions to make the audit pass.
const target = values.target ? execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values.target}^{commit}`],
  { encoding: 'utf8' }).trim() : null;
const readTarget = path => target ? gitText(`${target}:${path}`) : readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const parseSource = source => parse(source, { ecmaVersion: 'latest', locations: true });
const slice = (source, node) => source.slice(node.start, node.end);
const inRanges = (node, ranges) => ranges.some(([a, b]) => node.loc.start.line >= a && node.loc.end.line <= b);

for (const kind of ['utils', 'waveform']) {
  const spec = JSON.parse(readTarget(`scripts/refactor-tools/specs/${kind}-domains.json`));
  const before = gitText(`${spec.base}:web/${spec.source}`);
  const oldBody = parseSource(before).body[0].expression.callee.body.body;
  const oldClass = oldBody.find(node => node.type === 'ClassDeclaration');
  let statements = 0, methods = 0;
  for (const module of spec.modules) {
    const file = kind === 'utils' ? `shared/utils/${module.name}.js` : `editor/media/waveform/${module.name}.js`;
    const source = readTarget('web/' + file);
    const factory = parseSource(source).body[0].expression.arguments[1];
    const generatedBody = factory.body.body;
    const actual = module.methods
      ? generatedBody.find(node => node.type === 'ClassDeclaration').body.body
      : generatedBody.filter(node => !node.directive && node.type !== 'ReturnStatement'
        && !(node.type === 'VariableDeclaration' && node.declarations[0].id.type === 'ObjectPattern'));
    const expected = (module.methods ? oldClass.body.body : oldBody).filter(node => inRanges(node, module.ranges));
    const adaptHost = text => (module.hostSubstitutions || []).reduce(
      (result, [before, after]) => result.replaceAll(before, after), text);
    assert.deepEqual(actual.map(node => slice(source, node)), expected.map(node => adaptHost(slice(before, node))), file);
    if (module.methods) methods += actual.length; else statements += actual.length;
  }
  const facade = readTarget('web/' + spec.source);
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
  console.log(`${kind}: ${statements} statements, ${methods} methods, constructor/API unchanged; host substitutions explicitly audited`);
}
