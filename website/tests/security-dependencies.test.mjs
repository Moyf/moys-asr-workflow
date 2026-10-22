import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(new URL('../package.json', import.meta.url));
const astroRequire = createRequire(require.resolve('astro/package.json'));
const magicastRequire = createRequire(astroRequire.resolve('magicast/package.json'));
const dist = dirname(astroRequire.resolve('magicast'));
const bundlePath = process.env.MAW_TEST_MAGICAST_BUNDLE || join(dist,
  readdirSync(dist).find(name => /^builders-.*\.js$/.test(name)));
const bundle = readFileSync(bundlePath, 'utf8');
const runtime = bundle.match(/^var __commonJSMin = .*;$/m)?.[0];
const start = bundle.indexOf('//#region node_modules/.pnpm/source-map-js@');
const end = bundle.indexOf('//#region vendor/recast/lib/util.ts');
assert.ok(runtime && start >= 0 && end > start, 'Locate the installed magicast source-map bundle');
const context = createContext({ assert });
runInContext(runtime + '\n' + bundle.slice(start, end) + `
  const { SourceMapConsumer } = require_source_map_consumer();
  const { SourceMapGenerator } = require_source_map_generator();
  const { SourceNode } = require_source_node();
  const basic = { version: 3, sources: ['a.js'], names: [], mappings: 'AAAA', sourcesContent: ['x'] };
  const indexed = (line, map = basic, column = 0) => ({ version: 3, sections: [{ offset: { line, column }, map }] });
`, context, { timeout: 1000 });
const check = source => runInContext(source, context, { timeout: 2500 });

test('installed external source-map-js is patched', () => {
  assert.equal(magicastRequire('source-map-js/package.json').version, '1.2.2');
});

test('embedded consumer rejects oversized, invalid and cumulative section offsets', () => check(`
  for (const value of [1e8, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new SourceMapConsumer(indexed(value)), /Section offset/);
  }
  assert.throws(() => new SourceMapConsumer(indexed(0, basic, -1)), /Section offset/);
  assert.throws(() => new SourceMapConsumer(indexed(6e6, indexed(6e6))), /nested sections/);
  assert.equal(new SourceMapConsumer(indexed(0)).sources.join(','), 'a.js');
`));

test('embedded nested sources getter remains bounded', () => check(`
  let nested = basic;
  for (let i = 0; i < 40; i++) nested = indexed(0, nested);
  assert.equal(new SourceMapConsumer(nested).sources.join(','), 'a.js');
`));

test('embedded generator serializes large line gaps without rope amplification', () => check(`
  const generator = new SourceMapGenerator();
  generator.addMapping({ source: 'a.js', original: { line: 1, column: 0 }, generated: { line: 1e8, column: 0 } });
  assert.equal(generator.toJSON().mappings.length, 1e8 + 3);
`));

test('embedded SourceNode stops padding after the generated code ends', () => check(`
  const fakeConsumer = {
    sources: [],
    eachMapping(callback) { callback({ generatedLine: 1e9, generatedColumn: 0 }); }
  };
  assert.equal(SourceNode.fromStringWithSourceMap('x', fakeConsumer).toString(), 'x');
`));

test('magicast still edits configuration and generates valid source maps', async () => {
  const { parseModule, generateCode } = await import(pathToFileURL(astroRequire.resolve('magicast')).href);
  const mod = parseModule('export default { enabled: false };', { sourceFileName: 'config.js' });
  mod.exports.default.enabled = true;
  const output = generateCode(mod, { sourceMapName: 'config.js.map' });
  assert.match(output.code, /enabled: true/);
  assert.equal(output.map.version, 3);
});
