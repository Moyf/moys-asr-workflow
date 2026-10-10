// 主题解析/应用与后端桥接（bridge/waitForBackend）、首屏 reveal。

function isThemePreference(value) { return value === "light" || value === "dark" || value === "system"; }
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

// keycap 表情（1️⃣ 等）依赖彩色 emoji 字体：后端把 Noto Color Emoji 缓存到本机
// 后提供 file:// URI，这里注入 @font-face；注入一次即可，重复事件会被跳过。
function injectEmojiFont(uri) {
  if (!uri || document.querySelector("style[data-emoji-font]")) return;
  const style = document.createElement("style");
  style.dataset.emojiFont = "1";
  style.textContent = `@font-face{font-family:"MAW Emoji";src:url("${uri}") format("truetype");font-weight:400;font-display:swap;}`;
  document.head.appendChild(style);
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
