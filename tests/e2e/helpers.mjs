// Dev-only Playwright helpers for MAW waveform deletion regression.
// Deterministic synthetic WAV + project JSON generated at runtime; no committed media.
// Event/process/port-based lifecycle — no arbitrary sleeps for correctness.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawnServerProcess, stopServerProcess, serverHasExited, serverRequest } from './server-process.mjs';
import { createOutputTail } from './output-tail.mjs';

// E2E tests exercise Python-backed editor servers and edit.py. Use the
// repository's locked uv environment by default so the runner cannot silently
// fall back to a system interpreter with an incomplete dependency set. Set
// MAW_E2E_PYTHON only when deliberately testing with a specific interpreter.
const configuredPython = String(process.env.MAW_E2E_PYTHON || '').trim();
const PYTHON_RUNNER = configuredPython
  ? { command: configuredPython, prefixArgs: [] }
  : { command: 'uv', prefixArgs: ['run', '--frozen', 'python'] };

function pythonCommandArgs(args) {
  return [...PYTHON_RUNNER.prefixArgs, ...args];
}

function buildE2EProcessEnv(extra = {}) {
  const environment = { ...process.env, ...extra };
  // An inherited PYTHONPATH can reintroduce packages from a different
  // interpreter. The explicit MAW_E2E_PYTHON escape hatch keeps its old
  // behavior, while the default uv path stays isolated and reproducible.
  if (!configuredPython) delete environment.PYTHONPATH;
  return environment;
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

export function addBwfTimeReference(filePath, timeReferenceSamples) {
  const source = readFileSync(filePath);
  const bext = Buffer.alloc(8 + 346);
  bext.write('bext', 0);
  bext.writeUInt32LE(346, 4);
  bext.writeUInt32LE(timeReferenceSamples >>> 0, 8 + 338);
  bext.writeUInt32LE(Math.floor(timeReferenceSamples / 0x100000000), 8 + 342);
  const output = Buffer.concat([source.subarray(0, 36), bext, source.subarray(36)]);
  output.writeUInt32LE(output.length - 8, 4);
  writeFileSync(filePath, output);
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
    const segment = MaweBoot.DATA.segments[0];
    segment.text = 'Alpha Bravo';
    segment.items = [
      { start: segment.start, end: 4000, text: 'Alpha' },
      { start: 4000, end: segment.end, text: 'Bravo' },
    ];
    MaweSettings.EDITOR_SETTINGS.mainSplitModeOverride = 'word';
    MaweCuePanel.renderAll({ waveform: 'full' });
  });
}

// Generic editor E2E tests should start with a neutral selection.  The real
// first-open onboarding intentionally selects the first cue, which changes
// arrow-key behavior and leaves no Shift-selection anchor for tests that are
// exercising the editor itself.  Onboarding has its own dedicated spec, so
// only callers that opt into this helper skip it.
export async function disableOnboarding(page) {
  await page.addInitScript(() => {
    localStorage.setItem('moy.asr.editor.onboarding.v1', 'completed');

    // server-editor keeps the authoritative status in SERVER_CONFIG rather
    // than localStorage.  Mark that in-memory value before the onboarding
    // module's first animation frame, while retaining the file:// behavior
    // above for editor pages without server persistence.
    const markServerOnboardingComplete = () => {
      try {
        if (typeof MaweBoot.SERVER_CONFIG !== 'undefined' && MaweBoot.SERVER_CONFIG) {
          MaweBoot.SERVER_CONFIG.onboardingStatus = 'completed';
        }
      } catch (_) {
        // The standalone editor has no SERVER_CONFIG binding.
      }
    };
    const nativeRequestAnimationFrame = window.requestAnimationFrame;
    if (typeof nativeRequestAnimationFrame === 'function') {
      window.requestAnimationFrame = (callback) => nativeRequestAnimationFrame.call(
        window,
        (timestamp) => {
          markServerOnboardingComplete();
          callback(timestamp);
        },
      );
    }
    window.addEventListener('DOMContentLoaded', markServerOnboardingComplete, { once: true });
    window.setTimeout(markServerOnboardingComplete, 0);
  });
}

// Follow the public settings entry points after project/global settings were separated.
export async function openSettingsPage(page, key) {
  const project = ['timebase', 'project-tracks', 'subtitle-style', 'project-color', 'project-sticker'].includes(key);
  const panel = project ? 'project-settings' : 'editor-settings';
  const other = project ? 'editor-settings' : 'project-settings';
  if (await page.locator(`#${other}-panel`).isVisible()) await page.locator(`#${other}-close`).click();
  if (!await page.locator(`#${panel}-panel`).isVisible()) await page.locator(`#${panel}-toggle`).click();
  await page.locator(`#editor-settings-tab-${key}`).click();
}

