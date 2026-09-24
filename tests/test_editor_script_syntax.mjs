// 清单内全部脚本的语法检查：不依赖任何 devDependency，任何环境都必须能跑。
// tests/test_editor_script_order.mjs 用 acorn 做顺序断言，但 acorn 缺失时整体
// skip；这里用 vm.Script 只做编译不执行，保证「语法」这一层永远不会静默失守，
// 取代此前只检查 editor.js / waveform.js 两个历史入口的 node --check。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const manifest = readFileSync(join(webDir, "editor-scripts.txt"), "utf8")
  .split("\n")
  .map((line) => line.split("#", 1)[0].trim())
  .filter(Boolean);

test("editor-scripts.txt 内每个脚本都是合法的 classic script", () => {
  assert.ok(manifest.length > 1, "清单不应为空");
  const broken = [];
  for (const entry of manifest) {
    const source = readFileSync(join(webDir, ...entry.split("/")), "utf8");
    try {
      // 只编译，不执行：与 node --check 同等语法覆盖，不要求目标脚本能独立运行。
      new vm.Script(source, { filename: entry });
    } catch (error) {
      broken.push(`${entry}: ${error.message}`);
    }
  }
  assert.deepEqual(broken, [], "存在语法错误的编辑器脚本");
});
