import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const pages = [
  'tools/compare.html', 'tools/timestamp-compare.html',
  'tools/copy-review/copy-review.html', 'tools/changelog-editor/index.html',
  'tools/dev-dashboard/index.html', 'tools/waveform-compare/page.html',
  'tools/verification-checklist/templates/verification-checklist.html',
  'tools/index.html',
];

test('tool pages and shared bootstrap have valid JavaScript syntax', () => {
  for (const file of pages) {
    for (const match of read(file).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\bsrc=/.test(match[1])) continue;
      parse(match[2], {ecmaVersion:'latest'});
    }
  }
  for (const file of ['tools/shared/tool-page.js', 'tools/dev-dashboard/app.js']) parse(read(file), {ecmaVersion:'latest'});
});

test('active tool styles never declare font sizes below 11 pixels', () => {
  const sources=[...pages.filter(file=>!file.includes('waveform-compare')),'tools/shared/tool-page.css','tools/dev-dashboard/style.css','tools/term-extract/term_extract/report.py'];
  for(const file of sources){
    const source=read(file);
    for(const match of source.matchAll(/\bfont-size\s*:\s*([\d.]+)px|\bfont\s*:\s*(?:[\d.]+\s+)?([\d.]+)px/g)){
      const value=Number(match[1]||match[2]);
      assert.ok(value>=11,`${file}: ${value}px at character ${match.index}`);
    }
  }
});

test('tool catalog entries and maintenance states are accurate and resolvable', () => {
  const context={window:{}};vm.runInNewContext(read('tools/catalog.js'),context);
  const catalog=context.window.MAWToolCatalog,ids=new Set();
  for(const entry of catalog){
    assert.ok(!ids.has(entry.id));ids.add(entry.id);
    assert.ok(['maintained','experimental','paused','retired','deferred','cli'].includes(entry.status));
    for(const field of ['name','summary','input','output','boundary'])assert.ok(entry[field],entry.id+': '+field);
    assert.ok(entry.features.length);
    if(entry.entry)read('tools/'+entry.entry);
    read('tools/'+entry.docs);
  }
  assert.equal(catalog.find(t=>t.id==='waveform-compare').status,'paused');
  assert.equal(catalog.find(t=>t.id==='filmstrip-lab').status,'deferred');
  assert.equal(catalog.find(t=>t.id==='copy-review').status,'retired');
});

test('shared core color, font and radius tokens match the Launcher', () => {
  const shared = read('tools/shared/tool-page.css');
  const launcher = read('web/launcher/launcher.css');
  const blocks = css => [css.match(/:root[^{}]*\{([^}]+)\}/)[1], css.match(/\[data-theme="light"\]\s*\{([^}]+)\}/)[1]];
  const values = block => new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const names = ['bg-base','bg-panel','bg-raised','bg-input','text-primary','text-secondary','text-muted','border-subtle','border','accent','accent-hover','accent-text'];
  for (let i=0;i<2;i++) {
    const a=values(blocks(shared)[i]), b=values(blocks(launcher)[i]);
    for (const name of names) assert.equal(a.get('--'+name),b.get('--'+name),name);
  }
  const all = values(shared), base = values(blocks(launcher)[0]);
  for (const name of ['font-sans','font-mono','radius-sm','radius-md','radius-lg']) assert.equal(all.get('--'+name),base.get('--'+name),name);
});

test('theme initialization tolerates failed storage and invalid preferences', () => {
  function boot(saved, fails=false) {
    const classes = new Set();
    const root = { dataset:{}, getAttribute:()=> 'fixture', classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)} };
    const context = {
      document:{documentElement:root,addEventListener(){}},
      window:{matchMedia:()=>({matches:true,addEventListener(){}})},
      localStorage:{getItem:()=>{if(fails)throw Error('blocked');return saved;}},
    };
    vm.runInNewContext(read('tools/shared/tool-page.js'),context);
    return root;
  }
  assert.equal(boot('dark').dataset.theme,'dark');
  assert.equal(boot('unexpected').dataset.theme,'light');
  assert.equal(boot(null,true).dataset.theme,'light');
});

test('each active page wires shared foundations and named theme controls', () => {
  for (const file of pages) {
    const source=read(file);
    for (const marker of [/data-tool-page=/,/tool-page\.css/,/tool-page\.js/,/data-tool-theme/]) {
      assert.ok(marker.test(source),`${file}: missing ${marker} (${source.length} chars)`);
    }
  }
});
