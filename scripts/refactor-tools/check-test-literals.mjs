// 一次性校验：测试文件里所有 assertIn 字面量是否存在于当前产物语料。
// 用法: node scripts/refactor-tools/check-test-literals.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const page = fs.readFileSync(path.join(process.env.TEMP, "blank-current.html"), "utf8");
const webDir = path.join(root, "web");
const files = fs.readdirSync(webDir).filter((f) => f.startsWith("editor") && f.endsWith(".js"));
const corpus = page + files.map((f) => fs.readFileSync(path.join(webDir, f), "utf8")).join("");

const testFiles = ["tests/test_waveform.py", "tests/test_editor_assets.py", "tests/test_gui_web.py"];
const text = testFiles.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
const re = /assertIn\(\s*(?:f)?'((?:[^'\\]|\\.)*)'|assertIn\(\s*(?:f)?"((?:[^"\\]|\\.)*)"/g;
let m, fails = 0, total = 0;
while ((m = re.exec(text))) {
  const raw = m[1] ?? m[2];
  if (raw.includes("{")) continue; // f-string 插值，无法静态还原
  const s = raw.replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (s.length < 8) continue;
  total += 1;
  if (!corpus.includes(s)) {
    fails += 1;
    console.log("MISS: " + s.slice(0, 120).replace(/\n/g, "\\n"));
  }
}
console.log(`共检查 ${total} 个字面量，缺失 ${fails}`);
