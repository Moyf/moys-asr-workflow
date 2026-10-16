// 左侧导航与页面切换：转写 / 批量 / 工具箱 / 工程 / 设置，以及帮助菜单与顶栏主题切换。
// 批量使用独立页面；模式仍由 batch.js 管理，运行中不能被导航改写。

const GUIDE_URL = "https://moyf.github.io/moys-asr-workflow/docs/";
let activePage = "transcribe";
let settingsReturnPage = "transcribe";

function pageSection(page) { return page; }
function showPage(page) {
  const previous = activePage;
  const section = pageSection(page);
  document.querySelectorAll(".page[data-page]").forEach((node) => node.classList.toggle("hidden", node.dataset.page !== section));
  activePage = page;
  syncNavHighlight();
  if (section === "transcribe") syncFixedFooterClearance();
  if (previous !== page) window.dispatchEvent(new CustomEvent("mawpagechange", { detail: { page, previous } }));
}
function syncNavHighlight() {
  document.querySelectorAll("[data-nav-page]").forEach((item) => {
    const active = item.dataset.navPage === activePage;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}
function navigateTo(page) {
  if (page === "settings") { openSettings(); return; }
  if (page === "toolbox" && window.MAWLauncher?.openToolbox) { window.MAWLauncher.openToolbox(); return; }
  if (page === "transcribe" || page === "batch") {
    window.MAWLauncher?.setTranscribeMode?.(page === "batch" ? "batch" : "single");
    // 批量运行中不能切换模式：导航跟随实际模式，而不是点击目标。
    const mode = window.MAWLauncher?.getTranscribeMode?.() || "single";
    showPage(mode === "batch" ? "batch" : "transcribe");
    return;
  }
  showPage(page);
}
// batch.js 的单文件/批量切换回调：停留在转写页时同步导航高亮。
function onTranscribeModeChanged(mode) {
  if (!["transcribe", "batch"].includes(activePage)) return;
  showPage(mode === "batch" ? "batch" : "transcribe");
}

function setHelpMenuOpen(open) {
  $("helpMenu").classList.toggle("hidden", !open);
  $("helpButton").setAttribute("aria-expanded", String(open));
  $("helpButton").classList.toggle("open", open);
  if (open) $("helpMenu").querySelector('[role="menuitem"]:not(:disabled)')?.focus();
}
function moveHelpMenuFocus(event) {
  const items = [...$("helpMenu").querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const index = items.indexOf(document.activeElement);
  const target = event.key === "Home" ? items[0]
    : event.key === "End" ? items.at(-1)
      : items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
  if (!target) return;
  event.preventDefault();
  target.focus();
}

document.querySelectorAll("[data-nav-page]").forEach((item) => item.addEventListener("click", () => navigateTo(item.dataset.navPage)));
$("helpButton").addEventListener("click", () => setHelpMenuOpen($("helpMenu").classList.contains("hidden")));
$("helpMenu").addEventListener("keydown", (event) => {
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) moveHelpMenuFocus(event);
});
$("helpMenu").addEventListener("click", (event) => { if (event.target.closest('[role="menuitem"]:not(:disabled)')) setHelpMenuOpen(false); });
$("helpGuide").addEventListener("click", () => bridge("open_url", { url: GUIDE_URL }));
document.addEventListener("click", (event) => { if (!event.target.closest(".help-wrap")) setHelpMenuOpen(false); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || $("helpMenu").classList.contains("hidden")) return;
  setHelpMenuOpen(false);
  $("helpButton").focus();
});
$("themeToggle").addEventListener("click", () => setTheme(resolveTheme() === "dark" ? "light" : "dark"));
