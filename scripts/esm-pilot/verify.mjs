// ESM 试点验证门禁：三页对照 + 非零退出语义。
//
//   1. baseline  ：改造前 ref（--baseline，默认 origin/main）的清单与源码
//                  复刻装配的 classic 页——明确的改造前提交，不再依赖 HEAD 巧合；
//   2. file://   ：正式 edit.py build_blank_html() 的产物（真实装配路径）；
//   3. server    ：正式 server-editor/serve.py --blank（真实 http 装配路径）。
//
// 任一探针失败即以非零退出，可作 CI 门禁。
// 用法：node scripts/esm-pilot/verify.mjs [--baseline <ref>]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { findFreePort, startBlankServer } from "../../tests/e2e/helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB = path.join(ROOT, "web");
const OUT = path.join(ROOT, ".esm-pilot-out");

const baselineRefIdx = process.argv.indexOf("--baseline");
const BASELINE_REF = baselineRefIdx >= 0 ? process.argv[baselineRefIdx + 1] : "origin/main";
const PYTHON = process.env.MAW_E2E_PYTHON || "python";

const gitShow = (ref, file) => execFileSync("git", ["show", `${ref}:${file}`],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function renderBlankPage(scriptsBody) {
  let page = fs.readFileSync(path.join(WEB, "editor-template.html"), "utf8");
  const mediaHtml = '<audio id="player" preload="metadata" style="width:100%;display:block;"></audio>';
  const replacements = {
    "__EDITOR_CSS__": fs.readFileSync(path.join(WEB, "editor.css"), "utf8").trimEnd(),
    "__WAVEFORM_CSS__": fs.readFileSync(path.join(WEB, "waveform.css"), "utf8").trimEnd(),
    "__EDITOR_SCRIPTS_JS__": scriptsBody,
    "__PALETTE_JSON__": execFileSync(PYTHON, ["-c", "import json, edit; print(edit.build_palette_json())"],
      { cwd: ROOT, encoding: "utf8" }).trim(),
    "__TITLE__": "MAWE — Moy's ASR Workflow Editor · 用「打开工程」加载工程文件",
    "__MEDIA_HTML__": mediaHtml,
    "__DATA_JSON__": JSON.stringify({ segments: [], media: "", language: "", model: "" }),
    "__FILENAME_BASE_JSON__": JSON.stringify("untitled"),
    "__STICKERS_JSON__": "[]",
    "__STICKER_ROOT_JSON__": '""',
    "__STICKER_URL_PREFIX_JSON__": '""',
    "__SERVER_CONFIG_JSON__": "null",
    "__EDITOR_LOADING_HIDDEN__": " hidden",
    "__NINJA_SFX_BASE_URL_JSON__": '"web/sfx/"',
    "__UI_LANGUAGE_JSON__": "null",
    "__APP_VERSION__": (fs.readFileSync(path.join(ROOT, "pyproject.toml"), "utf8")
      .match(/^version = "([^"]+)"\r?$/m) || [, "0.0.0"])[1],
    "__JSON_DISPLAY__": "未加载工程",
    "__JSON_NAME_CLASS__": "empty",
    "__MEDIA_NAME_DISPLAY__": "未加载媒体",
    "__MEDIA_NAME_TITLE__": "",
    "__MEDIA_NAME_CLASS__": "empty",
  };
  for (const [token, value] of Object.entries(replacements)) page = page.split(token).join(value);
  return page;
}

// ---- 1. 基线页：改造前 ref 的清单与源码（replica 装配，仅作对照） ----
const baselineManifest = gitShow(BASELINE_REF, "web/editor-scripts.txt")
  .split("\n").map((l) => l.split("#", 1)[0].trim()).filter(Boolean);
for (const name of ["shared/host/storage.js", "shared/host/files.js", "shared/host/server-api.js"]) {
  const source = gitShow(BASELINE_REF, `web/${name}`);
  if (/^export /m.test(source)) {
    console.error(`基线 ref ${BASELINE_REF} 不是改造前状态：${name} 含 export`);
    process.exit(2);
  }
}
const baselineScripts = baselineManifest
  .map((name) => gitShow(BASELINE_REF, `web/${name}`).trimEnd()).join("\n\n");

// ---- 2. 当前 file:// 页：正式 edit.py 装配（不是自建复刻） ----
fs.mkdirSync(OUT, { recursive: true });
const currentPagePath = path.join(OUT, "blank-current.html");
const currentHtml = execFileSync(PYTHON, ["-c",
  `import edit; open(r'${currentPagePath.replace(/\\/g, "/")}', 'w', encoding='utf-8', newline='').write(edit.build_blank_html())`],
  { cwd: ROOT, encoding: "utf8" });
const currentPage = fs.readFileSync(currentPagePath, "utf8");
const bundleInRealAssembly = currentPage.includes("esm-bundle") || currentPage.includes("MaweHost");

// ---- 3. 探针 ----
const BOOT_CHECK = () => ({
  maweVersion: window.MAWE?.version ?? null,
  registry: window.MAWE?.list?.() ?? [],
  hasMaweHost: typeof window.MaweHost === "object" && window.MaweHost !== null,
  hostShape: window.MaweHost ? Object.keys(window.MaweHost).sort() : [],
  onboardingVisible: !document.getElementById("onboarding-card")?.hidden,
  cuesContainer: Boolean(document.getElementById("cues-container")),
  playerPresent: Boolean(document.getElementById("player")),
});
const RETIRED = ["host-storage", "host-files", "host-server-api", "editor-host"];

async function probe(page, url) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#onboarding-card", { state: "attached", timeout: 15_000 });
  await page.waitForTimeout(500);
  const boot = await page.evaluate(BOOT_CHECK);
  const storageRoundtrip = await page.evaluate(() => {
    try {
      window.MaweHost.storage.setItem("maw-esm-pilot", "ok");
      return window.MaweHost.storage.getItem("maw-esm-pilot") === "ok";
    } catch (e) { return `threw: ${e.message}`; }
  });
  return { url, errors, boot, storageRoundtrip };
}

