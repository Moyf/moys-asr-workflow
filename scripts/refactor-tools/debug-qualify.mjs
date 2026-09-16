// 最小复现：qualifyDeclaration 为何把局部 const start 改成 MAWE_I18N.start。
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

// 复刻工具的三个函数
const IGNORE_KEYS = new Set(["start", "end", "loc", "range"]);
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (IGNORE_KEYS.has(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value.type === "string") walk(value, visit, node);
  }
}
function patternNames(pattern, names = new Set()) {
  if (!pattern) return names;
  if (pattern.type === "Identifier") names.add(pattern.name);
  else if (pattern.type === "AssignmentPattern") patternNames(pattern.left, names);
  else if (pattern.type === "RestElement") patternNames(pattern.argument, names);
  else if (pattern.type === "ArrayPattern") for (const item of pattern.elements) patternNames(item, names);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) {
    if (property.type === "RestElement") patternNames(property.argument, names);
    else patternNames(property.value, names);
  }
  return names;
}
function localNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator") patternNames(node.id, names);
    else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) names.add(node.id.name);
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      for (const parameter of node.params) patternNames(parameter, names);
    } else if (node.type === "CatchClause" && node.param) patternNames(node.param, names);
  });
  return names;
}

const raw = fs.readFileSync(process.env.TEMP + "/addoverlay-main.txt", "utf8");
const ast = acorn.parse(raw, { ecmaVersion: "latest", sourceType: "script" });
const locals = localNames(ast);
console.log("locals 含 start:", locals.has("start"), "| 含 end:", locals.has("end"));
console.log("locals 大小:", locals.size, [...locals].slice(0, 20).join(","));
