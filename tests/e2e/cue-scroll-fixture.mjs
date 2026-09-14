// Synthetic-only fixture shared by source and frozen-app acceptance. Never uses
// the installed app, existing project files, user settings, or a real .env.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { generateWav, generateWaveformPayload, findFreePort } from './helpers.mjs';

const activeChildren = new Set();
process.on('exit', () => { for (const child of activeChildren) child.kill('SIGTERM'); });

export function syntheticScrollProject(count = 107, mode = 'main', paired = false) {
  const samples = ['短字幕', '这是一条会在字幕列表里自动换行的真实长度字幕',
    '较长字幕用于模拟采访视频中的自然断句和不同的列表行高', '中等长度字幕内容'];
  const segments = Array.from({ length: count }, (_, i) => ({
    id: `synthetic-${i}`, start: i * 2000, end: i * 2000 + 1800,
    text: `${samples[i % samples.length]} ${i + 1}`, items: [],
  }));
  return {
    media: 'synthetic.wav', segments, waveform: generateWaveformPayload(count * 2000 + 10000),
    multi_subtitle: { schema: 'moy.asr.multi_subtitle.v1', enabled: mode !== 'main',
      display_mode: mode === 'main' ? 'both' : mode, active_track_id: 'synthetic-ext',
      tracks: [{ id: 'synthetic-ext', name: '合成副轨', segments: segments.map(s => ({
        ...s, id: `ext-${s.id}`, text: `副 ${s.text}`,
      })) }], bindings: paired ? segments.map(s => ({
        id: `binding-${s.id}`, track_id: 'synthetic-ext', main_segment_ids: [s.id],
        extension_segment_ids: [`ext-${s.id}`], start_offset_ms: 0, end_offset_ms: 0,
      })) : [] },
  };
}

export async function startScrollFixture({ count = 107, mode = 'main', paired = false, blank = false } = {}) {
  const evidenceRoot = resolve(process.env.MAW_SCROLL_EVIDENCE || 'output/playwright/cue-scroll');
  mkdirSync(evidenceRoot, { recursive: true });
  const directory = mkdtempSync(join(evidenceRoot, 'fixture-'));
  const settings = join(directory, 'settings');
  mkdirSync(settings);
  const project = syntheticScrollProject(count, mode, paired);
  const projectPath = join(directory, 'synthetic.mosp');
  const mediaPath = join(directory, 'synthetic.wav');
  writeFileSync(projectPath, JSON.stringify(project));
  generateWav(mediaPath, count * 2 + 10);
  const emptyEnv = join(directory, 'empty.env');
  writeFileSync(emptyEnv, '');
  const port = await findFreePort();
  const app = process.env.MAW_SCROLL_APP;
  if (app && /\/Applications\//.test(resolve(app))) throw new Error('Acceptance must use an independent app');
  const python = String(process.env.MAW_E2E_PYTHON || '').trim();
  const command = app || python || 'uv';
  const args = [...(app ? ['--serve']
    : [...(python ? [] : ['run', '--no-sync', 'python']), 'server-editor/serve.py']),
    ...(blank ? ['--blank'] : [projectPath, '--media', mediaPath]),
    '--no-open', '--no-waveform', '--port', String(port)];
  const log = createWriteStream(join(directory, 'server.log'));
  const child = spawn(command, args, { env: {
    PATH: process.env.PATH, LANG: 'zh_CN.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
    ...(process.platform === 'win32' ? {
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: directory, TMP: directory,
    } : {}),
    MAW_ENV_FILE: emptyEnv, MAW_APP_DATA_ROOT: settings,
    LOCALAPPDATA: settings, XDG_CONFIG_HOME: settings, XDG_DATA_HOME: settings,
    PYINSTALLER_RESET_ENVIRONMENT: '1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchError = null;
  child.once('error', error => { launchError = error; activeChildren.delete(child); });
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify({ command, args, port, pid: child.pid }));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const stop = async () => {
    if (Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolveStop => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolveStop(); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolveStop(); });
      });
    }
    log.end();
  };
  const url = `http://127.0.0.1:${port}/`;
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Synthetic server exited: ${child.exitCode}`);
      const status = await fetch(`${url}api/startup-status`).then(r => r.json()).catch(() => null);
      if (status?.status === 'error') throw new Error(JSON.stringify(status));
      if (status?.status === 'ready') return { url, directory, stop, project, projectPath, pid: child.pid };
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Synthetic server did not become ready');
  } catch (error) { await stop(); throw error; }
}
