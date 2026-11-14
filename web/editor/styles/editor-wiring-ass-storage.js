import { getMaweDomPanels } from '../ui/editor-dom-panels.js';
import { assStyleLibraryUsesServerStorage, setAssStyleLibraryStatus, syncAssStyleManager } from './editor-wiring-ass-manager.js';

const storageService = {};

export function getAssStyleLibrary() { return storageService.getLibrary(); }
export function isAssStyleLibraryReady() { return storageService.isReady(); }
export function incrementAssStyleLibraryRevision() { storageService.incrementRevision(); }
export function setAssStyleLibrary(value, options) { return storageService.setLibrary(value, options); }
export function updateAssStyleLibrarySummary() { storageService.updateSummary(); }
export function scheduleAssStyleLibrarySave() { storageService.scheduleSave(); }
export function getAssBuiltinFontSuggestions() { return storageService.fontSuggestions(); }
export function loadAssStyleLibrary(options) { return storageService.load(options); }
export function persistAssStyleLibrary(options) { return storageService.persist(options); }
export function getAssStyleTransferState() { return storageService.transferState(); }
export function importAssStyleLibrary(library, revision) { return storageService.importLibrary(library, revision); }
export function reloadAssStyleLibrary() { return storageService.reload(); }
export function readAssStyleLibraryBackup() { return storageService.readBackup(); }
export function waitForAssStyleLibraryLoad() { return storageService.waitForLoad(); }

export function initAssStorageWiring() {















// CSS 预览的颜色样式（工程 color_style）；ASS 的颜色映射是独立字段
// ass_color_style（text / speaker / stroke / none），两者语义不同。


const DEFAULT_ASS_COLOR_STYLE = 'text';
// 字体输入框用 combobox 下拉提供筛选（映射逻辑在 editor-utils 的
// subtitleFontFamilyStoredToInput / subtitleFontFamilyInputToStored）；
// 扫描到的本机字体会由下拉列表动态合并，无需预设常量参与启动期渲染。
const ASS_BUILTIN_FONT_SUGGESTIONS = Object.freeze([
  'Arial', 'Microsoft YaHei', 'SimHei', 'SimSun', 'Segoe UI', 'Verdana', 'Times New Roman',
]);



























const ASS_STYLE_LIBRARY_STORAGE_KEY = 'moy.asr.ass.styles.v1';
let ASS_STYLE_LIBRARY = window.AsrEditorUtils.defaultAssStyleLibrary();
let ASS_STYLE_LIBRARY_READY = false;
let assStyleLibrarySaveTimer = 0;
let assStyleLibraryLoadPromise = null;
let assStyleLibraryDirty = false;
let assStyleLibraryRevision = 0;
let assStyleStorageRevision = null;
let assStyleLibraryConflict = false;
let assStyleSavePromise = null;
let assStyleImportInFlight = false;

function readLocalAssStyleLibrary() {
  try {
    return window.AsrEditorUtils.normalizeAssStyleLibrary(
      JSON.parse(localStorage.getItem(ASS_STYLE_LIBRARY_STORAGE_KEY) || 'null'),
    );
  } catch (_) {
    return window.AsrEditorUtils.defaultAssStyleLibrary();
  }
}

function writeLocalAssStyleLibrary(library) {
  localStorage.setItem(ASS_STYLE_LIBRARY_STORAGE_KEY,
    JSON.stringify(window.AsrEditorUtils.normalizeAssStyleLibrary(library)));
}

function setAssStyleLibrary(value, { persistLocal = false } = {}) {
  ASS_STYLE_LIBRARY = window.AsrEditorUtils.normalizeAssStyleLibrary(value);
  // The portable copy is written only under the compare-and-save operation.
  if (persistLocal && assStyleLibraryUsesServerStorage()) {
    try { writeLocalAssStyleLibrary(ASS_STYLE_LIBRARY); } catch (_) { /* optional cache */ }
  }
  return ASS_STYLE_LIBRARY;
}

function assStyleLibrarySummary() {
  return `${ASS_STYLE_LIBRARY.styles.length} 个样式 · ${ASS_STYLE_LIBRARY.assProfiles.length} 个 ASS 方案`;
}

function updateAssStyleLibrarySummary() {
  if (getMaweDomPanels().assStyleSummary) {
    const summary = assStyleLibrarySummary();
    getMaweDomPanels().assStyleSummary.textContent = window.MAWE_I18N?.translateText?.(summary) || summary;
  }
}

function scheduleAssStyleLibrarySave() {
  assStyleLibraryDirty = true;
  clearTimeout(assStyleLibrarySaveTimer);
  if (assStyleLibraryConflict) return;
  assStyleLibrarySaveTimer = setTimeout(() => {
    void persistAssStyleLibrary();
  }, 220);
}

function assStyleLibraryRequestBody(normalized, backup = false) {
  // 与其他本机写入接口一致：服务器会校验页面请求令牌，缺失时返回 403。
  return { ...normalized, _revision: assStyleStorageRevision, _backup: backup,
    requestToken: MaweBoot.SERVER_CONFIG?.requestToken || '' };
}

function assStyleLibraryPostOptions(body, { keepalive = false, backup = false } = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(assStyleLibraryRequestBody(body, backup)),
    ...(keepalive ? { keepalive: true } : {}),
  };
}

