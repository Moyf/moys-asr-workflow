'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Only the main process supplies target, directly from the native save dialog.
// Renderer IPC has no path-writing capability, and the backend only validates
// the project payload; it never exposes a general save-to-path HTTP endpoint.
function writeSelectedProject(target, project) {
  if (!path.isAbsolute(target) || !['.mosp', '.json'].includes(path.extname(target).toLowerCase())) {
    throw new Error('工程目标必须是原生对话框选定的 .mosp 或 .json 文件。');
  }
  if (!fs.statSync(path.dirname(target)).isDirectory()) throw new Error('目标目录不存在。');
  const assertRegularTarget = (candidate) => {
    if (!fs.existsSync(candidate)) return;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('工程和备份目标必须是普通文件。');
  };
  assertRegularTarget(target);
  const backup = fs.existsSync(target) ? `${target}.bak` : null;
  if (backup) {
    assertRegularTarget(backup);
    fs.copyFileSync(target, backup);
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(project, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  // Leave an incomplete temporary file recoverable if publishing fails.
  fs.renameSync(temporary, target);
  return { path: target, filename: path.basename(target), backup };
}

module.exports = { writeSelectedProject };
