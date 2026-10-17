// 工程页：本机历史由桌面后端保存，浏览器 mock 使用隔离的演示存储。
let launcherProjects = null;
function initializeLauncherProjects() {
  const $ = (id) => document.getElementById(id);
  let history = { enabled: true, entries: [] };
  let request = 0;
  let updating = false;
  const button = (key, action, className = "ghost small") => {
    const node = document.createElement("button"); node.type = "button"; node.className = className; node.textContent = t(key);
    const iconName = { open_folder: "folder", redesign_use_toolbox: "tool", redesign_remove_recent: "x" }[key];
    if (iconName) {
      node.classList.add("recent-icon-action"); node.title = t(key); node.setAttribute("aria-label", t(key)); node.textContent = "";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"); icon.classList.add("i"); icon.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", `#i-${iconName}`); icon.append(use); node.append(icon);
    }
    node.addEventListener("click", () => { void action(); }); return node;
  };
  function renderServer() {
    const running = state.serverRunning || Boolean(state.detectedServerUrl);
    $("projectServerState").textContent = state.serverStarting ? SERVER_STARTING_TEXT[state.lang]
      : running ? `${t("redesign_server_running")} · 127.0.0.1:${currentServerPort()}${state.serverProjectPath ? ` · ${baseName(state.serverProjectPath)}` : ""}` : t("redesign_server_stopped");
    $("projectStopServer").classList.toggle("hidden", !running);
    $("projectStopServer").disabled = state.serverStarting || state.serverStopping;
    $("projectOpenEditor").disabled = state.serverStarting;
    $("projectOpenSelected").disabled = state.serverStarting || !$("jsonPath").value.trim();
  }
  async function openProject(path) {
    if (state.serverStarting) return;
    if (state.detectedServerUrl && path) {
      $("recentProjectStatus").textContent = t("redesign_external_server_warning");
      return;
    }
    if (state.serverRunning && state.serverProjectPath !== path && !(await confirmAction(t("redesign_switch_project_warning")))) return;
    setJsonPath(path);
    await openServerEditor();
  }
  function render() {
    const query = $("recentProjectSearch").value.trim().toLocaleLowerCase();
    const entries = history.entries.filter((entry) => entry.path.toLocaleLowerCase().includes(query));
    const list = $("recentProjectList"); list.replaceChildren();
    entries.forEach((entry) => {
      const row = document.createElement("article"); row.className = `recent-project-row${entry.exists ? "" : " missing"}`;
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"); icon.classList.add("i"); icon.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", "#i-doc"); icon.append(use);
      const meta = document.createElement("div"); meta.className = "recent-project-meta";
      const name = document.createElement("strong"); name.textContent = baseName(entry.path); name.title = entry.path;
      const detail = document.createElement("p"); detail.className = "hint";
      const date = new Date(entry.openedAt);
      detail.textContent = entry.exists ? `${entry.path} · ${Number.isNaN(date.getTime()) ? "" : date.toLocaleString(state.lang === "zh" ? "zh-CN" : "en")}` : t("redesign_project_missing");
      meta.append(name, detail);
      if (state.serverRunning && state.serverProjectPath === entry.path) { const active = document.createElement("span"); active.className = "recent-project-active"; active.textContent = t("redesign_project_editing"); name.append(" ", active); }
      const actions = document.createElement("div"); actions.className = "recent-project-actions";
      if (entry.exists) {
        actions.append(button("redesign_use_toolbox", () => {
          window.MAWLauncher.openToolbox();
          $("toolboxInputPath").value = entry.path;
          $("toolboxInputPath").dispatchEvent(new Event("input", { bubbles: true }));
          $("toolboxInputPath").focus();
        }, "inline-link"), button("open_folder", async () => {
          const result = await bridge("open_containing_folder", { path: entry.path });
          if (!result.ok) $("recentProjectStatus").textContent = t("redesign_recent_error");
        }), button("redesign_open_project", () => openProject(entry.path)));
      } else {
        actions.append(button("redesign_relocate_project", async () => {
          const chosen = await bridge("choose_file", { kind: "json" });
          if (chosen.ok) await update({ action: "relocate", path: chosen.path, previousPath: entry.path });
        }));
      }
      actions.append(button("redesign_remove_recent", () => update({ action: "remove", path: entry.path }), "inline-link"));
      row.append(icon, meta, actions); list.append(row);
    });
    $("recentProjectEmpty").classList.toggle("hidden", entries.length > 0);
    $("recentProjectEmpty").textContent = t(query ? "redesign_no_search_results" : "redesign_no_recent_projects");
    $("recordRecentProjects").checked = history.enabled;
    $("recordRecentProjects").disabled = updating;
    $("clearRecentProjects").disabled = updating || !history.entries.length;
    renderServer();
  }
  async function load() {
    const token = ++request;
    const result = await bridge("get_recent_projects");
    if (token !== request) return;
    if (result.ok && Array.isArray(result.entries)) history = result;
    else $("recentProjectStatus").textContent = t("redesign_recent_error");
    updating = false; render();
  }
  async function update(payload) {
    const token = ++request;
    updating = true; render();
    const result = await bridge("update_recent_projects", payload);
    if (token !== request) return result;
    updating = false;
    if (result.ok && Array.isArray(result.entries)) { history = result; $("recentProjectStatus").textContent = ""; }
    else $("recentProjectStatus").textContent = t("redesign_recent_error");
    render(); return result;
  }
  $("recentProjectSearch").addEventListener("input", render);
  $("recordRecentProjects").addEventListener("change", () => { void update({ action: "enabled", enabled: $("recordRecentProjects").checked }); });
  $("clearRecentProjects").addEventListener("click", async () => { if (await confirmAction(t("redesign_clear_recent_confirm"))) await update({ action: "clear" }); });
  $("projectOpenEditor").addEventListener("click", () => { void openServerEditor(); });
  $("projectStopServer").addEventListener("click", () => { void stopEditorServer(); });
  $("projectOpenSelected").addEventListener("click", () => { void openProject($("jsonPath").value.trim()); });
  $("projectOpenBlank").addEventListener("click", () => { void openProject(""); });
  $("projectOpenPortable").addEventListener("click", () => { void bridge("open_blank_html"); });
  $("jsonPath").addEventListener("input", renderServer);
  $("aboutAppVersion").textContent = state.config?.appVersion || "";
  $("aboutSupport").addEventListener("click", () => $("supportLink").click());
  $("aboutGithub").addEventListener("click", () => $("homeLink").click());
  $("aboutGuide").addEventListener("click", () => $("helpGuide").click());
  window.addEventListener("mawpagechange", (event) => { if (["projects", "settings"].includes(event.detail.page)) void load(); });
  const previousLanguageChanged = window.MAWLauncher.onLanguageChanged;
  window.MAWLauncher.onLanguageChanged = () => { previousLanguageChanged?.(); render(); };
  launcherProjects = { renderServer, remember(path) { if (path && history.enabled) void update({ action: "remember", path }); } };
  window.MAWLauncher.rememberRecentProject = (path) => launcherProjects.remember(path);
  void load();
}
