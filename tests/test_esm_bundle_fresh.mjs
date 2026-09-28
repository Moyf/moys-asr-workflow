// esm-bundle 新鲜度门禁：清单里的打包产物必须与转换集源码同步。
// 转换集改动后忘记重新构建时，本测试以非零退出拦截（防「产物过期」类故障，
// 与 blank-editor.html 的发布前重生成约定同一性质的保险丝）。
// esbuild 缺失时 skip，保证最小验证命令在裸环境可用。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const esbuildMissing = !existsSync(new URL("../node_modules/esbuild/package.json", import.meta.url));

test("esm-bundle 与转换集源码同步", { skip: esbuildMissing ? "esbuild 未安装" : false }, async () => {
  const { buildBundle } = await import("../scripts/esm-pilot/build-esm-bundle.mjs");
  const { code } = buildBundle();
  const committed = (await import("node:fs")).readFileSync(
    new URL("../web/editor/boot/esm-bundle.js", import.meta.url), "utf8");
  assert.equal(committed, code, "web/editor/boot/esm-bundle.js 已过期：运行 node scripts/esm-pilot/build-esm-bundle.mjs 更新");
});
