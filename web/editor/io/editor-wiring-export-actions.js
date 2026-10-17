









// === 工作区库：服务器版可把工作区（窗口布局 + 显示状态）保存到本机设置，跨工程复用 ===












// 覆盖可能只存导航状态（后端自动创建），没有布局数据；只有含 navigation
// 以外字段的覆盖才能作为布局来源，否则退回内置默认布局。






















// 应用一次下拉选择：saved:* 从本机库恢复；内置 id 优先用本机覆盖版，否则用默认定义。
// 工作区 = 窗口布局 + 显示状态，切换时同时恢复该工作区保存的显示开关。






function projectSaveFingerprint() {
  return JSON.stringify([MaweBoot.DATA.segments, MaweBoot.DATA.multi_subtitle, MaweBoot.DATA.gap_remove,
    MaweBoot.DATA.preview, MaweBoot.DATA.media_metadata, MaweHistory.gapRemoveDirty, MaweAppearance.previewGeometryDirty, MaweServerSave.projectImportDirty]);
}



// 保存正在输入的文字，但不结束行内编辑、不替换节点、不移动光标。
function flushInlineEditsForSave() {
  const state = MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState;
  if (!state) {
    // Start/duration changes are committed by their own input handlers.  Only
    // flush the panel here when text input has actually opened a pending undo
    // edit; otherwise stale display values can rewrite externally changed
    // timing and schedule a second save.
    if (!MaweDom.cuePanel?.contains(document.activeElement) && MaweCuePanelState.cuePanelUndoPushed) {
      MaweCuePanel.commitCuePanelEdit();
    }
    return;
  }
  const extension = Boolean(MaweInlineEdit.extensionEditingState);
  const index = extension ? state.index : state.idx;
  const track = extension ? MaweMultiSubtitleCore.getExtensionTrack(state.trackId) : null;
  const segment = extension ? track?.segments[index] : MaweBoot.DATA.segments[index];
  const text = state.textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
  if (!segment || text === segment.text) return;
  return MaweCommands.run(extension ? '编辑副字幕' : '编辑文本', () => {
    segment.text = text;
    segment._dirty = true;
    state.original = text;
    state.el.classList.add('dirty');
    if (extension) {
      MaweMultiSubtitleCore.markMultiSubtitleDirty();
      MaweCoreState.waveformEditor?.refreshExtensionCueLabel(index, state.trackId);
    } else MaweCoreState.waveformEditor?.refreshCueLabel(index);
    MaweInlineEdit.syncCuePanelAfterInlineEdit(extension ? 'extension' : 'main', index, state.trackId);
  });
}





// 把当前工程写回页面持有的浏览器文件句柄（新建工程 / 另存为选定的目标）。


// 统一保存入口：句柄目标优先（最近一次新建/另存为选定的文件），否则写回服务器绑定工程。


// 另存为：打开系统文件浏览对话框把工程文件保存到用户选择的位置。
// 与「导出工程」的区别：保存成功后当前工程名跟随新文件（标题、导出默认名随之更新），
// 且后续 Ctrl(Cmd)+S / 自动保存都写回这个新选定的文件。



if (MaweProjectSave.mediaNameEl && !MaweProjectSave.mediaNameEl.classList.contains('empty')) {
  MaweProjectSave.mediaNameEl.addEventListener('click', () => {
    const name = MaweProjectSave.mediaNameEl.textContent.trim();
    if (name) MaweExportTimeline.copyText(name, `已复制媒体名：${name}`);
  });
}


if (MaweProjectSave.jsonNameEl && !MaweProjectSave.jsonNameEl.classList.contains('empty')) {
  MaweProjectSave.jsonNameEl.addEventListener('click', () => {
    const name = MaweProjectSave.jsonNameEl.textContent.trim();
    if (name) MaweExportTimeline.copyText(name, `已复制：${name}`);
  });
}









document.getElementById('download-fcp7-export')?.addEventListener('click', MaweDynamicExports.openFcp7ExportModal);
MaweDom.fcp7ExportNativeText?.addEventListener('change', () => {
  // 「导出字幕轨」只在写入原生文本时参与计划构建，未勾选时禁用以免造成可用的假象。
  MaweDom.fcp7ExportSubtitleTracks.disabled = !MaweDom.fcp7ExportNativeText.checked;
});
MaweDom.fcp7ExportCancel?.addEventListener('click', MaweDynamicExports.closeFcp7ExportModal);
MaweDom.fcp7ExportConfirm?.addEventListener('click', () => { void MaweDynamicExports.exportFcp7Xml(); });
MaweDom.fcp7ExportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.fcp7ExportModal) MaweDynamicExports.closeFcp7ExportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.fcp7ExportModal.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDynamicExports.closeFcp7ExportModal();
}, true);









const DYNAMIC_EXPORT_CUSTOM_SIZE_LIMITS = { min: 16, max: 7680 };

// 打开弹窗时让「合成尺寸」自动匹配工程媒体元数据（schema §1.1 的成对宽高）；
// 命中预设选项就选中，否则落到自定义并预填媒体尺寸；没有元数据时保持现状。
function applyMediaSizeToResolutionModal(select, customRow, widthInput, heightInput) {
  if (!select) return;
  const size = window.AsrEditorUtils?.exportVideoSize?.(MaweBoot.DATA) || null;
  if (size && widthInput && heightInput) {
    widthInput.value = size.width;
    heightInput.value = size.height;
  }
  const preset = size ? `${size.width}x${size.height}` : '';
  if (preset && select.querySelector(`option[value="${preset}"]`)) {
    select.value = preset;
  } else if (size) {
    select.value = 'custom';
  }
  if (customRow) customRow.hidden = select.value !== 'custom';
}

