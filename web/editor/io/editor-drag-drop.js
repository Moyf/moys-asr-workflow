// 拖放：文件拖入分流与拖拽遮罩。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweDragDrop 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweDragDrop(global) {
  'use strict';



  // === Drag & Drop：拖入视频/音频/JSON/SRT/LRC 自动加载 ===
  const dragOverlay = document.getElementById('drag-overlay');


  function isJsonFile(f) {
    const name = f.name.toLowerCase();
    return f.type === 'application/json' || name.endsWith('.json') || name.endsWith('.mosp');
  }


  function isSrtFile(f) {
    return f.name.toLowerCase().endsWith('.srt');
  }


  function isLrcFile(f) {
    return f.name.toLowerCase().endsWith('.lrc');
  }


  async function handleDroppedFiles(files) {
  if (!files.length) return;
  const finishLoading = MaweLoadingProgress.beginEditorLoading('正在处理拖入文件…', 2);
  try {
  const mediaFile = files.find(MaweCoreState.isMediaFile);
  const reapeaksFile = files.find(MaweCoreState.isReapeaksFile);
  const jsonFile = files.find(isJsonFile);
  const subtitleFile = files.find((file) => isSrtFile(file) || isLrcFile(file));
  let stagedSubtitleSegments = null;
  if (!mediaFile && !reapeaksFile && !jsonFile && !subtitleFile) {
    MaweHint.flashHint('不支持的文件类型（仅支持视频 / 音频 / JSON / SRT / LRC / reapeaks）', 'warning');
    return;
  }
  if (jsonFile) {
    if (MaweBoot.DATA.segments.length > 0) {
      if (MaweServerSave.hasUnsavedProjectChanges()
          && !confirm('当前有未保存的改动，是否继续处理此工程文件？选择“打开工程”仍会替换当前工程。')) return;
      try {
        const segments = await MaweLoadingProgress.parseSubtitleImportFile(jsonFile);
        await MaweMultiImport.showMultiSubtitleImportChoice(jsonFile, segments, {
          projectFile: jsonFile,
          projectMediaFile: mediaFile,
        });
      } catch (error) {
        MaweHint.flashHint(`导入工程字幕失败：${error.message || error}`, 'warning');
      }
      return;
    }
    // 工程与媒体一起拖入时，媒体随工程自动加载，不再弹窗要求重选。
    const opened = await MaweMultiImport.openProjectFile(jsonFile, { suppressMediaPrompt: Boolean(mediaFile), mediaFile });
    if (opened && mediaFile && !window.MOSEDesktop?.pathForFile?.(jsonFile)) await MaweMediaLoad.loadMediaFile(mediaFile);
    return;
  }
  if (reapeaksFile && !mediaFile && !subtitleFile) {
    await MaweMediaLoad.loadReapeaksFile(reapeaksFile);
    return;
  }
  if (subtitleFile && MaweBoot.DATA.segments.length === 0) {
    try {
      stagedSubtitleSegments = await parseDroppedSubtitleFile(subtitleFile);
    } catch (error) {
      MaweHint.flashHint(`导入字幕失败：${error.message || error}`, 'warning');
      return;
    }
  }
  if ((mediaFile || subtitleFile) && !await MaweProjectLoad.ensureProjectCheckpointForImport(mediaFile || subtitleFile, { usePicker: false })) return;
  if (mediaFile) {
    const imported = await MaweMediaLoad.loadMediaFile(mediaFile);
    if (imported) MaweServerSave.projectImportDirty = true;
  }
  if (reapeaksFile) await MaweMediaLoad.loadReapeaksFile(reapeaksFile);
  if (subtitleFile) {
    if (MaweBoot.DATA.segments.length > 0) {
      try {
        const segments = await MaweLoadingProgress.parseSubtitleImportFile(subtitleFile);
        await MaweMultiImport.showMultiSubtitleImportChoice(subtitleFile, segments);
      } catch (error) {
        MaweHint.flashHint(`导入字幕失败：${error.message || error}`, 'warning');
      }
    } else {
      MaweProjectLoad.replaceMainTrack(stagedSubtitleSegments, subtitleFile.name, { overlaySegments: stagedSubtitleSegments.overlaySegments || [] });
    }
  }
  if ((mediaFile || subtitleFile) && MaweServerSave.projectSaveTargetEnabled()) await MaweProjectSave.saveCurrentProject({ silent: true });
  MaweLoadingProgress.updateEditorLoading(100, '文件加载完成');
  } finally {
    finishLoading();
  }
}


  // SRT 与 LRC 都按文本读取（内部自动处理 BOM/GBK），仅解析器不同。
  async function parseDroppedSubtitleFile(file) {
    const text = await MaweLoadingProgress.readFileTextWithProgress(file);
    return isLrcFile(file) ? window.AsrEditorUtils.parseLrcSegments(text) : MaweProjectLoad.parseSrtSegments(text);
  }


  let dragCounter = 0;

  global.MaweDragDrop = Object.freeze({
    dragOverlay,
    isJsonFile,
    isSrtFile,
    isLrcFile,
    handleDroppedFiles,
    get dragCounter() { return dragCounter; },
    set dragCounter(v) { dragCounter = v; }
  });
})(typeof window !== 'undefined' ? window : globalThis);
