import { MaweBoot } from '../boot/editor-boot.js';
import { MaweHost } from '../boot/editor-host.js';
import { MaweInlineEdit } from '../cues/editor-inline-edit.js';
import { MaweSettings } from '../state/editor-settings.js';
import { MaweHint } from '../ui/editor-hint.js';
import { MaweExportTimeline } from './editor-export-timeline.js';
export let MaweStickerOtioExport;
export function initStickerOtioExportModule() {
  // 表情包 OTIO 导出：便携模式同步与导出入口。
  // 由 split-cluster codemod 自 editor.js 拆出。
  const stickerOtioExportMode = /** @type {HTMLSelectElement} */ (document.getElementById('sticker-otio-export-mode'));


  const portableStickerExportOption = /** @type {HTMLOptionElement} */ (stickerOtioExportMode?.querySelector('option[value="portable"]'));



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
      const response = await MaweHost.server.fetch(MaweBoot.SERVER_CONFIG.portableStickerExportUrl, {
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
      MaweHint.flashHint(`便携表情包 OTIO 导出失败：${error.message || error}`, 'warning', { error });
    }
  }

  MaweStickerOtioExport = Object.freeze({
    stickerOtioExportMode,
    portableStickerExportOption,
    syncStickerOtioExportMode,
    exportStickerOtio
  });
}
