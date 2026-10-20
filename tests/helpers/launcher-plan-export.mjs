// Execute the production plan exporters without starting the Launcher UI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/launcher/postprocess.js', import.meta.url), 'utf8');
function launcherFunction(name) {
  const start = source.search(new RegExp(`^  function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `missing ${name}`);
  const next = source.slice(start + 1).search(/\n  (?:async )?function /u);
  assert.notEqual(next, -1, `missing boundary after ${name}`);
  return source.slice(start, start + 1 + next);
}

const symbols = JSON.parse(readFileSync(0, 'utf8'));
const fields = {
  postprocessExtraSplitPunctuation: symbols.split.join('\n'),
  postprocessPreservePunctuation: symbols.preserve.join('\n'),
};
const context = vm.createContext({
  $: (id) => ({ value: fields[id] || '', checked: false }),
  ocrRegionPayload: () => ({}),
  stepProviderId: () => 'deepseek',
  getLlmPrompt: () => '',
  parseReplacements: () => [],
  autoLlmOperation: (id) => id,
  ocrVideoManual: false,
});
for (const name of ['punctuationLines', 'defaultAutoPlan', 'autoPlanFromControls']) {
  vm.runInContext(launcherFunction(name), context);
}
process.stdout.write(JSON.stringify({ defaults: context.defaultAutoPlan(), controls: context.autoPlanFromControls() }));
