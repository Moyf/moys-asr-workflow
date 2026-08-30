'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  appendBoundedOutput,
  childExited,
  terminateBackendTree: terminateBackendProcessTree,
  waitForBackendReady,
} = require('./backend_runtime.cjs');
// The server's MAW_DESKTOP_READY record is the only signal that permits page loading.
const {
  buildServeArgs,
  createProjectMessageQueue,
  parseProjectArgs,
  resolvePackagedMawPath,
  resolveSourcePython,
} = require('./runtime_helpers.cjs');

const BACKEND_START_TIMEOUT_MS = 30_000;
const BACKEND_SHUTDOWN_REQUEST_TIMEOUT_MS = 1_500;
const BACKEND_STOP_TIMEOUT_MS = 5_000;
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const smokeMode = process.argv.includes('--mose-smoke');

// CI and headless smoke hosts may not expose a usable GPU process.  Keep the
// production editor on Electron's normal accelerated path, but make the
// deterministic hidden smoke check independent of the host graphics stack.
// These switches are installed before Electron creates any renderer process;
// calling them after ``whenReady`` is too late for the GPU service.
if (smokeMode) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let backend = null;
let startingBackendChild = null;
let queuedProjectPath = null;
let rendererMessageQueue = null;
let quitRequested = false;

function repositoryRoot() {
  return path.resolve(__dirname, '..', '..');
}

function packagedMawPath() {
  return resolvePackagedMawPath(process.execPath);
}

function resolveBackend() {
  if (app.isPackaged) {
    const executable = packagedMawPath();
    if (!fs.existsSync(executable)) {
      throw new Error(`未找到同套件的 MAW.exe：${executable}`);
    }
    return { executable, argsPrefix: [] };
  }
  const root = repositoryRoot();
  // Prefer the repository-managed environment in source checkouts.  The
  // release workflow installs MAW's dependencies with ``uv sync`` into this
  // .venv, while ``python`` on PATH may be an unrelated system interpreter.
  // MAW_MOSE_PYTHON remains an explicit escape hatch for other environments.
  const python = resolveSourcePython(root);
  return {
    executable: python,
    argsPrefix: [path.join(root, 'server-editor', 'serve.py')],
  };
}

function buildBackendCommand(projectPath, token) {
  const backendCommand = resolveBackend();
  const args = buildServeArgs(projectPath, {
    packaged: app.isPackaged,
    serverPath: backendCommand.argsPrefix[0],
  });
  return {
    executable: backendCommand.executable,
    args,
    token,
  };
}

