// 无头探针：加载产物页，断言各命名空间挂载且零 pageerror。
// 用法: node scripts/refactor-tools/probe-namespace.mjs <html路径>
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const target = process.argv[2];
if (!target) {
  console.error("用法: node scripts/refactor-tools/probe-namespace.mjs <html路径>");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto(pathToFileURL(target).href);
await page.waitForTimeout(1500);

const probe = await page.evaluate(() => ({
  MaweHint: typeof window.MaweHint?.flashHint === "function" && typeof window.MaweHint?.dismissHintCard === "function",
  hintMutableAccessor: (() => { window.MaweHint.lastScaleLimitMsg = "x"; const v = window.MaweHint.lastScaleLimitMsg; window.MaweHint.lastScaleLimitMsg = ""; return v === "x"; })(),
  MaweJklPlayback: typeof window.MaweJklPlayback?.isJklDirectionMode === "function" && typeof window.MaweJklPlayback?.playJklForward === "function",
  jklRateDefault: window.MaweJklPlayback?.jklPlaybackRate === 1,
  jklSetRate: (() => { window.MaweJklPlayback.jklPlaybackRate = 4; const v = window.MaweJklPlayback.jklPlaybackRate; window.MaweJklPlayback.jklPlaybackRate = 1; return v === 4; })(),
  AsrEditorUtils: typeof window.AsrEditorUtils === "object",
  AsrWaveform: typeof window.AsrWaveform === "object",
  MAWE_I18N: typeof window.MAWE_I18N === "object",
  MAWE_EDITOR_BRIDGE: typeof window.MAWE_EDITOR_BRIDGE === "object",
  MAWE: typeof window.MAWE === "object",
  cueListRendered: !!document.querySelector("#cue-list, .cue-row, [id^='cue']"),
}));

await browser.close();
let failed = 0;
for (const [k, v] of Object.entries(probe)) {
  const ok = v === true || (k === "jklRateDefault" && v === true);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok " : "FAIL"} ${k}: ${JSON.stringify(v)}`);
}
console.log(`pageerror 数量: ${errors.length}`);
for (const e of errors) console.log("  pageerror:", e);
if (errors.length > 0 || failed > 0) process.exit(1);
console.log("探针通过：全部命名空间挂载，零 pageerror");
