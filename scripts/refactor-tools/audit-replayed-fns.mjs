// 绑定感知审计 v2：对 72 个重放符号，在其所在模块内找定义，与 main 原版对比局部名误 NS 化。
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

const WEB = path.resolve("web");
const mainSrc = fs.readFileSync(path.join(process.env.TEMP, "main-editor3.js"), "utf8");

function extractFn(src, name) {
  const idx = src.indexOf(`function ${name}(`);
  if (idx < 0) return null;
  let paren = 0, k = idx, bodyStart = -1;
  for (; k < src.length; k++) {
    const ch = src[k];
    if (ch === "'" || ch === '"' || ch === "`") { const q = ch; k++; while (k < src.length && src[k] !== q) { if (src[k] === "\\") k++; k++; } continue; }
    if (ch === "(") paren++;
    else if (ch === ")") { paren--; if (paren === 0) { bodyStart = k + 1; break; } }
  }
  if (bodyStart < 0) return null;
  let depth = 0, j = bodyStart;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === "'" || ch === '"' || ch === "`") { const q = ch; j++; while (j < src.length && src[j] !== q) { if (src[j] === "\\") j++; j++; } continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(idx, j);
}
function localBindings(fnText) {
  const out = new Set();
  try {
    const ast = acorn.parse(`(${fnText})`, { ecmaVersion: "latest" });
    walk.full(ast, (n) => {
      if (n.type === "VariableDeclarator" && n.id.type === "Identifier") out.add(n.id.name);
      else if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
        if (n.id) out.add(n.id.name);
        for (const p of n.params ?? []) walk.full(p, (c) => { if (c.type === "Identifier") out.add(c.name); });
      }
    });
  } catch { return null; }
  return out;
}

const replayed = ["restoreExtensionTrackSelection","syncProjectTimebase","snapshotSegments","snapshotEditorSelection","restoreEditorSelection","applyHistoryRecord","applyCueListDisplaySettings","updateMultiSubtitleUi","clearSelection","selectOnlyExtension","toggleExtensionSelection","selectExtensionRange","toggleSel","selectRange","selectOnly","addToSelection","addExtensionToSelection","selectAll","renderAll","getCurrentCuePanelTarget","getCuePanelTextElement","setCuePanelTarget","commitCuePanelEdit","renderCurrentCuePanel","navigateCuePanel","splitCuePanelAtCursor","updateCueStickerPresentation","buildCueEl","selectAllFilteredCues","refreshCueColorRows","refreshCueStickerRows","refreshStickerAssignmentUi","applySearch","renderLinkedSplitText","splitAutoSubmitReady","updateLinkedSplitPreview","confirmLinkedSplit","splitGroupsAtCutPoints","mergeAdjacentSubtitle","refreshSubtitlePreview","rebuildStickerIntervals","activeStickersAt","renderStickerOverlay","buildSrt","buildAss","buildGapRemovedSrt","usedSubtitleColors","downloadColorSrts","buildJson","normalizeProjectTimings","repairCurrentProjectTimings","buildGapRemovedSubtitleMarkers","buildTimelineOtio","collectStickerOtioEntries","buildStickerOtioTrack","hasUnsavedProjectChanges","openFcp7ExportModal","applyCanonicalProject","parseSrtSegments","replaceMainTrack","openSrtFile","openStickerPicker","assignSticker","openStickerPreview","removeStickerCascade","toggleDisabled","addCueRangeFromWaveform","showWaveformBlankMenu","showContextMenu","syncTimelineGroupRanges","initWaveformEditor","handleDroppedFiles"];

const moduleFiles = fs.readdirSync(WEB).filter((f) => /^editor-.*\.js$/.test(f) || f === "editor.js");
let bad = 0, checked = 0;
for (const name of replayed) {
  const mainFn = extractFn(mainSrc, name);
  if (!mainFn) { console.log(`${name}: main 提取失败`); continue; }
  const locals = localBindings(mainFn);
  if (!locals) { console.log(`${name}: main 局部绑定解析失败`); continue; }
  let found = null;
  for (const f of moduleFiles) {
    const src = fs.readFileSync(path.join(WEB, f), "utf8");
    const fn = extractFn(src, name);
    if (fn) { found = { f, fn }; break; }
  }
  if (!found) { console.log(`${name}: 模块树未找到定义`); bad += 1; continue; }
  checked += 1;
  const re = /\b(Mawe[A-Z]\w*)\.(\w+)/g;
  let m;
  while ((m = re.exec(found.fn)) !== null) {
    if (locals.has(m[2])) {
      console.log(`${name} @${found.f}: 误替换 ${m[1]}.${m[2]}（main 中是局部绑定）`);
      bad += 1;
    }
  }
}
console.log(`检查 ${checked} 个函数，误替换 ${bad} 处`);