function startBackend(projectPath) {
  const token = crypto.randomBytes(32).toString('base64url');
  const command = buildBackendCommand(projectPath, token);
  const outputState = { output: '' };
  let child;
  try {
    const childEnv = {
      ...process.env,
      MAW_DESKTOP_TOKEN: token,
      PYTHONUTF8: '1',
    };
    // Smoke is a deterministic backend/page/exit check.  Do not let a
    // developer's persisted "open last project" setting turn it into a
    // media or filesystem test (the real project-open path is exercised by
    // the normal command-line flow).
    if (smokeMode) childEnv.MAW_DESKTOP_SMOKE = '1';
    child = spawn(command.executable, command.args, {
      cwd: app.isPackaged ? path.dirname(packagedMawPath()) : repositoryRoot(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return Promise.reject(error);
  }
  startingBackendChild = child;

  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on?.('data', (chunk) => appendBoundedOutput(outputState, chunk));
  return waitForBackendReady(child, {
    timeoutMs: BACKEND_START_TIMEOUT_MS,
    onOutput: (chunk) => appendBoundedOutput(outputState, chunk),
  }).then(({ host, port }) => {
    if (startingBackendChild === child) startingBackendChild = null;
    // Keep consuming stdout after the readiness record.  The server logs
    // requests and media diagnostics for the entire session; leaving this
    // pipe unread would eventually fill its Windows buffer and stall MAW.
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => appendBoundedOutput(outputState, chunk));
    return {
      child,
      token,
      host,
      port,
      origin: `http://${host}:${port}`,
      outputState,
    };
  }).catch(async (error) => {
    if (startingBackendChild === child) startingBackendChild = null;
    // Readiness failures must not leave a MAW process behind.  The process
    // object is the exact child created above; no port/name based discovery is
    // used here, so an unrelated manually started Server remains untouched.
    await terminateBackendTree(child);
    const detail = error instanceof Error ? error.message : String(error);
    const output = outputState.output;
    throw new Error(output && !detail.includes(output) ? `${detail}${detail.endsWith('。') ? '' : '。'}${output}` : detail);
  });
}

function backendHeaders(token) {
  return { 'X-MAW-Desktop-Token': token };
}

function configureSession(targetSession, state) {
  const filter = { urls: [`${state.origin}/*`] };
  targetSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    details.requestHeaders = { ...details.requestHeaders, ...backendHeaders(state.token) };
    callback({ requestHeaders: details.requestHeaders });
  });
  targetSession.on('will-download', (event, item, webContents) => {
    const owner = BrowserWindow.fromWebContents(webContents) || mainWindow;
    const defaultPath = path.join(app.getPath('downloads'), item.getFilename());
    // Keep the download alive while choosing a destination.  Electron treats
    // event.preventDefault() here as a cancellation, so use the synchronous
    // dialog and set the path before returning from the event handler.
    const filePath = dialog.showSaveDialogSync(owner, {
      defaultPath,
      title: '保存导出文件',
    });
    if (!filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(filePath);
  });
}

function isAllowedExternalUrl(url) {
  return url.startsWith('https://') || url.startsWith('http://');
}

function isExactBackendUrl(url, origin) {
  try {
    const candidate = new URL(url);
    const expected = new URL(origin);
    return candidate.origin === expected.origin
      && candidate.protocol === 'http:'
      && candidate.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function attachWindowGuards(window, state) {
  const targetOrigin = state.origin;
  const openExternalIfAllowed = (url) => {
    if (isAllowedExternalUrl(url) && !isExactBackendUrl(url, targetOrigin)) void shell.openExternal(url);
  };
  const guardNavigation = (event, url) => {
    if (url === 'about:blank' || isExactBackendUrl(url, targetOrigin)) return;
    event.preventDefault();
    openExternalIfAllowed(url);
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', guardNavigation);
  // Redirects do not reliably emit will-navigate.  Guard them separately so
  // a compromised page cannot navigate the embedded window away from the
  // exact loopback origin established by the readiness record.
  window.webContents.on('will-redirect', guardNavigation);
}

function sendProjectToRenderer(projectPath) {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererMessageQueue) {
    queuedProjectPath = projectPath;
    return;
  }
  rendererMessageQueue.enqueue(projectPath);
}

function createWindow(state, { show = true } = {}) {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 600,
    title: 'MOSE — Moy\'s Open Subtitle Editor',
    backgroundColor: '#16181d',
    show,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  rendererMessageQueue = createProjectMessageQueue((projectPath) => {
    if (!window.isDestroyed()) window.webContents.send('mose-open-project', projectPath);
  });
  // A second instance can arrive before the first BrowserWindow exists.  Move
  // that path into the same queue used by later arrivals so it cannot be
  // delivered after a newer path that arrives while the page is loading.
  if (queuedProjectPath) {
    const pending = queuedProjectPath;
    queuedProjectPath = null;
    rendererMessageQueue.enqueue(pending);
  }
  rendererMessageQueue.markNotReady();
  configureSession(window.webContents.session, state);
  attachWindowGuards(window, state);
  window.webContents.on('did-start-loading', () => {
    rendererMessageQueue?.markNotReady();
  });
  window.webContents.on('did-finish-load', () => {
    rendererMessageQueue?.markReady();
  });
  window.on('closed', () => {
    const pending = rendererMessageQueue?.pendingPath?.();
    if (pending) queuedProjectPath = pending;
    if (mainWindow === window) mainWindow = null;
    rendererMessageQueue?.markNotReady();
    rendererMessageQueue = null;
  });
  void window.loadURL(`${state.origin}/?mose-desktop=1`).catch((error) => {
    if (smokeMode) {
      process.exitCode = 1;
      if (!quitRequested) app.quit();
    } else if (!window.isDestroyed()) {
      window.webContents.send('mose-load-error', String(error));
    }
  });
  return window;
}

async function stopBackend() {
  const owned = backend;
  backend = null;
  const starting = startingBackendChild;
  if (!owned && starting) {
    if (startingBackendChild === starting) startingBackendChild = null;
    if (!childExited(starting)) await terminateBackendTree(starting);
    return;
  }
  if (!owned || !owned.child || childExited(owned.child)) return;
  const shutdownController = new AbortController();
  const shutdownTimer = setTimeout(
    () => shutdownController.abort(),
    BACKEND_SHUTDOWN_REQUEST_TIMEOUT_MS,
  );
  try {
    await fetch(`${owned.origin}/api/shutdown`, {
      method: 'POST',
      headers: { ...backendHeaders(owned.token), 'Content-Length': '0' },
      signal: shutdownController.signal,
    });
  } catch {
    // The child may already be gone; the exact PID is still checked below.
  } finally {
    clearTimeout(shutdownTimer);
  }
  await new Promise((resolve) => {
    if (childExited(owned.child)) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, BACKEND_STOP_TIMEOUT_MS);
    owned.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (!childExited(owned.child)) {
    await terminateBackendTree(owned.child);
  }
}

function terminateBackendTree(child) {
  // backend_runtime uses taskkill /T only with this exact spawned child PID.
  return terminateBackendProcessTree(child);
}

async function chooseProject() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'MAW 工程', extensions: ['mosp', 'json'] }],
  });
  return result.canceled ? '' : result.filePaths[0] || '';
}