function dynamicExportCanvasSize(select, widthInput, heightInput) {
  if (select?.value !== 'custom') {
    const match = /^(\d+)x(\d+)$/u.exec(select?.value || '');
    if (!match) return { width: 1920, height: 1080 };
    return { width: Number(match[1]), height: Number(match[2]) };
  }
  const limits = DYNAMIC_EXPORT_CUSTOM_SIZE_LIMITS;
  const width = Number(widthInput?.value);
  const height = Number(heightInput?.value);
  if (!Number.isInteger(width) || width < limits.min || width > limits.max
    || !Number.isInteger(height) || height < limits.min || height > limits.max) {
    throw new Error(MaweProjectSave.translatedEditorText(
      '自定义合成尺寸需要 16–7680 之间的整数宽高',
    ));
  }
  return { width, height };
}

function bindResolutionCustomSizeToggle(select, customRow) {
  select?.addEventListener('change', () => {
    if (customRow) customRow.hidden = select.value !== 'custom';
  });
}







document.getElementById('download-lottie')?.addEventListener('click', MaweDynamicExports.openLottieExportModal);
bindResolutionCustomSizeToggle(MaweDom.lottieExportResolution, lottieExportCustomSize);
MaweDom.lottieExportCancel?.addEventListener('click', MaweDynamicExports.closeLottieExportModal);
MaweDom.lottieExportConfirm?.addEventListener('click', () => { void MaweDynamicExports.exportLottieDynamicCaptions(); });
MaweDom.lottieExportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.lottieExportModal) MaweDynamicExports.closeLottieExportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.lottieExportModal?.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDynamicExports.closeLottieExportModal();
}, true);















document.getElementById('download-ograf')?.addEventListener('click', MaweDynamicExports.openOgrafExportModal);
bindResolutionCustomSizeToggle(MaweDom.ografExportResolution, ografExportCustomSize);
MaweDom.ografExportCancel?.addEventListener('click', MaweDynamicExports.closeOgrafExportModal);
MaweDom.ografExportConfirm?.addEventListener('click', () => { void MaweDynamicExports.exportOgrafDynamicCaptions(); });
MaweDom.ografExportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.ografExportModal) MaweDynamicExports.closeOgrafExportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.ografExportModal?.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDynamicExports.closeOgrafExportModal();
}, true);

