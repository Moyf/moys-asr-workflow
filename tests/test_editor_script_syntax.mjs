// 编辑器源集的语法检查（终态契约）。
//
// 源文件集合从 web/editor+web/shared 目录推导（清单已退役，
// 与 build-editor.deriveSources 同口径）。源码一律按 module 解析；
// 「classic 产物」保证由 test_editor_bundle 承担：产物 bundle 用
// vm.Script 编译（classic）+ 构建器入口校验。acorn 为
// devDependency（package.json 显式声明），缺失时本测试直接崩红
// 而非静默 skip——语法层不许无声失守。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const sources = ["editor", "shared"].flatMap((base) =>
  (function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!entry.name.endsWith(".js")) return [];
      return [full];
    });
  })(join(webDir, base))
).filter((file) => !file.endsWith(".bundle.js")).sort();

test("编辑器源集内每个文件都是合法 ESM 模块", () => {
  assert.ok(sources.length > 1, "源集不应为空");
  const broken = [];
  for (const file of sources) {
    const source = readFileSync(file, "utf8");
    try {
      // 只解析，不执行：与 node --check 同等语法覆盖，不要求源文件能独立运行。
      acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
    } catch (error) {
      broken.push(`${file}: ${error.message}`);
    }
  }
  assert.deepEqual(broken, [], "存在语法错误的编辑器源");
});
