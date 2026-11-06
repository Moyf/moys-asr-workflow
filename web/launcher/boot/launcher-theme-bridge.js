// 主题解析/应用与后端桥接（bridge/waitForBackend）、首屏 reveal。
// L02 过渡接入：常量与无状态判断来自 ESM 叶子（theme/launcher-theme-keys.js），
// 经 transition 机制注入 classic 作用域；localStorage 读写仍在本文件。

const themeKeys = createThemeKeys();
const { THEME_KEY, isThemePreference } = themeKeys;
function readStoredTheme() { try { const savedTheme = localStorage.getItem(THEME_KEY); return isThemePreference(savedTheme) ? savedTheme : "system"; } catch (error) { return "system"; } }
function storeTheme(pref) { try { localStorage.setItem(THEME_KEY, pref); } catch (error) { /* localStorage 不可用时交给后端持久化 */ } }
function resolveTheme() { if (state.theme === "light" || state.theme === "dark") return state.theme; return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
function applyTheme() { if (resolveTheme() === "light") document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme; $("themeLight").classList.toggle("active", state.theme === "light"); $("themeDark").classList.toggle("active", state.theme === "dark"); $("themeSystem").classList.toggle("active", state.theme === "system"); }
function setTheme(pref) { if (!isThemePreference(pref)) return; state.theme = pref; storeTheme(pref); applyTheme(); void bridge("save_prefs", { theme: pref }).then((result) => { if (result.ok) { if (state.config) state.config.theme = pref; } else applyErrorResult(result); }); }
function revealLauncher() {
  state.initializing = false;
  const shell = document.querySelector(".shell");
  shell?.removeAttribute("inert");
  shell?.setAttribute("aria-busy", "false");
  document.body.classList.add("launcher-ready");
}

async function bridge(method, payload = {}) {
  try {
    return await api[method](payload);
  } catch (error) {
    const message = `${method}: ${error && error.message ? error.message : error}`;
    appendLog(`[bridge] ${message}`);
    setStatus(message);
    return { ok: false, error: message };
  }
}

function waitForBackend(timeoutMs = 1800) {
  if (window.pywebview && window.pywebview.api) return Promise.resolve(window.pywebview.api);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    window.addEventListener("pywebviewready", () => finish(window.pywebview && window.pywebview.api ? window.pywebview.api : null), { once: true });
    setTimeout(() => finish(window.pywebview && window.pywebview.api ? window.pywebview.api : null), timeoutMs);
  });
}

function setRunning(running) { state.running = running; $("progress").classList.toggle("hidden", !running); $("start").classList.toggle("hidden", running); $("stop").classList.toggle("hidden", !running); $("start").disabled = running; $("stop").disabled = !running; setStatus(running ? t("running") : t("ready")); }
