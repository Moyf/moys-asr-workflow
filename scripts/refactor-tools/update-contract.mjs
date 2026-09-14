// 契约测试更新：追加 timeline / speaker-labels 两个条目。
import fs from "node:fs";
const p = "tests/test_editor_assets.py";
let s = fs.readFileSync(p, "utf8");
const t1 = '                "editor-timeline.js",\n';
if (!s.includes('                "editor-speaker-labels.js",\n')) {
  s = s.replace(t1, t1 + '                "editor-speaker-labels.js",\n');
}
const a1 = '            "editor-theme.js": "(function initMaweTheme(global) {",';
const add1 = '            "editor-timeline.js": "(function initMaweTimeline(global) {",\n'
  + '            "editor-speaker-labels.js": "(function initMaweSpeakerLabels(global) {",\n';
if (!s.includes('"editor-timeline.js": "(function initMaweTimeline')) {
  s = s.replace(a1, add1 + a1);
}
fs.writeFileSync(p, s, "utf8");
console.log("契约已更新");