// Use the normal serialized save path so a successful background flush also
// updates the revision. A second write must not race an older in-flight save.
function flushAssStyleLibraryOnUnload() {
  clearTimeout(assStyleLibrarySaveTimer);
  assStyleLibrarySaveTimer = 0;
  if (!assStyleLibraryDirty || assStyleLibraryConflict) return;
  if (assStyleLibraryUsesServerStorage() && !assStyleStorageRevision) return;
  void persistAssStyleLibrary({ keepalive: true });
}
window.addEventListener('pagehide', flushAssStyleLibraryOnUnload);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushAssStyleLibraryOnUnload();
  } else if (assStyleLibraryDirty && !assStyleLibrarySaveTimer) {
    // 切后台时的 flush 可能保留了 dirty（存在在途旧修订写入）；回到前台后补一次常规保存。
    scheduleAssStyleLibrarySave();
  }
});

// 403 = 页面内嵌的请求令牌与当前服务器实例不一致（典型：服务器重启后页面
// 未刷新）。给用户可执行的动作，而不是裸状态码；整句进 i18n 翻译表。
function describeAssStyleSyncError(error) {
  const message = String(error?.message || '未知错误');
  return message === 'HTTP 403' ? 'HTTP 403（页面已失效，请刷新网页后重试）' : message;
}

async function commitAssStyleLibrary(normalized, { backup = false, keepalive = false } = {}) {
  if (assStyleLibraryConflict) throw new Error('样式库已被其他窗口修改，请先重新加载');
  if (assStyleLibraryUsesServerStorage()) {
    if (!assStyleStorageRevision) throw new Error('尚未读取本机样式库，请重新加载');
    const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.assStylesUrl, window.location.href),
      assStyleLibraryPostOptions(normalized, { backup, keepalive }));
    if (response.status === 409) {
      assStyleLibraryConflict = true;
      throw new Error('样式库已被其他窗口修改，请先导出当前副本，再重新加载');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    assStyleStorageRevision = payload._revision;
    return window.AsrEditorUtils.normalizeAssStyleLibrary(payload);
  }
  const write = () => {
    const current = localStorage.getItem(ASS_STYLE_LIBRARY_STORAGE_KEY);
    if (current !== assStyleStorageRevision) {
      assStyleLibraryConflict = true;
      throw new Error('样式库已被其他窗口修改，请先导出当前副本，再重新加载');
    }
    const backupKey = `${ASS_STYLE_LIBRARY_STORAGE_KEY}.backup`;
    const previousBackup = backup ? localStorage.getItem(backupKey) : null;
    if (backup) localStorage.setItem(backupKey, current ?? JSON.stringify(ASS_STYLE_LIBRARY));
    try {
      writeLocalAssStyleLibrary(normalized);
    } catch (error) {
      if (backup) {
        if (previousBackup === null) localStorage.removeItem(backupKey);
        else localStorage.setItem(backupKey, previousBackup);
      }
      throw error;
    }
    assStyleStorageRevision = localStorage.getItem(ASS_STYLE_LIBRARY_STORAGE_KEY);
    return normalized;
  };
  return navigator.locks?.request ? navigator.locks.request(ASS_STYLE_LIBRARY_STORAGE_KEY, write) : write();
}

