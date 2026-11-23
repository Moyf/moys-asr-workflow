import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { cueStyleUpdates } from '../web/shared/utils/cue-styles.js';
import { projectModel, runtimeProject } from './helpers/runtime-project.mjs';

const source = fs.readFileSync(new URL('../web/editor/styles/editor-wiring-ass-manager.js', import.meta.url), 'utf8');
let target;
walk.simple(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), {
  FunctionDeclaration(node) { if (node.id?.name === 'updateAssStyleProjectHint') target = node; },
});
assert.ok(target);

test('style snapshot hint inspects canonical secondary cues using the live style library', () => {
  const library = { styles: [{ id: 'style', fontSize: 32 }] };
  const project = projectModel.importProject(runtimeProject([], { extensions: [{ id: 'en', segments: [
    { id: 'cue', start: 0, end: 1000, text: 'hello', assStyle: { id: 'style', fontSize: 40 } },
  ] }] })).project;
  const entry = project.cue_styles[0];
  assert.equal(entry.library_id, undefined);
  entry.library_id = 'style';
  const hint = { hidden: true };
  const context = { assStyleProjectHint: hint, MaweBoot: { DATA: project }, getAssStyleLibrary: () => library,
    cueStyleUpdates };
  vm.createContext(context);
  vm.runInContext(`${source.slice(target.start, target.end)}\nupdateAssStyleProjectHint()`, context);
  assert.equal(hint.hidden, false);
  library.styles[0].fontSize = 40;
  context.updateAssStyleProjectHint();
  assert.equal(hint.hidden, true);
});
