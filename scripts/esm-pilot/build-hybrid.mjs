// ESM 试点构建脚本：证明「部分模块 ESM 化 + esbuild 打包」能嵌回经典拼接架构。
//
// 产物：.esm-pilot-out/baseline-blank.html（全经典拼接，对照组）
//       .esm-pilot-out/hybrid-blank.html（host 四模块走 esbuild 产物，同页共存）
// 用法：node scripts/esm-pilot/build-hybrid.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB = path.join(ROOT, "web");
const OUT = path.join(ROOT, ".esm-pilot-out");

function r(x) { return path.join(ROOT, x); }

// ---- 试点转换集：单一事实来源在 tests/helpers/esm-pilot-converted.mjs ----
const CONVERTED = (await import(pathToFileURL(r("tests/helpers/esm-pilot-converted.mjs")))).CONVERTED;

// ---- 读清单 ----
const manifest = fs.readFileSync(r("web/editor-scripts.txt"), "utf8")
  .split("\n").map((l) => l.split("#", 1)[0].trim()).filter(Boolean);
const firstIdx = manifest.indexOf(CONVERTED[0]);
const lastIdx = manifest.indexOf(CONVERTED[CONVERTED.length - 1]);
if (firstIdx < 0 || lastIdx !== firstIdx + CONVERTED.length - 1) {
  throw new Error("试点转换集在清单中不是连续段，装配位置无法保持");
}
const classicBefore = manifest.slice(0, firstIdx);
const classicAfter = manifest.slice(lastIdx + 1);
const readWeb = (name) => fs.readFileSync(path.join(WEB, name), "utf8");
// 基线必须取 HEAD 版本：工作区里试点文件已是 ESM，不再属于经典世界。
const readHead = (name) => execFileSync("git", ["show", `HEAD:web/${name}`],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const joinScripts = (list, reader = readWeb) => list
  .map((name) => reader(name).trimEnd())
  .join("\n\n");

// ---- esbuild 打包转换集 ----
const entryPath = path.join(WEB, "editor", "boot", "esm-entry.tmp.js");
// 门面挂载属于页面装配（副作用归入口），不进模块本体——这是 ESM 化的规范动作；
// 若省略这行，esbuild 会把「无人使用」的纯导出模块整体 tree-shake 掉。
fs.writeFileSync(entryPath, `// 试点临时入口：按清单顺序引入已转换模块（正式迁移中此文件即新入口）。\n`
  + CONVERTED.map((f) => `import "../../${f}";\n`).join("")
  + `import { createEditorHost } from "../../editor/boot/editor-host.js";\n`
  + `window.MaweHost = createEditorHost({ browser: window, environment: globalThis });\n`);
const t0 = performance.now();
const result = await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  write: false,
  metafile: true,
  logLevel: "silent",
});
const bundleMs = performance.now() - t0;
fs.rmSync(entryPath);
const bundle = result.outputFiles[0].text;
const bundleInputs = Object.keys(result.metafile.inputs);

// ---- 经典整块的最小化测量（今天就能用，不依赖迁移） ----
const fullClassic = joinScripts(manifest, readHead);
const t1 = performance.now();
const minified = await esbuild.transform(fullClassic, { minify: true, target: ["chrome120"] });
const minifyMs = performance.now() - t1;
const gzip = (s) => zlib.gzipSync(Buffer.from(s)).length;

// ---- 页面装配（镜像 edit.py render_editor_page 的 blank 分支） ----
function paletteJson() {
  try {
    const py = process.env.MAW_E2E_PYTHON || "python";
    return execFileSync(py, ["-c", "import json, edit; print(edit.build_palette_json())"],
      { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    const src = fs.readFileSync(r("edit.py"), "utf8");
    const m = src.match(/COLOR_PALETTE\s*=\s*(\[[\s\S]*?\n\])/);
    return JSON.stringify(eval(m[1]));
  }
}
function appVersion() {
  const m = fs.readFileSync(r("pyproject.toml"), "utf8").match(/^version = "([^"]+)"\r?$/);
  return m ? m[1] : "0.0.0";
}
function renderPage(scriptsBody) {
  let page = fs.readFileSync(path.join(WEB, "editor-template.html"), "utf8");
  const mediaHtml = '<audio id="player" preload="metadata" style="width:100%;display:block;"></audio>';
  const replacements = {
    "__EDITOR_CSS__": fs.readFileSync(path.join(WEB, "editor.css"), "utf8").trimEnd(),
    "__WAVEFORM_CSS__": fs.readFileSync(path.join(WEB, "waveform.css"), "utf8").trimEnd(),
    "__EDITOR_SCRIPTS_JS__": scriptsBody,
    "__PALETTE_JSON__": paletteJson(),
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
    "__APP_VERSION__": appVersion(),
    "__JSON_DISPLAY__": "未加载工程",
    "__JSON_NAME_CLASS__": "empty",
    "__MEDIA_NAME_DISPLAY__": "未加载媒体",
    "__MEDIA_NAME_TITLE__": "",
    "__MEDIA_NAME_CLASS__": "empty",
  };
  for (const [token, value] of Object.entries(replacements)) page = page.split(token).join(value);
  return page;
}

// 基线页：全部经典拼接（HEAD 原始内容，与 edit.py 产物等价，作为对照）
const baseline = renderPage(joinScripts(manifest, readHead));
// 混合页：经典前块 + <script>esbuild 产物</script> + 经典后块（同一 token 内开合 script 标签）
const hybrid = renderPage(
  joinScripts(classicBefore)
  + "\n</script>\n<script>\n" + bundle + "\n</script>\n<script>\n"
  + joinScripts(classicAfter),
);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "baseline-blank.html"), baseline);
fs.writeFileSync(path.join(OUT, "hybrid-blank.html"), hybrid);

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(JSON.stringify({
  bundleMs: +bundleMs.toFixed(1),
  bundleBytes: Buffer.byteLength(bundle),
  bundleInputs,
  classicBeforeFiles: classicBefore.length,
  classicAfterFiles: classicAfter.length,
  pageBaseline: { bytes: Buffer.byteLength(baseline), gzip: gzip(baseline) },
  pageHybrid: { bytes: Buffer.byteLength(hybrid), gzip: gzip(hybrid) },
  fullClassicBlock: { bytes: Buffer.byteLength(fullClassic), gzip: gzip(fullClassic) },
  fullClassicMinified: {
    bytes: Buffer.byteLength(minified.code), gzip: gzip(minified.code), minifyMs: +minifyMs.toFixed(0),
  },
}, null, 2));
