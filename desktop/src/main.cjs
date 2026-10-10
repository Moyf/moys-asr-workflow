'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeSelectedProject } = require('./native_files.cjs');
const { installLinuxIntegration } = require('./linux_integration.cjs');
const { createPreferenceStore } = require('./preferences.cjs');
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
const BACKEND_STOP_TIMEOUT_MS = 5_000;
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const smokeMode = process.argv.includes('--mose-smoke');
if (process.platform === 'win32') app.setAppUserModelId('com.moy.mose');

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
let shutdownComplete = false;
let currentProjectPath = '';

function repositoryRoot() {
  return path.resolve(__dirname, '..', '..');
}

function windowIconPath() {
  const name = process.platform === 'win32' ? 'maw.ico' : 'maw.png';
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', name)
    : path.join(repositoryRoot(), 'assets', process.platform === 'win32' ? 'maw.ico' : 'maw-icon-rounded.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function packagedMawPath() {
  return resolvePackagedMawPath(process.execPath, { resourcesPath: process.resourcesPath });
}

function resolveBackend() {
  if (app.isPackaged) {
    const executable = packagedMawPath();
    if (!fs.existsSync(executable)) {
      throw new Error(`未找到桌面后端，请重新安装完整套件：${executable}`);
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
      detached: process.platform !== 'win32',
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

function assertTrustedIpc(event) {
  if (!backend || !mainWindow || event.sender !== mainWindow.webContents
      || event.senderFrame !== event.sender.mainFrame
      || !isExactBackendUrl(event.senderFrame.url, backend.origin)) {
    throw new Error('桌面操作只能由当前编辑器主页面发起。');
  }
}

function trustedIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpc(event);
    return handler(...args);
  });
}

async function requestBackend(route, payload) {
  if (!backend) throw new Error('编辑器后端未连接。');
  const response = await fetch(`${backend.origin}${route}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { ...backendHeaders(backend.token), 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function syncProjectInfo() {
  if (!backend || !mainWindow || mainWindow.isDestroyed()) return;
  const info = await requestBackend('/api/desktop/state');
  currentProjectPath = info.projectPath || '';
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle(`${currentProjectPath ? path.basename(currentProjectPath) : '未命名工程'} — MOSE`);
  if (process.platform === 'darwin') mainWindow.setRepresentedFilename(currentProjectPath);
  if (currentProjectPath) app.addRecentDocument(currentProjectPath);
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
    icon: windowIconPath(),
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
    void syncProjectInfo().catch(() => {});
  });
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning', title: 'MOSE',
      message: '当前工程有未保存的改动。',
      detail: '离开会丢失未保存内容。选择取消可返回编辑器保存工程。',
      buttons: ['丢弃改动并继续', '取消'], defaultId: 1, cancelId: 1,
    });
    if (choice === 0) event.preventDefault();
    else quitRequested = false;
  });
  window.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
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
  // Stop the whole owned tree while its root still exists. Asking only the
  // HTTP server to exit can orphan FFmpeg running in a daemon cache thread.
  await terminateBackendTree(owned.child);
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
    await terminateBackendTree(owned.child, 'SIGKILL');
  }
}

function terminateBackendTree(child, signal = 'SIGTERM') {
  // backend_runtime uses taskkill /T only with this exact spawned child PID.
  return terminateBackendProcessTree(child, { processGroup: process.platform !== 'win32', signal });
}

async function chooseProject() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'MAW 工程', extensions: ['mosp', 'json'] }],
  });
  return result.canceled ? '' : result.filePaths[0] || '';
}

async function saveProjectAs(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('工程内容格式不正确。');
  const suggestedName = path.basename(String(payload.suggestedName || 'untitled.mosp'));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: payload.newProject ? '新建工程' : '另存为工程',
    defaultPath: path.join(currentProjectPath ? path.dirname(currentProjectPath) : app.getPath('documents'), suggestedName),
    filters: [{ name: 'MOSE 工程', extensions: ['mosp', 'json'] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const prepared = await requestBackend('/api/desktop/project/prepare', {
    project: payload.project, newProject: payload.newProject === true,
  });
  const saved = writeSelectedProject(result.filePath, prepared.project);
  try {
    await requestBackend('/api/desktop/project/open', { path: saved.path });
    await syncProjectInfo();
    const state = await requestBackend('/api/desktop/state');
    return { ...saved, ...state, project: prepared.project, bound: true };
  } catch (error) {
    // The disk save succeeded. Report the bind failure explicitly so the page
    // keeps edits and cannot keep saving to its previous bound project.
    return { ...saved, project: prepared.project, bound: false, error: String(error.message || error) };
  }
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
  const preferences = createPreferenceStore(path.join(app.getPath('userData'), 'editor-preferences.json'));
  // Settings must be available while the classic editor script initializes.
  // This small bounded store preserves the synchronous Storage contract.
  ipcMain.on('mose:storage', (event, request) => {
    try {
      assertTrustedIpc(event);
      if (!request || !['get', 'set'].includes(request.operation)) throw new Error('无效的偏好操作。');
      const value = request.operation === 'get'
        ? preferences.getItem(request.key) : preferences.setItem(request.key, request.value);
      event.returnValue = { ok: true, value };
    } catch (error) {
      event.returnValue = { ok: false, error: String(error.message || error) };
    }
  });
  trustedIpc('mose:choose-project', chooseProject);
  trustedIpc('mose:save-project-as', saveProjectAs);
  trustedIpc('mose:choose-media', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择关联媒体', properties: ['openFile'],
      filters: [{ name: '音视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'flv', 'webm', 'm4v', 'ts', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff'] }],
    });
    return result.canceled ? '' : result.filePaths[0] || '';
  });
  trustedIpc('mose:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return result.canceled ? '' : result.filePaths[0] || '';
  });
  trustedIpc('mose:load-media', (payload) => requestBackend('/api/desktop/media/load', payload));
  trustedIpc('mose:commit-media', (ticket) => requestBackend('/api/desktop/media/commit', { ticket }));
  trustedIpc('mose:reveal-project', () => {
    if (currentProjectPath) shell.showItemInFolder(currentProjectPath);
  });
  trustedIpc('mose:state', () => ({
    ok: true,
    origin: backend?.origin || '',
    desktop: true,
  }));
}

function configureApplicationMenu() {
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(null);
    return;
  }
  const command = (id) => () => mainWindow?.webContents.send('mose-command', id);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New project', accelerator: 'CommandOrControl+N', click: command('new-project') },
      { label: 'Open project…', accelerator: 'CommandOrControl+O', click: command('open-project') },
      { label: 'Save', accelerator: 'CommandOrControl+S', click: command('save-project') },
      { label: 'Save as…', accelerator: 'CommandOrControl+Shift+S', click: command('save-project-as') },
      ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] }] : []),
      { type: 'separator' }, { role: 'close' },
      ...(process.platform === 'linux' ? [{ role: 'quit' }] : []),
    ] },
    { role: 'editMenu' }, { role: 'windowMenu' },
    ...(process.platform === 'linux' && app.isPackaged ? [{ label: 'Tools', submenu: [{
      label: '添加工程打开方式…', click: async () => {
        try {
          const result = await installLinuxIntegration({
            applicationPath: process.env.APPIMAGE || process.execPath,
            assetsPath: path.join(process.resourcesPath, 'assets'),
            dataHome: process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local/share'),
          });
          await dialog.showMessageBox(mainWindow, { type: 'info', message: '已添加 MOSE 工程打开方式。',
            detail: `可在文件管理器的“打开方式”中选择 MOSE。${result.warnings.length ? '\n部分图标或类型缓存工具不可用，重新登录后再检查。' : ''}` });
        } catch (error) { dialog.showErrorBox('无法添加打开方式', String(error.message || error)); }
      },
    }] }] : []),
  ]));
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

function focusEditor(projectPath) {
  if (projectPath) sendProjectToRenderer(projectPath);
  if (!mainWindow && backend && !quitRequested) createWindow(backend);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('open-file', (event, projectPath) => {
    event.preventDefault();
    const candidate = parseProjectArgs([projectPath]);
    focusEditor(candidate);
  });
  app.on('second-instance', (_event, argv, cwd) => {
    const projectPath = parseProjectArgs(argv, cwd);
    focusEditor(projectPath);
  });
  app.whenReady().then(async () => {
    // Windows uses the editor toolbar; macOS/Linux also expose native file,
    // text editing and window actions with their platform accelerators.
    configureApplicationMenu();
    registerIpc();
    await bootstrap(initialProjectPath);
  });
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (quitRequested) return;
    quitRequested = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
      return;
    }
    void stopBackend().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => {
    if (quitRequested || process.platform !== 'darwin') {
      void stopBackend().finally(() => {
        shutdownComplete = true;
        app.quit();
      });
    }
  });
  app.on('activate', () => {
    if (!mainWindow && backend && !quitRequested) createWindow(backend);
  });
}
