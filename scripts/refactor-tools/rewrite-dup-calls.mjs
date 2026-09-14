// 把指向已删除模块副本的调用点改回 editor.js 全局裸名。
import fs from "node:fs";
const f = "web/editor.js";
let s = fs.readFileSync(f, "utf8");
const before = s;
for (const n of ["buildExtensionSrt", "buildGapRemovedSrt", "usedSubtitleColors", "updateSubtitleExportUi"]) {
  s = s.split(`MaweExportSrt.${n}`).join(n);
}
for (const n of ["renderedCueBoundaryTarget", "navigateCueListBoundary"]) {
  s = s.split(`MaweKeyboardTargets.${n}`).join(n);
}
fs.writeFileSync(f, s, "utf8");
console.log(`改写 ${before !== s ? "有变更" : "无变更"}`);
