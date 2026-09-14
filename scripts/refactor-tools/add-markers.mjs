// 给 markers 表批量补充模块条目。
import fs from "node:fs";
const p = "tests/test_editor_assets.py";
let s = fs.readFileSync(p, "utf8");
const mods = [
  ["editor-gap-remove-ui", "MaweGapRemoveUi"],
  ["editor-selection", "MaweSelection"],
  ["editor-binding-align", "MaweBindingAlign"],
  ["editor-cue-panel", "MaweCuePanel"],
  ["editor-cue-elements", "MaweCueElements"],
  ["editor-color-filter", "MaweColorFilter"],
  ["editor-search", "MaweSearch"],
  ["editor-inline-edit", "MaweInlineEdit"],
  ["editor-split-core", "MaweSplitCore"],
  ["editor-split-context", "MaweSplitContext"],
  ["editor-segment-ops", "MaweSegmentOps"],
  ["editor-nav-preview", "MaweNavPreview"],
  ["editor-cue-events", "MaweCueEvents"],
  ["editor-cue-list-anchor", "MaweCueListAnchor"],
];
const anchor = '            "editor-theme.js": "(function initMaweTheme(global) {",';
const add = mods.map(([m, ns]) => `            "${m}.js": "(function init${ns}(global) {",`).join("\n");
if (!s.includes(anchor)) throw new Error("anchor 未找到");
s = s.replace(anchor, anchor + "\n" + add);
fs.writeFileSync(p, s, "utf8");
console.log("markers 补充 " + mods.length + " 条");
