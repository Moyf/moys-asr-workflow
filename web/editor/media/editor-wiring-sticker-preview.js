

// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。
'use strict';
import { MaweStickerOverlay } from "./editor-sticker-overlay.js";
import { MawePreviewGeometry } from "./editor-preview-geometry.js";
import { MaweAppearance } from "../styles/editor-appearance.js";
import { MaweMediaPlayback } from "./editor-media-playback.js";
import { MaweCoreState } from "../state/editor-core-state.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweSettings } from "../state/editor-settings.js";
import { MaweHistory } from "../state/editor-history.js";
import { MawePlaybackLoop } from "./editor-playback-loop.js";
// 叠加轨表情包显示归属（sticker-overlay 写、渲染签名读）。
// 循环 import（sticker-overlay ↔ 本文件）下状态与安装主体都在本模块，
// 提供具名 setter 供跨文件写入（ESM 导入绑定不可赋值）。
let activeStickerHasOverlay = false;
export function setActiveStickerHasOverlay(value) { activeStickerHasOverlay = value; }
export function activeStickerHasOverlayFlag() { return activeStickerHasOverlay; }

// 循环 import（sticker-overlay ↔ 本文件）下，顶层立即初始化推迟
// 到全部模块求值完成后执行。
queueMicrotask(() => {
  MaweStickerOverlay.stickerOverlayLayer.id = 'sticker-overlay-layer';
  MaweStickerOverlay.stickerOverlayLayer.className = 'geo-box';
  MaweStickerOverlay.stickerOverlayLayer.tabIndex = 0;
  MaweStickerOverlay.stickerOverlayLayer.setAttribute('role', 'group');
  MaweStickerOverlay.stickerOverlayLayer.setAttribute('aria-label', '表情包预览位置。可拖动调整；方向键移动，按住 Shift 加速，按住 Alt 配合方向键调整大小，Enter 显示控制点，Esc 退出。');

  MaweStickerOverlay.stickerOverlayContent.className = 'sticker-overlay-content';
  MaweStickerOverlay.stickerOverlayLayer.appendChild(MaweStickerOverlay.stickerOverlayContent);
  ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((h) => {
    const handle = document.createElement('span');
    handle.className = 'overlay-handle';
    handle.dataset.handle = h;
    MaweStickerOverlay.stickerOverlayLayer.appendChild(handle);
  });
  MaweDom.playerStage.appendChild(MaweStickerOverlay.stickerOverlayLayer);
  MawePreviewGeometry.bindPreviewBoxPointerEvents(MaweStickerOverlay.stickerOverlayLayer, 'sticker');
  MaweStickerOverlay.stickerOverlayLayer.addEventListener('keydown', (event) => MawePreviewGeometry.handlePreviewBoxKeydown(event, 'sticker'));



















  MaweDom.stickerOverlayToggle?.addEventListener('change', () => {
    MaweSettings.updateEditorSettings({ stickerOverlayEnabled: MaweDom.stickerOverlayToggle.checked });
    MawePreviewGeometry.refreshPreviewGeometryEditable();
    MawePlaybackLoop.update();
  });

  // 表情包功能总开关：关闭时「预览表情包」不可用（强制关闭并禁用），
  // 右键菜单的分配入口由 context-menus 按同一设置隐藏；工程数据不受影响。
  function applyStickerFeatureEnabled() {
    const enabled = MaweSettings.EDITOR_SETTINGS.stickersEnabled !== false;
    const featureToggle = document.getElementById('sticker-feature-toggle');
    if (featureToggle) featureToggle.checked = enabled;
    if (MaweDom.stickerOverlayToggle) {
      MaweDom.stickerOverlayToggle.disabled = !enabled;
      if (!enabled && MaweDom.stickerOverlayToggle.checked) {
        MaweDom.stickerOverlayToggle.checked = false;
        MaweSettings.updateEditorSettings({ stickerOverlayEnabled: false });
      }
    }
    MaweStickerOverlay.stickerOverlayLayer.classList.toggle('hidden', !enabled);
    MawePreviewGeometry.refreshPreviewGeometryEditable();
    MawePlaybackLoop.update();
  }
  document.getElementById('sticker-feature-toggle')?.addEventListener('change', (event) => {
    MaweSettings.updateEditorSettings({ stickersEnabled: event.target.checked });
    applyStickerFeatureEnabled();
  });
  applyStickerFeatureEnabled();

  // 初次应用（不弄脏工程）：字幕与表情包预览几何。必须在 stickerOverlayLayer 创建之后执行（TDZ）。
  MawePreviewGeometry.setPreviewGeometry(MaweAppearance.getPreviewGeometry(), { markDirty: false });
  MawePreviewGeometry.setStickerGeometry(MawePreviewGeometry.getStickerGeometry(), { markDirty: false });
  MawePreviewGeometry.refreshPreviewGeometryEditable();

  MaweMediaPlayback.bindPlayerEvents(MaweCoreState.player);
});
MaweDom.overlayToggle.addEventListener('change', () => {
  // change 触发时 checked 已是新值；其它预览样式和副字幕开关仍从当前快照保留。
  const previous = MaweHistory.snapshotPreviewState();
  previous.overlay = !MaweDom.overlayToggle.checked;
  MaweHistory.pushPreviewUndo('切换字幕预览', previous);
  MaweSettings.updateEditorSettings({ overlayEnabled: MaweDom.overlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  if (!MaweDom.overlayToggle.checked) MaweDom.overlayEl.classList.add('hidden');
  else MawePlaybackLoop.update();
});
