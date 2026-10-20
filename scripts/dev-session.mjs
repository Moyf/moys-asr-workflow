#!/usr/bin/env node
// 跨平台开发会话：先完整构建所需 bundle，再运行 Python 入口；dev 模式额外挂对应 watcher。
// 替代原 Windows-only 的 scripts/dev-editor.ps1，生命周期保持一致：
// 构建失败立即退出；Python 入口退出后回收 watcher；Ctrl+C / SIGTERM 一并清理子进程。
// 不用 shell 的 && 串联：pnpm 对复合脚本的 -- 参数转发不可靠，且 && 本身依赖脚本壳。
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = {
  editor: {
    bundleTargets: ['editor'],
    pythonScript: 'server-editor/serve.py',
    defaultRunArgs: ['--blank'],
  },
  launcher: {
    // Launcher 会启动编辑器：两套产物先就绪，避免首次打开时再现场构建。
    bundleTargets: ['editor', 'launcher'],
    pythonScript: 'maw_gui.py',
    // 旧 Codex/Paseo 入口始终带 -dbg/--debug；Launcher 前端开发需要 pywebview 调试能力。
    defaultRunArgs: ['--debug'],
  },
};

export function resolveSession(target, forwardedArgs = []) {
  const config = TARGETS[target];
  if (!config) {
    throw new Error(`未知的开发目标 "${target}"，可选：${Object.keys(TARGETS).join('、')}。`);
  }
  const runArgs = ['run', '--no-sync', 'python', config.pythonScript];
  if (forwardedArgs.length > 0) {
    runArgs.push(...forwardedArgs);
  } else {
    runArgs.push(...config.defaultRunArgs);
  }
  return {
    target,
    bundles: config.bundleTargets.map((kind) => ({
      kind,
      buildArgs: [`scripts/build-${kind}.mjs`, '--write'],
      watchArgs: [`scripts/build-${kind}.mjs`, '--watch'],
    })),
    runCommand: 'uv',
    runArgs,
  };
}

export function runSession(target, forwardedArgs = [], deps = {}) {
  const spawnFn = deps.spawn ?? spawn;
  const exitFn = deps.exit ?? ((code) => process.exit(code));
  const writeError = deps.writeError ?? ((line) => console.error(line));

  const build = buildBundles(target, forwardedArgs, deps);
  if (build.exitCode !== null) {
    exitFn(build.exitCode);
    return null;
  }
  const session = build.session;

  const watchers = [];
  let runChild;
  const alive = (child) => child && child.exitCode === null && !child.killed;
  const stopChild = (child) => {
    if (alive(child)) {
      try {
        child.kill();
      } catch {
        // 子进程已退出，忽略。
      }
    }
  };

  let shuttingDown = false;
  const shutdown = (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    for (const watcher of watchers) stopChild(watcher);
    stopChild(runChild);
    exitFn(exitCode);
  };

  const onSignal = () => shutdown(0);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  for (const bundle of session.bundles) {
    const watcher = spawnFn(process.execPath, bundle.watchArgs, { cwd: ROOT, stdio: 'inherit' });
    watchers.push(watcher);
    watcher.on('error', (error) => {
      writeError(`[dev-session] 无法启动 ${bundle.kind} watcher：${error.message}`);
      shutdown(1);
    });
    watcher.on('close', (code) => {
      if (shuttingDown) return;
      writeError(`[dev-session] ${bundle.kind} watcher 已退出；停止开发会话。`);
      shutdown(typeof code === 'number' && code !== 0 ? code : 1);
    });
  }

  runChild = spawnFn(session.runCommand, session.runArgs, { cwd: ROOT, stdio: 'inherit' });

  runChild.on('error', (error) => {
    writeError(`[dev-session] 无法启动 "${session.runCommand}"：${error.message}`);
    shutdown(1);
  });
  runChild.on('close', (code) => {
    shutdown(typeof code === 'number' ? code : 1);
  });
  return { watchers, runChild };
}

export function parseSessionArgs(argv = []) {
  const [target, ...rest] = argv;
  // pnpm 11 会把 `pnpm run x -- args` 里的 `--` 原样透传（可能落在 --once 前后），npm 则会剥离。
  // 跳过所有前导控制 token（`--` / `--once`），其余原样转发。
  let i = 0;
  let once = false;
  while (i < rest.length && (rest[i] === '--' || rest[i] === '--once')) {
    if (rest[i] === '--once') once = true;
    i += 1;
  }
  return { target, once, forwardedArgs: rest.slice(i) };
}

export function runOnce(target, forwardedArgs = [], deps = {}) {
  const spawnFn = deps.spawn ?? spawn;
  const exitFn = deps.exit ?? ((code) => process.exit(code));
  const writeError = deps.writeError ?? ((line) => console.error(line));

  const build = buildBundles(target, forwardedArgs, deps);
  if (build.exitCode !== null) {
    exitFn(build.exitCode);
    return null;
  }

  const session = build.session;
  const runChild = spawnFn(session.runCommand, session.runArgs, { cwd: ROOT, stdio: 'inherit' });
  runChild.on('error', (error) => {
    writeError(`[dev-session] 无法启动 "${session.runCommand}"：${error.message}`);
    exitFn(1);
  });
  runChild.on('close', (code) => {
    exitFn(typeof code === 'number' ? code : 1);
  });
  return { runChild };
}

function buildBundles(target, forwardedArgs, deps) {
  const spawnSyncFn = deps.spawnSync ?? spawnSync;
  const write = deps.write ?? ((line) => console.log(line));
  const writeError = deps.writeError ?? ((line) => console.error(line));

  let session;
  try {
    session = resolveSession(target, forwardedArgs);
  } catch (error) {
    writeError(`[dev-session] ${error.message}`);
    return { exitCode: 2, session: null };
  }

  for (const bundle of session.bundles) {
    write(`[dev-session] 正在构建 ${bundle.kind} bundle...`);
    const build = spawnSyncFn(process.execPath, bundle.buildArgs, { cwd: ROOT, stdio: 'inherit' });
    if (build.error || build.status !== 0) {
      if (build.error) {
        writeError(`[dev-session] ${bundle.kind} 构建进程未能启动：${build.error.message}`);
      } else {
        writeError(`[dev-session] ${bundle.kind} bundle 构建失败，退出码 ${build.status}；未启动 watcher 与 Python 入口。`);
      }
      return { exitCode: build.error ? 1 : build.status ?? 1, session: null };
    }
  }
  return { exitCode: null, session };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  const { target, once, forwardedArgs } = parseSessionArgs(process.argv.slice(2));
  if (!target) {
    console.error('用法：node scripts/dev-session.mjs <editor|launcher> [--once] [透传给 Python 入口的参数]');
    process.exit(2);
  }
  if (once) {
    runOnce(target, forwardedArgs);
  } else {
    runSession(target, forwardedArgs);
  }
}
