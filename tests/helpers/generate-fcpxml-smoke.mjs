// Manual Mac QA fixture generator; not an editor or public CLI entry point.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEditorModule, prepareEditorModule } from './editor-module-loader.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const project = JSON.parse(fs.readFileSync(new URL('../fixtures/fcpxml_titles_project.json', import.meta.url), 'utf8'));
const output = path.join(root, '.artifacts');
fs.mkdirSync(output, { recursive: true });

await prepareEditorModule('shared/editor-utils.js');
const { AsrEditorUtils: { buildFcpxmlTitlePlan } } = loadEditorModule({ window: {} }, 'shared/editor-utils.js');
for (const [baseName, timelineMode, fps, width, height] of [
  ['MAW Bilingual Original', 'source', '30', 1920, 1080],
  ['MAW Bilingual Compressed', 'gap_removed', '30000/1001', 1080, 1920],
]) {
  const { ir } = buildFcpxmlTitlePlan(project, { baseName, timelineMode, fps, width, height });
  const result = spawnSync(process.env.MAW_TEST_PYTHON || 'python3', ['-c', [
    'import json, sys',
    'from maw.fcpxml import build_fcpxml_titles_bundle',
    'sys.stdout.buffer.write(build_fcpxml_titles_bundle(json.loads(sys.stdin.buffer.read()))[1])',
  ].join('; ')], { input: JSON.stringify(ir), cwd: root, timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.error || result.stderr.toString('utf8'));
  const filename = `${baseName}-final-cut.fcpxmld.zip`;
  fs.writeFileSync(path.join(output, filename), result.stdout);
  console.log(`.artifacts/${filename} — ${ir.durationFrames} frames, ${ir.titles.length} titles`);
}
