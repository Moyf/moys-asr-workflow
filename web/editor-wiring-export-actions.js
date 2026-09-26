









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
  MaweHistory.pushUndo(extension ? '编辑副字幕' : '编辑文本');
  segment.text = text;
  segment._dirty = true;
  state.original = text;
  state.el.classList.add('dirty');
  if (extension) {
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweCoreState.waveformEditor?.refreshExtensionCueLabel(index, state.trackId);
  } else MaweCoreState.waveformEditor?.refreshCueLabel(index);
  MaweInlineEdit.syncCuePanelAfterInlineEdit(extension ? 'extension' : 'main', index, state.trackId);
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
  if (MaweInlineEdit.extensionEditingState) MaweInlineEdit.finishExtensionEdit(true);
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  if (!track) return;
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildExtensionSrt(track), `${MaweBoot.FILENAME_BASE}_extension.srt`, 'text/plain', {
    desc: '副字幕 SRT 文件', types: { 'text/plain': ['.srt'] },
  });
});
document.getElementById('download-full-srt')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
    desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
  });
});
document.getElementById('download-full-ass')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildAss(), `${MaweBoot.FILENAME_BASE}.ass`, 'text/plain', {
    desc: '完整 ASS 字幕文件', types: { 'text/plain': ['.ass'] }
  });
});
document.getElementById('download-color-srt')?.addEventListener('click', () => MaweExportSrt.downloadColorSrts(false));
document.getElementById('download-plain-text')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(window.AsrEditorUtils.buildPlainTextPayload(MaweBoot.DATA.segments), `${MaweBoot.FILENAME_BASE}.txt`, 'text/plain', {
    desc: '纯文本字幕文件', types: { 'text/plain': ['.txt'] }
  });
});
document.getElementById('download-json')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(MaweJsonRepair.buildJson(), `${MaweBoot.FILENAME_BASE}.mosp`, 'application/json', {
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
  const payload = MaweExportSrt.buildGapRemovedAss();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.ass`, 'text/plain', {
      desc: '去空隙带样式 ASS 字幕', types: { 'text/plain': ['.ass'] }
    });
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
    const msg = '没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除';
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
