
// === ASS 预览接线（Canvas 合成） + 当前行高亮 ===

// ASS 模式下文本统一由 MaweAssCanvas 在 PlayRes 原生分辨率画布上绘制
//（描边质量与 libass 一致的理由见该模块头注）；本文件只负责组装样式、
// 动画状态与锚定参数，并把 ASS 模式的 DOM 文本元素整体隐藏。
// SRT/CSS 预览仍走原有的 DOM 路径，退出 ASS 模式时 restore* 恢复。

// 列表点击关闭自动滚动时，避免这次 seek 的同步 active 更新再次滚动列表；
// 播放指针拖动期间也暂时保持列表位置，避免连续 seek 触发滚动布局。













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

function applyAssSubtitlePreview({ tMs, segment, extension, overlay, overlaySegments, mainColorName, speakerLabelVisible }) {
  const library = window.AsrEditorUtils.normalizeAssStyleLibrary(ASS_STYLE_LIBRARY);
  const profile = window.AsrEditorUtils.assProfileForId(
    library,
    library.assignments?.assExportProfileId || 'ass',
  );
  const baseStyle = window.AsrEditorUtils.assStyleForId(library, profile.styleId);
  const metrics = assPreviewMetrics();
  // 边距保持 PlayRes 原生坐标：Canvas 合成层直接在原生坐标系绘制，
  // 锚点、描边、字号不再各自乘缩放系数。
  const margins = {
    left: Math.max(0, Number(baseStyle.marginL) || 0),
    right: Math.max(0, Number(baseStyle.marginR) || 0),
    vertical: Math.max(0, Number(baseStyle.marginV) || 0),
  };
  const appearance = MaweAppearance.getSubtitleAppearance();
  const extensionSegments = activeExtensionSegments();
  const mainStyle = assPreviewStyleVariant(baseStyle, segment, MaweBoot.DATA.segments, appearance);
  // 副字幕使用样式库「副字幕样式」槽位的独立样式（副字幕不支持颜色分组，
  // 不做调色板变体），对齐与边距完全由该样式决定。
  const extensionStyleBase = window.AsrEditorUtils.assStyleForId(
    library, library.assignments?.assExtensionStyleId || 'ass-extension',
  );
  const extensionMargins = {
    left: Math.max(0, Number(extensionStyleBase.marginL) || 0),
    right: Math.max(0, Number(extensionStyleBase.marginR) || 0),
    // 副字幕锚定在主字幕上方：边距 = 主字幕垂直边距 + 1.2 × 主字号，
    // 与导出侧的固化公式一致；副字幕样式自身的 marginV 不再决定位置。
    vertical: Math.max(0, Number(margins.vertical) || 0)
      + Math.round(1.2 * assPreviewExportFontSize(baseStyle, metrics)),
  };
  // 叠加轨导出引用颜色样式名（无颜色时回落）；预览按同一映射
  // 应用 ass_color_style 的调色板变体，保持与导出一致。
  const overlayTrackStyle = assPreviewStyleVariant(
    baseStyle,
    overlay,
    overlaySegments || [],
    appearance,
  );
  const mainDuration = Math.max(1, Number(segment?.end) - Number(segment?.start) || 1);
  const extensionDuration = Math.max(1, Number(extension?.end) - Number(extension?.start) || 1);
  const mainAnimation = window.AsrEditorUtils.assPreviewAnimationState(
    profile,
    Math.max(0, Number(tMs) - Number(segment?.start || 0)),
    mainDuration,
    {
      playResX: metrics.resolution.width,
      playResY: metrics.resolution.height,
      stageWidth: metrics.stageWidth,
      stageHeight: metrics.stageHeight,
      fad: window.AsrEditorUtils.assSentenceFadeTags(
        segment?.text || '', profile, MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule,
      ).fad,
    },
  );
  const extensionAnimation = window.AsrEditorUtils.assPreviewAnimationState(
    profile,
    Math.max(0, Number(tMs) - Number(extension?.start || 0)),
    extensionDuration,
    {
      playResX: metrics.resolution.width,
      playResY: metrics.resolution.height,
      stageWidth: metrics.stageWidth,
      stageHeight: metrics.stageHeight,
      fad: window.AsrEditorUtils.assSentenceFadeTags(
        extension?.text || '', profile, MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule,
      ).fad,
    },
  );
  // 叠加轨不跟随 \move（绝对 PlayRes 坐标只属于主字幕）；fad/fade/t 与
  // 位置无关，预览与导出保持一致。
  const overlayDuration = Math.max(1, Number(overlay?.end) - Number(overlay?.start) || 1);
  const overlayAnimation = window.AsrEditorUtils.assPreviewAnimationState(
    profile,
    Math.max(0, Number(tMs) - Number(overlay?.start || 0)),
    overlayDuration,
    {
      playResX: metrics.resolution.width,
      playResY: metrics.resolution.height,
      stageWidth: metrics.stageWidth,
      stageHeight: metrics.stageHeight,
      fad: window.AsrEditorUtils.assSentenceFadeTags(
        overlay?.text || '', profile, MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule,
      ).fad,
    },
  );
  const animationGroup = profile.animations || {};
  const withMove = (style, state) => ({
    ...assPreviewAnimatedStyle(style, profile, state, metrics),
    __assMove: animationGroup.move?.enabled ? { x: state.moveX, y: state.moveY } : null,
  });
  const animatedMainStyle = withMove(mainStyle, mainAnimation);
  // 副字幕与叠加轨不跟随 \move（绝对 PlayRes 坐标只属于主字幕）；
  // fad/fade/t 与位置无关，预览与导出保持一致。
  const animatedExtensionStyle = assPreviewAnimatedStyle(extensionStyleBase, profile, extensionAnimation, metrics);
  const animatedOverlayTrackStyle = assPreviewAnimatedStyle(overlayTrackStyle, profile, overlayAnimation, metrics);
  // 叠加轨锚定 = 下方最近一层的边距 + 1.2 × 该层字号（与导出的固化
  // 公式一致）：有副字幕时叠在副字幕上方，否则叠在主字幕上方。偏移按
  // 动画前的基础字号计算——导出侧 MarginV 固化在样式里，\t(\fs) 只改
  // 变字形大小，不改变锚定边距。
  const extensionTrackActive = extensionSegments
    .some((cue) => cue && cue.disabled !== true);
  const mainNativeFontSize = assPreviewExportFontSize(baseStyle, metrics);
  const extensionNativeFontSize = assPreviewExportFontSize(extensionStyleBase, metrics);
  const overlayOffsetNative = extensionTrackActive
    ? extensionMargins.vertical + 1.2 * extensionNativeFontSize
    : margins.vertical + 1.2 * mainNativeFontSize;

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

  // 说话人标签跟随主字幕合成（画在首行行首）：与导出 assEventText 一致，
  // text / speaker 模式标签跟随调色板颜色，其余保持基础色。
  let speaker = null;
  if (speakerLabelVisible) {
    const paletteColor = MaweColors.COLOR_BY_NAME[mainColorName]?.value;
    const assColorStyle = appearance.ass_color_style || DEFAULT_ASS_COLOR_STYLE;
    const labelColor = assColorStyle === 'text' || assColorStyle === 'speaker'
      ? paletteColor || animatedMainStyle.primaryColor
      : animatedMainStyle.primaryColor;
    speaker = {
      text: String(MaweDom.overlayMainSpeakerLabelEl.textContent || ''),
      color: labelColor,
    };
  }
  // 叠加轨说话人标签同理：映射按叠加轨自身数组解析（与播放循环同源），
  // 叠加轨 DOM 元素在 ASS 模式已整体隐藏，标签必须进 Canvas 才可见。
  let overlaySpeaker = null;
  if (overlay) {
    const speakerLabels = MaweSpeakerLabels.getSpeakerLabelSettings();
    const overlayColorContext = overlaySegments || [];
    const overlayLabel = speakerLabels.mapping_enabled && speakerLabels.enabled
      ? window.AsrEditorUtils.speakerLabelForSegment(
        overlay, overlayColorContext, speakerLabels.names,
      )
      : '';
    const overlayColorName = MULTI_SUBTITLE_UTILS.effectiveColorName(overlay, overlayColorContext);
    if (overlayLabel && overlayColorName && MaweColors.COLOR_BY_NAME[overlayColorName]) {
      const assColorStyle = appearance.ass_color_style || DEFAULT_ASS_COLOR_STYLE;
      const paletteColor = MaweColors.COLOR_BY_NAME[overlayColorName].value;
      const labelColor = assColorStyle === 'text' || assColorStyle === 'speaker'
        ? paletteColor
        : animatedOverlayTrackStyle.primaryColor;
      overlaySpeaker = {
        text: `${overlayLabel}${speakerLabels.separator}`,
        color: labelColor,
      };
    }
  }

  window.MaweAssCanvas?.render({
    playResX: metrics.resolution.width,
    playResY: metrics.resolution.height,
    tracks: [
      {
        visible: Boolean(segment),
        runs: assPreviewTrackRuns(segment?.text || ''),
        style: animatedMainStyle,
        animation: mainAnimation,
        nativeFontSize: assPreviewExportFontSize(animatedMainStyle, metrics),
        margins,
        speaker,
      },
      {
        visible: Boolean(extension),
        runs: assPreviewTrackRuns(extension?.text || ''),
        style: animatedExtensionStyle,
        animation: extensionAnimation,
        nativeFontSize: assPreviewExportFontSize(animatedExtensionStyle, metrics),
        margins: extensionMargins,
      },
      {
        // 链在副字幕上方时，叠加元素沿用副字幕样式的对齐与边距（与导出
        // 侧 Overlay 样式继承锚定层坐标系保持一致）；垂直偏移用链式锚定，
        // 覆盖样式的 marginV。
        visible: Boolean(overlay),
        runs: assPreviewTrackRuns(overlay?.text || ''),
        style: animatedOverlayTrackStyle,
        animation: overlayAnimation,
        nativeFontSize: assPreviewExportFontSize(animatedOverlayTrackStyle, metrics),
        alignment: extensionTrackActive ? extensionStyleBase.alignment : baseStyle.alignment,
        speaker: overlaySpeaker,
        margins: {
          left: extensionTrackActive ? extensionMargins.left : margins.left,
          right: extensionTrackActive ? extensionMargins.right : margins.right,
          vertical: overlayOffsetNative,
        },
      },
    ],
  });
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
  exportFontSize: assPreviewExportFontSize,
});





// 列表重绘或属性批量变更后的 update() 只刷新时间码与激活态，不触发播放跟随滚动。
// renderAll 刚重建列表时，content-visibility 让视口外的行仍处于估算占位
// 高度，updateActiveCue 量到的瞬态几何会把「活动行不在视口」误判成真，
// 再用被污染的 offsetTop 算出错误目标平滑滚走（页面放大倍率越高、真实
// 行高与估算差异越大越容易触发）。这些操作是否滚动、滚到哪里都应由
// 调用方显式决定（例如拆分按来源保持原位或居中新右半段）。
