// 动态导出：FCP7XML、Lottie、Ograf 模态与导出。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweDynamicExports 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweDynamicExports(global) {
  'use strict';



  function closeFcp7ExportModal() {
    MaweDom.fcp7ExportModal.classList.remove('show');
  }



  function openFcp7ExportModal() {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  if (MaweInlineEdit.extensionEditingState) MaweInlineEdit.finishExtensionEdit(true);
  MaweCuePanel.commitCuePanelEdit();
  const extensionAvailable = Boolean(MaweMultiSubtitleCore.getActiveExtensionTrack());
  const overlayAvailable = overlayTrackVisible();
  const extensionOption = MaweDom.fcp7ExportSubtitleTracks.querySelector('option[value="main_and_extension"]');
  extensionOption.disabled = !extensionAvailable;
  const overlayOption = MaweDom.fcp7ExportSubtitleTracks.querySelector('option[value="overlay"]');
  overlayOption.disabled = !overlayAvailable;
  const allOption = MaweDom.fcp7ExportSubtitleTracks.querySelector('option[value="all"]');
  allOption.disabled = !extensionAvailable && !overlayAvailable;
  if (!extensionAvailable && MaweDom.fcp7ExportSubtitleTracks.value === 'main_and_extension') {
    MaweDom.fcp7ExportSubtitleTracks.value = 'main';
  }
  if (!overlayAvailable && ['overlay', 'all'].includes(MaweDom.fcp7ExportSubtitleTracks.value)) {
    MaweDom.fcp7ExportSubtitleTracks.value = 'main';
  }
  MaweDom.fcp7ExportNativeText.checked = true;
  MaweDom.fcp7ExportSubtitleTracks.disabled = !MaweDom.fcp7ExportNativeText.checked;
  MaweDom.fcp7ExportModal.classList.add('show');
  MaweDom.fcp7ExportTimelineMode.focus();
}



  async function exportFcp7Xml() {
    MaweDom.fcp7ExportConfirm.disabled = true;
    try {
      const durationMs = MaweCoreState.waveformEditor?.durationMs
        || Math.round(Number(MaweCoreState.player?.duration) * 1000)
        || MaweBoot.DATA.waveform?.duration_ms
        || 0;
      const options = window.AsrEditorUtils.normalizeExportOptions({
        timelineMode: MaweDom.fcp7ExportTimelineMode.value,
        fps: MaweDom.fcp7ExportFps.value,
        subtitleTracks: MaweDom.fcp7ExportSubtitleTracks.value,
        nativeTextObjects: MaweDom.fcp7ExportNativeText.checked,
        baseName: MaweBoot.FILENAME_BASE,
      });
      const plan = window.AsrEditorUtils.buildProjectExportPlan(MaweBoot.DATA, {
        ...options,
        durationMs: Math.round(durationMs),
      });
      const [artifact] = window.AsrEditorUtils.buildFcp7ExportArtifacts(plan, options);
      closeFcp7ExportModal();
      const result = await MaweExportTimeline.downloadFile(
        artifact.content,
        artifact.filename,
        artifact.mime,
        { desc: 'FCP 7 XML', types: { 'application/xml': ['.xml'] } },
         { detailed: true },
      );
      const messages = {
        saved: ['FCP 7 XML 已保存', 'success'],
        dispatched: ['FCP 7 XML 下载已发起', 'success'],
        cancelled: ['FCP 7 XML 保存已取消', 'invalid'],
        failed: ['FCP 7 XML 保存失败', 'warning'],
      };
      const [message, type] = messages[result.status] || messages.failed;
      MaweHint.flashHint(MaweProjectSave.translatedEditorText(message), type);
    } catch (error) {
      MaweHint.flashHint(`${MaweProjectSave.translatedEditorText('FCP 7 XML 导出失败')}：${error.message}`, 'warning');
    } finally {
      MaweDom.fcp7ExportConfirm.disabled = false;
    }
  }



  function lottieExportAvailable() {
    return Boolean(MaweBoot.SERVER_CONFIG?.canLottieExport && MaweBoot.SERVER_CONFIG?.lottieExportUrl);
  }



  function updateLottieExportButton() {
    const button = document.getElementById('download-lottie');
    if (!button) return;
    if (!button.dataset.originalTitle) button.dataset.originalTitle = button.title;
    const disabled = !lottieExportAvailable();
    button.classList.toggle('sticker-disabled', disabled);
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    button.title = disabled
      ? MaweProjectSave.translatedEditorText('服务器打包模式不可用：请以 server-editor 打开并绑定工程文件后再导出动态字幕')
      : button.dataset.originalTitle;
  }



  function lottieExportBlocked() {
    if (lottieExportAvailable()) return false;
    const message = '当前模式不可用：动态字幕 .lottie 导出需要以 server-editor 打开并绑定工程文件';
    MaweHint.flashHint(window.MAWE_I18N?.translateText?.(message) || message, 'warning');
    return true;
  }



  function closeLottieExportModal() {
    MaweDom.lottieExportModal?.classList.remove('show');
  }



  function openLottieExportModal() {
  if (lottieExportBlocked()) return;
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  if (MaweInlineEdit.extensionEditingState) MaweInlineEdit.finishExtensionEdit(true);
  MaweCuePanel.commitCuePanelEdit();
  const extensionOption = MaweDom.lottieExportTrack?.querySelector('option[value="extension"]');
  const extensionAvailable = Boolean(MaweMultiSubtitleCore.getActiveExtensionTrack());
  if (extensionOption) extensionOption.disabled = !extensionAvailable;
  if (!extensionAvailable && MaweDom.lottieExportTrack) MaweDom.lottieExportTrack.value = 'main';
  applyMediaSizeToResolutionModal(
    MaweDom.lottieExportResolution, lottieExportCustomSize, lottieExportCustomWidth, lottieExportCustomHeight,
  );
  MaweDom.lottieExportModal?.classList.add('show');
  MaweDom.lottieExportTrack?.focus();
}



  function lottieExportCanvasSize() {
  return dynamicExportCanvasSize(MaweDom.lottieExportResolution, lottieExportCustomWidth, lottieExportCustomHeight);
}



  async function exportLottieDynamicCaptions() {
    if (lottieExportBlocked()) return;
    MaweDom.lottieExportConfirm.disabled = true;
    try {
      const extension = MaweDom.lottieExportTrack?.value === 'extension';
      const track = extension ? MaweMultiSubtitleCore.getActiveExtensionTrack() : null;
      const sourceSegments = extension ? track?.segments : MaweBoot.DATA.segments;
      if (!Array.isArray(sourceSegments) || !sourceSegments.some((segment) => (
        !segment?.disabled && String(segment?.text || '').trim()
      ))) {
        throw new Error(MaweProjectSave.translatedEditorText(
          extension ? '当前副字幕轨没有可导出的字幕' : '当前主轨没有可导出的字幕',
        ));
      }
      const gapRemoved = MaweDom.lottieExportGapRemoved?.checked === true;
      const exportData = MaweExportSrt.buildDynamicCaptionExportData(sourceSegments, gapRemoved);
      if (!exportData) return;
      const { segments, durationMs } = exportData;
      if (!segments.some((segment) => !segment?.disabled && String(segment?.text || '').trim())) {
        throw new Error(MaweProjectSave.translatedEditorText(
          extension ? '当前副字幕轨没有可导出的字幕' : '当前主轨没有可导出的字幕',
        ));
      }
      const size = lottieExportCanvasSize();
      const appearance = extension ? MaweAppearance.getExtensionSubtitleAppearance() : MaweAppearance.getSubtitleAppearance();
      const animation = window.AsrEditorUtils.buildLottieAnimation(segments, {
        durationMs: Math.round(durationMs),
        fps: MaweDom.lottieExportFps?.value || '30',
        renderMode: MaweDom.lottieExportRenderMode?.value || 'text',
        width: size.width,
        height: size.height,
        subtitle: { ...MaweAppearance.getPreviewGeometry(), ...appearance },
      });
      MaweHint.flashHint(MaweProjectSave.translatedEditorText('正在生成动态字幕 .lottie…'));
      const response = await MaweHost.server.fetch(MaweBoot.SERVER_CONFIG.lottieExportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, animation }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `服务器返回 ${response.status}`);
      }
      const blob = await response.blob();
      closeLottieExportModal();
      const suffix = extension ? '_extension' : '';
      const gapSuffix = gapRemoved ? `_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}` : '';
      const saved = await MaweExportTimeline.downloadFile(
        blob,
        `${MaweBoot.FILENAME_BASE}${suffix}${gapSuffix}_dynamic-caption.lottie`,
        'application/zip+dotlottie',
        { desc: 'Lottie 动态字幕', types: { 'application/zip+dotlottie': ['.lottie'] } },
      );
      if (saved) MaweHint.flashHint(MaweProjectSave.translatedEditorText('动态字幕 .lottie 已生成'), 'success');
    } catch (error) {
      MaweHint.flashHint(`${MaweProjectSave.translatedEditorText('动态字幕 .lottie 导出失败')}：${error.message || error}`, 'warning');
    } finally {
      MaweDom.lottieExportConfirm.disabled = false;
    }
  }



  function ografExportAvailable() {
    return Boolean(MaweBoot.SERVER_CONFIG?.canOgrafExport && MaweBoot.SERVER_CONFIG?.ografExportUrl);
  }



  function updateOgrafExportButton() {
    const button = document.getElementById('download-ograf');
    if (!button) return;
    if (!button.dataset.originalTitle) button.dataset.originalTitle = button.title;
    const disabled = !ografExportAvailable();
    button.classList.toggle('sticker-disabled', disabled);
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    button.title = disabled
      ? MaweProjectSave.translatedEditorText('服务器打包模式不可用：请以 server-editor 打开并绑定工程文件后再导出动态字幕')
      : button.dataset.originalTitle;
  }



  function ografExportBlocked() {
    if (ografExportAvailable()) return false;
    const message = '当前模式不可用：OGraf 动态字幕导出需要以 server-editor 打开并绑定工程文件';
    MaweHint.flashHint(window.MAWE_I18N?.translateText?.(message) || message, 'warning');
    return true;
  }



  function closeOgrafExportModal() {
    MaweDom.ografExportModal?.classList.remove('show');
  }



  function openOgrafExportModal() {
  if (ografExportBlocked()) return;
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  if (MaweInlineEdit.extensionEditingState) MaweInlineEdit.finishExtensionEdit(true);
  MaweCuePanel.commitCuePanelEdit();
  const extensionOption = MaweDom.ografExportTrack?.querySelector('option[value="extension"]');
  const extensionAvailable = Boolean(MaweMultiSubtitleCore.getActiveExtensionTrack());
  if (extensionOption) extensionOption.disabled = !extensionAvailable;
  if (!extensionAvailable && MaweDom.ografExportTrack) MaweDom.ografExportTrack.value = 'main';
  applyMediaSizeToResolutionModal(
    MaweDom.ografExportResolution, ografExportCustomSize, ografExportCustomWidth, ografExportCustomHeight,
  );
  MaweDom.ografExportModal?.classList.add('show');
  MaweDom.ografExportTrack?.focus();
}



  function ografExportCanvasSize() {
  return dynamicExportCanvasSize(MaweDom.ografExportResolution, ografExportCustomWidth, ografExportCustomHeight);
}



  async function exportOgrafDynamicCaptions() {
    if (ografExportBlocked()) return;
    MaweDom.ografExportConfirm.disabled = true;
    try {
      const extension = MaweDom.ografExportTrack?.value === 'extension';
      const track = extension ? MaweMultiSubtitleCore.getActiveExtensionTrack() : null;
      const sourceSegments = extension ? track?.segments : MaweBoot.DATA.segments;
      if (!Array.isArray(sourceSegments) || !sourceSegments.some((segment) => (
        !segment?.disabled && String(segment?.text || '').trim()
      ))) {
        throw new Error(MaweProjectSave.translatedEditorText(
          extension ? '当前副字幕轨没有可导出的字幕' : '当前主轨没有可导出的字幕',
        ));
      }
      const gapRemoved = MaweDom.ografExportGapRemoved?.checked === true;
      const exportData = MaweExportSrt.buildDynamicCaptionExportData(sourceSegments, gapRemoved);
      if (!exportData) return;
      const { segments, durationMs } = exportData;
      if (!segments.some((segment) => !segment?.disabled && String(segment?.text || '').trim())) {
        throw new Error(MaweProjectSave.translatedEditorText(
          extension ? '当前副字幕轨没有可导出的字幕' : '当前主轨没有可导出的字幕',
        ));
      }
      const size = ografExportCanvasSize();
      const appearance = extension ? MaweAppearance.getExtensionSubtitleAppearance() : MaweAppearance.getSubtitleAppearance();
      const graphic = window.AsrEditorUtils.buildOgrafGraphic(segments, {
        durationMs: Math.round(durationMs),
        fps: MaweDom.ografExportFps?.value || '30',
        width: size.width,
        height: size.height,
        subtitle: { ...MaweAppearance.getPreviewGeometry(), ...appearance },
      });
      MaweHint.flashHint(MaweProjectSave.translatedEditorText('正在生成动态字幕 .ograf.zip…'));
      const response = await MaweHost.server.fetch(MaweBoot.SERVER_CONFIG.ografExportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, graphic }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `服务器返回 ${response.status}`);
      }
      const blob = await response.blob();
      closeOgrafExportModal();
      const suffix = extension ? '_extension' : '';
      const gapSuffix = gapRemoved ? `_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}` : '';
      const saved = await MaweExportTimeline.downloadFile(
        blob,
        `${MaweBoot.FILENAME_BASE}${suffix}${gapSuffix}_dynamic-caption.ograf.zip`,
        'application/zip',
        { desc: 'OGraf 动态字幕', types: { 'application/zip': ['.zip'] } },
      );
      if (saved) MaweHint.flashHint(MaweProjectSave.translatedEditorText('动态字幕 .ograf.zip 已生成；请先解压'), 'success');
    } catch (error) {
      MaweHint.flashHint(`${MaweProjectSave.translatedEditorText('动态字幕 .ograf.zip 导出失败')}：${error.message || error}`, 'warning');
    } finally {
      MaweDom.ografExportConfirm.disabled = false;
    }
  }

  global.MaweDynamicExports = Object.freeze({
    closeFcp7ExportModal,
    openFcp7ExportModal,
    exportFcp7Xml,
    lottieExportAvailable,
    updateLottieExportButton,
    lottieExportBlocked,
    closeLottieExportModal,
    openLottieExportModal,
    lottieExportCanvasSize,
    exportLottieDynamicCaptions,
    ografExportAvailable,
    updateOgrafExportButton,
    ografExportBlocked,
    closeOgrafExportModal,
    openOgrafExportModal,
    ografExportCanvasSize,
    exportOgrafDynamicCaptions
  });
})(typeof window !== 'undefined' ? window : globalThis);