export async function dragFloatingPanelAwayFrom(page, panelSelector, dragHandleSelector, targetSelector) {
  const panel = page.locator(panelSelector);
  const panelBefore = await panel.boundingBox();
  const handle = await page.locator(dragHandleSelector).boundingBox();
  const target = await page.locator(targetSelector).boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!panelBefore || !handle || !target) throw new Error('Floating panel drag fixture is not visible');

  const targetOnLeft = target.x + target.width / 2 < viewport.width / 2;
  const left = targetOnLeft ? viewport.width - panelBefore.width - 8 : 8;
  const top = Math.max(8, Math.min(24, viewport.height - panelBefore.height - 8));
  const offsetX = Math.min(40, Math.max(12, handle.width / 2));
  const offsetY = Math.max(8, Math.min(15, handle.height / 2));
  const start = { x: handle.x + offsetX, y: handle.y + offsetY };
  // Import/other actions may leave a transient hint card above the settings
  // header. Wait until the real drag handle owns this screen point so the
  // mouse gesture exercises normal pointer capture instead of hitting a toast.
  await page.waitForFunction(({ x, y, selector }) => {
    const dragHandle = document.querySelector(selector);
    const hit = document.elementFromPoint(x, y);
    return Boolean(dragHandle && hit && (hit === dragHandle || dragHandle.contains(hit)));
  }, { x: start.x, y: start.y, selector: dragHandleSelector }, { timeout: 10_000 });
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return { tag: element?.tagName, id: element?.id, className: element?.className };
  }, start);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const started = await panel.evaluate(element => element.classList.contains('dragging'));
  await page.mouse.move(left + offsetX, top + offsetY, { steps: 6 });
  await page.mouse.up();

  const panelAfter = await panel.boundingBox();
  if (!panelAfter) throw new Error('Floating panel disappeared during drag');
  const overlaps = panelAfter.x < target.x + target.width
    && panelAfter.x + panelAfter.width > target.x
    && panelAfter.y < target.y + target.height
    && panelAfter.y + panelAfter.height > target.y;
  return { panelBefore, panelAfter, target, overlaps, handle, start, hit, started, destination: { left, top } };
}

export async function closeSettingsPanels(page) {
  for (const prefix of ['project-settings', 'editor-settings']) {
    if (await page.locator(`#${prefix}-panel`).isVisible()) await page.locator(`#${prefix}-close`).click();
  }
}

export async function toggleGlobalSettings(page) {
  const open = await page.locator('#editor-settings-panel').isVisible();
  await closeSettingsPanels(page);
  if (!open) await page.locator('#editor-settings-toggle').click();
}

export async function setProjectTrackEnabled(page, id, enabled) {
  await openSettingsPage(page, 'project-tracks');
  await page.locator(`#${id}`).setChecked(enabled);
  await closeSettingsPanels(page);
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
async function launchServerProcess(pythonArgs, port, env, { waitForStartup = false } = {}) {
  const proc = spawnServerProcess(PYTHON_RUNNER.command, pythonCommandArgs(pythonArgs), {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });

  const url = `http://127.0.0.1:${port}/`;

  try {
    await new Promise((resolve, reject) => {
      let pollTimer;
      let settled = false;
      const output = createOutputTail();
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (pollTimer) clearTimeout(pollTimer);
        callback();
      };
      const timeout = setTimeout(() => {
        finish(() => reject(new Error(`Server did not respond within 30s. Output tail: ${output.text()}`)));
      }, 30000);
      proc.stdout.on('data', (chunk) => output.append(chunk));
      proc.stderr.on('data', (chunk) => output.append(chunk, 'stderr'));
      proc.on('error', (err) => finish(() => reject(err)));
      proc.on('exit', (code) => finish(() => {
        void stopServerProcess(proc).then(
          () => reject(new Error(`Server exited with code ${code}. Output tail: ${output.text()}`)), reject,
        );
      }));

      const poll = async () => {
        try {
          const res = await serverRequest(url);
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

  if (waitForStartup) {
    const deadline = Date.now() + 30000;
    while (true) {
      if (serverHasExited(proc)) {
        await stopServerProcess(proc);
        throw new Error(`Server exited during project startup: ${proc.exitCode ?? proc.signalCode}`);
      }
      try {
        const response = await serverRequest(`${url}api/startup-status`, { json: true });
        const result = response.body;
        if (response.ok && result.status === 'ready') break;
        if (response.ok && result.status === 'error') {
          throw new Error(`Server project startup failed: ${result.error || 'unknown error'}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Server project startup failed:')) {
          await stopServerProcess(proc);
          throw error;
        }
      }
      if (Date.now() >= deadline) {
        await stopServerProcess(proc);
        throw new Error('Server project startup did not become ready within 30s');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
  return launchServerProcess(pythonArgs, port, buildE2EProcessEnv({
    PYTHONUNBUFFERED: '1',
    LOCALAPPDATA: settingsRoot,
    XDG_CONFIG_HOME: settingsRoot,
    // macOS ignores both keys above; the app-level override isolates the
    // MAW user-data root on every platform so local saved styles never
    // leak into assertions.
    MAW_APP_DATA_ROOT: settingsRoot,
  }), { waitForStartup: true });
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
  return launchServerProcess(pythonArgs, port, buildE2EProcessEnv({
    PYTHONUNBUFFERED: '1',
    LOCALAPPDATA: settingsRoot,
    XDG_CONFIG_HOME: settingsRoot,
    MAW_APP_DATA_ROOT: settingsRoot,
  }));
}

export async function startAlignmentServer(projectPath, scriptPath, port) {
  const pythonArgs = [
    'server-align/serve.py',
    projectPath,
    scriptPath,
    '--port', String(port),
    '--no-open',
  ];
  return launchServerProcess(pythonArgs, port, buildE2EProcessEnv({
    PYTHONUNBUFFERED: '1',
  }));
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
// Build a portable blank editor from the current web/ sources (edit.py --blank).
// The committed blank-editor.html is refreshed only before a release, so specs
// that exercise the portable page must build the current sources instead of
// copying a possibly stale artifact.
// ---------------------------------------------------------------------------
export function buildPortableBlankEditor(outputPath) {
  const { command, prefixArgs } = PYTHON_RUNNER;
  execFileSync(
    command,
    [...prefixArgs, 'edit.py', '--blank', '--output', outputPath],
    { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (!existsSync(outputPath)) {
    throw new Error(`Failed to build portable blank editor: ${outputPath}`);
  }
  return outputPath;
}
