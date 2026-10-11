// All server fixtures own an isolated Windows Job / POSIX process group.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const active = new Set();
const records = new WeakMap();

function terminate(record) {
  if (record.closed) return;
  if (process.platform === 'win32') {
    // Only the supervisor is killed; the kernel closes its Job and kills all
    // members, including grandchildren whose immediate parent already exited.
    if (record.proc.exitCode === null && record.proc.signalCode === null) record.proc.kill('SIGKILL');
  } else {
    try { process.kill(-record.proc.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

function cleanup() {
  for (const record of active) {
    try { terminate(record); } catch (error) { console.error('E2E server cleanup failed:', error.message); }
  }
}
process.on('exit', cleanup);
process.on('uncaughtExceptionMonitor', cleanup);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143],
  ...(process.platform === 'win32' ? [['SIGBREAK', 149]] : [['SIGHUP', 129]])]) {
  process.on(signal, () => { cleanup(); process.exit(code); });
}

export function spawnServerProcess(command, args, options = {}) {
  let executable = command;
  let argv = args;
  if (process.platform === 'win32') {
    executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./windows-server-job.ps1', import.meta.url)),
      Buffer.from(JSON.stringify({ command, args }), 'utf8').toString('base64')];
  }
  const proc = spawn(executable, argv, { ...options, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const record = { proc, closed: false, stop: null, error: null };
  records.set(proc, record);
  if (proc.pid) active.add(record);
  proc.on('error', error => { record.error = error; });
  proc.once('exit', () => {
    // POSIX group ownership survives its leader's exit. Reap the rest now,
    // before dropping the record; Windows Job ownership handles this in-kernel.
    try { terminate(record); } catch (error) { record.cleanupError = error; }
  });
  proc.once('close', () => { record.closed = true; active.delete(record); });
  return proc;
}

export function stopServerProcess(proc) {
  const record = records.get(proc);
  if (!record) return Promise.reject(new Error('Not an owned E2E server'));
  if (record.stop) return record.stop;
  record.stop = new Promise((resolve, reject) => {
    if (record.closed) { record.cleanupError ? reject(record.cleanupError) : resolve(); return; }
    let timer;
    const finish = error => {
      clearTimeout(timer);
      proc.removeListener('close', onClose);
      error ? reject(error) : resolve();
    };
    const onClose = () => finish(record.cleanupError);
    proc.once('close', onClose);
    // A timeout is failure, never evidence that descendants or pipes closed.
    timer = setTimeout(() => finish(new Error(`E2E server ${proc.pid} did not close within 5s`)), 5000);
    try { terminate(record); } catch (error) { finish(error); }
  });
  return record.stop;
}

export function serverHasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null || Boolean(records.get(proc)?.error);
}

// Bound the entire response (including its body), not just connection setup.
export async function serverRequest(url, { json = false, timeout = 1000 } = {}) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
  if (json) return { ok: response.ok, body: await response.json() };
  await response.body?.cancel();
  return { ok: response.ok };
}