MaweDom.downloadMultiSrtButton?.addEventListener('click', async () => {
  if (MaweDom.downloadMultiSrtButton.classList.contains('disabled')
      || MaweMultiSubtitleCore.getMultiSubtitleState().enabled !== true) return;
  if (MaweInlineEdit.extensionEditingState) MaweInlineEdit.finishExtensionEdit(true);
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  if (!track) return;
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildExtensionSrt(track), `${MaweBoot.FILENAME_BASE}_extension.srt`, 'text/plain', {
    desc: '副字幕 SRT 文件', types: { 'text/plain': ['.srt'] },
  });
});
document.getElementById('download-bilingual-srt')?.addEventListener('click', async (event) => {
  if (event.currentTarget.classList.contains('disabled')
      || MaweMultiSubtitleCore.getMultiSubtitleState().enabled !== true) return;
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  if (MaweInlineEdit.extensionEditingState) MaweInlineEdit.finishExtensionEdit(true);
  const payload = MaweExportSrt.buildBilingualSrt();
  if (!payload) return;
  await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_bilingual.srt`, 'text/plain', {
    desc: '双语整合字幕 SRT', types: { 'text/plain': ['.srt'] },
  });
});
document.getElementById('download-full-srt')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
    desc: 'SRT 字幕文件', types: { 'text/plain': ['.srt'] }
  });
});
document.getElementById('download-full-ass')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  try {
    const payload = MaweExportSrt.buildAss();
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}.ass`, 'text/plain', {
      desc: '完整 ASS 字幕文件', types: { 'text/plain': ['.ass'] }
    });
  } catch (error) {
    MaweHint.flashHint(`ASS 导出失败：${error.message || error}`, 'warning');
  }
});
document.getElementById('download-color-srt')?.addEventListener('click', () => MaweExportSrt.downloadColorSrts(false));
document.getElementById('download-plain-text')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(window.AsrEditorUtils.buildPlainTextPayload(MaweExportSrt.cleanupMainSegments(), {
    ...MaweSpeakerLabels.speakerLabelExportOptions(),
    assSpecialSymbolRule: MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule,
  }), `${MaweBoot.FILENAME_BASE}.txt`, 'text/plain', {
    desc: '纯文本字幕文件', types: { 'text/plain': ['.txt'] }
  });
});
document.getElementById('download-json')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(MaweJsonRepair.buildJson({ forFileExport: true }), `${MaweBoot.FILENAME_BASE}.mosp`, 'application/json', {
    desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
  });
});
MaweDom.saveProjectButton?.addEventListener('click', () => MaweProjectSave.saveCurrentProject());
MaweDom.saveProjectAsButton?.addEventListener('click', () => MaweProjectSave.saveProjectAsToFile());
// Project-level save shortcuts intentionally override the browser page-save
// command. finishEdit() inside saveProjectToServer commits an active text edit.
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  if (event.shiftKey) {
    void MaweProjectSave.saveProjectAsToFile();
  } else {
    void MaweProjectSave.saveCurrentProject();
  }
});
document.getElementById('download-resolve-json')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportTimeline.buildResolveJson();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_resolve.json`, 'application/json', {
      desc: 'Resolve JSON', types: { 'application/json': ['.json'] }
    });
  }
});





MaweStickerOtioExport.stickerOtioExportMode?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ stickerOtioExportMode: MaweStickerOtioExport.stickerOtioExportMode.value });
});



document.getElementById('download-sticker-otio')?.addEventListener('click', () => {
  if (MaweExportTimeline.stickerExportBlocked('download-sticker-otio')) return;
  MaweStickerOtioExport.exportStickerOtio(
    'stickers', MaweExportTimeline.buildStickerOtio, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otio`, 'OTIO 工程文件'
  );
});
document.getElementById('download-gap-removed-srt')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedSrt();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.srt`, 'text/plain', {
      desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-gap-removed-color-srt')?.addEventListener('click', () => MaweExportSrt.downloadColorSrts(true));
document.getElementById('download-gap-removed-ass')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  try {
    const payload = MaweExportSrt.buildGapRemovedAss();
    if (payload) {
      await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.ass`, 'text/plain', {
        desc: '去空隙带样式 ASS 字幕', types: { 'text/plain': ['.ass'] }
      });
    }
  } catch (error) {
    MaweHint.flashHint(`ASS 导出失败：${error.message || error}`, 'warning');
  }
});
document.getElementById('download-otio')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportTimeline.buildSourceOtio();
  if (!payload) return;
  await MaweExportTimeline.downloadFile(payload, MaweBoot.FILENAME_BASE + '.otio', 'application/vnd.opentimelineio+json', {
    desc: 'OTIO 工程', types: { 'application/vnd.opentimelineio+json': ['.otio'] }
  });
  if (MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
      desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-otioz')?.addEventListener('click', async () => {
  const saved = await MaweExportTimeline.exportTimelineOtioz(
    'source',
    MaweExportTimeline.buildSourceOtio,
    MaweBoot.FILENAME_BASE + '.otioz',
    'OTIOZ 打包工程',
  );
  if (saved && MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
      desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-gap-removed-otio')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportTimeline.buildGapRemovedOtio();
  if (!payload) return;
  await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.otio`, 'application/vnd.opentimelineio+json', {
    desc: '去空隙 OTIO 工程', types: { 'application/vnd.opentimelineio+json': ['.otio'] }
  });
  if (MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    const srtPayload = MaweExportSrt.buildGapRemovedSrt();
    if (srtPayload) {
      await MaweExportTimeline.downloadFile(srtPayload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.srt`, 'text/plain', {
        desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
      });
    }
  }
});
document.getElementById('download-gap-removed-otioz')?.addEventListener('click', async () => {
  const saved = await MaweExportTimeline.exportTimelineOtioz(
    'gap-removed',
    MaweExportTimeline.buildGapRemovedOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.otioz`,
    '去空隙时间线 OTIOZ 打包工程',
  );
  if (saved && MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    const srtPayload = MaweExportSrt.buildGapRemovedSrt();
    if (srtPayload) {
      await MaweExportTimeline.downloadFile(srtPayload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.srt`, 'text/plain', {
        desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
      });
    }
  }
});
document.getElementById('download-gap-removed-ffconcat')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedFfconcat();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.ffconcat`, 'text/plain', {
      desc: 'FFconcat 剪辑计划', types: { 'text/plain': ['.ffconcat'] }
    });
  }
});
document.getElementById('download-gap-removed-video')?.addEventListener('click', async () => {
  if (window.__maweGapRemovedVideoTask) return;
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const tr = (text) => window.MAWE_I18N?.translateText?.(text) || text;
  const config = MaweBoot.SERVER_CONFIG;
  const isAudio = config?.gapRemovedMediaKind === 'audio';
  const mediaText = (text) => tr(isAudio ? text.replaceAll('视频', '音频') : text);
  const sourceName = config?.gapRemovedMediaSourceName ?? config?.gapRemovedVideoSourceName;
  const sourceExtension = typeof sourceName === 'string' ? sourceName.match(/\.[^.]+$/)?.[0]?.toLowerCase() : '';
  const mimeByExtension = {
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
    '.webm': 'video/webm', '.ts': 'video/mp2t', '.m4v': 'video/x-m4v',
  };
  const outputExtension = config?.gapRemovedMediaOutputExtension ?? sourceExtension;
  const outputMime = config?.gapRemovedMediaOutputMime ?? mimeByExtension[outputExtension];
  const canExport = () => config?.canGapRemovedMediaExport ?? config?.canGapRemovedVideoExport;
  const safeError = (error, fallback) => {
    const message = error?.message || error;
    if (typeof message !== 'string' || !message || message.length > 240
        || /extract_extradata|No start code|Invalid data found|[A-Z]:[\\/]|maw-media-job-/i.test(message)) return tr(fallback);
    return tr(message);
  };
  if (!canExport() || !config.gapRemovedVideoExportUrl
      || !Number.isSafeInteger(config.bindingGeneration) || config.bindingGeneration < 1
      || typeof config.sourceMediaId !== 'string' || !config.sourceMediaId
      || typeof sourceName !== 'string' || !sourceName) {
    MaweHint.flashHint(mediaText('请从启动器打开关联源媒体的工程，再导出重组结果'), 'warning');
    return;
  }
  if (!MaweHost.files.hasSavePicker() || !outputMime || !outputExtension
      || (!isAudio && mimeByExtension[outputExtension] !== outputMime) || (isAudio && (outputExtension !== '.wav' || outputMime !== 'audio/wav'))) {
    MaweHint.flashHint(mediaText('当前浏览器或媒体格式不支持重组后视频保存'), 'warning');
    return;
  }
  const context = MaweExportSrt.gapRemovedExportContext();
  if (!context) return;
  const bindingGeneration = config.bindingGeneration;
  const sourceMediaId = config.sourceMediaId;
  const projectBindingEpoch = window.MaweProjectLoad?.projectBindingEpoch;
  const exportUrl = config.gapRemovedVideoExportUrl;
  const jobsUrl = config.gapRemovedVideoJobsUrl;
  const requestToken = config.requestToken;
  const initialConfiguredAudioTrack = config.gapRemovedMediaAudioTrack;
  const currentAudioTrack = () => {
    const metadata = MaweBoot.DATA?.media_metadata;
    if (metadata && typeof metadata === 'object') {
      if (Number.isInteger(metadata.selected_audio_track) && metadata.selected_audio_track >= 0) return metadata.selected_audio_track;
      const track = metadata.audio_tracks?.find?.(entry => entry?.default === true
        && Number.isInteger(entry.audio_index) && entry.audio_index >= 0);
      return track?.audio_index ?? 0;
    }
    return Number.isInteger(config.gapRemovedMediaAudioTrack) && config.gapRemovedMediaAudioTrack >= 0
      ? config.gapRemovedMediaAudioTrack : undefined;
  };
  const selectedAudioTrack = isAudio ? currentAudioTrack() : undefined;
  const audioSelection = selectedAudioTrack === undefined ? {} : { selectedAudioTrack };
  const intervals = context.intervals.map(({ start, end }) => ({ startMs: start, endMs: end }));
  const buildVideoSrt = !isAudio ? MaweExportSrt.captureVideoSrt?.() : null;
  let videoTimeline = null;
  const isBindingCurrent = () => MaweBoot.SERVER_CONFIG === config && canExport()
    && config.bindingGeneration === bindingGeneration && config.sourceMediaId === sourceMediaId
    && (config.gapRemovedMediaSourceName ?? config.gapRemovedVideoSourceName) === sourceName
    && (config.gapRemovedMediaOutputExtension ?? sourceExtension) === outputExtension
    && (config.gapRemovedMediaOutputMime ?? mimeByExtension[outputExtension]) === outputMime
    && (!isAudio || (config.gapRemovedMediaAudioTrack === initialConfiguredAudioTrack
      && currentAudioTrack() === selectedAudioTrack))
    && (config.gapRemovedMediaKind === 'audio') === isAudio && config.gapRemovedVideoExportUrl === exportUrl
    && config.requestToken === requestToken && window.MaweProjectLoad?.projectBindingEpoch === projectBindingEpoch;
  MaweHint.flashHint(tr(isAudio ? '按保留区域精确裁切音频，导出为 WAV。' : '按保留区域重组视频；切点可能受关键帧影响。'), 'warning');

  let handle;
  try {
    const suggestedName = `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}${outputExtension}`;
    handle = await MaweHost.files.pickSaveFile({
      suggestedName,
      types: [{ description: mediaText('重组后视频'), accept: { [outputMime]: [outputExtension] } }],
    });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    MaweHint.flashHint(`${mediaText('无法打开视频保存位置选择器')}：${safeError(error, '请检查保存位置权限后重试')}`, 'warning');
    return;
  }
  // The picker can yield while this page (or another server tab) changes project.
  // Never combine the old interval snapshot with a new source binding.
  if (!isBindingCurrent()) {
    MaweHint.flashHint(mediaText('工程或媒体绑定已变更，请重新发起视频导出'), 'warning');
    return;
  }
  if (handle.name.toLowerCase() === sourceName.toLowerCase()) {
    MaweHint.flashHint(mediaText('保存目标不能与源视频同名'), 'warning');
    return;
  }
  if (!handle.name.toLowerCase().endsWith(outputExtension)) {
    MaweHint.flashHint(tr(isAudio ? '音频导出请使用 .wav 扩展名' : '保存文件扩展名需要与源视频一致'), 'warning');
    return;
  }

  let writable = null;
  let reader = null;
  let response = null;
  let transferComplete = false;
  let noOutputComplete = false;
  let task = null;
  let panel = null;
  let stopButton = null;
  let statusLabel = null;
  let progressBar = null;
  let expansionLabel = null;
  let expansionNotice = null;
  let removalSummary = null;
  let removalDetails = null;
  let removalDetailsTitle = null;
  let removalDetailsLimit = null;
  let removalDetailsList = null;
  let removalDiagnosticKey = null;
  let removalGapRows = [];
  let rejectStop;
  let committing = false;
  let cleanupWarningShown = false;
  const warnCleanup = (error) => {
    if (cleanupWarningShown) return;
    cleanupWarningShown = true;
    MaweHint.flashHint(safeError(error, '无法确认导出已停止，请重试'), 'warning');
  };
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  void stopped.catch(() => {});
  const raceStop = (promise) => task ? Promise.race([promise, stopped]) : promise;
  const pause = () => new Promise(resolve => setTimeout(resolve, 250));
  const button = document.getElementById('download-gap-removed-video');
  const setProgress = (text, value = null) => {
    if (!panel) return;
    statusLabel.textContent = text;
    if (value === null) progressBar.removeAttribute('value');
    else progressBar.value = Math.max(0, Math.min(1, value));
  };
  const durationValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? tr('{seconds} 秒').replace('{seconds}', (value / 1000).toFixed(3)) : tr('未知');
  const diagnosticReasons = {
    hevc_cra: '此处为 CRA 切点，暂不用于安全切割',
    h264_recovery: '此处为开放 GOP 或恢复入口，尚未确认可安全拼接',
    hevc_non_idr: '此处不是独立解码入口',
    h264_non_idr: '此处不是独立解码入口',
    unsupported_codec: '当前编码尚未支持安全切点分析',
    unsupported_container: '当前封装尚未支持安全切点分析',
    invalid_packet_layout: '媒体包信息不足，无法确认安全切点',
    invalid_packet_metadata: '媒体包信息不足，无法确认安全切点',
    read_error: '读取媒体信息失败',
    ambiguous_nal_length: '无法确认视频数据单元边界',
    unsupported_lacing: '当前媒体包布局暂不支持安全切点分析',
    unsupported_packet_transform: '当前媒体包布局暂不支持安全切点分析',
    container_element_limit: '切点数据超出分析范围，未确认安全入口',
    payload_position_unverified: '无法确认视频数据位置',
    point_budget_exhausted: '已达到分析预算，部分切点尚未确认',
    budget_exhausted: '已达到分析预算，部分切点尚未确认',
    nal_limit: '切点数据超出分析范围，未确认安全入口',
    display_boundary_overlap: '显示与解码边界交叠，保留该区间',
    keyframe_alignment: '对齐安全关键帧后仍保留部分空隙',
    no_common_video_boundary: '未找到可用的安全切点',
  };
  const updateRemovalDiagnostics = state => {
    if (!removalSummary) return;
    const timeline = state.videoTimeline;
    const key = JSON.stringify([timeline || null, state.stage === 'preparing']);
    if (key === removalDiagnosticKey) return;
    removalDiagnosticKey = key;
    for (const [field, label] of [
      ['requestedRemovedMs', '计划删除'], ['actualRemovedMs', '实际可删'], ['retainedGapMs', '仍保留'],
    ]) {
      const value = removalSummary.querySelector(`[data-removal-value="${field}"]`);
      value.textContent = timeline ? durationValue(timeline[field]) : tr(state.stage === 'preparing' ? '计算中…' : '未知');
      value.setAttribute('aria-label', `${tr(label)} ${value.textContent}`);
    }
    const gaps = Array.isArray(timeline?.gaps) ? timeline.gaps.filter(gap => (
      gap && (typeof gap.retainedGapMs === 'number' && gap.retainedGapMs > 0
        || typeof gap.actualRemovedMs === 'number' && typeof gap.requestedRemovedMs === 'number'
          && gap.actualRemovedMs < gap.requestedRemovedMs
        || !Number.isFinite(gap.actualRemovedMs) && Array.isArray(gap.reasons) && gap.reasons.length)
    )) : [];
    const count = timeline?.unremovedGapCount;
    removalDetails.hidden = !(gaps.length || typeof count === 'number' && count > 0);
    const internal = timeline?.internalUnremovedGapCount;
    removalDetailsTitle.textContent = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
      ? (Number.isSafeInteger(internal) && internal >= 0
        ? tr('未完全移除的空隙（{count} 段，内部 {internal} 段）').replace('{internal}', String(internal))
        : tr('未完全移除的空隙（{count} 段）')).replace('{count}', String(count)) : tr('空隙处理详情');
    removalDetailsLimit.hidden = timeline?.gapDetailsTruncated !== true;
    removalGapRows = gaps;
    renderRemovalDetails();
  };
  const renderRemovalDetails = () => {
    // Keep the first precheck response cheap even for projects with many gaps.
    // Detail rows are created only when requested, and remain in a bounded scroller.
    if (!removalDetails?.open) return;
    removalDetailsList.replaceChildren();
    for (const gap of removalGapRows) {
      const item = document.createElement('li');
      const interval = document.createElement('div');
      interval.className = 'gap-video-job-gap-range';
      const positionLabel = { leading: '开头空隙', internal: '内部空隙', trailing: '结尾空隙' }[gap.position];
      interval.textContent = (positionLabel ? `${tr(positionLabel)} · ` : '')
        + tr('源区间：{start} — {end}').replace('{start}', durationValue(gap.sourceStartMs))
        .replace('{end}', durationValue(gap.sourceEndMs));
      const retained = document.createElement('div');
      retained.textContent = tr('仍保留：{duration}').replace('{duration}', durationValue(gap.retainedGapMs));
      const reasons = document.createElement('div');
      reasons.className = 'gap-video-job-gap-reason';
      const codes = Array.isArray(gap.reasons) ? gap.reasons : [];
      reasons.textContent = [...new Set(codes.map(code => tr(diagnosticReasons[code] || '未提供具体原因')))].join('；')
        || tr('未提供具体原因');
      item.append(interval, retained, reasons);
      removalDetailsList.append(item);
    }
    if (!removalGapRows.length && !removalDetails.hidden) {
      const item = document.createElement('li');
      item.textContent = tr('暂未提供源区间详情');
      removalDetailsList.append(item);
    }
  };
  const finishResultPanel = withoutOutput => {
    if (!panel) return;
    panel.dataset.completed = 'true';
    if (withoutOutput) panel.dataset.noOutput = 'true';
    setProgress(tr(withoutOutput ? '未能安全移除空隙，未生成视频' : isAudio
      ? '去空隙音频已重组并保存' : '去空隙视频已重组并保存'), withoutOutput ? null : 1);
    progressBar.hidden = withoutOutput;
    stopButton.removeEventListener('click', requestStop);
    stopButton.remove();
    const actions = document.createElement('div');
    actions.className = 'gap-video-job-actions';
    const srt = withoutOutput ? null : buildVideoSrt?.(videoTimeline);
    if (srt !== null && srt !== undefined) {
      const saveSrt = document.createElement('button');
      saveSrt.id = 'gap-video-job-save-srt';
      saveSrt.textContent = tr('保存匹配字幕（SRT）');
      saveSrt.addEventListener('click', async () => {
        saveSrt.disabled = true;
        try {
          await MaweExportTimeline.downloadFile(srt, handle.name.replace(/\.[^.]+$/, '') + '.srt', 'text/plain',
            { desc: 'SRT', types: { 'text/plain': ['.srt'] } });
        } catch (error) { MaweHint.flashHint(safeError(error, '字幕保存失败，请重试'), 'warning'); }
        finally { saveSrt.disabled = false; }
      });
      actions.append(saveSrt);
    }
    const close = document.createElement('button');
    close.id = 'gap-video-job-close';
    close.textContent = tr('关闭');
    close.addEventListener('click', () => panel.remove(), { once: true });
    actions.append(close);
    panel.append(actions);
  };
  const stopBackend = () => {
    if (!task) return Promise.resolve();
    if (task.cancelRequest) return task.cancelRequest;
    task.cancelRequest = (async () => {
      const controller = new AbortController();
      let deadlineTimer;
      const timeout = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
          reject(new Error(tr('无法确认导出已停止，请重试')));
          controller.abort();
        }, 30000);
      });
      try {
        await Promise.race([(async () => { while (true) {
        const cancelUrl = task.id ? `${jobsUrl}/${encodeURIComponent(task.id)}/cancel` : `${jobsUrl}/cancel-admission`;
        const reply = await MaweHost.server.fetch(cancelUrl, {
          method: 'POST', keepalive: true, signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestToken, admissionToken: task.admissionToken }),
        });
        const state = await reply.json();
        if (!reply.ok) throw new Error(state.error || tr('无法确认导出已停止，请重试'));
        if (state.cleanupComplete === true) return;
        if (state.cleanupError) throw new Error(tr('导出已结束，但临时文件清理失败，请重试'));
        if (state.state === 'failed') {
          throw new Error(state.cleanupError
            ? tr('导出已结束，但临时文件清理失败，请重试')
            : tr('无法确认导出已停止，请重试'));
        }
        if (['cancelled', 'completed'].includes(state.state) && state.cleanupComplete !== false) return;
        await pause();
        } })(), timeout]);
      } finally {
        clearTimeout(deadlineTimer);
        controller.abort();
      }
    })();
    return task.cancelRequest;
  };
  const confirmBackendCleanup = async () => {
    if (!task?.id) return;
    const controller = new AbortController();
    let deadlineTimer;
    const timeout = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(new Error(tr('文件已保存，但无法确认临时文件已清理，请重试')));
        controller.abort();
      }, 30000);
    });
    try {
      await Promise.race([(async () => {
        while (true) {
          const reply = await MaweHost.server.fetch(`${jobsUrl}/${encodeURIComponent(task.id)}`, {
            headers: { 'X-MAW-Request-Token': requestToken }, signal: controller.signal,
          });
          const state = await reply.json();
          if (!reply.ok) throw new Error(tr('文件已保存，但无法确认临时文件已清理，请重试'));
          if (state.cleanupError) throw new Error(tr('导出已结束，但临时文件清理失败，请重试'));
          if (state.cleanupComplete === true) return;
          // Old servers do not report disposal; retain their terminal contract.
          if (state.cleanupComplete === undefined && ['completed', 'cancelled'].includes(state.state)) return;
          if (state.state === 'failed') throw new Error(tr('文件已保存，但无法确认临时文件已清理，请重试'));
          await pause();
        }
      })(), timeout]);
    } finally {
      clearTimeout(deadlineTimer);
      controller.abort();
    }
  };
  const requestStop = () => {
    if (!task || task.stopRequested || committing) return;
    task.stopRequested = true;
    task.controller.abort();
    const error = new Error(mediaText('视频导出已停止'));
    error.name = 'AbortError';
    rejectStop(error);
    setProgress(mediaText('正在停止导出…'));
    stopButton.disabled = true;
    void stopBackend().catch(() => {});
  };
  const ensureCurrent = () => {
    if (!isBindingCurrent() || config.gapRemovedVideoJobsUrl !== jobsUrl) {
      requestStop();
      throw new Error(mediaText('工程或媒体绑定已变更，请重新发起视频导出'));
    }
    if (task?.stopRequested) {
      const error = new Error(mediaText('视频导出已停止'));
      error.name = 'AbortError';
      throw error;
    }
  };
  try {
    // A second picker can resume while another export is already running.
    if (window.__maweGapRemovedVideoTask) return;
    if (typeof jobsUrl === 'string' && jobsUrl) {
      const random = crypto.getRandomValues(new Uint8Array(32));
      const admissionToken = Array.from(random, value => value.toString(16).padStart(2, '0')).join('');
      task = { id: null, admissionToken, controller: new AbortController(), stopRequested: false, cancelRequest: null };
      window.__maweGapRemovedVideoTask = task;
      button.disabled = true;
      document.querySelectorAll('.gap-video-job[data-completed]').forEach(previous => previous.remove());
      panel = document.createElement('div');
      panel.className = 'gap-video-job';
      panel.setAttribute('role', 'status');
      panel.setAttribute('aria-live', 'polite');
      statusLabel = document.createElement('div');
      statusLabel.id = 'gap-video-job-status';
      progressBar = document.createElement('progress');
      progressBar.max = 1;
      progressBar.setAttribute('aria-label', mediaText('重组后视频'));
      stopButton = document.createElement('button');
      stopButton.id = 'gap-video-job-stop';
      stopButton.textContent = mediaText('停止视频导出');
      stopButton.addEventListener('click', requestStop);
      panel.append(statusLabel, progressBar, stopButton);
      if (!isAudio) {
        removalSummary = document.createElement('dl');
        removalSummary.id = 'gap-video-job-removal-summary';
        removalSummary.className = 'gap-video-job-removal-summary';
        for (const [field, label] of [
          ['requestedRemovedMs', '计划删除'], ['actualRemovedMs', '实际可删'], ['retainedGapMs', '仍保留'],
        ]) {
          const metric = document.createElement('div');
          const title = document.createElement('dt');
          title.textContent = tr(label);
          const value = document.createElement('dd');
          value.dataset.removalValue = field;
          value.textContent = tr('计算中…');
          metric.append(title, value);
          removalSummary.append(metric);
        }
        removalDetails = document.createElement('details');
        removalDetails.id = 'gap-video-job-removal-details';
        removalDetails.hidden = true;
        removalDetailsTitle = document.createElement('summary');
        removalDetailsTitle.textContent = tr('空隙处理详情');
        removalDetailsLimit = document.createElement('div');
        removalDetailsLimit.className = 'gap-video-job-explanation';
        removalDetailsLimit.textContent = tr('仅展示部分明细，计数包含全部空隙。');
        removalDetailsLimit.hidden = true;
        removalDetailsList = document.createElement('ul');
        removalDetails.append(removalDetailsTitle, removalDetailsLimit, removalDetailsList);
        removalDetails.addEventListener('toggle', () => { if (removalDetails.open) renderRemovalDetails(); });
        progressBar.before(removalSummary, removalDetails);
        expansionLabel = document.createElement('div');
        expansionLabel.id = 'gap-video-job-expansion';
        expansionLabel.textContent = tr('累积偏移时长：计算中…');
        expansionNotice = document.createElement('div');
        expansionNotice.className = 'gap-video-job-explanation';
        expansionNotice.hidden = true;
        const explanation = document.createElement('div');
        explanation.className = 'gap-video-job-explanation';
        explanation.textContent = tr('关键帧扩展增加的保留时长；按合并后区间计算，实际文件可能有帧或音频包级差异。');
        progressBar.before(expansionLabel, explanation, expansionNotice);
      }
      document.body.append(panel);
      window.addEventListener('pagehide', requestStop);
      setProgress(mediaText('正在准备导出…'));
      // The client token makes cancellation safe even before the server ID is
      // delivered, including pagehide or a response which never finishes.
      const admission = await raceStop(MaweHost.server.fetch(jobsUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestToken, bindingGeneration, sourceMediaId, intervals, ...audioSelection,
          admissionToken, admissionDeadline: Date.now() + 60000 }),
        signal: task.controller.signal,
      }));
      let state = await raceStop(admission.json());
      if (!admission.ok) throw new Error(state.error || `服务器返回 ${admission.status}`);
      if (typeof state.jobId !== 'string' || !state.jobId) throw new Error(mediaText('导出状态异常，请重试'));
      task.id = state.jobId;
      while (true) {
        ensureCurrent();
        if (state.jobId !== task.id || state.bindingGeneration !== bindingGeneration || state.sourceMediaId !== sourceMediaId) {
          throw new Error(mediaText('导出状态异常，请重试'));
        }
        updateRemovalDiagnostics(state);
        if (expansionLabel) {
          const expansion = state.videoTimeline?.keyframeExpansionMs;
          expansionLabel.textContent = Number.isFinite(expansion) && expansion >= 0
            ? tr('累积偏移时长：{seconds} 秒').replace('{seconds}', (expansion / 1000).toFixed(3))
            : tr(state.stage === 'preparing' ? '累积偏移时长：计算中…' : '累积偏移时长：不可用');
          expansionNotice.hidden = state.noOutput === true || state.videoTimeline?.noGapsRemoved !== true;
          expansionNotice.textContent = state.noOutput === true ? '' : tr('安全关键帧扩展后未移除空隙，将保留完整媒体。');
        }
        if (!isAudio && state.noOutput === true && state.state === 'completed') {
          videoTimeline = state.videoTimeline;
          noOutputComplete = true;
          committing = true;
          finishResultPanel(true);
          if (state.cleanupComplete !== true) {
            try { await confirmBackendCleanup(); }
            catch (error) { warnCleanup(error); }
          }
          return;
        }
        if (state.state === 'ready') { videoTimeline = state.videoTimeline; break; }
        if (['failed', 'cancelled', 'completed'].includes(state.state)) throw new Error(state.error || mediaText('导出状态异常，请重试'));
        const stages = {
          preparing: '正在读取源视频信息…', rebuilding: '正在重组去空隙视频…',
          exporting: '正在裁切并拼接音频…',
          verifying: '正在验证重组结果…', validating: '正在验证重组结果…',
        };
        const percent = ['rebuilding', 'exporting'].includes(state.stage) && typeof state.progress === 'number' ? state.progress : null;
        setProgress(mediaText(stages[state.stage] || '正在准备导出…') + (percent === null ? '' : ` ${Math.round(percent * 100)}%`), percent);
        await raceStop(pause());
        const poll = await raceStop(MaweHost.server.fetch(`${jobsUrl}/${encodeURIComponent(task.id)}`, {
          headers: { 'X-MAW-Request-Token': requestToken }, signal: task.controller.signal,
        }));
        state = await raceStop(poll.json());
        if (!poll.ok) throw new Error(state.error || `服务器返回 ${poll.status}`);
      }
      ensureCurrent();
      setProgress(mediaText('正在下载并写入视频…'), 0);
      response = await raceStop(MaweHost.server.fetch(`${jobsUrl}/${encodeURIComponent(task.id)}/download`, {
        headers: { 'X-MAW-Request-Token': requestToken }, signal: task.controller.signal,
      }));
    } else {
    MaweHint.flashHint(mediaText('正在重组去空隙视频…'));
    response = await MaweHost.server.fetch(exportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestToken,
        bindingGeneration,
        sourceMediaId,
        intervals,
        ...audioSelection,
      }),
    });
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `服务器返回 ${response.status}`);
    }
    const contentType = (response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== outputMime) {
      throw new Error(tr(isAudio ? '导出文件格式不符合预期，请重试' : '服务器返回的视频格式与源视频不一致'));
    }
    if (!response.body?.getReader) throw new Error(mediaText('当前浏览器不支持流式保存视频'));
    const expectedLength = Number(response.headers.get('Content-Length'));
    if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0) {
      throw new Error(mediaText('服务器返回的视频大小无效'));
    }
    ensureCurrent();
    const writablePromise = handle.createWritable();
    // A pending browser permission/storage operation can finish after stop.
    // Dispose a late writable too; it must never become a saved old result.
    if (task) void writablePromise.then(value => {
      if (task.stopRequested) void value.abort().catch(() => {});
    }).catch(() => {});
    writable = await raceStop(writablePromise);
    ensureCurrent();
    reader = response.body.getReader();
    let receivedLength = 0;
    while (true) {
      const { done, value } = await raceStop(reader.read());
      ensureCurrent();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) continue;
      receivedLength += value.byteLength;
      if (receivedLength > expectedLength) throw new Error(mediaText('服务器返回的视频长度超出预期'));
      await raceStop(writable.write(value));
      ensureCurrent();
      setProgress(`${mediaText('正在下载并写入视频…')} ${Math.round(receivedLength / expectedLength * 100)}%`, receivedLength / expectedLength);
    }
    if (receivedLength !== expectedLength) throw new Error(mediaText('视频传输不完整，未保存部分文件'));
    ensureCurrent();
    committing = true;
    if (stopButton) stopButton.disabled = true;
    setProgress(mediaText('正在完成保存…'), 1);
    await writable.close();
    writable = null;
    transferComplete = true;
    finishResultPanel(false);
    MaweHint.flashHint(mediaText('去空隙视频已重组并保存'), 'success');
    try { await confirmBackendCleanup(); }
    catch (error) { warnCleanup(error); }
  } catch (error) {
    if (task?.stopRequested && error?.name === 'AbortError') {
      try {
        await stopBackend();
        MaweHint.flashHint(mediaText('视频导出已停止'));
      } catch (cleanupError) {
        warnCleanup(cleanupError);
      }
    } else MaweHint.flashHint(`${mediaText('重组后视频导出失败')}：${safeError(error, '媒体处理失败，请确认源文件可以正常播放后重试')}`, 'warning');
  } finally {
    if (!transferComplete && response?.body) {
      // Releasing a reader only relinquishes its JS lock. Cancel the network
      // body as well so the server can finish streaming and release its export
      // lock after a validation/storage failure, including before reader setup.
      // Do not wait for transport cleanup or replace the original failure.
      try {
        const cancellation = reader ? reader.cancel() : response.body.cancel();
        void cancellation.catch(() => {});
      } catch (_) {}
    }
    if (reader) reader.releaseLock();
    if (writable) await writable.abort().catch(() => {});
    if (task && !transferComplete && !noOutputComplete) {
      try { await stopBackend(); }
      catch (error) { warnCleanup(error); }
    }
    if (task) {
      window.removeEventListener('pagehide', requestStop);
      if (!transferComplete && !noOutputComplete) panel.remove();
      if (window.__maweGapRemovedVideoTask === task) window.__maweGapRemovedVideoTask = null;
      button.disabled = false;
    }
  }
});
// Refresh both initial server media and browser-local project/media changes.
window.MaweGapRemovedMediaExport = Object.freeze({
  updateButton() {
    const button = document.getElementById('download-gap-removed-video');
    if (!button) return;
    const config = MaweBoot.SERVER_CONFIG;
    const mediaName = MaweBoot.DATA?.media || '';
    const player = document.getElementById('player');
    const hasPlayerSource = player?.getAttribute('src') || player?.querySelector('source')?.getAttribute('src');
    const knownVideo = /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v)$/i.test(mediaName);
    const knownAudio = /\.(wav|mp3|m4a|aac|flac|ogg|opus|wma|aiff?|ape)$/i.test(mediaName);
    const audio = config?.gapRemovedMediaKind === 'audio'
      || (!config?.gapRemovedMediaKind && (knownAudio || (!knownVideo && hasPlayerSource && player?.tagName === 'AUDIO')));
    const translate = (text) => window.MAWE_I18N?.translateText?.(text) || text;
    button.textContent = translate(audio ? '重组后音频' : '重组后视频');
    button.title = translate(audio ? '按保留区域精确裁切音频，导出为 WAV。' : '按保留区域重组视频；切点可能受关键帧影响。');
    // 烧录需要视频画面；音频工程隐藏去空隙菜单里的烧录入口。
    const burnItem = document.getElementById('download-gap-removed-burn-video');
    if (burnItem) burnItem.hidden = audio || !config?.canBurnVideoExport || !config?.burnVideoJobsUrl
      || window.MaweSettings?.EDITOR_SETTINGS?.assMode !== true;
  },
});
window.MaweGapRemovedMediaExport.updateButton();
document.addEventListener('mawe:languagechange', () => window.MaweGapRemovedMediaExport.updateButton());

document.getElementById('download-gap-removed-regions-json')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedRegionsJson();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.keep-regions.json`, 'application/json', {
      desc: '去空隙保留区域 JSON', types: { 'application/json': ['.json'] }
    });
  }
});
document.getElementById('download-gap-removed-sticker-otio')?.addEventListener('click', async () => {
  if (MaweExportTimeline.stickerExportBlocked('download-gap-removed-sticker-otio')) return;
  await MaweStickerOtioExport.exportStickerOtio(
    'gap-removed-stickers', MaweExportTimeline.buildGapRemovedStickerOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}-${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otio`, '去空隙表情包 OTIO 工程'
  );
});
document.getElementById('download-gap-removed-sticker-otioz')?.addEventListener('click', async () => {
  if (MaweExportTimeline.stickerExportBlocked('download-gap-removed-sticker-otioz')) return;
  const removed = MaweGapRemoveData.getRemovedGapRanges();
  if (!removed.length) {
    const msg = '没有已移除的静音空隙；请先在「静音空隙」中扫描';
    MaweHint.flashHint(window.MAWE_I18N?.translateText?.(msg) || msg);
    return;
  }
  await MaweExportTimeline.exportStickerOtoz(
    'gap-removed-stickers', MaweExportTimeline.buildGapRemovedStickerOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}-${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otioz`, '去空隙表情包 OTIOZ 打包工程'
  );
});
document.getElementById('download-sticker-otioz')?.addEventListener('click', async () => {
  if (MaweExportTimeline.stickerExportBlocked('download-sticker-otioz')) return;
  await MaweExportTimeline.exportStickerOtoz(
    'stickers', MaweExportTimeline.buildStickerOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otioz`, '表情包 OTIOZ 打包工程'
  );
});

// 时间线 OTIO / OTIOZ 导出选项：两个 OTIO 子菜单（原始 / 去空隙）共享同一份设置，
// 任一处勾选立即持久化并同步另一处；导出时由 buildSourceOtio / buildGapRemovedOtio 读取。





MaweExportTimeline.otioExportOptionInputs.forEach((input) => {
  input.addEventListener('change', () => {
    const key = MaweExportTimeline.OTIO_EXPORT_OPTION_KEYS[input.dataset.otioExportOption];
    if (!key) return;
    MaweSettings.updateEditorSettings({ [key]: input.checked });
    MaweExportTimeline.syncOtioExportOptionInputs();
    // 鼠标点击切换后立即交还焦点：焦点留在子菜单内的复选框上会让悬停关闭
    // 逻辑（wrapper.contains(document.activeElement)）一直误判指针仍在菜单内，
    // 导致二级菜单不再自动收起。键盘切换（:focus-visible）保持焦点不受影响。
    if (!input.matches(':focus-visible')) input.blur();
  });
});
MaweExportTimeline.syncOtioExportOptionInputs();

// 初始按服务器模式刷新表情包 OTIOZ 导出按钮的可用性
MaweExportTimeline.updateStickerExportButtons();
MaweExportTimeline.updateTimelineOtiozExportButtons();
MaweDynamicExports.updateLottieExportButton();
MaweDynamicExports.updateOgrafExportButton();
