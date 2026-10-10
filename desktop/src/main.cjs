'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  webUtils,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFileRegistry } = require('./file_registry.cjs');
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
  showAndFocusWindow,
} = require('./runtime_helpers.cjs');

const BACKEND_START_TIMEOUT_MS = 30_000;
const BACKEND_SHUTDOWN_REQUEST_TIMEOUT_MS = 1_500;
const BACKEND_STOP_TIMEOUT_MS = 5_000;
const CLOSE_HANDSHAKE_TIMEOUT_MS = 15_000;
const DESKTOP_STATUS_INTERVAL_MS = 2_000;
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
let allowWindowCloseOnce = false;
let pendingCloseRequest = null;
let closeRequestSequence = 0;
let desktopStatusTimer = null;
let lastSuccessfulExportDirectory = null;
const pendingExportDownloads = new Map();
const exportedPathReferences = new Map();
let fileRegistry = createFileRegistry({ fs, pathModule: path });

const PROJECT_FILTERS = [{ name: 'MAW 工程', extensions: ['mosp', 'json'] }];
const MEDIA_FILTERS = [{
  name: '音频与视频',
  extensions: ['aac', 'aif', 'aiff', 'alac', 'avi', 'flac', 'flv', 'm4a', 'm4v',
    'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'ogg', 'opus', 'wav', 'webm', 'wma', 'wmv'],
}];

function repositoryRoot() {
  return path.resolve(__dirname, '..', '..');
}

function windowIconPath() {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'maw.ico')
    : path.join(repositoryRoot(), 'assets', 'maw.ico');
  return fs.existsSync(candidate) ? candidate : undefined;
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
  const commandKey = crypto.randomBytes(32).toString('base64url');
  const command = buildBackendCommand(projectPath, token);
  const outputState = { output: '' };
  let child;
  try {
    const childEnv = {
      ...process.env,
      MAW_DESKTOP_TOKEN: token,
      MAW_DESKTOP_COMMAND_KEY: commandKey,
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
      commandKey,
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

function sendExportResult(task, result) {
  if (!task || task.finished) return;
  task.finished = true;
  if (task.timeout) clearTimeout(task.timeout);
  pendingExportDownloads.delete(task.url);
  if (!task.owner || task.owner.isDestroyed() || task.owner.webContents.isDestroyed()) return;
  task.owner.webContents.send('mose-export-result', { taskId: task.id, ...result });
}

function registerExportDownload(_event, payload) {
  if (!backend || typeof payload?.url !== 'string' || typeof payload?.filename !== 'string') {
    throw new TypeError('导出任务参数无效');
  }
  if (!payload.url.startsWith(`blob:${backend.origin}/`)) {
    throw new TypeError('导出内容不是当前编辑器创建的临时文件');
  }
  const filename = payload.filename.trim();
  if (!filename || /[\\/\0]/.test(filename) || filename === '.' || filename === '..') {
    throw new TypeError('导出文件名无效');
  }
  if (pendingExportDownloads.has(payload.url)) throw new TypeError('导出任务重复');
  const task = {
    id: crypto.randomUUID(),
    url: payload.url,
    filename,
    language: payload.language === 'en' ? 'en' : 'zh',
    owner: mainWindow,
    finished: false,
    timeout: null,
  };
  task.timeout = setTimeout(() => sendExportResult(task, {
    status: 'error', error: { code: 'DOWNLOAD_NOT_STARTED', message: '未能启动导出下载，请重试' },
  }), 30_000);
  pendingExportDownloads.set(task.url, task);
  return { status: 'ok', data: { taskId: task.id } };
}

function downloadFilter(filename) {
  const extension = path.extname(filename).replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9]{1,12}$/.test(extension)) return undefined;
  return [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }];
}

