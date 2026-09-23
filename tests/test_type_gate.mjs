// 类型门 canary：验证 tsc --checkJs 能捕获「跨模块门面契约违约」——
// 我们基于 acorn 的三层检查（语法 / 作用域 / 符号分诊）对此类静默漂移全部免疫。
//
// fixture 模拟真实形态：owner 模块挂载冻结门面（强类型），caller 模块经
// window.MaweDemo 消费并写出违约赋值。预期 tsc 报错、非零退出。
// typescript 未安装时 skip（与 test_editor_script_order 的 acorn 缺失处理一致）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..");
const tscPath = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const fixtureDir = join(testDir, "fixtures", "type-gate");

test("类型门 canary：门面契约违约必须被 tsc 捕获", { skip: existsSync(tscPath) ? false : "typescript 未安装" }, () => {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "globals.d.ts"), `interface DemoSegment {
  start: number;
  end: number;
}
interface MaweDemoApi {
  readonly segments: DemoSegment[];
}
interface Window {
  MaweDemo: MaweDemoApi;
}
declare var MaweDemo: MaweDemoApi;
`, "utf8");
  writeFileSync(join(fixtureDir, "owner.js"), `/** @param {Window & typeof globalThis} global */
(function initMaweDemo(global) {
  'use strict';
  /** @type {DemoSegment[]} */
  const SEGMENTS = [{ start: 0, end: 1000 }];
  global.MaweDemo = Object.freeze({
    get segments() { return SEGMENTS; },
  });
})(typeof window !== 'undefined' ? window : globalThis);
`, "utf8");
  writeFileSync(join(fixtureDir, "caller.js"), `'use strict';
// 违约：毫秒整数位被写入字符串——acorn 三层检查全绿，只有类型层能拦。
window.MaweDemo.segments.push({ start: '0', end: 1000 });
`, "utf8");
  writeFileSync(join(fixtureDir, "tsconfig.json"), `{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "target": "es2022",
    "strict": false
  },
  "include": ["*.js", "*.d.ts"]
}
`, "utf8");

  try {
    const result = spawnSync(process.execPath, [tscPath, "-p", fixtureDir], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "tsc 应当以非零退出报告契约违约");
    assert.match(`${result.stdout}${result.stderr}`, /TS2322/, "报错应包含 start 字段的类型违约（TS2322）");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
