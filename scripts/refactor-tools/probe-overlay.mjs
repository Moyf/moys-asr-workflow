// 定位 overlay 创建链断点：加载工程 → 模拟 Ctrl+拖动 → 检查各环节状态。
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const blank = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto(pathToFileURL(blank).href);
await page.waitForTimeout(1200);

const probe = await page.evaluate(() => {
  const out = {};
  out.getOverlayTrackType = typeof getOverlayTrack;
  try {
    out.overlayTrackEnabled = getOverlayTrack()?.enabled;
    out.overlayCreateEnabled = getOverlayTrack()?.enabled === true;
  } catch (e) { out.getOverlayTrackErr = String(e); }
  out.wfOptionsOverlayCreate = typeof MaweCoreState.waveformEditor?.options?.getOverlayCreateEnabled === "function"
    ? MaweCoreState.waveformEditor.options.getOverlayCreateEnabled()
    : "(无选项)";
  out.overlayTrackVisible = typeof overlayTrackVisible === "function" ? overlayTrackVisible() : "(fn 不在全局)";
  out.overlayBlocks = document.querySelectorAll(".waveform-cue-block.waveform-overlay-block").length;
  out.addOverlayRangeType = typeof addOverlayRangeFromWaveform;
  return out;
});
console.log(JSON.stringify(probe, null, 2));
console.log("errors:", errors.length ? errors.join(" | ") : "(无)");
await browser.close();
