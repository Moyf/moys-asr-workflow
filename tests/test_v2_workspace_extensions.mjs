import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('live waveform workspace updates preserve stored extensions without replacing current settings', () => {
  const stored = { schema: 'workspace', preset: 'old', vendor: { empty: [], value: false },
    waveformSettings: { rowHeight: 100, vendor: { zero: 0 } },
    editorDisplay: { cuePanel: false, vendor: {} } };
  const before = structuredClone(stored);
  const current = { schema: 'workspace', preset: 'new', waveformSettings: { rowHeight: 240 } };
  const context = { document: { querySelectorAll: () => [] }, MaweBoot: { DATA: { workspace: stored } },
    MaweCoreState: { waveformEditor: { getLayoutData: () => current } },
    MaweWorkspaces: { currentBuiltinWorkspaceName: 'new' },
    MaweDisplaySettings: { getEditorDisplaySettings: () => ({ cuePanel: true }) } };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../web/editor/io/editor-export-timeline.js', import.meta.url), 'utf8'), context);
  const saved = JSON.parse(JSON.stringify(context.MaweExportTimeline.buildCurrentWorkspaceData()));
  assert.deepEqual(saved, { ...before, preset: 'new', selectedPreset: 'new',
    waveformSettings: { rowHeight: 240, vendor: { zero: 0 } },
    editorDisplay: { cuePanel: true, vendor: {} } });
  assert.deepEqual(stored, before);
});
