// ESM 试点验证：file:// 加载基线页与混合页，对比启动行为与宿主桥等价性。
// 用法：node scripts/esm-pilot/verify.mjs
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".esm-pilot-out");

const BOOT_CHECK = () => {
  return {
    maweVersion: window.MAWE?.version ?? null,
    registry: window.MAWE?.list?.() ?? [],
    hasMaweHost: typeof window.MaweHost === "object" && window.MaweHost !== null,
    hostShape: window.MaweHost ? Object.keys(window.MaweHost).sort() : [],
    savePickerCapable: window.MaweHost?.files?.hasSavePicker?.() ?? null,
    onboardingVisible: !document.getElementById("onboarding-card")?.hidden,
    cuesContainer: Boolean(document.getElementById("cues-container")),
    playerPresent: Boolean(document.getElementById("player")),
  };
};

async function probe(page, file) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.goto("file:///" + file.replace(/\\/g, "/"));
  await page.waitForSelector("#onboarding-card", { state: "attached", timeout: 10_000 });
  await page.waitForTimeout(500);
  const boot = await page.evaluate(BOOT_CHECK);
  // 宿主桥功能探针：写入 → 读回（门面只有 getItem/setItem，没有 removeItem）
  const storageRoundtrip = await page.evaluate(() => {
    try {
      window.MaweHost.storage.setItem("maw-esm-pilot", "ok");
      return window.MaweHost.storage.getItem("maw-esm-pilot") === "ok";
    } catch (e) { return `threw: ${e.message}`; }
  });
  return { file: path.basename(file), errors, boot, storageRoundtrip };
}

const browser = await chromium.launch();
const baseline = await probe(await browser.newPage(), path.join(OUT, "baseline-blank.html"));
const hybrid = await probe(await browser.newPage(), path.join(OUT, "hybrid-blank.html"));
await browser.close();

const retiredModules = ["host-storage", "host-files", "host-server-api", "editor-host"];
const registryDiff = {
  baselineOnly: baseline.boot.registry.filter((n) => !hybrid.boot.registry.includes(n)),
  hybridOnly: hybrid.boot.registry.filter((n) => !baseline.boot.registry.includes(n)),
};
const verdict = {
  baselineErrors: baseline.errors,
  hybridErrors: hybrid.errors,
  zeroErrorsBoth: baseline.errors.length === 0 && hybrid.errors.length === 0,
  bootEquivalent: JSON.stringify({ ...baseline.boot, registry: null })
    === JSON.stringify({ ...hybrid.boot, registry: null }),
  storageRoundtripBoth: baseline.storageRoundtrip === true && hybrid.storageRoundtrip === true,
  retiredFromRegistry: retiredModules.every((n) => !hybrid.boot.registry.includes(n))
    && retiredModules.every((n) => baseline.boot.registry.includes(n)),
  registryDiff,
};
console.log(JSON.stringify({ baseline, hybrid, verdict }, null, 2));
