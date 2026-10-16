// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


const stickerOtioExportMode = document.getElementById('sticker-otio-export-mode');

const portableStickerExportOption = stickerOtioExportMode?.querySelector('option[value="portable"]');


import { MaweHint } from "../ui/editor-hint.js";
import { MaweBoot } from "../boot/editor-boot.js";
import { MaweSettings } from "../state/editor-settings.js";
import { MaweExportTimeline } from "./editor-export-timeline.js";
import { MaweInlineEdit } from "../cues/editor-inline-edit.js";
import { getMaweHost } from '../boot/editor-host.js';
function syncStickerOtioExportMode() {
  const available = Boolean(
    MaweBoot.SERVER_CONFIG?.canPortableStickerExport && MaweBoot.SERVER_CONFIG?.portableStickerExportUrl
  );
  if (portableStickerExportOption) portableStickerExportOption.disabled = !available;
  if (stickerOtioExportMode) {
    stickerOtioExportMode.value = available
      ? MaweSettings.EDITOR_SETTINGS.stickerOtioExportMode
      : 'original';
  }
  return available;
}

async function exportStickerOtio(kind, buildTimeline, filename, description) {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = buildTimeline();
  if (!payload) return;
  if (stickerOtioExportMode?.value !== 'portable') {
    await MaweExportTimeline.downloadFile(payload, filename, 'application/vnd.opentimelineio+json', {
      desc: description, types: { 'application/vnd.opentimelineio+json': ['.otio'] }
    });
    return;
  }
  if (!syncStickerOtioExportMode()) {
    MaweHint.flashHint('当前工程无法导出便携表情包 OTIO 文件夹', 'warning');
    return;
  }
  MaweHint.flashHint('正在生成便携表情包 OTIO 文件夹…');
  try {
    const response = await getMaweHost().server.fetch(MaweBoot.SERVER_CONFIG.portableStickerExportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestToken: MaweBoot.SERVER_CONFIG.requestToken,
        kind,
        timeline: JSON.parse(payload),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
    MaweHint.flashHint(`已生成 ${result.folderPath}，复制 ${result.stickerCount} 张表情包`, 'success');
  } catch (error) {
    MaweHint.flashHint(`便携表情包 OTIO 导出失败：${error.message || error}`, 'warning');
  }
}

window.MaweStickerOtioExport = Object.freeze({
  stickerOtioExportMode,
  portableStickerExportOption,
  syncStickerOtioExportMode,
  exportStickerOtio
});

export const MaweStickerOtioExport = Object.freeze({
    stickerOtioExportMode,
    portableStickerExportOption,
    syncStickerOtioExportMode,
    exportStickerOtio
  });
window.MaweStickerOtioExport = MaweStickerOtioExport;
