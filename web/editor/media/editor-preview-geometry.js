// 预览几何：字幕/表情包预览框的手势拖拽与几何读写。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MawePreviewGeometry 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMawePreviewGeometry(global) {
  'use strict';


  // 写回 DATA.preview.subtitle 并刷新 DOM。markDirty=false 用于初次加载，不弄脏工程。
  function setPreviewGeometry(geo, { markDirty = true, replaceAppearance = false } = {}) {
    const clamped = MaweAppearance.GEO_UTILS.clampPreviewGeometry(MaweAppearance.GEO_UTILS.normalizePreviewGeometry(geo));
    const appearance = replaceAppearance
      ? MaweAppearance.getSubtitleAppearance(geo)
      : { ...MaweAppearance.getSubtitleAppearance(), ...MaweAppearance.normalizeSubtitleAppearance(geo) };
    if (!MaweBoot.DATA.preview || typeof MaweBoot.DATA.preview !== 'object') MaweBoot.DATA.preview = {};
    MaweBoot.DATA.preview.subtitle = {
      ...clamped,
      ...appearance,
      speaker_labels: MaweSpeakerLabels.getSpeakerLabelSettings(),
    };
    if (markDirty) MaweAppearance.previewGeometryDirty = true;
    applyPreviewGeometryToDom(clamped);
    MaweAppearance.applySubtitleAppearance(MaweBoot.DATA.preview.subtitle);
    return clamped;
  }


  function applyPreviewGeometryToDom(geo) {
    const css = MaweAppearance.GEO_UTILS.previewGeometryToCss(geo);
    MaweDom.overlayEl.style.left = css.left;
    MaweDom.overlayEl.style.top = css.top;
    MaweDom.overlayEl.style.width = css.width;
    MaweDom.overlayEl.style.height = css.height;
    MaweDom.overlayEl.style.right = 'auto';
    MaweDom.overlayEl.style.bottom = 'auto';
  }


  // === 表情包预览几何（preview.sticker）===
  // 与字幕预览同一套归一化/钳制逻辑，仅默认值不同（右上角小图）。
  function getStickerGeometry() {
    return MaweAppearance.GEO_UTILS.normalizePreviewGeometry(MaweBoot.DATA.preview?.sticker, MaweAppearance.GEO_UTILS.DEFAULT_STICKER_GEOMETRY);
  }


  // 写回 DATA.preview.sticker 并刷新 DOM。markDirty=false 用于初次加载，不弄脏工程。
  function setStickerGeometry(geo, { markDirty = true } = {}) {
    const clamped = MaweAppearance.GEO_UTILS.clampPreviewGeometry(
      MaweAppearance.GEO_UTILS.normalizePreviewGeometry(geo, MaweAppearance.GEO_UTILS.DEFAULT_STICKER_GEOMETRY),
    );
    if (!MaweBoot.DATA.preview || typeof MaweBoot.DATA.preview !== 'object') MaweBoot.DATA.preview = {};
    MaweBoot.DATA.preview.sticker = clamped;
    if (markDirty) MaweAppearance.previewGeometryDirty = true;
    applyStickerGeometryToDom(clamped);
    return clamped;
  }


  function applyStickerGeometryToDom(geo) {
    const css = MaweAppearance.GEO_UTILS.previewGeometryToCss(geo);
    MaweStickerOverlay.stickerOverlayLayer.style.left = css.left;
    MaweStickerOverlay.stickerOverlayLayer.style.top = css.top;
    MaweStickerOverlay.stickerOverlayLayer.style.width = css.width;
    MaweStickerOverlay.stickerOverlayLayer.style.height = css.height;
    MaweStickerOverlay.stickerOverlayLayer.style.right = 'auto';
    MaweStickerOverlay.stickerOverlayLayer.style.bottom = 'auto';
  }


  // 只有当对应预览开关开启时才允许几何编辑（关闭时字幕盒完全隐藏、表情包盒不拦截指针）。
  function refreshPreviewGeometryEditable() {
  const assMode = MaweSettings.EDITOR_SETTINGS.assMode === true;
  MaweDom.overlayEl.classList.toggle(
    'geometry-enabled',
    !assMode && (!!MaweDom.overlayToggle.checked || !!MaweDom.extensionOverlayToggle?.checked),
  );
  MaweStickerOverlay.stickerOverlayLayer.classList.toggle('geometry-enabled', !!MaweDom.stickerOverlayToggle?.checked);
}



  // --- 指针拖动 / 缩放（Pointer Events），字幕预览与表情包预览共用 ---
  let previewGesture = null;

    // { pointerId, handle, target, startX, startY, startGeo, rect }
  function previewTargetEl(target) { return target === 'sticker' ? MaweStickerOverlay.stickerOverlayLayer : MaweDom.overlayEl; }


  function previewTargetEnabled(target) {
    return target === 'sticker'
      ? !!MaweDom.stickerOverlayToggle?.checked
      : (!!MaweDom.overlayToggle.checked || !!MaweDom.extensionOverlayToggle?.checked);
  }


  function getTargetGeometry(target) { return target === 'sticker' ? getStickerGeometry() : MaweAppearance.getPreviewGeometry(); }


  function setTargetGeometry(target, geo) {
    if (target === 'sticker') setStickerGeometry(geo); else setPreviewGeometry(geo);
  }


  function playerStageRect() {
    return MaweDom.playerStage.getBoundingClientRect();
  }


  function beginPreviewGesture(event, handle, target) {
    if (!previewTargetEnabled(target)) return;
    const rect = playerStageRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const targetLabel = target === 'sticker' ? '表情包预览' : '字幕预览';
    // 一手势一撤销：在手势开始时压入手势前的快照。
    MaweHistory.pushPreviewUndo((handle === 'move' ? '移动' : '缩放') + targetLabel, MaweHistory.snapshotPreviewState());
    previewGesture = {
      pointerId: event.pointerId,
      handle,
      target,
      startX: event.clientX,
      startY: event.clientY,
      startGeo: getTargetGeometry(target),
      rect,
    };
    previewTargetEl(target).classList.add('dragging', 'editable');
    try { event.target.setPointerCapture?.(event.pointerId); } catch (_) {}
  }


  function movePreviewGesture(event) {
    if (!previewGesture || event.pointerId !== previewGesture.pointerId) return;
    const { rect, startX, startY, startGeo, handle, target } = previewGesture;
    const dx = (event.clientX - startX) / rect.width;
    const dy = (event.clientY - startY) / rect.height;
    const next = MaweAppearance.GEO_UTILS.applyPreviewGeometryDelta(startGeo, handle, dx, dy);
    setTargetGeometry(target, next);
  }


  function endPreviewGesture(event) {
    if (!previewGesture || event.pointerId !== previewGesture.pointerId) return;
    try { event.target.releasePointerCapture?.(event.pointerId); } catch (_) {}
    previewTargetEl(previewGesture.target).classList.remove('dragging');
    previewGesture = null;
  }


  function bindPreviewBoxPointerEvents(el, target) {
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // beginPreviewGesture 的 preventDefault 会阻止默认聚焦，显式聚焦让调整框随 :focus 显示
      el.focus();
      const handleEl = event.target.closest?.('.overlay-handle');
      const handle = handleEl ? handleEl.dataset.handle : 'move';
      beginPreviewGesture(event, handle, target);
    });
    el.addEventListener('pointermove', movePreviewGesture);
    el.addEventListener('pointerup', endPreviewGesture);
    el.addEventListener('pointercancel', endPreviewGesture);
  }



  // --- 键盘操作（聚焦时），字幕预览与表情包预览共用 ---
  // 方向键移动 1%；Shift 加速到 10%；Alt+方向缩放；Enter 切换 editable；Esc 失焦。
  function handlePreviewBoxKeydown(event, target) {
    if (!previewTargetEnabled(target)) return;
    const el = previewTargetEl(target);
    if (event.key === 'Escape') { el.blur(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      el.classList.toggle('editable');
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = arrows[event.key];
    if (!dir) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.10 : 0.01;
    const resize = event.altKey;  // Alt+方向缩放；否则移动
    const dx = dir[0] * step;
    const dy = dir[1] * step;
    const targetLabel = target === 'sticker' ? '表情包预览' : '字幕预览';
    MaweHistory.pushPreviewUndo((resize ? '缩放' : '移动') + targetLabel, MaweHistory.snapshotPreviewState());
    const startGeo = getTargetGeometry(target);
    const next = resize
      ? MaweAppearance.GEO_UTILS.applyPreviewGeometryDelta(startGeo, dir[0] !== 0 ? 'e' : 's', dx, dy)
      : MaweAppearance.GEO_UTILS.applyPreviewGeometryDelta(startGeo, 'move', dx, dy);
    setTargetGeometry(target, next);
  }

  global.MawePreviewGeometry = Object.freeze({
    setPreviewGeometry,
    applyPreviewGeometryToDom,
    getStickerGeometry,
    setStickerGeometry,
    applyStickerGeometryToDom,
    refreshPreviewGeometryEditable,
    get previewGesture() { return previewGesture; },
    set previewGesture(v) { previewGesture = v; },
    previewTargetEl,
    previewTargetEnabled,
    getTargetGeometry,
    setTargetGeometry,
    playerStageRect,
    beginPreviewGesture,
    movePreviewGesture,
    endPreviewGesture,
    bindPreviewBoxPointerEvents,
    handlePreviewBoxKeydown
  });
})(typeof window !== 'undefined' ? window : globalThis);