const browser = await chromium.launch();
const stripVolatile = (p) => JSON.stringify({ ...p.boot, registry: null });
try {
  fs.writeFileSync(path.join(OUT, "baseline.html"), renderBlankPage(baselineScripts));
  const baseline = await probe(await browser.newPage(),
    "file:///" + path.join(OUT, "baseline.html").replace(/\\/g, "/"));
  const current = await probe(await browser.newPage(),
    "file:///" + currentPagePath.replace(/\\/g, "/"));
  const port = await findFreePort();
  const server = await startBlankServer(port, path.join(os.tmpdir(), `maw-esm-pilot-${Date.now()}`));
  let serverProbe;
  try {
    serverProbe = await probe(await browser.newPage(), server.url);
  } finally {
    server.proc?.kill?.();
  }

  const hostModulesPresent = (p) => RETIRED.every((n) => p.boot.registry.includes(n));
  const verdict = {
    baselineRef: BASELINE_REF,
    realAssemblyContainsBundle: bundleInRealAssembly,
    checks: {
      baselineZeroErrors: baseline.errors.length === 0,
      currentFilePageZeroErrors: current.errors.length === 0,
      serverPageZeroErrors: serverProbe.errors.length === 0,
      currentBootMatchesBaseline: stripVolatile(baseline) === stripVolatile(current),
      serverBootMatchesBaseline: stripVolatile(baseline) === stripVolatile(serverProbe),
      storageRoundtripAll: [baseline, current, serverProbe].every((p) => p.storageRoundtrip === true),
      hostModulesLiveViaBundleOnCurrent: current.boot.hasMaweHost && !current.boot.registry.some((n) => RETIRED.includes(n)),
      hostModulesInBaselineRegistry: hostModulesPresent(baseline),
    },
    errors: { baseline: baseline.errors, current: current.errors, server: serverProbe.errors },
  };
  verdict.ok = Object.values(verdict.checks).every(Boolean);
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.ok) process.exitCode = 1;
} finally {
  await browser.close();
}
