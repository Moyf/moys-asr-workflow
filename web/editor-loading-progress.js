// 加载进度：进度条状态机与带进度的文件读取。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweLoadingProgress 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweLoadingProgress(global) {
  'use strict';



  const editorLoading = document.getElementById('editor-loading');


  const editorLoadingLabel = document.getElementById('editor-loading-label');


  const editorLoadingProgress = document.getElementById('editor-loading-progress');


  const editorLoadingProgressValue = document.getElementById('editor-loading-progress-value');


  let editorLoadingDepth = 0;



  function updateEditorLoading(progress, label = null) {
    if (!editorLoading || editorLoadingDepth <= 0) return;
    const value = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
    if (label) editorLoadingLabel.textContent = label;
    editorLoadingProgress.value = value;
    editorLoadingProgressValue.textContent = `${value}%`;
  }



  function beginEditorLoading(label, progress = 0) {
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
      if (isSrtFile(file)) return MaweProjectLoad.parseSrtSegments(await readFileTextWithProgress(file));
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

  global.MaweLoadingProgress = Object.freeze({
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
})(typeof window !== 'undefined' ? window : globalThis);
