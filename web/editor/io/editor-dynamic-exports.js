import { overlayTrackVisible } from '../cues/overlay-track.js';
import { runFcp7PngExport } from './editor-fcp7-png.js';

export function initMaweDynamicExports() {
'use strict';

// 动态导出：FCP7XML、Lottie、Ograf 模态与导出。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweDynamicExports 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweDynamicExports(global) {
  'use strict';
  // The controls themselves retain edits while this project remains open.
  // A new binding starts from the new project's dimensions instead of inheriting
  // another project's choice. Nothing is written to global preferences.
  let fcp7PngSizeEpoch = null;



  function closeFcp7ExportModal() {
    if (MaweDom.fcp7ExportModal.dataset.busy) return;
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
  const epoch = MaweProjectLoad.projectBindingEpoch;
  if (fcp7PngSizeEpoch !== epoch) {
    fcp7PngSizeEpoch = epoch;
    const projectSize = MaweExportSrt.currentAssVideoResolution() || { width: 1920, height: 1080 };
    document.getElementById('fcp7-png-size').value = 'project';
    document.getElementById('fcp7-png-width').value = String(projectSize.width);
    document.getElementById('fcp7-png-height').value = String(projectSize.height);
    document.getElementById('fcp7-png-custom-size').hidden = true;
  }
  updateFcp7Mode();
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
        ...MaweSpeakerLabels.speakerLabelExportOptions(),
        assSpecialSymbolRule: MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule,
        durationMs: Math.round(durationMs),
      });
      if (document.getElementById('fcp7-export-format').value === 'png') {
        const size = document.getElementById('fcp7-png-size').value === 'custom'
          ? { width: Number(document.getElementById('fcp7-png-width').value), height: Number(document.getElementById('fcp7-png-height').value) }
          : (MaweExportSrt.currentAssVideoResolution() || { width: 1920, height: 1080 });
        if (![size.width, size.height].every(n => Number.isInteger(n) && n >= 1 && n <= 8192)
            || size.width * size.height > 33554432) {
          throw new Error(MaweProjectSave.translatedEditorText('图片宽高须为 1–8192 的整数，且总像素不超过 33554432'));
        }
        const status = document.getElementById('fcp7-export-status');
        const stop = document.getElementById('fcp7-export-stop');
        const controller = new AbortController();
        const controls = [...MaweDom.fcp7ExportModal.querySelectorAll('input, select')]
          .map(element => ({ element, disabled: element.disabled }));
        controls.forEach(({ element }) => { element.disabled = true; });
        const showStatus = text => { status.textContent = MaweProjectSave.translatedEditorText(text); };
        const stopExport = () => { controller.abort(); showStatus('正在停止图片字幕导出…'); };
        stop.hidden = false;
        stop.addEventListener('click', stopExport);
        MaweDom.fcp7ExportCancel.disabled = true;
        MaweDom.fcp7ExportModal.dataset.busy = 'true';
        try {
          const assOptions = { alignFirstStart: false, pngEventNames: true };
          const ass = options.timelineMode === 'gap_removed' && MaweGapRemoveData.getRemovedGapRanges().length
            ? MaweExportSrt.buildGapRemovedAss(assOptions) : MaweExportSrt.buildAss(assOptions);
          const layers = { main: [0], main_and_extension: [0, 1], extension: [1], overlay: [2], all: [0, 1, 2] }[options.subtitleTracks];
          const result = await runFcp7PngExport({ plan, ass, layers, size,
            includeMedia: document.getElementById('fcp7-export-scope').value === 'media',
            config: MaweBoot.SERVER_CONFIG, signal: controller.signal,
            onProgress: showStatus });
          showStatus(`已保存 ${result.imageCount} 张图片与 XML：${result.xmlPath}`);
          if (result.vegasXmlPath) status.textContent += '\n' + MaweProjectSave.translatedEditorText('VEGAS 兼容 XML：') + result.vegasXmlPath;
          if (result.fontNotices?.length) status.textContent += '\n' + result.fontNotices
            .map(message => MaweProjectSave.translatedEditorText(message)).join('\n');
          MaweHint.flashHint(MaweProjectSave.translatedEditorText('图片字幕 XML 已保存到工程旁的独立目录'), 'success');
        } catch (error) {
          showStatus(error?.name === 'AbortError' ? '图片字幕导出已停止' : `图片字幕导出失败：${error.message}`);
          if (error?.name === 'AbortError') return;
          throw error;
        } finally {
          stop.hidden = true;
          stop.removeEventListener('click', stopExport);
          MaweDom.fcp7ExportCancel.disabled = false;
          controls.forEach(({ element, disabled }) => { element.disabled = disabled; });
          delete MaweDom.fcp7ExportModal.dataset.busy;
        }
        return;
      }
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

  function updateFcp7Mode() {
    const png = document.getElementById('fcp7-export-format').value === 'png';
    document.getElementById('fcp7-export-png-options').hidden = !png;
    document.getElementById('fcp7-export-native-hint').hidden = png;
    document.getElementById('fcp7-export-title').textContent = MaweProjectSave.translatedEditorText(png ? 'PNG 字幕 · FCP 7 XML' : 'Premiere FCP 7 XML');
    MaweDom.fcp7ExportNativeText.closest('label').style.display = png ? 'none' : '';
    document.getElementById('fcp7-export-description').textContent = MaweProjectSave.translatedEditorText(png
      ? '将 ASS 字幕渲染为透明图片，连同多轨 XML 导出到工程旁的独立目录。'
      : '导出 FCP 7 XML 供 Premiere 交接。此交接尚未完成目标应用验证。');
    MaweDom.fcp7ExportSubtitleTracks.disabled = !png && !MaweDom.fcp7ExportNativeText.checked;
  }

  document.getElementById('fcp7-export-format').addEventListener('change', updateFcp7Mode);
  document.getElementById('fcp7-png-size').addEventListener('change', (event) => {
    document.getElementById('fcp7-png-custom-size').hidden = event.target.value !== 'custom';
  });



  function lottieExportAvailable() {
    return Boolean(MaweBoot.SERVER_CONFIG?.canLottieExport && MaweBoot.SERVER_CONFIG?.lottieExportUrl);
  }



  function updateLottieExportButton() {
    const button = document.getElementById('download-lottie');
    if (!button) return;
    if (!button.dataset.originalTitle) button.dataset.originalTitle = button.dataset.title || button.title;
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
  window.MaweGapRemovedMediaExport.applyMediaSizeToResolutionModal(
    MaweDom.lottieExportResolution, window.MaweDomPanelsWiring.lottieExportCustomSize, window.MaweDomPanelsWiring.lottieExportCustomWidth, window.MaweDomPanelsWiring.lottieExportCustomHeight,
  );
  MaweDom.lottieExportModal?.classList.add('show');
  MaweDom.lottieExportTrack?.focus();
}



  function lottieExportCanvasSize() {
  return window.MaweGapRemovedMediaExport.dynamicExportCanvasSize(MaweDom.lottieExportResolution, window.MaweDomPanelsWiring.lottieExportCustomWidth, window.MaweDomPanelsWiring.lottieExportCustomHeight);
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
    if (!button.dataset.originalTitle) button.dataset.originalTitle = button.dataset.title || button.title;
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
  window.MaweGapRemovedMediaExport.applyMediaSizeToResolutionModal(
    MaweDom.ografExportResolution, window.MaweDomPanelsWiring.ografExportCustomSize, window.MaweDomPanelsWiring.ografExportCustomWidth, window.MaweDomPanelsWiring.ografExportCustomHeight,
  );
  MaweDom.ografExportModal?.classList.add('show');
  MaweDom.ografExportTrack?.focus();
}



  function ografExportCanvasSize() {
  return window.MaweGapRemovedMediaExport.dynamicExportCanvasSize(MaweDom.ografExportResolution, window.MaweDomPanelsWiring.ografExportCustomWidth, window.MaweDomPanelsWiring.ografExportCustomHeight);
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
}