async function persistAssStyleLibrary({ keepalive = false } = {}) {
  if (assStyleSavePromise) return assStyleSavePromise;
  clearTimeout(assStyleLibrarySaveTimer);
  assStyleLibrarySaveTimer = 0;
  const revision = assStyleLibraryRevision;
  const normalized = window.AsrEditorUtils.normalizeAssStyleLibrary(ASS_STYLE_LIBRARY);
  assStyleSavePromise = (async () => { try {
    const payload = await commitAssStyleLibrary(normalized, { keepalive });
    if (revision === assStyleLibraryRevision) {
      setAssStyleLibrary(payload, { persistLocal: true });
      assStyleLibraryDirty = false;
      ASS_STYLE_LIBRARY_READY = true;
      setAssStyleLibraryStatus('', 'success');
    } else {
      // A newer edit was made while this request was in flight.  Keep the
      // current local state and let its debounced save publish the newer
      // revision instead of rolling the form back to an older response.
      ASS_STYLE_LIBRARY_READY = false;
      setAssStyleLibraryStatus('本地有更新改动，等待再次同步', 'warning');
    }
    syncAssStyleManager?.();
    return ASS_STYLE_LIBRARY;
  } catch (error) {
    // 本地副本仍然可用；状态会在管理窗中明确显示为未同步。
    ASS_STYLE_LIBRARY_READY = false;
    setAssStyleLibraryStatus(`保存失败：${describeAssStyleSyncError(error)}`, 'warning');
    return null;
  } finally {
    assStyleSavePromise = null;
    if (assStyleLibraryDirty && revision !== assStyleLibraryRevision && !assStyleLibraryConflict) scheduleAssStyleLibrarySave();
  } })();
  return assStyleSavePromise;
}

async function loadAssStyleLibrary({ force = false, discard = false } = {}) {
  if (assStyleImportInFlight) return ASS_STYLE_LIBRARY;
  if (assStyleLibraryLoadPromise) return assStyleLibraryLoadPromise;
  if (force && assStyleLibraryDirty && !discard) {
    // The manager may be reopened while a debounced save is pending.  A
    // forced read must never replace those unsaved edits with the old file.
    syncAssStyleManager?.();
    MawePlaybackLoop.refreshSubtitlePreview?.();
    return ASS_STYLE_LIBRARY;
  }
  if (discard) {
    clearTimeout(assStyleLibrarySaveTimer);
    assStyleLibrarySaveTimer = 0;
  }
  const startedAtRevision = assStyleLibraryRevision;
  // The browser cache is a startup fallback only. Once the server has been
  // read, a failed refresh must not replace that trusted in-memory library.
  if (assStyleLibraryUsesServerStorage() && assStyleStorageRevision === null && !assStyleLibraryDirty && !discard) {
    setAssStyleLibrary(readLocalAssStyleLibrary());
  }
  setAssStyleLibraryStatus('正在加载…', 'pending');
  assStyleLibraryLoadPromise = (async () => {
    // 让出一轮微任务再继续：便携（无服务器）分支没有任何真正的 await，
    // 会同步执行到底；启动早期调用时脚本后部的预览声明（如
    // renderedStickerOverlayEnabled）仍在暂时性死区，同步刷新预览会抛
    // ReferenceError。先等待一轮，保证回调都在脚本求值完成后运行。
    await Promise.resolve();
    if (!assStyleLibraryUsesServerStorage()) {
      try {
        const raw = localStorage.getItem(ASS_STYLE_LIBRARY_STORAGE_KEY);
        const loaded = raw ? JSON.parse(raw) : window.AsrEditorUtils.defaultAssStyleLibrary();
        if (startedAtRevision === assStyleLibraryRevision && (!assStyleLibraryDirty || discard)) {
          assStyleStorageRevision = raw;
          setAssStyleLibrary(loaded);
          assStyleLibraryRevision += 1;
          assStyleLibraryDirty = false;
          assStyleLibraryConflict = false;
        }
      }
      catch (_) {
        assStyleLibraryConflict = true;
        ASS_STYLE_LIBRARY_READY = false;
        setAssStyleLibraryStatus('浏览器存储不可用或样式库损坏，样式尚未保存', 'warning');
        assStyleLibraryLoadPromise = null;
        return ASS_STYLE_LIBRARY;
      }
      ASS_STYLE_LIBRARY_READY = true;
      setAssStyleLibraryStatus('', 'success');
      syncAssStyleManager?.();
      MawePlaybackLoop.refreshSubtitlePreview?.();
      assStyleLibraryLoadPromise = null;
      return ASS_STYLE_LIBRARY;
    }
    try {
      const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.assStylesUrl, window.location.href), {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (startedAtRevision === assStyleLibraryRevision && (!assStyleLibraryDirty || discard)) {
        assStyleStorageRevision = payload._revision;
        assStyleLibraryConflict = false;
        setAssStyleLibrary(payload, { persistLocal: true });
        assStyleLibraryRevision += 1;
        assStyleLibraryDirty = false;
        ASS_STYLE_LIBRARY_READY = true;
        setAssStyleLibraryStatus('', 'success');
      } else {
        // A form edit happened while GET was in flight.  The local edit is
        // authoritative until its own POST succeeds.
        ASS_STYLE_LIBRARY_READY = false;
        setAssStyleLibraryStatus('本地有更新改动，等待再次同步', 'warning');
      }
    } catch (_) {
      // Keep the last trusted in-memory state and any pending edits.
      ASS_STYLE_LIBRARY_READY = false;
      setAssStyleLibraryStatus('重新加载失败，保留当前样式', 'warning');
    }
    syncAssStyleManager?.();
    MawePlaybackLoop.refreshSubtitlePreview?.();
    // Do not cache either a successful or failed request: each subsequent
    // manager open can observe changes made by another Editor or Launcher.
    assStyleLibraryLoadPromise = null;
    return ASS_STYLE_LIBRARY;
  })();
  return assStyleLibraryLoadPromise;
}

