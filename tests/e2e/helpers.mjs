// Dev-only Playwright helpers for MAW waveform deletion regression.
// Deterministic synthetic WAV + project JSON generated at runtime; no committed media.
// Event/process/port-based lifecycle — no arbitrary sleeps for correctness.
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

// The editor server and portable HTML generator use only the repository's
// Python sources and standard library.  Running them directly avoids making
// browser tests depend on uv's global cache (which may be locked down on a
// developer machine).  Set MAW_E2E_PYTHON when a specific interpreter is
// needed.
const PYTHON_COMMAND = process.env.MAW_E2E_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');

// ---------------------------------------------------------------------------
// Process cleanup for interrupted E2E runs.
// ---------------------------------------------------------------------------
// Keep this list limited to server processes started by this helper.  In
// particular, do not try to discover or terminate every Python process on the
// machine when a test runner is interrupted.
const activeServerPids = new Set();
let cleanupInProgress = false;

function terminateProcessTreeSync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (_) {
    // The process may already have exited between registration and cleanup.
  }
}

function cleanupActiveServersSync() {
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  try {
    for (const pid of activeServerPids) {
      terminateProcessTreeSync(pid);
    }
  } finally {
    activeServerPids.clear();
    cleanupInProgress = false;
  }
}

function registerServerProcess(proc) {
  if (!Number.isInteger(proc.pid) || proc.pid <= 0) return;

  activeServerPids.add(proc.pid);
  proc.once('exit', () => activeServerPids.delete(proc.pid));
  proc.once('error', () => activeServerPids.delete(proc.pid));
}

function stopServerProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || !Number.isInteger(proc.pid)) {
      activeServerPids.delete(proc.pid);
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.removeListener('exit', finish);
      resolve();
    };
    const timeout = setTimeout(finish, 5000);

    proc.once('exit', finish);
    terminateProcessTreeSync(proc.pid);
  });
}

process.on('exit', cleanupActiveServersSync);
process.on('uncaughtExceptionMonitor', cleanupActiveServersSync);

