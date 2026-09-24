// 复刻 merge-flow 的 ownerOf 判定，检查指定符号的归属。
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

const WEB = path.resolve("web");
const IGNORE_KEYS = new Set(["start", "end", "loc", "range"]);
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (IGNORE_KEYS.has(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value.type === "string") walk(value, visit);
  }
}
function exportedNames(ast, namespace) {
  const names = new Set();
  walk(ast, (node) => {
    if (node.type !== "AssignmentExpression" || node.left.type !== "MemberExpression"
        || node.left.computed || node.left.property.name !== namespace) return;
    let object = node.right;
    if (object.type === "CallExpression" && object.callee.type === "MemberExpression"
        && !object.callee.computed && object.callee.object.name === "Object"
        && object.callee.property.name === "freeze") object = object.arguments[0];
    if (object?.type !== "ObjectExpression") return;
    for (const property of object.properties) {
      if (property.type === "Property" && property.value?.type === "Identifier") names.add(property.value.name);
      if (property.type === "Property" && property.key?.type === "Identifier") names.add(property.key.name);
    }
  });
  return names;
}
const files = fs.readdirSync(WEB).filter((f) => /^editor-.*\.js$/.test(f)).sort();
const ownerOf = new Map();
for (const f of files) {
  const source = fs.readFileSync(path.join(WEB, f), "utf8");
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const freeze = source.match(/(?:global|window)\.(\w+)\s*=\s*(?:Object\.freeze\s*\()?[{[]/);
  if (!freeze) continue;
  for (const name of exportedNames(ast, freeze[1])) {
    if (!ownerOf.has(name)) ownerOf.set(name, `${f} [${freeze[1]}]`);
  }
}
console.log(`ownerOf 大小: ${ownerOf.size}`);
for (const n of process.argv.slice(2)) {
  console.log(`${n} => ${ownerOf.get(n) ?? "(无所有者→应留在入口)"}`);
}