// G07：init 化模块经 window 延迟取用本文件的运行时入口；classic 调用方不受影响。
storageService.getLibrary = () => ASS_STYLE_LIBRARY;
storageService.isReady = () => ASS_STYLE_LIBRARY_READY;
storageService.incrementRevision = () => { assStyleLibraryRevision += 1; };
storageService.setLibrary = setAssStyleLibrary;
storageService.updateSummary = updateAssStyleLibrarySummary;
storageService.scheduleSave = scheduleAssStyleLibrarySave;
storageService.fontSuggestions = () => ASS_BUILTIN_FONT_SUGGESTIONS;
storageService.load = loadAssStyleLibrary;
storageService.persist = persistAssStyleLibrary;
storageService.transferState = () => ({ dirty: assStyleLibraryDirty, revision: assStyleLibraryRevision });
storageService.waitForLoad = () => assStyleLibraryLoadPromise || Promise.resolve();
storageService.importLibrary = async (library, expectedRevision) => {
  if (assStyleLibraryDirty || assStyleSavePromise || assStyleLibraryLoadPromise || assStyleImportInFlight || expectedRevision !== assStyleLibraryRevision) {
    throw new Error('样式库已改变，请重新导入并预览');
  }
  assStyleImportInFlight = true;
  try {
    const saved = await commitAssStyleLibrary(library, { backup: true });
    if (expectedRevision !== assStyleLibraryRevision) {
      // Do not discard edits made while the import request was in flight.
      scheduleAssStyleLibrarySave();
      throw new Error('导入期间样式库发生更改，请检查当前内容');
    }
    assStyleLibraryRevision += 1;
    setAssStyleLibrary(saved, { persistLocal: true });
    assStyleLibraryDirty = false;
    ASS_STYLE_LIBRARY_READY = true;
    setAssStyleLibraryStatus('样式库已导入；已保留导入前副本', 'success');
    syncAssStyleManager({ force: true });
    MawePlaybackLoop.refreshSubtitlePreview?.();
    return saved;
  } finally {
    assStyleImportInFlight = false;
  }
};
storageService.reload = async () => {
  if (assStyleSavePromise) await assStyleSavePromise;
  return loadAssStyleLibrary({ force: true, discard: true });
};
storageService.readBackup = async () => {
  if (assStyleLibraryUsesServerStorage()) {
    const response = await fetch(new URL(`${MaweBoot.SERVER_CONFIG.assStylesUrl}-backup`, window.location.href), { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }
  const raw = localStorage.getItem(`${ASS_STYLE_LIBRARY_STORAGE_KEY}.backup`);
  if (!raw) throw new Error('没有找到导入前的样式库副本');
  return JSON.parse(raw);
};
Object.defineProperty(window, 'ASS_STYLE_LIBRARY', {
  configurable: true,
  get: () => ASS_STYLE_LIBRARY,
  set: value => { ASS_STYLE_LIBRARY = value; },
});
Object.defineProperty(window, 'loadAssStyleLibrary', {
  configurable: true,
  writable: true,
  value: loadAssStyleLibrary,
});
window.MaweAssStorageWiring = window.MaweAssStorageWiring || Object.freeze({
  DEFAULT_ASS_COLOR_STYLE,
  updateAssStyleLibrarySummary,
  loadAssStyleLibrary,
  styles: () => ASS_STYLE_LIBRARY.styles || [],
});
}