async function handleDownload(item, owner, registeredTask) {
  const task = registeredTask || null;
  const filename = task?.filename || item.getFilename();
  if (task?.timeout) clearTimeout(task.timeout);
  item.pause();
  item.once('done', (_event, state) => {
    if (!task) return;
    if (state !== 'completed') {
      sendExportResult(task, {
        status: 'error',
        error: { code: 'DOWNLOAD_FAILED', message: `导出未能完成（${state}）` },
      });
      return;
    }
    const filePath = item.getSavePath();
    try {
      if (!filePath || !fs.statSync(filePath).isFile()) throw new Error('导出文件未落盘');
    } catch (error) {
      sendExportResult(task, {
        status: 'error',
        error: { code: 'DOWNLOAD_NOT_WRITTEN', message: error.message || '导出文件未能写入磁盘' },
      });
      return;
    }
    lastSuccessfulExportDirectory = path.dirname(filePath);
    const exportRefId = crypto.randomUUID();
    exportedPathReferences.set(exportRefId, filePath);
    while (exportedPathReferences.size > 64) {
      exportedPathReferences.delete(exportedPathReferences.keys().next().value);
    }
    sendExportResult(task, { status: 'ok', exportRefId, filename: path.basename(filePath) });
  });
  try {
    const defaultPath = path.join(lastSuccessfulExportDirectory || app.getPath('downloads'), filename);
    const english = task?.language === 'en';
    const result = await dialog.showSaveDialog(owner, {
      title: english ? 'Save export file' : '保存导出文件',
      defaultPath,
      filters: downloadFilter(filename),
    });
    if (result.canceled || !result.filePath) {
      item.cancel();
      if (task) sendExportResult(task, { status: 'cancelled' });
      return;
    }
    item.setSavePath(result.filePath);
    item.resume();
  } catch (error) {
    item.cancel();
    if (task) sendExportResult(task, {
      status: 'error', error: { code: 'SAVE_DIALOG_FAILED', message: error.message || '无法打开导出保存窗口' },
    });
  }
}

function configureSession(targetSession, state) {
  const filter = { urls: [`${state.origin}/*`] };
  targetSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    details.requestHeaders = { ...details.requestHeaders, ...backendHeaders(state.token) };
    callback({ requestHeaders: details.requestHeaders });
  });
  targetSession.on('will-download', (event, item, webContents) => {
    const owner = BrowserWindow.fromWebContents(webContents) || mainWindow;
    const task = pendingExportDownloads.get(item.getURL()) || null;
    if (task && task.owner !== owner) {
      item.cancel();
      sendExportResult(task, {
        status: 'error', error: { code: 'DOWNLOAD_OWNER_MISMATCH', message: '导出任务来源窗口无效' },
      });
      return;
    }
    void handleDownload(item, owner, task);
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

function standardError(error, code = 'DESKTOP_OPERATION_FAILED') {
  return {
    status: 'error',
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function isEnglishUi(language) {
  return language === 'en' || (!language && app.getLocale().toLowerCase().startsWith('en'));
}

function registerProjectPath(projectPath) {
  return fileRegistry.register(projectPath, 'project');
}

function isTrustedRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  if (event.senderFrame !== event.sender.mainFrame) return false;
  return Boolean(backend && isExactBackendUrl(event.senderFrame.url, backend.origin));
}

function trustedIpcHandler(handler) {
  return async (event, ...args) => {
    if (!isTrustedRenderer(event)) return standardError(new Error('桌面请求来源无效'), 'UNTRUSTED_SENDER');
    try {
      return await handler(event, ...args);
    } catch (error) {
      return standardError(error);
    }
  };
}

async function chooseFile(event, kind, language) {
  if (!['project', 'media'].includes(kind)) throw new TypeError('文件类型不受支持');
  const english = isEnglishUi(language);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: english ? (kind === 'project' ? 'Open project' : 'Choose media') : undefined,
    filters: kind === 'project'
      ? (english ? [{ name: 'MAW project', extensions: ['mosp', 'json'] }] : PROJECT_FILTERS)
      : (english ? [{ name: 'Audio and video', extensions: MEDIA_FILTERS[0].extensions }] : MEDIA_FILTERS),
  });
  if (result.canceled || !result.filePaths[0]) return { status: 'cancelled' };
  const file = kind === 'project'
    ? registerProjectPath(result.filePaths[0])
    : fileRegistry.register(result.filePaths[0], 'media');
  return { status: 'ok', file };
}

async function chooseDirectory(_event, language) {
  const english = isEnglishUi(language);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: english ? 'Choose sticker folder' : '选择表情包文件夹',
  });
  if (result.canceled || !result.filePaths[0]) return { status: 'cancelled' };
  return { status: 'ok', path: result.filePaths[0] };
}