function monitorBackendExit(child) {
  const handleExit = (code, signal) => {
    if (quitRequested || !backend || backend.child !== child) return;
    backend = null;
    const detail = `MOSE 后端意外退出（code=${code}, signal=${signal}）。`;
    console.error(`[MOSE] ${detail}`);
    if (!mainWindow || mainWindow.isDestroyed()) {
      app.quit();
      return;
    }
    void dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'MOSE 后端已停止',
      message: '编辑器后端意外停止。',
      detail,
    }).finally(() => {
      if (!quitRequested) app.quit();
    });
  };
  child.once('exit', handleExit);
  if (childExited(child)) handleExit(child.exitCode, child.signalCode);
}

async function smokeBackendPage(state) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_START_TIMEOUT_MS);
  try {
    const response = await fetch(`${state.origin}/?mose-desktop=1`, {
      headers: backendHeaders(state.token),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`页面请求返回 HTTP ${response.status}。`);
    }
    const body = await response.text();
    // A 200 response from an unrelated local service is not sufficient for
    // the packaged smoke.  Check the rendered MAWE document marker as well.
    if (!body.includes('<html') || !body.includes('MAWE')) {
      throw new Error('后端返回的页面不是 MAWE 编辑器页面。');
    }
  } finally {
    clearTimeout(timer);
  }
}

function registerIpc() {
  ipcMain.handle('mose:choose-project', chooseProject);
  ipcMain.handle('mose:state', () => ({
    ok: true,
    origin: backend?.origin || '',
    desktop: true,
  }));
}

async function bootstrap(projectPath) {
  try {
    backend = await startBackend(projectPath);
    monitorBackendExit(backend.child);
    if (smokeMode) {
      // Do not create a BrowserWindow here.  The smoke is intentionally usable
      // on a Windows runner without an interactive desktop or GPU: the
      // authenticated loopback page request verifies the exact route that
      // Electron loads in normal mode, then the same shutdown path is tested.
      await smokeBackendPage(backend);
      await stopBackend();
      app.exit(0);
      return;
    }
    const window = createWindow(backend, { show: !smokeMode });
  } catch (error) {
    await stopBackend();
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[MOSE] 启动失败：${detail}`);
    if (smokeMode) {
      // Never show a modal dialog from a hidden CI smoke.  Apart from hanging
      // the process, a dialog would make a backend failure look like a GPU
      // or Electron crash to the caller.
      app.exit(1);
      return;
    }
    await dialog.showMessageBox({
      type: 'error',
      title: 'MOSE 启动失败',
      message: '独立编辑器无法启动。',
      detail,
    });
    app.exit(1);
  }
}

const initialProjectPath = parseProjectArgs(process.argv.slice(1), process.cwd());
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    const projectPath = parseProjectArgs(argv, cwd);
    if (projectPath) sendProjectToRenderer(projectPath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    registerIpc();
    await bootstrap(initialProjectPath);
  });
  app.on('before-quit', (event) => {
    if (quitRequested) return;
    quitRequested = true;
    event.preventDefault();
    void stopBackend().finally(() => app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