function handleTerminationSignal(signal) {
  cleanupActiveServersSync();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.on('SIGINT', () => handleTerminationSignal('SIGINT'));
process.on('SIGTERM', () => handleTerminationSignal('SIGTERM'));
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => handleTerminationSignal('SIGBREAK'));
} else {
  process.on('SIGHUP', () => handleTerminationSignal('SIGHUP'));
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (LCG) — fixed seed so WAV peaks and waveform data are
// reproducible across runs.  No Math.random() where determinism matters.
// ---------------------------------------------------------------------------
const SEED = 42;
function makeRng(seed) {
  let state = seed | 0;
  return () => {
    state = (state * 1664525 + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Temp directory for synthetic fixtures (cleaned by test teardown).
// ---------------------------------------------------------------------------
const TEMP_BASE = join(tmpdir(), 'opencode', 'maw-e2e');

export function makeTempDir(label) {
  const dir = join(TEMP_BASE, `${label}-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupTempDir(dir) {
  if (dir && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Find a free TCP port on 127.0.0.1 (ephemeral, no hardcode).
// ---------------------------------------------------------------------------
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Generate a deterministic minimal WAV file (mono, 8 kHz, 16-bit PCM).
// ---------------------------------------------------------------------------
export function generateWav(filePath, durationSec = 60) {
  const sampleRate = 8000;
  const bitsPerSample = 16;
  const channels = 1;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * (bitsPerSample / 8) * channels;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * (bitsPerSample / 8) * channels, 28);
  buffer.writeUInt16LE(bitsPerSample / 8 * channels, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const rng = makeRng(SEED);
  for (let i = 0; i < numSamples; i++) {
    const offset = 44 + i * 2;
    const noise = Math.round((rng() - 0.5) * 4000);
    buffer.writeInt16LE(noise, offset);
  }

  writeFileSync(filePath, buffer);
  return filePath;
}

// ---------------------------------------------------------------------------
// Generate deterministic waveform payload (moy.asr.waveform.v1 format).
// ---------------------------------------------------------------------------
export function generateWaveformPayload(durationMs, peaksPerSecond = 100) {
  const peakCount = Math.ceil((durationMs / 1000) * peaksPerSecond);
  const encoded = Buffer.alloc(peakCount * 2);
  const rng = makeRng(SEED + 1);
  for (let i = 0; i < peakCount; i++) {
    const amp = Math.round(40 + 30 * rng());
    encoded.writeInt8(-amp, i * 2);
    encoded.writeInt8(amp, i * 2 + 1);
  }
  return {
    schema: 'moy.asr.waveform.v1',
    encoding: 'i8-minmax-base64',
    peaks_per_second: peaksPerSecond,
    peak_count: peakCount,
    duration_ms: durationMs,
    data: encoded.toString('base64'),
    source: { name: 'synthetic.wav', size: 0, modified_ms: 0 },
  };
}

// ---------------------------------------------------------------------------
// 6-segment test project spanning 300 seconds — enough for multi-row
// virtualization at secondsPerRow=5 (60 rows; viewport shows ~8-10 rows).
// Each segment has a unique NATO-phonetic name for exact identity assertions.
// Segments are spaced 50s apart so each occupies a distinct row pair.
// ---------------------------------------------------------------------------
export const DURATION_MS = 300_000;

export function testSegments() {
  return [
    { start: 0, end: 8000, text: 'Alpha', items: [
      { start: 0, end: 4000, text: 'Al' },
      { start: 4000, end: 8000, text: 'pha' },
    ]},
    { start: 50000, end: 58000, text: 'Bravo', items: [
      { start: 50000, end: 54000, text: 'Bra' },
      { start: 54000, end: 58000, text: 'vo' },
    ]},
    { start: 100000, end: 108000, text: 'Charlie', items: [
      { start: 100000, end: 104000, text: 'Char' },
      { start: 104000, end: 108000, text: 'lie' },
    ]},
    { start: 150000, end: 158000, text: 'Delta', items: [
      { start: 150000, end: 154000, text: 'Del' },
      { start: 154000, end: 158000, text: 'ta' },
    ]},
    { start: 200000, end: 208000, text: 'Echo', items: [
      { start: 200000, end: 204000, text: 'Ec' },
      { start: 204000, end: 208000, text: 'ho' },
    ]},
    { start: 250000, end: 258000, text: 'Foxtrot', items: [
      { start: 250000, end: 254000, text: 'Fox' },
      { start: 254000, end: 258000, text: 'trot' },
    ]},
  ];
}

// A word-mode split must land between words rather than in the middle of an
// item. Keep the shared identity fixture unchanged for the other tests and
// opt into this two-word shape only in split-specific scenarios.
export async function makeFirstCueWordSplittable(page) {
  await page.evaluate(() => {
    const segment = DATA.segments[0];
    segment.text = 'Alpha Bravo';
    segment.items = [
      { start: segment.start, end: 4000, text: 'Alpha' },
      { start: 4000, end: segment.end, text: 'Bravo' },
    ];
    renderAll({ waveform: 'full' });
  });
}

export function generateProjectJson(filePath) {
  const project = {
    media: 'synthetic.wav',
    segments: testSegments(),
    waveform: generateWaveformPayload(DURATION_MS),
  };
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Start the MAW localhost editor server.
// Returns { url, proc, stop } where stop() returns a Promise that resolves
// when the process has fully exited.
// ---------------------------------------------------------------------------
async function launchServerProcess(pythonArgs, port, env) {
  const proc = spawn(PYTHON_COMMAND, pythonArgs, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });
  registerServerProcess(proc);

  const url = `http://127.0.0.1:${port}/`;

  try {
    await new Promise((resolve, reject) => {
      let pollTimer;
      let settled = false;
      const allOutput = [];
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (pollTimer) clearTimeout(pollTimer);
        callback();
      };
      const timeout = setTimeout(() => {
        finish(() => reject(new Error('Server did not respond within 30s')));
      }, 30000);
      proc.stdout.on('data', (chunk) => allOutput.push(chunk.toString()));
      proc.stderr.on('data', (chunk) => allOutput.push(chunk.toString()));
      proc.on('error', (err) => finish(() => reject(err)));
      proc.on('exit', (code) => finish(() => {
        reject(new Error(`Server exited with code ${code}. Output: ${allOutput.join('')}`));
      }));

      const poll = async () => {
        try {
          const res = await fetch(url);
          if (res.ok) {
            finish(resolve);
            return;
          }
        } catch (_) {}
        if (!settled) pollTimer = setTimeout(poll, 500);
      };
      poll();
    });
  } catch (error) {
    await stopServerProcess(proc);
    throw error;
  }

  return {
    url,
    proc,
    async stop() {
      return stopServerProcess(proc);
    },
  };
}

export async function startServer(projectJsonPath, mediaPath, port) {
  const settingsRoot = join(dirname(projectJsonPath), '.settings');
  mkdirSync(settingsRoot, { recursive: true });
  const pythonArgs = [
    'server-editor/serve.py',
    projectJsonPath,
    '-m', mediaPath,
    '--no-waveform',
    '--port', String(port),
    '--no-open',
  ];
  return launchServerProcess(pythonArgs, port, {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    LOCALAPPDATA: settingsRoot,
    XDG_CONFIG_HOME: settingsRoot,
  });
}

// 空白服务器（--blank）：用于「浏览器打开工程后由服务器接管」的回归测试。
// settingsRoot 隔离本机最近工程记录，保证每次都以空白状态启动。
export async function startBlankServer(port, settingsRoot) {
  mkdirSync(settingsRoot, { recursive: true });
  const pythonArgs = [
    'server-editor/serve.py',
    '--blank',
    '--no-waveform',
    '--port', String(port),
    '--no-open',
  ];
  return launchServerProcess(pythonArgs, port, {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    LOCALAPPDATA: settingsRoot,
    XDG_CONFIG_HOME: settingsRoot,
  });
}

// ---------------------------------------------------------------------------
// Start a minimal static file server for portable HTML testing.
// ---------------------------------------------------------------------------
export async function startStaticServer(filePath, port) {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    try {
      const content = readFileSync(filePath);
      res.writeHead(200);
      res.end(content);
    } catch (err) {
      res.writeHead(500);
      res.end(`Error: ${err.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    async stop() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 2000);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Generate blank-editor.html via edit.py --blank.
// ---------------------------------------------------------------------------
export function generateBlankEditor(outputPath) {
  const args = ['edit.py', '--blank', '-o', outputPath];
  execFileSync(PYTHON_COMMAND, args, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 30000,
    windowsHide: true,
  });
  return outputPath;
}
