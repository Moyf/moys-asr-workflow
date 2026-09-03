'use strict';

const { execFile: defaultExecFile } = require('node:child_process');

const BACKEND_READY_PREFIX = 'MAW_DESKTOP_READY ';
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;

/**
 * Parse the one machine-readable line emitted by the desktop server.
 *
 * Returning null for ordinary output is intentional: the backend is allowed
 * to print progress and diagnostics before it announces the listening socket.
 * A line with the reserved prefix is always treated as a readiness record and
 * malformed records fail closed instead of making Electron guess an address.
 */
function parseBackendReadyLine(line, prefix = BACKEND_READY_PREFIX) {
  const text = String(line ?? '');
  if (!text.startsWith(prefix)) return null;
  let payload;
  try {
    payload = JSON.parse(text.slice(prefix.length));
  } catch (error) {
    throw new Error(`MOSE 后端启动标记无效：${error.message}`);
  }
  const host = payload?.host;
  const port = payload?.port;
  // Do not fill in missing fields or coerce strings here.  Readiness is the
  // trust boundary that supplies the exact URL loaded by Electron, so a
  // malformed record must fail closed rather than making the host guess.
  if (
    !payload
    || typeof payload !== 'object'
    || host !== '127.0.0.1'
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
  ) {
    throw new Error('MOSE 后端返回了无效的监听地址。');
  }
  return { host, port };
}

function childExited(child) {
  return (child?.exitCode !== null && child?.exitCode !== undefined)
    || (child?.signalCode !== null && child?.signalCode !== undefined);
}

/**
 * Terminate exactly the process object created by Electron and its
 * descendants. The caller must only pass a child returned by its own spawn;
 * this helper never discovers or kills a process by port/name.
 */
function terminateBackendTree(child, {
  platform = process.platform,
  execFileImpl = defaultExecFile,
} = {}) {
  // Never issue a PID-based kill after the ChildProcess has reported an exit:
  // the numeric PID may already have been reused by an unrelated process.
  if (childExited(child)) return Promise.resolve(false);
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (platform === 'win32') {
    return new Promise((resolve) => {
      // /T descends only from this verified PID; it cannot touch a manually
      // started MAW server listening on the same port.
      execFileImpl(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true },
        (error) => resolve(!error),
      );
    });
  }
  try {
    return Promise.resolve(Boolean(child.kill('SIGTERM')));
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Wait until the backend emits a validated readiness line or fails. Output is
 * forwarded to onOutput for bounded diagnostics owned by the caller.
 */
function waitForBackendReady(child, {
  timeoutMs = 30_000,
  prefix = BACKEND_READY_PREFIX,
  onOutput = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    const stdout = child?.stdout;

    const cleanup = () => {
      stdout?.removeListener?.('data', onStdout);
      child?.removeListener?.('error', onError);
      child?.removeListener?.('exit', onExit);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onStdout = (chunk) => {
      const text = String(chunk ?? '');
      onOutput(text);
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith(prefix)) continue;
        try {
          finish(null, parseBackendReadyLine(line, prefix));
        } catch (error) {
          finish(error);
        }
        return;
      }
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      finish(new Error(`MOSE 后端提前退出（code=${code}, signal=${signal}）。`));
    };
    const timer = setTimeout(() => {
      finish(new Error('MOSE 后端启动超时。'));
    }, timeoutMs);

    if (!stdout || typeof stdout.on !== 'function') {
      finish(new Error('MOSE 后端没有可读取的标准输出。'));
      return;
    }
    try {
      // Attach the listeners before the state check.  A child can exit in the
      // tiny interval between checking exitCode and registering ``exit``;
      // registering first makes that transition observable instead of
      // leaving the caller waiting for the full startup timeout.
      stdout.setEncoding?.('utf8');
      stdout.on('data', onStdout);
      child.once('error', onError);
      child.once('exit', onExit);
      if (childExited(child)) {
        finish(new Error(`MOSE 后端提前退出（code=${child.exitCode}, signal=${child.signalCode}）。`));
      }
    } catch (error) {
      finish(error);
    }
  });
}

function appendBoundedOutput(state, chunk, limit = DEFAULT_OUTPUT_LIMIT) {
  const text = String(chunk ?? '');
  state.output = `${state.output || ''}${text}`;
  if (state.output.length > limit) state.output = state.output.slice(-limit);
  return state.output;
}

module.exports = {
  BACKEND_READY_PREFIX,
  DEFAULT_OUTPUT_LIMIT,
  appendBoundedOutput,
  childExited,
  parseBackendReadyLine,
  terminateBackendTree,
  waitForBackendReady,
};
