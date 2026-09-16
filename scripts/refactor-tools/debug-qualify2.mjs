// 用 merge-flow 的真实 qualify 逻辑复现 MAWE_I18N.start 误替换。
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

const WEB = path.resolve("web");
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
function identifierIsReference(node, parent) {
  if (!parent) return false;
  if (["FunctionDeclaration", "FunctionExpression", "ClassDeclaration"].includes(parent.type) && parent.id === node) return false;
  if (parent.type === "VariableDeclarator" && parent.id === node) return false;
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression")
      && parent.params.includes(node)) return false;
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === node && !parent.computed) return false;
  if ((parent.type === "Property" || parent.type === "MethodDefinition") && parent.key === node && !parent.computed && !parent.shorthand) return false;
  return !["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent.type);
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
function applyEdits(source, edits) {
  let previous = source.length + 1;
  const unique = new Map();
  for (const edit of edits) unique.set(`${edit.start}:${edit.end}`, edit);
  for (const edit of [...unique.values()].sort((a, b) => b.start - a.start)) {
    if (edit.end > previous) throw new Error(`overlapping edits near ${edit.start}`);
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    previous = edit.start;
  }
  return source;
}
// ownerOf（与工具一致）
const ownerOf = new Map();
for (const f of fs.readdirSync(WEB).filter((x) => /^editor-.*\.js$/.test(x)).sort()) {
  const source = fs.readFileSync(path.join(WEB, f), "utf8");
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const freeze = source.match(/(?:global|window)\.(\w+)\s*=\s*(?:Object\.freeze\s*\()?[{[]/);
  if (!freeze) continue;
  for (const name of exportedNames(ast, freeze[1])) {
    if (!ownerOf.has(name)) ownerOf.set(name, { file: f, ns: freeze[1] });
  }
}
console.log("start 的 owner:", JSON.stringify(ownerOf.get("start")));
console.log("end 的 owner:", JSON.stringify(ownerOf.get("end")));

const raw = fs.readFileSync(process.env.TEMP + "/addoverlay-main.txt", "utf8");
const ast = acorn.parse(raw, { ecmaVersion: "latest", sourceType: "script" });
const locals = localNames(ast);
console.log("locals 含 start:", locals.has("start"));
const edits = [];
walk(ast, (node, parent) => {
  if (node.type !== "Identifier" || !identifierIsReference(node, parent) || locals.has(node.name)) return;
  const owner = ownerOf.get(node.name);
  if (owner && owner.ns !== "MaweBoot") {
    const text = parent?.type === "Property" && parent.shorthand
      ? `${node.name}: ${owner.ns}.${node.name}` : `${owner.ns}.${node.name}`;
    edits.push({ start: node.start, end: node.end, at: raw.slice(Math.max(0, node.start - 25), node.start + 20), text });
  }
});
console.log("替换数:", edits.length);
edits.slice(0, 6).forEach((e) => console.log(`  [${e.at}] -> ${e.text}`));
