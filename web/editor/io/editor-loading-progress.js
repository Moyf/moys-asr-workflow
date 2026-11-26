import { MaweProjectValidation } from '../../shared/utils/project-validation.js';
import { MaweDragDrop } from './editor-drag-drop.js';
import { MaweJsonRepair } from './editor-json-repair.js';
import { MaweProjectLoad } from './editor-project-load.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';
export let MaweLoadingProgress;
export function initLoadingProgressModule() {
  // 加载进度：进度条状态机与带进度的文件读取。
  // 由 split-cluster codemod 自 editor.js 拆出。
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
    return AsrEditorUtils.decodeSubtitleText(await file.arrayBuffer());
  }



  async function parseSubtitleImportFile(file) {
    const finishLoading = beginEditorLoading(`正在读取字幕 ${file.name}…`, 5);
    try {
      if (MaweDragDrop.isSrtFile(file)) return MaweProjectLoad.parseSrtSegments(await readFileTextWithProgress(file));
      if (MaweDragDrop.isLrcFile(file)) return AsrEditorUtils.parseLrcSegments(await readFileTextWithProgress(file));
      const imported = MaweProjectValidation.prepareProject(JSON.parse(await readFileTextWithProgress(file)));
      if (!imported.ok) throw new Error(imported.errors.map(error => `${error.path}: ${error.message}`).join('; '));
      const data = imported.project;
      MaweJsonRepair.noteImportReport(imported.changes);
      const sourceTrack = AsrEditorUtils.getMainTrack(data);
      const sourceSegments = AsrEditorUtils.cloneJsonValue(sourceTrack.segments);
      const validSegments = sourceSegments.filter((segment) => segment.text.trim());
      if (!validSegments.length) {
        throw new Error('副字幕没有可导入的有效文本或时间码');
      }
      Object.defineProperties(validSegments, {
        subtitle_groups: { value: AsrEditorUtils.cloneJsonValue(data.subtitle_groups) },
        speakers: { value: AsrEditorUtils.cloneJsonValue(data.speakers) },
        sourceTrack: { value: AsrEditorUtils.cloneJsonValue({ ...sourceTrack, segments: undefined }) },
        sourceStyle: { value: AsrEditorUtils.cloneJsonValue((data.styles || []).find(style => style.id === sourceTrack.style?.style_id) || null) },
      });
      return validSegments;
    } finally {
      finishLoading();
    }
  }

  MaweLoadingProgress = Object.freeze({
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
}
