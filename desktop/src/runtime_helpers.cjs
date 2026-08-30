'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_EXTENSIONS = new Set(['.mosp', '.json']);

function resolvePackagedMawPath(executablePath) {
  if (typeof executablePath !== 'string' || !executablePath) {
    throw new TypeError('executablePath must be a non-empty string');
  }
  return path.resolve(path.dirname(executablePath), '..', 'MAW.exe');
}

function resolveSourcePython(root, {
  platform = process.platform,
  environment = process.env,
  exists = fs.existsSync,
} = {}) {
  const venvPython = platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  return environment.MAW_MOSE_PYTHON
    || (exists(venvPython) ? venvPython : null)
    || environment.PYTHON
    || 'python';
}

function isProjectPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('-')) return false;
  return PROJECT_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function parseProjectArgs(argv, cwd = process.cwd()) {
  for (const value of argv) {
    if (!isProjectPath(value)) continue;
    const candidate = path.isAbsolute(value) ? value : path.resolve(cwd, value);
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // Let the editor report a missing path when an association points at it.
      return path.resolve(candidate);
    }
  }
  return null;
}

function buildServeArgs(projectPath, { packaged = false, serverPath = '' } = {}) {
  // A packaged MAW.exe dispatches the public CLI's --server subcommand;
  // source mode invokes server-editor/serve.py directly.
  const args = packaged ? ['--server'] : [serverPath];
  if (projectPath) args.push(projectPath);
  args.push('--port', '0', '--no-open', '--desktop-mode');
  return args;
}

/**
 * Queue project paths until the renderer has installed its message listener.
 *
 * Electron's `did-finish-load` means that the document exists, but keeping
 * this small state machine outside the main process makes the ordering
 * contract explicit and testable: second-instance paths received while a
 * page is loading are delivered exactly once after `markReady()`.
 */
function createProjectMessageQueue(send) {
  if (typeof send !== 'function') throw new TypeError('send must be a function');
  let ready = false;
  let pending = null;

  const flush = () => {
    if (!ready || pending === null) return false;
    const projectPath = pending;
    pending = null;
    send(projectPath);
    return true;
  };

  return {
    enqueue(projectPath) {
      if (typeof projectPath !== 'string' || !projectPath) return false;
      if (!ready) {
        pending = projectPath;
        return false;
      }
      send(projectPath);
      return true;
    },
    markReady() {
      ready = true;
      return flush();
    },
    markNotReady() {
      ready = false;
    },
    isReady() {
      return ready;
    },
    pendingPath() {
      return pending;
    },
  };
}

module.exports = {
  PROJECT_EXTENSIONS,
  buildServeArgs,
  createProjectMessageQueue,
  isProjectPath,
  parseProjectArgs,
  resolvePackagedMawPath,
  resolveSourcePython,
};
