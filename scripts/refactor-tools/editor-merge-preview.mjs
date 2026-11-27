import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { collectOwners, migrateEditorFile } from './editor-global-migration.mjs';
import { analyzeModule } from './scope-core.mjs';

const sourceFile = file => /^web\/(?:editor|shared)\/.*\.(?:m?js)$/.test(file)
  && !/(?:-bundle|\.min)\.js$/.test(file);
const nul = text => text.split('\0').filter(Boolean);

function git(args, { input, allowed = [0] } = {}) {
  const result = spawnSync('git', args, { input, encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowed.includes(result.status)) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function listChanges(base, head) {
  return nul(git(['diff', '--name-only', '-z', base, head]));
}

function merge(base, left, right) {
  const blobs = [left, base, right].map(input => git(['hash-object', '-w', '--stdin'], { input }).trim());
  const result = spawnSync('git', ['merge-file', '--object-id', '-p', '--zdiff3', ...blobs],
    { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status === null || result.status > 127) throw new Error(result.stderr || 'git merge-file failed');
  return { source: result.stdout, hunks: result.status };
}

function loadTree(revision) {
  return new Set(nul(git(['ls-tree', '-r', '--name-only', '-z', revision])));
}

const [leftRef, rightRef, output] = process.argv.slice(2);
if (!leftRef || !rightRef || process.argv.length > 5) {
  throw new Error('Usage: editor-merge-preview.mjs <left-ref> <incoming-ref> [.artifacts/new-directory]');
}
const revision = ref => git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim();
const left = revision(leftRef), right = revision(rightRef);
const bases = git(['merge-base', '--all', left, right]).trim().split(/\s+/);
if (bases.length !== 1) throw new Error('Expected one common ancestor');
const [base] = bases;
const changedLeft = new Set(listChanges(base, left));
const changedRight = listChanges(base, right);
const overlap = changedRight.filter(file => changedLeft.has(file));
const [, ...raw] = nul(git(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', left, right],
  { allowed: [0, 1] }));
const conflicts = new Set(raw);
const trees = [base, left, right].map(loadTree);
const candidates = [];
const leftSources = new Map([...trees[1]].filter(sourceFile)
  .map(file => [file, git(['show', `${left}:${file}`])]));
const owners = collectOwners(leftSources);
function read(rev, file) {
  return rev === left ? leftSources.get(file) : git(['show', `${rev}:${file}`]);
}
for (const file of conflicts) {
  if (!sourceFile(file) || !trees.every(tree => tree.has(file))) {
    candidates.push({ file, result: 'manual' });
    continue;
  }
  const sides = [base, left, right].map(rev => migrateEditorFile(read(rev, file), file, owners));
  const result = merge(...sides.map(side => side.source));
  const entry = { file, result: result.hunks ? 'conflict' : 'candidate', hunks: result.hunks };
  if (!result.hunks) {
    try {
      analyzeModule(result.source);
      entry.source = result.source;
    } catch (error) {
      entry.result = 'invalid-ast';
      entry.error = error.message;
    }
  }
  candidates.push(entry);
}

if (output) {
  const root = fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim());
  const artifactRoot = path.join(root, '.artifacts');
  fs.mkdirSync(artifactRoot, { recursive: true });
  if (fs.realpathSync(artifactRoot) !== artifactRoot) throw new Error('Artifact root must be local');
  const folder = path.resolve(root, output);
  if (path.dirname(folder) !== artifactRoot) throw new Error('Use a new direct child of .artifacts');
  fs.mkdirSync(folder);
  for (const item of candidates.filter(item => item.source !== undefined)) {
    const file = path.resolve(folder, item.file);
    if (!file.startsWith(folder + path.sep)) throw new Error('Candidate path escapes output directory');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, item.source, { flag: 'wx' });
  }
}

console.log(JSON.stringify({
  base, left, right, incomingFiles: changedRight.length, overlap: overlap.length,
  rawConflicts: conflicts.size, candidates: candidates.map(({ source, ...item }) => item),
}, null, 2));
