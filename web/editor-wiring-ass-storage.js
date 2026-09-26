// CSS 预览的颜色样式（工程 color_style）；ASS 的颜色映射是独立字段
// ass_color_style（text / speaker / stroke / none），两者语义不同。


const ASS_COLOR_STYLE_VALUES = Object.freeze(['text', 'speaker', 'stroke', 'none']);
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
let assStyleLibrarySaveInFlight = false;
let assStyleLibraryInFlightRevision = 0;

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
  try {
    localStorage.setItem(
      ASS_STYLE_LIBRARY_STORAGE_KEY,
      JSON.stringify(window.AsrEditorUtils.normalizeAssStyleLibrary(library)),
    );
  } catch (_) {
    // file:// 隐私模式可能拒绝 localStorage；当前页面仍可继续使用样式。
  }
}

function setAssStyleLibrary(value, { persistLocal = false } = {}) {
  ASS_STYLE_LIBRARY = window.AsrEditorUtils.normalizeAssStyleLibrary(value);
  if (persistLocal) writeLocalAssStyleLibrary(ASS_STYLE_LIBRARY);
  return ASS_STYLE_LIBRARY;
}

function assStyleLibrarySummary() {
  return `${ASS_STYLE_LIBRARY.styles.length} 个样式 · ${ASS_STYLE_LIBRARY.assProfiles.length} 个 ASS 方案`;
}

function updateAssStyleLibrarySummary() {
  if (assStyleSummary) {
    const summary = assStyleLibrarySummary();
    assStyleSummary.textContent = window.MAWE_I18N?.translateText?.(summary) || summary;
  }
}

function scheduleAssStyleLibrarySave() {
  assStyleLibraryDirty = true;
  clearTimeout(assStyleLibrarySaveTimer);
  assStyleLibrarySaveTimer = setTimeout(() => {
    void persistAssStyleLibrary();
  }, 220);
}

function assStyleLibraryRequestBody(normalized) {
  // 与其他本机写入接口一致：服务器会校验页面请求令牌，缺失时返回 403。
  return { ...normalized, requestToken: MaweBoot.SERVER_CONFIG?.requestToken || '' };
}

function assStyleLibraryPostOptions(body, { keepalive = false } = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(assStyleLibraryRequestBody(body)),
    ...(keepalive ? { keepalive: true } : {}),
  };
}

// 离开页面（刷新/关闭/跳转、切后台）时 debounce 定时器可能还没触发；
// dirty 的最后改动要用 keepalive 请求立刻发出，否则重新打开时会
// 被服务器上的旧样式覆盖。已有请求在途且携带同一修订时无需重复发送；
// 在途请求携带更旧修订时仍要 flush，但不清除 dirty，页面回来后再补一次
// 常规保存，避免两个在途写入在服务器端乱序覆盖。
function flushAssStyleLibraryOnUnload() {
  clearTimeout(assStyleLibrarySaveTimer);
  assStyleLibrarySaveTimer = 0;
  if (!assStyleLibraryDirty || !assStyleLibraryUsesServerStorage()) return;
  if (assStyleLibrarySaveInFlight && assStyleLibraryInFlightRevision === assStyleLibraryRevision) return;
  const normalized = window.AsrEditorUtils.normalizeAssStyleLibrary(ASS_STYLE_LIBRARY);
  try {
    void fetch(new URL(MaweBoot.SERVER_CONFIG.assStylesUrl, window.location.href),
      assStyleLibraryPostOptions(normalized, { keepalive: true }))
      .catch(() => { /* 页面正在卸载，失败时保留本地副本即可 */ });
    if (!assStyleLibrarySaveInFlight) assStyleLibraryDirty = false;
  } catch (_) {
    // URL 或请求构造失败时保留 dirty 标记；页面已在卸载流程中，无法再重试。
  }
}
window.addEventListener('pagehide', flushAssStyleLibraryOnUnload);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushAssStyleLibraryOnUnload();
  } else if (assStyleLibraryDirty && !assStyleLibrarySaveTimer && assStyleLibraryUsesServerStorage()) {
    // 切后台时的 flush 可能保留了 dirty（存在在途旧修订写入）；回到前台后补一次常规保存。
    scheduleAssStyleLibrarySave();
  }
});

async function persistAssStyleLibrary() {
  clearTimeout(assStyleLibrarySaveTimer);
  assStyleLibrarySaveTimer = 0;
  const revision = assStyleLibraryRevision;
  const normalized = setAssStyleLibrary(ASS_STYLE_LIBRARY, { persistLocal: true });
  if (!assStyleLibraryUsesServerStorage()) {
    if (revision === assStyleLibraryRevision) {
      assStyleLibraryDirty = false;
      ASS_STYLE_LIBRARY_READY = true;
    }
    setAssStyleLibraryStatus('', 'success');
    syncAssStyleManager?.();
    return normalized;
  }
  assStyleLibrarySaveInFlight = true;
  assStyleLibraryInFlightRevision = revision;
  try {
    const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.assStylesUrl, window.location.href),
      assStyleLibraryPostOptions(normalized));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
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
    setAssStyleLibraryStatus(`本地已保存，服务器同步失败：${error?.message || '未知错误'}`, 'warning');
    return normalized;
  } finally {
    assStyleLibrarySaveInFlight = false;
    assStyleLibraryInFlightRevision = 0;
  }
}

async function loadAssStyleLibrary({ force = false } = {}) {
  if (assStyleLibraryLoadPromise) return assStyleLibraryLoadPromise;
  if (force && assStyleLibraryDirty) {
    // The manager may be reopened while a debounced save is pending.  A
    // forced read must never replace those unsaved edits with the old file.
    syncAssStyleManager?.();
    MawePlaybackLoop.refreshSubtitlePreview?.();
    return ASS_STYLE_LIBRARY;
  }
  setAssStyleLibrary(readLocalAssStyleLibrary());
  setAssStyleLibraryStatus('正在加载…', 'pending');
  assStyleLibraryLoadPromise = (async () => {
    // 让出一轮微任务再继续：便携（无服务器）分支没有任何真正的 await，
    // 会同步执行到底；启动早期调用时脚本后部的预览声明（如
    // renderedStickerOverlayEnabled）仍在暂时性死区，同步刷新预览会抛
    // ReferenceError。先等待一轮，保证回调都在脚本求值完成后运行。
    await Promise.resolve();
    if (!assStyleLibraryUsesServerStorage()) {
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
      if (!assStyleLibraryDirty) {
        setAssStyleLibrary(payload, { persistLocal: true });
        ASS_STYLE_LIBRARY_READY = true;
        setAssStyleLibraryStatus('', 'success');
      } else {
        // A form edit happened while GET was in flight.  The local edit is
        // authoritative until its own POST succeeds.
        ASS_STYLE_LIBRARY_READY = false;
        setAssStyleLibraryStatus('本地有更新改动，等待再次同步', 'warning');
      }
    } catch (_) {
      // localhost 服务暂不可用时沿用本地副本；下次打开编辑器会再次尝试读取。
      ASS_STYLE_LIBRARY_READY = false;
      setAssStyleLibraryStatus('使用本地副本，服务器同步失败', 'warning');
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













