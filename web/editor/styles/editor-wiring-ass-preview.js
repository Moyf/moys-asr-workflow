
// === ASS 预览接线（Canvas 合成） + 当前行高亮 ===

// ASS 模式下文本统一由 MaweAssCanvas 在 PlayRes 原生分辨率画布上绘制
//（描边质量与 libass 一致的理由见该模块头注）；本文件只负责组装样式、
// 动画状态与锚定参数，并把 ASS 模式的 DOM 文本元素整体隐藏。
// SRT/CSS 预览仍走原有的 DOM 路径，退出 ASS 模式时 restore* 恢复。

// 列表点击关闭自动滚动时，避免这次 seek 的同步 active 更新再次滚动列表；
// 播放指针拖动期间也暂时保持列表位置，避免连续 seek 触发滚动布局。













let lastStableAssPreviewGeometry = null;
function assPreviewMetrics() {
  const resolution = MaweExportSrt.currentAssVideoResolution()
    || { width: 1920, height: 1080 };
  const rect = MaweDom.playerStage?.getBoundingClientRect?.();
  const boxWidth = Math.max(1, Number(rect?.width) || Number(MaweDom.playerStage?.clientWidth) || resolution.width);
  const boxHeight = Math.max(1, Number(rect?.height) || Number(MaweDom.playerStage?.clientHeight) || resolution.height);
  const player = MaweCoreState.player;
  const aspect = player?.videoWidth && player?.videoHeight
    ? player.videoWidth / player.videoHeight : resolution.width / resolution.height;
  const video = player?.tagName === 'VIDEO';
  const stageWidth = video ? Math.min(boxWidth, boxHeight * aspect) : boxWidth;
  const stageHeight = video ? Math.min(boxHeight, boxWidth / aspect) : boxHeight;
  if (stageWidth >= 48 && stageHeight >= 48) {
    lastStableAssPreviewGeometry = {
      stageWidth,
      stageHeight,
      offsetX: (boxWidth - stageWidth) / 2,
      offsetY: (boxHeight - stageHeight) / 2,
    };
  } else if (lastStableAssPreviewGeometry) {
    // Playback refreshes the ASS canvas every frame, including while a fullscreen
    // layout transition briefly collapses the stage. Keep the last usable geometry
    // until ResizeObserver's settled refresh supplies the new dimensions.
    return {
      resolution,
      ...lastStableAssPreviewGeometry,
      scaleX: lastStableAssPreviewGeometry.stageWidth / resolution.width,
      scaleY: lastStableAssPreviewGeometry.stageHeight / resolution.height,
    };
  } else {
    // A first render can race the initial layout. Use the native canvas size until
    // the stage has a meaningful rectangle rather than squeezing ASS into a few px.
    return {
      resolution,
      stageWidth: resolution.width,
      stageHeight: resolution.height,
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
    };
  }
  return {
    resolution,
    stageWidth,
    stageHeight,
    offsetX: (boxWidth - stageWidth) / 2,
    offsetY: (boxHeight - stageHeight) / 2,
    scaleX: stageWidth / resolution.width,
    scaleY: stageHeight / resolution.height,
  };
}

function assPreviewStyleVariant(style, segment, segments, appearance) {
  // ASS 预览的颜色映射只跟随 ass_color_style；color_underline 只控制 CSS 预览。
  const colorName = segment
    ? MULTI_SUBTITLE_UTILS.effectiveColorName(segment, segments) : null;
  const paletteValue = MaweColors.COLOR_BY_NAME[colorName]?.value || '';
  if (!paletteValue || typeof window.AsrEditorUtils.assStyleVariant !== 'function') return style;
  return window.AsrEditorUtils.assStyleVariant(
    style,
    paletteValue,
    appearance.ass_color_style || DEFAULT_ASS_COLOR_STYLE,
  );
}

