// 叠加轨动作接线：表情包分配/预览 modal 的 DOM 绑定。颜色组、叠加轨
// 颜色/合并/清除与波形新增等领域逻辑已收入 ESM 纯模块 overlay-track.js
// （含 stickerTargetTrack / previewTrack 可变状态，经 overlaySticker 访问器
// 读写）。classic 时代的 overlay 动作门面由静态 import 取代。
import { overlaySticker } from './overlay-track.js';

export function initOverlayActionsWiring() {
  'use strict';

// === 表情包 ===
  // 顶层 DOM 监听随函数体在装配器调用位次执行，时机不变（G07 gate）。

document.getElementById('sticker-filter')?.addEventListener('input', (e) => {
  MaweStickerPicker.renderStickerGrid(e.target.value);
});
document.getElementById('sticker-cancel')?.addEventListener('click', () => MaweDom.stickerModal.classList.remove('show'));
document.getElementById('sticker-clear')?.addEventListener('click', MaweStickerPicker.clearStickerOnTargets);
MaweDom.stickerModal?.addEventListener('click', (e) => { if (e.target === MaweDom.stickerModal) MaweDom.stickerModal.classList.remove('show'); });

// 表情包预览 modal

document.getElementById('sticker-preview-close')?.addEventListener('click', () => MaweDom.stickerPreviewModal.classList.remove('show'));
MaweDom.stickerPreviewModal?.addEventListener('click', (e) => { if (e.target === MaweDom.stickerPreviewModal) MaweDom.stickerPreviewModal.classList.remove('show'); });
document.getElementById('sticker-preview-delete')?.addEventListener('click', () => {
  if (MaweStickerPicker.previewIdx < 0) return;
  // 如果删除的是 head，要把所有引用它的 sticker_ref 也清掉
  MaweStickerPicker.removeStickerCascade(MaweStickerPicker.previewIdx, { overlay: overlaySticker.previewTrack === 'overlay' });
  MaweDom.stickerPreviewModal.classList.remove('show');
  MaweCuePanel.renderAll();
  MaweHint.flashHint('已删除', 'success');
});

// 删除表情包时级联清理引用：
// - 如果 idx 是 head，清掉所有 headIdx===idx 的 sticker_ref
// - 如果 idx 是 ref，仅清自己（不影响 head）

document.getElementById('sticker-preview-replace')?.addEventListener('click', () => {
  if (MaweStickerPicker.previewIdx < 0) return;
  MaweDom.stickerPreviewModal.classList.remove('show');
  MaweStickerPicker.openStickerPicker([MaweStickerPicker.previewIdx], false, { overlay: overlaySticker.previewTrack === 'overlay' });
});

// 拓展表情包时间到多选范围
// 选中范围内可以包含 sticker（head）或 sticker_ref（引用），都视作"已有表情包"

// === 标记颜色 ===
// 数据结构与表情包同构：head 持完整 color，后续条持 color_ref（仅 name + headIdx）
// 单选 → 设为 head；多选 → 第一条为 head，时间跨整个范围，后续为 ref
// （颜色组与叠加轨颜色的领域逻辑在 overlay-track.js）

// === 禁用/启用 ===
// 统一切换语义：目标全部禁用 → 全部启用；否则全部禁用
// 单条时即"切换这一条的状态"（Alt+点击 / 右键菜单均走这里）

// === 从波形空白处新增字幕 ===
// （overlay-track.js：addOverlayRangeFromWaveform / addOverlayAtWaveformTime）

// 右键波形背景：添加空隙、创建字幕，或按右键对应的音频位置拆分命中的字幕。
// （接线在 editor-wiring-context-menus.js）
}
