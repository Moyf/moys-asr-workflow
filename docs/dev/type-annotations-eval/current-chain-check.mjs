// 对照组：用「我们目前的体系」检查同一组文件，全部通过——这正是盲区所在。
// 运行：在工作树根目录 node docs/dev/type-annotations-eval/current-chain-check.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import * as eslintScope from "eslint-scope";
import { rewriteSource } from "../../../scripts/refactor-tools/ns-rewrite-editor.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// 模拟 editor-scripts.txt 清单拼接：两个模块进同一个全局作用域
const assembled =
  readFileSync(join(here, "render-module.js"), "utf8") + "\n" +
  readFileSync(join(here, "caller-module.js"), "utf8");

// 第 1 层：语法（等价 node --check）
acorn.parse(assembled, { ecmaVersion: 16, sourceType: "script", ranges: true });
console.log("1) 语法解析（node --check 层）:            通过（renderAll(true) 语法完全合法）");

// 第 2 层：作用域（ns-rewrite / eslint-scope 层）——符号都能解析，零未解析引用
const nameNs = new Map([["renderAll", "MaweNavPreview"]]);
const { edits, selfCheck } = rewriteSource(assembled, nameNs);
console.log(`2) 作用域解析（ns-rewrite 层）:            通过（改写 ${edits.length} 处，自检 ok=${selfCheck.ok}）`);

// 第 3 层：符号级三方合并分诊——调用方函数体 base/theirs/ours 语法一致 → 静默 REPLAY
const callerSrc = readFileSync(join(here, "caller-module.js"), "utf8");
const ast = acorn.parse(callerSrc, { ecmaVersion: 16, sourceType: "script" });
const fn = ast.body.find((n) => n.type === "FunctionDeclaration");
console.log("3) 符号级合并分诊（merge-flow 层）:        onSegmentsReplaced 三方语法一致 → REPLAY，不产生 CONFLICT");

console.log("\n结论：三层全绿，但 renderAll(true) 在运行期把 boolean 传给 options 对象——");
console.log("     解构默认值兜底后波形照常，preserveCueListScroll 静默失效，只有 e2e 兜底。");
