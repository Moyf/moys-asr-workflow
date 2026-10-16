// 盘点工具契约：夹具形态的判定正确性（局部遮蔽、字符串/注释、
// 立即/延迟、发布/读写分类）+ 真实仓库指标（owner 唯一、bundle 排除）。
// 工具是迁移的安全依据，夹具红灯优先于迁移红灯。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tool = path.join(root, 'scripts/esm-migration/inventory.mjs');
const bareReadsTool = path.join(root, 'scripts/esm-migration/bare-reads.mjs');

function runInventory(extraArgs = []) {
  const outJson = path.join('.artifacts/esm-migration/test-inventory.json');
  const outMd = path.join('.artifacts/esm-migration/test-inventory.md');
  fs.rmSync(outJson, { force: true });
  execFileSync(process.execPath, [tool, '--json', outJson, '--md', outMd],
    { cwd: root, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(path.join(root, outJson), 'utf8'));
}

test('inventory: publisher fixture classified with owner + accessor', () => {
  const report = runInventory();
  const pub = report.perFile['tests/fixtures/esm-inventory/publisher.js'];
  assert.deepEqual(pub.publishes.sort(), ['MaweFixMut', 'MaweFixPub']);
  assert.equal(report.publishers.MaweFixPub, 'tests/fixtures/esm-inventory/publisher.js');
  assert.equal(report.publishers.MaweFixMut, 'tests/fixtures/esm-inventory/publisher.js');
});

test('inventory: consumer reads classified, shadowed local not a read', () => {
  const report = runInventory();
  const cons = report.perFile['tests/fixtures/esm-inventory/consumer.js'];
  // windowReads 记录非本文件 owner 的门面读（立即+延迟都在 AST 全量里）
  assert.ok(cons.windowReads.includes('MaweFixPub'), JSON.stringify(cons));
  assert.ok(cons.windowReads.includes('MaweFixMut'), JSON.stringify(cons));
  // shadow.js 的 MaweHint 是局部 const/参数遮蔽，不得记为门面读
  const shadow = report.perFile['tests/fixtures/esm-inventory/shadow.js'];
  assert.ok(!shadow.windowReads.includes('MaweHint'), JSON.stringify(shadow));
  assert.ok(!shadow.bareImmediateReads.includes('MaweHint'), JSON.stringify(shadow));
  // 字符串/注释不产生 owner
  assert.equal(report.publishers.MaweFixStr, undefined, 'string/comment text must not create owners');
});

test('bare-read scan: accessor owners are recognized and consumers have no bare reads', () => {
  const outJson = path.join('.artifacts/esm-migration/test-bare-reads.json');
  fs.mkdirSync(path.dirname(path.join(root, outJson)), { recursive: true });
  execFileSync(process.execPath, [bareReadsTool, '--json', outJson],
    { cwd: root, stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(path.join(root, outJson), 'utf8'));
  assert.equal(report.publishers.MaweState, 'editor/state/editor-state.js');
  assert.equal(report.counts.bareReads, 0);
  assert.deepEqual(report.perFile, {});
});

test('inventory: real repo owners unique, bundle excluded, sccs known', () => {
  const report = runInventory();
  // bundle 不是源码
  assert.equal(report.perFile['editor/boot/editor-bundle.js'], undefined);
  // 登记表已退役：不再有工厂形态的文件。
  const kinds = Object.values(report.perFile).map(r => r.kind);
  assert.equal(kinds.filter(k => k === 'factory').length, 0);
  // Pin the current measured cycle shape. When a refactor changes it, update
  // this baseline from the generated report instead of maintaining a partial
  // handwritten member allowlist that silently misses most of the SCC.
  assert.deepEqual(report.sccs.map(scc => scc.length).sort((a, b) => b - a), [58, 4, 2]);
  for (const file of report.sccs.flat()) assert.ok(report.perFile[file], file);
});
