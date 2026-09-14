// 拖放：文件拖入分流与拖拽遮罩。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweDragDrop 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweDragDrop(global) {
  'use strict';



  // === Drag & Drop：拖入视频/音频/JSON/SRT 自动加载 ===
  const dragOverlay = document.getElementById('drag-overlay');


  function isJsonFile(f) {
    const name = f.name.toLowerCase();
    return f.type === 'application/json' || name.endsWith('.json') || name.endsWith('.mosp');
  }


  function isSrtFile(f) {
    return f.name.toLowerCase().endsWith('.srt');
  }


  async function handleDroppedFiles(files) {
    if (!files.length) return;
    const finishLoading = MaweLoadingProgress.beginEditorLoading('正在处理拖入文件…', 2);
    try {
    const mediaFile = files.find(MaweCoreState.isMediaFile);
    const reapeaksFile = files.find(MaweCoreState.isReapeaksFile);
    const jsonFile = files.find(isJsonFile);
    const srtFile = files.find(isSrtFile);
    let stagedSrtSegments = null;
    if (!mediaFile && !reapeaksFile && !jsonFile && !srtFile) {
      MaweHint.flashHint('不支持的文件类型（仅支持视频 / 音频 / JSON / SRT / reapeaks）', 'warning');
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
      const opened = await MaweMultiImport.openProjectFile(jsonFile, { suppressMediaPrompt: Boolean(mediaFile) });
      if (opened && mediaFile) await MaweMediaLoad.loadMediaFile(mediaFile);
      return;
    }
    if (reapeaksFile && !mediaFile && !srtFile) {
      await MaweMediaLoad.loadReapeaksFile(reapeaksFile);
      return;
    }
    if (srtFile && MaweBoot.DATA.segments.length === 0) {
      try {
        stagedSrtSegments = MaweProjectLoad.parseSrtSegments(await MaweLoadingProgress.readFileTextWithProgress(srtFile));
      } catch (error) {
        MaweHint.flashHint(`导入字幕失败：${error.message || error}`, 'warning');
        return;
      }
    }
    if ((mediaFile || srtFile) && !await MaweProjectLoad.ensureProjectCheckpointForImport(mediaFile || srtFile, { usePicker: false })) return;
    if (mediaFile) {
      const imported = await MaweMediaLoad.loadMediaFile(mediaFile);
      if (imported) MaweServerSave.projectImportDirty = true;
    }
    if (reapeaksFile) await MaweMediaLoad.loadReapeaksFile(reapeaksFile);
    if (srtFile) {
      if (MaweBoot.DATA.segments.length > 0) {
        try {
          const segments = await MaweLoadingProgress.parseSubtitleImportFile(srtFile);
          await MaweMultiImport.showMultiSubtitleImportChoice(srtFile, segments);
        } catch (error) {
          MaweHint.flashHint(`导入字幕失败：${error.message || error}`, 'warning');
        }
      } else {
        MaweProjectLoad.replaceMainTrack(stagedSrtSegments, srtFile.name);
      }
    }
    if ((mediaFile || srtFile) && MaweServerSave.projectSaveTargetEnabled()) await MaweProjectSave.saveCurrentProject({ silent: true });
    MaweLoadingProgress.updateEditorLoading(100, '文件加载完成');
    } finally {
      finishLoading();
    }
  }


  let dragCounter = 0;

  global.MaweDragDrop = Object.freeze({
    dragOverlay,
    isJsonFile,
    isSrtFile,
    handleDroppedFiles,
    get dragCounter() { return dragCounter; },
    set dragCounter(v) { dragCounter = v; }
  });
})(typeof window !== 'undefined' ? window : globalThis);