function assPreviewAnimatedStyle(style, profile, animationState, metrics) {
  if (animationState.transformProgress === null) return style;
  const tags = profile?.animations?.t?.tags || '';
  // \fs targets are in native PlayRes pixels, whereas the library stores its
  // base size at 1080p. Interpolate both endpoints in native coordinates.
  const native = { ...style, fontSize: assPreviewExportFontSize(style, metrics) };
  const result = window.AsrEditorUtils.assPreviewStyleAt(native, tags, animationState.transformProgress);
  return { ...result, __assNativeFontSize: result.fontSize };
}

const assPreviewFontMetrics = new Map();

function assPreviewFontScale(style) {
  // ASS sizes the font by ascent + descent, CSS by unitsPerEm. The browser's
  // normal line box approximates that ratio without reading local font files.
  // This remains approximate (fallback fonts and OS/2 vs hhea metrics differ);
  // the paused Server preview uses libass itself for exact shaping/layout.
  const family = MaweAppearance.subtitleFontFamilyCss(style.fontName);
  const key = JSON.stringify([family, style.bold, style.italic]);
  if (assPreviewFontMetrics.has(key)) return assPreviewFontMetrics.get(key);
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:max-content;padding:0;border:0;margin:0;line-height:normal;font-size:200px;';
  probe.style.fontFamily = family;
  probe.style.fontWeight = style.bold ? '700' : '400';
  probe.style.fontStyle = style.italic ? 'italic' : 'normal';
  probe.textContent = 'Mg';
  document.body.append(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  const scale = height > 0 ? 200 / height : 1;
  assPreviewFontMetrics.set(key, scale);
  return scale;
}

function assPreviewExportFontSize(style, metrics) {
  if (Number.isFinite(style.__assNativeFontSize)) return Math.max(1, style.__assNativeFontSize);
  return window.AsrEditorUtils.normalizeAssFontSize(
    Number(style.fontSize) * metrics.resolution.height / ASS_PREVIEW_REFERENCE_HEIGHT,
  );
}

document.fonts?.addEventListener('loadingdone', () => {
  assPreviewFontMetrics.clear();
  window.MaweAssCanvas?.clearCaches();
  window.MawePlaybackLoop?.refreshSubtitlePreview();
});

function clearAssPreviewSpeakerLabelStyle(element) {
  if (!element) return;
  [
    'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration-line',
    'text-decoration-color', 'text-underline-offset', 'color', '-webkit-text-stroke',
    'paint-order', 'filter', 'letter-spacing', 'line-height',
  ].forEach((property) => element.style.removeProperty(property));
}

function restoreCssSubtitlePreviewElement(element, appearance, fallbackSize, fallbackColor) {
  if (!element) return;
  [
    'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration-line',
    'text-decoration-color', 'text-underline-offset', 'color', ' -webkit-text-stroke',
    '-webkit-text-stroke', 'paint-order', 'filter', 'letter-spacing', 'line-height',
    'max-width', 'word-break', 'padding', 'background-color', 'border-radius', 'opacity', 'position',
    'left', 'right', 'top', 'bottom', 'white-space', 'text-align', 'transform-origin', 'transform',
  ].forEach((property) => element.style.removeProperty(property.trim()));
  element.style.setProperty(
    '--subtitle-preview-font-size',
    `${appearance.font_size || fallbackSize}px`,
  );
  element.style.fontFamily = MaweAppearance.subtitleFontFamilyCss(appearance.font_family);
  const hasCustomBackground = Object.prototype.hasOwnProperty.call(appearance, 'background_color')
    || Object.prototype.hasOwnProperty.call(appearance, 'background_alpha');
  element.style.backgroundColor = hasCustomBackground ? MaweAppearance.subtitleBackgroundCss(appearance) : '';
  element.style.color = appearance.color || fallbackColor;
}

function restoreCssSubtitlePreview() {
  window.MaweAssCanvas?.hide();
  window.MaweAssCuePosition?.sync();
  clearAssEmphasisPreview(MaweDom.overlayTextEl);
  clearAssEmphasisPreview(MaweDom.overlayExtensionTextEl);
  clearAssEmphasisPreview(overlayTrackTextEl);
  MaweDom.overlayEl.removeAttribute('data-ass-mode');
  MaweDom.overlayEl.classList.remove('ass-preview-active');
  delete MaweDom.overlayTextEl.dataset.colorUnderline;
  delete MaweDom.overlayTextEl.dataset.colorText;
  delete MaweDom.overlayTextEl.dataset.colorStroke;
  delete MaweDom.overlayMainSpeakerLabelEl.dataset.color;
  ['align-items', 'justify-content', 'text-align', 'padding', 'box-sizing'].forEach((property) => {
    MaweDom.overlayEl.style.removeProperty(property);
  });
  MawePreviewGeometry.applyPreviewGeometryToDom(MaweAppearance.getPreviewGeometry());
  restoreCssSubtitlePreviewElement(
    MaweDom.overlayTextEl,
    MaweAppearance.getSubtitleAppearance(),
    MaweSettings.SUBTITLE_DEFAULT_FONT_SIZE,
    MaweSettings.DEFAULT_SUBTITLE_COLOR,
  );
  restoreCssSubtitlePreviewElement(
    MaweDom.overlayExtensionTextEl,
    MaweAppearance.getExtensionSubtitleAppearance(),
    MaweSettings.EXTENSION_SUBTITLE_DEFAULT_FONT_SIZE,
    MaweSettings.DEFAULT_EXTENSION_SUBTITLE_COLOR,
  );
  clearAssPreviewSpeakerLabelStyle(MaweDom.overlayMainSpeakerLabelEl);
  restoreAssOverlayTrackPreview();
}

function clearAssEmphasisPreview(element) {
  const wrapper = element?.querySelector(':scope > .ass-emphasis-runs');
  wrapper?.remove();
  if (element) delete element.dataset.assEmphasisKey;
}

// ASS 文本 run 构建：预览剥离单句渐入渐出标记（`>>`/`<<` 由 fad 动画表现，
// 不显示为文字），再按编辑器标记语法切成强调/下划线/删除线/大小字号
// run——与旧 DOM 预览同源，绘制交给 MaweAssCanvas。
function assPreviewTrackRuns(text) {
  const source = window.AsrEditorUtils.stripSentenceFadeMarkers(
    String(text ?? ''), MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule,
  );
  return window.AsrEditorUtils.assInlineStyleRuns(
    source, MaweSettings.EDITOR_SETTINGS.assEmphasisSyntax, MaweSettings.EDITOR_SETTINGS,
  );
}

let cachedAssStackKey = '';
let cachedAssStackPlan = null;
let lastAssStackDiagnostic = '';
let assStackFontRevision = 0;
const assStackCueSnapshots = [[], [], []];
let assStackCueRevision = 0;
function assStackInputRevision(tracks, identityTracks = tracks) {
  let changed = false;
  for (let track = 0; track < tracks.length; track += 1) {
    const source = tracks[track] || [], snapshot = assStackCueSnapshots[track];
    if (snapshot.length !== source.length) { snapshot.length = source.length; changed = true; }
    for (let index = 0; index < source.length; index += 1) {
      const cue = source[index] || {}, previous = snapshot[index];
      const identity = identityTracks[track]?.[index] || cue;
      const color = typeof cue.color === 'object' ? JSON.stringify(cue.color) : cue.color;
      // Locally projected cues are temporary objects. Keep raw identity stable,
      // but include retained item boundaries so equal repeated text cannot hide
      // a different selection or a source restoration from the cached plan.
      const retainedItems = cue !== identity ? JSON.stringify(cue.items) : '';
      if (!previous || previous[0] !== identity || previous[1] !== cue.start || previous[2] !== cue.end
        || previous[3] !== cue.text || previous[4] !== cue.disabled || previous[5] !== color
        || previous[6] !== cue.speaker || previous[7] !== cue.id
        || previous[8] !== cue.color_ref?.headIdx || previous[9] !== cue.color_ref?.name
        || previous[10] !== retainedItems || previous[11] !== JSON.stringify(cue.assOverride)) {
        snapshot[index] = [identity, cue.start, cue.end, cue.text, cue.disabled, color, cue.speaker, cue.id,
          cue.color_ref?.headIdx, cue.color_ref?.name, retainedItems, JSON.stringify(cue.assOverride)]; changed = true;
      }
    }
  }
  if (changed) assStackCueRevision += 1;
  return assStackCueRevision;
}
document.fonts?.addEventListener('loadingdone', () => { assStackFontRevision += 1; cachedAssStackKey = ''; });

function applyAssSubtitlePreview({ tMs, overlaySegments }) {
  const metrics = assPreviewMetrics();
  // Snapshot only project inputs: measurements and animation envelopes are
  // computed once per revision, never once per playback frame. Direct edits
  // to mutable imported cue/style records also invalidate this snapshot.
  const rawTracks = [MaweBoot.DATA.segments, activeExtensionSegments(), overlaySegments];
  const revision = assStackInputRevision([MaweExportSrt.cleanupMainSegments(), rawTracks[1], rawTracks[2]], rawTracks);
  const key = JSON.stringify([revision, ASS_STYLE_LIBRARY, MaweSettings.EDITOR_SETTINGS,
    MaweAppearance.getSubtitleAppearance(), metrics.resolution, MaweColors.COLOR_PALETTE,
    MaweSpeakerLabels.getSpeakerLabelSettings(), MaweDom.overlayToggle.checked,
    MaweDom.extensionOverlayToggle?.checked, assStackFontRevision]);
  if (key !== cachedAssStackKey || !cachedAssStackPlan) {
    MaweExportSrt.buildAss({ preview: true, allowAssPlanDiagnostics: true,
      onAssPlan: plan => { cachedAssStackPlan = plan; } });
    cachedAssStackKey = key;
  }
  const frame = window.AsrEditorUtils.assStackFrame(cachedAssStackPlan, Number(tMs));
  MaweDom.overlayEl.dataset.assStackStatus = frame.diagnostic ? 'unavailable' : 'ready';
  MaweDom.overlayEl.title = frame.diagnostic;
  if (frame.diagnostic !== lastAssStackDiagnostic) {
    if (frame.diagnostic) MaweHint.flashHint(frame.diagnostic, 'warning');
    lastAssStackDiagnostic = frame.diagnostic;
  }
  MaweDom.overlayEl.dataset.assMode = 'true';
  MaweDom.overlayEl.classList.add('ass-preview-active');
  // ASS 的坐标系覆盖整个 PlayRes 画布；旧版 CSS 预览保存的自定义字幕盒
  // 只在 CSS 模式下生效，否则会把 Alignment / Margin 的语义再次套一层。
  // overlayEl 只是 Canvas 的定位容器，文字绘制全部在画布内完成。
  MaweDom.overlayEl.style.left = `${metrics.offsetX}px`;
  MaweDom.overlayEl.style.top = `${metrics.offsetY}px`;
  MaweDom.overlayEl.style.right = 'auto';
  MaweDom.overlayEl.style.bottom = 'auto';
  MaweDom.overlayEl.style.width = `${metrics.stageWidth}px`;
  MaweDom.overlayEl.style.height = `${metrics.stageHeight}px`;
  // ASS 文本由 Canvas 合成，DOM 文本元素整体隐藏（refreshSubtitlePreview
  // 在 CSS 模式下按可见性切换 hidden，这里每帧强制覆盖）。
  [MaweDom.overlayTextEl, MaweDom.overlayExtensionTextEl, overlayTrackTextEl, MaweDom.overlayMainSpeakerLabelEl]
    .forEach((element) => {
      if (element && !element.classList.contains('hidden')) element.classList.add('hidden');
    });

  const profile = cachedAssStackPlan.profile;
  const tracks = frame.items.map(item => {
    const animation = (item.legacy && !item.sharedStackCue ? window.AsrEditorUtils.assPreviewAnimationState : window.AsrEditorUtils.assStackAnimationState)(profile,
      Number(tMs) - item.start, item.end - item.start, { fad: item.fad });
    const native = { ...item.style, fontSize: item.fontSize };
    const animated = animation.transformProgress === null ? native
      : window.AsrEditorUtils.assPreviewStyleAt(native, profile.animations.t.tags, animation.transformProgress, { nativeFontSize: true });
    if ((!item.legacy || item.sharedStackCue) && profile.animations.t.enabled) {
      // libass applies discrete style tags inside t immediately, even before
      // the numeric transform window starts (real b/i frame-hash verification).
      const targets = window.AsrEditorUtils.assTransformStyleTargets(profile.animations.t.tags);
      for (const key of ['bold', 'italic', 'underline', 'strikeOut']) {
        if (targets[key] !== undefined) animated[key] = Boolean(targets[key]);
      }
    }
    const scale = item.scale * (item.cueScale || 1);
    const style = { ...animated, spacing: animated.spacing * scale,
      outline: animated.outline * scale, shadow: animated.shadow * scale,
      __assMove: item.legacy && !item.manual && item.role === 'main' && profile.animations.move.enabled ? { x: animation.moveX, y: animation.moveY } : null };
    return { visible: true, role: item.role, cueId: item.segment.id ?? item.index,
      runs: item.runs, style, animation,
      shakeOffset: item.shakeOffset || null,
      fractionalFontSize: !item.legacy || item.sharedStackCue,
      nativeFontSize: Math.max(1, animated.fontSize * scale), alignment: item.alignment,
      anchor: item.anchor || null, margins: { left: item.style.marginL, right: item.style.marginR, vertical: item.style.marginV } };
  });
  window.MaweAssCanvas?.render({ playResX: metrics.resolution.width, playResY: metrics.resolution.height, tracks });
}

function restoreAssOverlayTrackPreview() {
  if (!overlayTrackTextEl) return;
  [
    'position', 'left', 'right', 'top', 'bottom', 'white-space', 'word-break', 'text-align',
    'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration-line',
    'text-decoration-color', 'text-underline-offset', 'color', '-webkit-text-stroke',
    'paint-order', 'text-shadow', 'letter-spacing', 'line-height',
    'max-width', 'padding', 'background-color', 'border-radius', 'opacity',
    'transform-origin', 'transform',
  ].forEach((property) => overlayTrackTextEl.style.removeProperty(property));
  delete overlayTrackTextEl.dataset.colorUnderline;
  delete overlayTrackTextEl.dataset.colorText;
  delete overlayTrackTextEl.dataset.colorStroke;
}

// The manager also uses the calibrated font metrics after boot has completed;
// the Canvas layer reuses exportFontSize for native run sizes.
window.MaweAssPreview = Object.freeze({
  fontScale: assPreviewFontScale,
  get stackPlan() { return cachedAssStackPlan; },
  exportFontSize: assPreviewExportFontSize,
});





// 列表重绘或属性批量变更后的 update() 只刷新时间码与激活态，不触发播放跟随滚动。
// renderAll 刚重建列表时，content-visibility 让视口外的行仍处于估算占位
// 高度，updateActiveCue 量到的瞬态几何会把「活动行不在视口」误判成真，
// 再用被污染的 offsetTop 算出错误目标平滑滚走（页面放大倍率越高、真实
// 行高与估算差异越大越容易触发）。这些操作是否滚动、滚到哪里都应由
// 调用方显式决定（例如拆分按来源保持原位或居中新右半段）。