async function callDesktopServer(command, payload = {}) {
  if (!backend || !backend.child || childExited(backend.child)) {
    return standardError(new Error('MOSE 本地服务未连接'), 'BACKEND_UNAVAILABLE');
  }
  const response = await fetch(`${backend.origin}/api/desktop/command`, {
    method: 'POST',
    headers: {
      ...backendHeaders(backend.token),
      'X-MAW-Desktop-Command-Key': backend.commandKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ command, ...payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    return standardError(new Error(result.error || `服务器返回 ${response.status}`), result.code || 'SERVER_REJECTED');
  }
  return { status: 'ok', data: result };
}

async function callDesktopStatus() {
  if (!backend || !backend.child || childExited(backend.child)) {
    return standardError(new Error('MOSE 本地服务未连接'), 'BACKEND_UNAVAILABLE');
  }
  const response = await fetch(`${backend.origin}/api/desktop/project/status`, {
    headers: {
      ...backendHeaders(backend.token),
      'X-MAW-Desktop-Command-Key': backend.commandKey,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    return standardError(new Error(result.error || `服务器返回 ${response.status}`), result.code || 'SERVER_REJECTED');
  }
  return { status: 'ok', data: result };
}

async function desktopCommand(event, command, payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('桌面命令参数无效');
  }
  if (command === 'openProject') {
    const project = fileRegistry.get(payload.projectRefId, 'project');
    if (!project) throw new TypeError('工程文件引用已失效，请重新选择');
    let mediaPath = null;
    if (payload.mediaRefId) {
      const media = fileRegistry.get(payload.mediaRefId, 'media');
      if (!media) throw new TypeError('媒体文件引用已失效，请重新选择');
      mediaPath = media.path;
    }
    return callDesktopServer(command, { projectPath: project.path, mediaPath });
  }
  if (command === 'openRecentProject') {
    if (typeof payload.path !== 'string' || !payload.path.trim()) throw new TypeError('最近工程路径无效');
    return callDesktopServer(command, { projectPath: payload.path });
  }
  if (command === 'saveProject') {
    const mode = payload.mode;
    if (!['new', 'current', 'saveAs'].includes(mode)) throw new TypeError('保存模式无效');
    let targetPath;
    if (mode !== 'current') {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: isEnglishUi(payload.language)
          ? (mode === 'new' ? 'New project' : 'Save project as')
          : (mode === 'new' ? '新建工程' : '工程另存为'),
        defaultPath: payload.suggestedName || '未命名工程.mosp',
        filters: isEnglishUi(payload.language)
          ? [{ name: 'MAW project', extensions: ['mosp', 'json'] }]
          : PROJECT_FILTERS,
      });
      if (result.canceled || !result.filePath) return { status: 'cancelled' };
      targetPath = result.filePath;
      if (!path.extname(targetPath)) targetPath += '.mosp';
      if (!['.mosp', '.json'].includes(path.extname(targetPath).toLowerCase())) {
        throw new TypeError('工程文件必须使用 .mosp 或 .json 扩展名');
      }
    }
    return callDesktopServer(command, {
      mode,
      targetPath,
      project: payload.project,
      expectedGeneration: payload.expectedGeneration,
      expectedRevision: payload.expectedRevision,
      backupLimit: payload.backupLimit,
      backupOnly: payload.backupOnly === true,
    });
  }
  if (command === 'status') {
    return payload.force === true
      ? callDesktopServer('getStatus', { forceRevision: true })
      : callDesktopStatus();
  }
  if (command === 'prepareExportDownload') return registerExportDownload(event, payload);
  if (command === 'getLocation') {
    const target = payload.target;
    if (!['project', 'media', 'stickers', 'backups'].includes(target)) {
      throw new TypeError('文件定位目标无效');
    }
    const result = await callDesktopServer('getLocation', { target });
    if (result.status !== 'ok') return result;
    const targetPath = result.data.path;
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
      return standardError(new Error('服务端没有返回有效文件位置'), 'INVALID_LOCATION');
    }
    if (payload.open === false) return { status: 'ok', data: { path: targetPath } };
    if (target === 'project' || target === 'media') {
      if (fs.existsSync(targetPath)) shell.showItemInFolder(targetPath);
      else {
        const error = await shell.openPath(path.dirname(targetPath));
        if (error) return standardError(new Error(error), 'OPEN_LOCATION_FAILED');
      }
      return { status: 'ok', data: { path: targetPath } };
    }
    const error = await shell.openPath(targetPath);
    return error
      ? standardError(new Error(error), 'OPEN_LOCATION_FAILED')
      : { status: 'ok', data: { path: targetPath } };
  }
  if (command === 'openExportLocation') {
    const targetPath = exportedPathReferences.get(payload.exportRefId);
    if (!targetPath || !fs.existsSync(targetPath)) {
      throw new TypeError('导出文件引用已失效或文件已移动');
    }
    if (payload.open === false) return { status: 'ok', data: { path: targetPath } };
    shell.showItemInFolder(targetPath);
    return { status: 'ok', data: { path: targetPath } };
  }
  if (command === 'reloadProject') return callDesktopServer('reloadProject');
  if (command === 'attachMedia') {
    const media = fileRegistry.get(payload.mediaRefId, 'media');
    if (!media) throw new TypeError('媒体文件引用已失效，请重新选择');
    return callDesktopServer(command, { mediaPath: media.path, expectedGeneration: payload.expectedGeneration });
  }
  if (command === 'setStickerRoot') {
    if (typeof payload.path !== 'string') throw new TypeError('表情包目录路径无效');
    return callDesktopServer(command, { path: payload.path });
  }
  throw new TypeError('桌面命令不受支持');
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
    if (window.isDestroyed()) return;
    try {
      window.webContents.send('mose-open-project', registerProjectPath(projectPath));
    } catch (error) {
      void dialog.showMessageBox(window, { type: 'error', title: '无法打开工程', message: error.message });
    }
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
    startDesktopStatusMonitor(window);
  });
  window.once('ready-to-show', () => {
    showAndFocusWindow(window);
  });
  window.on('close', (event) => {
    if (allowWindowCloseOnce) {
      allowWindowCloseOnce = false;
      return;
    }
    event.preventDefault();
    requestRendererClose(window, 'window');
  });
  window.on('closed', () => {
    if (desktopStatusTimer) clearInterval(desktopStatusTimer);
    desktopStatusTimer = null;
    const pending = rendererMessageQueue?.pendingPath?.();
    if (pending) queuedProjectPath = pending;
    if (mainWindow === window) mainWindow = null;
    rendererMessageQueue?.markNotReady();
    rendererMessageQueue = null;
    fileRegistry.clear();
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

function startDesktopStatusMonitor(window) {
  if (desktopStatusTimer) clearInterval(desktopStatusTimer);
  desktopStatusTimer = setInterval(async () => {
    if (!mainWindow || mainWindow !== window || window.isDestroyed()) return;
    const result = await callDesktopStatus();
    if (result.status !== 'ok' || window.webContents.isDestroyed()) return;
    window.webContents.send('mose-project-status', result.data);
  }, DESKTOP_STATUS_INTERVAL_MS);
}

function clearCloseRequest(pending = pendingCloseRequest) {
  if (!pending || pendingCloseRequest !== pending) return;
  if (pending.timeout) clearTimeout(pending.timeout);
  pendingCloseRequest = null;
  if (pending.source === 'app') quitRequested = false;
}

function scheduleCloseHandshakeTimeout(pending) {
  if (pending.timeout) clearTimeout(pending.timeout);
  pending.timeout = setTimeout(async () => {
    if (pendingCloseRequest !== pending || pending.window.isDestroyed()) return;
    const english = isEnglishUi(pending.language);
    const choice = await dialog.showMessageBox(pending.window, {
      type: 'warning',
      title: english ? 'Waiting for the editor' : '仍在等待编辑器',
      message: english ? 'The editor has not finished its close check.' : '编辑器尚未完成关闭确认。',
      detail: english ? 'You can keep waiting. Cancelling keeps the window and local service open.' : '可以继续等待；取消会让窗口和本地服务保持打开。',
      buttons: english ? ['Keep waiting', 'Cancel close'] : ['继续等待', '取消关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (pendingCloseRequest !== pending) return;
    if (choice.response === 0) scheduleCloseHandshakeTimeout(pending);
    else clearCloseRequest(pending);
  }, CLOSE_HANDSHAKE_TIMEOUT_MS);
}

function requestRendererClose(window, source) {
  if (!window || window.isDestroyed()) return false;
  if (pendingCloseRequest) {
    if (source === 'app') {
      pendingCloseRequest.source = 'app';
      quitRequested = true;
    }
    return true;
  }
  const pending = {
    id: ++closeRequestSequence,
    source,
    window,
    timeout: null,
  };
  pendingCloseRequest = pending;
  scheduleCloseHandshakeTimeout(pending);
  try {
    window.webContents.send('mose-close-request', { requestId: pending.id });
  } catch {
    clearCloseRequest(pending);
    return false;
  }
  return true;
}

async function chooseCloseAction(event, requestId, hasUnsavedChanges, language) {
  const pending = pendingCloseRequest;
  if (!pending || pending.id !== requestId || pending.window.webContents !== event.sender) {
    return { status: 'cancelled' };
  }
  pending.language = language;
  const english = isEnglishUi(language);
  if (pending.timeout) clearTimeout(pending.timeout);
  pending.timeout = null;
  if (!hasUnsavedChanges) {
    scheduleCloseHandshakeTimeout(pending);
    return { status: 'ok', action: 'discard' };
  }
  const choice = await dialog.showMessageBox(pending.window, {
    type: 'warning',
    title: english ? 'Save project?' : '保存工程？',
    message: english ? 'There are unsaved changes.' : '当前有未保存的改动。',
    detail: english ? 'The window closes only after a successful save. Cancelling or a failed save keeps it open.' : '保存成功后才会关闭；取消保存或保存失败都会保留当前窗口。',
    buttons: english ? ['Save and continue', 'Don’t save', 'Cancel close'] : ['保存并继续', '不保存', '取消关闭'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (pendingCloseRequest !== pending) return { status: 'cancelled' };
  if (choice.response === 2) {
    clearCloseRequest(pending);
    return { status: 'ok', action: 'cancel' };
  }
  scheduleCloseHandshakeTimeout(pending);
  return { status: 'ok', action: choice.response === 0 ? 'save' : 'discard' };
}

async function chooseProjectSwitchAction(_event, hasUnsavedChanges, language) {
  if (!hasUnsavedChanges) return { status: 'ok', action: 'discard' };
  const english = isEnglishUi(language);
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: english ? 'Unsaved changes' : '处理未保存的改动',
    message: english ? 'The current project has unsaved changes.' : '当前工程有未保存的改动。',
    detail: english ? 'The project switches only after a successful save. Cancelling or a failed save keeps the current project open.' : '保存成功后才会继续切换；取消保存或保存失败会留在当前工程。',
    buttons: english ? ['Save and continue', 'Don’t save', 'Cancel'] : ['保存并继续', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return { status: 'ok', action: choice.response === 0 ? 'save' : choice.response === 1 ? 'discard' : 'cancel' };
}

async function chooseExternalChangeAction(_event, hasUnsavedChanges, language) {
  const english = isEnglishUi(language);
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: english ? 'Project file changed outside MOSE' : '工程文件已在外部改变',
    message: english ? 'The disk version differs from the editor. Auto-save is paused.' : '磁盘上的工程与当前编辑内容不一致。自动保存已暂停。',
    detail: hasUnsavedChanges
      ? (english ? 'Reloading discards unsaved edits and asks for confirmation.' : '重新加载会丢弃页面中的未保存改动，并会再次确认。')
      : (english ? 'Save As writes the current editor contents to a new file.' : '选择“另存为”可将当前页面内容保存到新文件。'),
    buttons: english ? ['Reload', 'Save As', 'Keep current edits'] : ['重新加载', '另存为', '保留当前编辑'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  });
  return {
    status: 'ok',
    action: choice.response === 0 ? 'reload' : choice.response === 1 ? 'saveAs' : 'keep',
  };
}

async function confirmExternalReload(_event, hasUnsavedChanges, language) {
  if (!hasUnsavedChanges) return { status: 'ok', confirmed: true };
  const english = isEnglishUi(language);
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: english ? 'Reload the external project?' : '重新加载外部工程？',
    message: english ? 'Reloading discards edits that have not been saved from this page.' : '重新加载会丢弃当前页面中尚未保存的编辑。',
    detail: english ? 'The disk file will not be changed. To keep these edits, go back and choose Save As or Keep current edits.' : '磁盘上的文件不会被修改。若要保留当前编辑，请返回并选择“另存为”或“保留当前编辑”。',
    buttons: english ? ['Reload and discard edits', 'Cancel'] : ['重新加载并丢弃编辑', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return { status: 'ok', confirmed: choice.response === 0 };
}

function confirmRendererClose(requestId, accepted) {
  const pending = pendingCloseRequest;
  if (!pending || pending.id !== requestId) return { status: 'cancelled' };
  if (!accepted) {
    clearCloseRequest(pending);
    return { status: 'ok', closed: false };
  }
  if (pending.timeout) clearTimeout(pending.timeout);
  pendingCloseRequest = null;
  allowWindowCloseOnce = true;
  const window = pending.window;
  if (window && !window.isDestroyed()) window.close();
  if (pending.source === 'app') {
    quitRequested = true;
    void stopBackend().finally(() => app.exit(0));
  }
  return { status: 'ok', closed: true };
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
  ipcMain.handle('mose:choose-file', trustedIpcHandler((_event, kind, language) => chooseFile(_event, kind, language)));
  ipcMain.handle('mose:choose-directory', trustedIpcHandler(chooseDirectory));
  ipcMain.handle('mose:register-file', trustedIpcHandler((_event, filePath, kind) => {
    if (!['project', 'media', 'any'].includes(kind)) throw new TypeError('文件类型不受支持');
    return { status: 'ok', file: fileRegistry.register(filePath, kind) };
  }));
  ipcMain.handle('mose:desktop-command', trustedIpcHandler(desktopCommand));
  ipcMain.handle('mose:choose-close-action', trustedIpcHandler(chooseCloseAction));
  ipcMain.handle('mose:choose-switch-action', trustedIpcHandler(chooseProjectSwitchAction));
  ipcMain.handle('mose:choose-external-change-action', trustedIpcHandler(chooseExternalChangeAction));
  ipcMain.handle('mose:confirm-external-reload', trustedIpcHandler(confirmExternalReload));
  ipcMain.handle('mose:confirm-close', trustedIpcHandler((_event, requestId, accepted) => (
    confirmRendererClose(requestId, accepted === true)
  )));
  ipcMain.handle('mose:state', trustedIpcHandler(() => ({
    ok: true,
    origin: backend?.origin || '',
    desktop: true,
  })));
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
    showAndFocusWindow(mainWindow);
  });
  app.whenReady().then(async () => {
    // MAWE renders its own theme-aware toolbar inside the editor document.
    // Electron's default File/Edit/View/Window menu is redundant and follows
    // the OS chrome instead of the editor theme, so keep only the title bar.
    Menu.setApplicationMenu(null);
    registerIpc();
    await bootstrap(initialProjectPath);
  });
  app.on('before-quit', (event) => {
    if (quitRequested) return;
    quitRequested = true;
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (requestRendererClose(mainWindow, 'app')) return;
      quitRequested = false;
    }
    quitRequested = true;
    void stopBackend().finally(() => app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
