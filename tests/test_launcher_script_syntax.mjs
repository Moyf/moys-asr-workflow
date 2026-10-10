// 清单内全部 launcher 脚本的语法检查：不依赖任何 devDependency，任何环境都必须能跑。
// 与 tests/test_editor_script_syntax.mjs 同构：ESM 工厂用 acorn 按 module 解析，
// 其余用 vm.Script 只编译不执行，保证「语法」这一层永远不会静默失守。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as acorn from 'acorn';

const modules = new Set(JSON.parse(readFileSync(new URL('../web/launcher-modules.json', import.meta.url), 'utf8'))
  .modules.map(item => item.file));

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const manifest = readFileSync(join(webDir, "launcher-scripts.txt"), "utf8")
  .split("\n")
  .map((line) => line.split("#", 1)[0].trim())
  .filter(Boolean);

test("launcher-scripts.txt 内每个脚本都是合法的 classic script", () => {
  assert.ok(manifest.length >= 1, "清单不应为空");
  const broken = [];
  for (const entry of manifest) {
    const source = readFileSync(join(webDir, ...entry.split("/")), "utf8");
    try {
      // 只编译，不执行：与 node --check 同等语法覆盖，不要求目标脚本能独立运行。
      if (modules.has(entry)) acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
      else new vm.Script(source, { filename: entry });
    } catch (error) {
      broken.push(`${entry}: ${error.message}`);
    }
  }
  assert.deepEqual(broken, [], "存在语法错误的启动器脚本");
});
