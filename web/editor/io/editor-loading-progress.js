// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


const editorLoading = document.getElementById('editor-loading');

const editorLoadingLabel = document.getElementById('editor-loading-label');

const editorLoadingProgress = document.getElementById('editor-loading-progress');

const editorLoadingProgressValue = document.getElementById('editor-loading-progress-value');

let editorLoadingDepth = 0;


import { MaweProjectLoad } from "./editor-project-load.js";function updateEditorLoading(progress, label = null) {
  if (!editorLoading || editorLoadingDepth <= 0) return;
  const value = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
  if (label) editorLoadingLabel.textContent = label;
  editorLoadingProgress.value = value;
  editorLoadingProgressValue.textContent = `${value}%`;
}


import { MaweDragDrop } from "./editor-drag-drop.js";function beginEditorLoading(label, progress = 0) {
  if (!editorLoading) return () => {};
  editorLoadingDepth += 1;
  editorLoading.hidden = false;
  updateEditorLoading(progress, label);
  return () => {
    editorLoadingDepth = Math.max(0, editorLoadingDepth - 1);
    if (!editorLoadingDepth) editorLoading.hidden = true;
  };
}

async function readFileTextWithProgress(file) {
  updateEditorLoading(20, `正在读取 ${file?.name || '文件'}…`);
  return window.AsrEditorUtils.decodeSubtitleText(await file.arrayBuffer());
}

async function parseSubtitleImportFile(file) {
  const finishLoading = beginEditorLoading(`正在读取字幕 ${file.name}…`, 5);
  try {
    if (MaweDragDrop.isSrtFile(file)) return MaweProjectLoad.parseSrtSegments(await readFileTextWithProgress(file));
    if (MaweDragDrop.isLrcFile(file)) return window.AsrEditorUtils.parseLrcSegments(await readFileTextWithProgress(file));
    const data = JSON.parse(await readFileTextWithProgress(file));
    if (!data || !Array.isArray(data.segments)) throw new Error('缺少有效 segments 数组');
    const sourceSegments = data.segments.map((segment) => {
      const copy = {
        start: segment.start,
        end: segment.end,
        text: typeof segment.text === 'string' ? segment.text : '',
      };
      if (Array.isArray(segment.items)) {
        copy.items = segment.items.map((item) => ({ ...item }));
      }
      return copy;
    });
    window.AsrEditorUtils.normalizeSegmentTimings(sourceSegments);
    const validSegments = sourceSegments.filter((segment) => segment.text.trim());
    if (!validSegments.length) {
      throw new Error('副字幕没有可导入的有效文本或时间码');
    }
    return validSegments;
  } finally {
    finishLoading();
  }
}

window.MaweLoadingProgress = Object.freeze({
  editorLoading,
  editorLoadingLabel,
  editorLoadingProgress,
  editorLoadingProgressValue,
  get editorLoadingDepth() { return editorLoadingDepth; },
  set editorLoadingDepth(v) { editorLoadingDepth = v; },
  updateEditorLoading,
  beginEditorLoading,
  readFileTextWithProgress,
  parseSubtitleImportFile
});

export const MaweLoadingProgress = Object.freeze({
    editorLoading,
    editorLoadingLabel,
    editorLoadingProgress,
    editorLoadingProgressValue,
    get editorLoadingDepth() { return editorLoadingDepth; },
    set editorLoadingDepth(v) { editorLoadingDepth = v; },
    updateEditorLoading,
    beginEditorLoading,
    readFileTextWithProgress,
    parseSubtitleImportFile
  });
window.MaweLoadingProgress = MaweLoadingProgress;
