// ESM 试点产物构建器：把转换集（真 ESM）打成一个 classic IIFE，
// 作为已提交的清单资产 web/editor/boot/esm-bundle.js。
//
// 为什么提交产物而不是装配时现打包：edit.py / serve.py / Tauri build.rs
// 三个消费端都只认「清单里的一个文件」，不引入 Node 运行时依赖；
// 产物过期由 tests/test_esm_bundle_fresh.mjs 把关。
//
// 用法：node scripts/esm-pilot/build-esm-bundle.mjs [--check]
//   --check  不写盘，仅比较产物是否最新（退出码语义），供测试与 CI 复用。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB = path.join(ROOT, "web");
const BUNDLE_REL = "editor/boot/esm-bundle.js";
const BUNDLE_ABS = path.join(WEB, BUNDLE_REL);

// 单一事实来源：试点转换集（清单原四条目，现已合并为 bundle 一个条目）。
const CONVERTED = [
  "shared/host/storage.js",
  "shared/host/files.js",
  "shared/host/server-api.js",
  "editor/boot/editor-host.js",
];

export function buildBundle() {
  // 门面挂载属于页面装配（副作用归入口），不进模块本体；
  // 若省略，esbuild 会把「无人使用」的纯导出模块整体 tree-shake 掉。
  const entry = `// ESM 试点转换集入口：按清单顺序引入已转换模块。\n`
    + CONVERTED.map((f) => `import "../../${f}";\n`).join("")
    + `import { createEditorHost } from "../../editor/boot/editor-host.js";\n`
    + `window.MaweHost = createEditorHost({ browser: window, environment: globalThis });\n`;
  const t0 = performance.now();
  const result = esbuild.buildSync({
    stdin: { contents: entry, resolveDir: path.join(WEB, "editor", "boot"), loader: "js" },
    bundle: true,
    format: "iife",
    target: ["chrome120"],
    write: false,
    logLevel: "silent",
  });
  return { code: result.outputFiles[0].text, ms: performance.now() - t0 };
}

// ---- CLI 分支：仅直接运行时执行，带副作用（写盘） ----
// 导入本模块（如 tests/test_esm_bundle_fresh.mjs）只应获得纯函数 buildBundle()；
// CLI 逻辑必须留在 invokedDirectly 守卫之后，否则测试导入即重写产物，
// 「过期检测」永远测不出过期（PR #157 评审 P1）。
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const isCheck = process.argv.includes("--check");
  const { code, ms } = buildBundle();
  const existing = fs.existsSync(BUNDLE_ABS) ? fs.readFileSync(BUNDLE_ABS, "utf8") : null;
  if (isCheck) {
    if (existing !== code) {
      console.error(`esm-bundle 过期：请运行 node scripts/esm-pilot/build-esm-bundle.mjs 更新 ${BUNDLE_REL}`);
      process.exitCode = 1;
    } else {
      console.log(`esm-bundle 最新（${code.length} 字节）`);
    }
  } else {
    fs.writeFileSync(BUNDLE_ABS, code, "utf8");
    console.log(`esm-bundle 已写入 ${BUNDLE_REL}（${code.length} 字节，${ms.toFixed(1)} ms）`);
  }
}
