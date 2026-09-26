
// === 当前行高亮 + overlay ===

// 列表点击关闭自动滚动时，避免这次 seek 的同步 active 更新再次滚动列表；
// 播放指针拖动期间也暂时保持列表位置，避免连续 seek 触发滚动布局。
















function assPreviewAlignment(value) {
  const alignment = Math.min(9, Math.max(1, Math.round(Number(value) || 2)));
  const column = (alignment - 1) % 3;
  const row = Math.floor((alignment - 1) / 3);
  return {
    x: column / 2,
    y: row === 0 ? 1 : row === 1 ? 0.5 : 0,
    alignItems: column === 0 ? 'flex-start' : column === 1 ? 'center' : 'flex-end',
    justifyContent: row === 0 ? 'flex-end' : row === 1 ? 'center' : 'flex-start',
    textAlign: column === 0 ? 'left' : column === 1 ? 'center' : 'right',
  };
}

function assPreviewMetrics() {
  const resolution = MaweExportSrt.currentAssVideoResolution()
    || { width: 1920, height: 1080 };
  const rect = MaweDom.playerStage?.getBoundingClientRect?.();
  const stageWidth = Math.max(1, Number(rect?.width) || Number(MaweDom.playerStage?.clientWidth) || resolution.width);
  const stageHeight = Math.max(1, Number(rect?.height) || Number(MaweDom.playerStage?.clientHeight) || resolution.height);
  return {
    resolution,
    stageWidth,
    stageHeight,
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

function assPreviewAnimatedStyle(style, profile, animationState) {
  if (animationState.transformProgress === null) return style;
  const tags = profile?.animations?.t?.tags || '';
  return window.AsrEditorUtils.assPreviewStyleAt(style, tags, animationState.transformProgress);
}

function assPreviewFontSize(style, metrics) {
  // Style-library font sizes use the same 1080p reference as ASS export.
  // Export scales the value to PlayResY; applying the inverse stage scale here
  // keeps a 4K source visually consistent with its exported ASS rendering.
  return Math.max(1, Number(style.fontSize) || 18)
    * metrics.stageHeight / ASS_PREVIEW_REFERENCE_HEIGHT;
}

function applyAssPreviewElement(element, style, animationState, metrics, alignment, margins, anchorTranslate = '') {
  if (!element) return;
  const scaleX = metrics.scaleX;
  const scaleY = metrics.scaleY;
  const fontSize = assPreviewFontSize(style, metrics);
  const opacity = Math.max(0, Math.min(1,
    Number(animationState.opacity) * (1 - Math.max(0, Math.min(255, Number(style.alpha) || 0)) / 255),
  ));
  const outline = Math.max(0, Number(style.outline) || 0) * scaleY;
  const shadow = Math.max(0, Number(style.shadow) || 0) * scaleY;
  const spacing = (Number(style.spacing) || 0) * scaleY;
  const borderBox = Number(style.borderStyle) === 3;
  const transform = [];
  // 锚定元素（叠加轨/副字幕）的居中平移作为前缀并入，替代 CSS 类里的
  // translateX(-50%)（此处写 transform 会整体覆盖类内变换）。
  if (anchorTranslate) transform.push(anchorTranslate);
  const move = style.__assMove;
  if (move) {
    element.style.position = 'absolute';
    element.style.left = `${move.x * metrics.scaleX}px`;
    element.style.top = `${move.y * metrics.scaleY}px`;
    transform.push(`translate(${-alignment.x * 100}%, ${-alignment.y * 100}%)`);
  } else {
    element.style.position = '';
    element.style.left = '';
    element.style.top = '';
  }
  transform.push(`scale(${Math.max(0, Number(style.scaleX) || 100) / 100}, ${Math.max(0, Number(style.scaleY) || 100) / 100})`);
  if (Number(style.rotationX) || Number(style.rotationY)) transform.push('perspective(600px)');
  if (Number(style.rotationX)) transform.push(`rotateX(${Number(style.rotationX)}deg)`);
  if (Number(style.rotationY)) transform.push(`rotateY(${Number(style.rotationY)}deg)`);
  if (Number(style.angle)) transform.push(`rotateZ(${Number(style.angle)}deg)`);
  element.style.fontFamily = MaweAppearance.subtitleFontFamilyCss(style.fontName);
  element.style.fontSize = `${fontSize}px`;
  element.style.fontWeight = style.bold ? '700' : '400';
  element.style.fontStyle = style.italic ? 'italic' : 'normal';
  element.style.textDecorationLine = [style.underline ? 'underline' : '', style.strikeOut ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
  element.style.textDecorationColor = style.primaryColor;
  element.style.textUnderlineOffset = style.underline ? '0.16em' : '';
  element.style.color = style.primaryColor;
  element.style.webkitTextStroke = outline > 0 ? `${outline}px ${style.outlineColor}` : '';
  element.style.paintOrder = outline > 0 ? 'stroke fill' : '';
  element.style.filter = !borderBox && shadow > 0
    ? `drop-shadow(${shadow}px ${shadow}px 0 ${style.backColor})` : '';
  element.style.letterSpacing = `${spacing}px`;
  element.style.lineHeight = 'normal';
  // ASS 预览采用 no-wrap 策略：只保留字幕文本中的显式换行，
  // 不因为播放器容器边界重新插入自动换行。
  element.style.whiteSpace = 'pre';
  element.style.wordBreak = 'normal';
  element.style.maxWidth = 'none';
  element.style.padding = borderBox
    ? `${Math.max(1, 4 * scaleY)}px ${Math.max(1, 8 * scaleX)}px`
    : `${Math.max(1, scaleY)}px ${Math.max(1, 2 * scaleX)}px`;
  element.style.backgroundColor = borderBox ? style.backColor : 'transparent';
  element.style.borderRadius = '0';
  element.style.opacity = String(opacity);
  element.style.transformOrigin = `${alignment.x * 100}% ${alignment.y * 100}%`;
  element.style.transform = transform.join(' ') || 'none';
}

function applyAssPreviewSpeakerLabel(element, style, metrics) {
  if (!element) return;
  const scaleY = metrics.scaleY;
  const fontSize = assPreviewFontSize(style, metrics);
  const outline = Math.max(0, Number(style.outline) || 0) * scaleY;
  const shadow = Math.max(0, Number(style.shadow) || 0) * scaleY;
  const spacing = (Number(style.spacing) || 0) * scaleY;
  element.style.fontFamily = MaweAppearance.subtitleFontFamilyCss(style.fontName);
  element.style.fontSize = `${fontSize}px`;
  element.style.fontWeight = style.bold ? '700' : '400';
  element.style.fontStyle = style.italic ? 'italic' : 'normal';
  element.style.textDecorationLine = [style.underline ? 'underline' : '', style.strikeOut ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
  element.style.textDecorationColor = style.primaryColor;
  element.style.textUnderlineOffset = style.underline ? '0.16em' : '';
  element.style.webkitTextStroke = outline > 0 ? `${outline}px ${style.outlineColor}` : '';
  element.style.paintOrder = outline > 0 ? 'stroke fill' : '';
  element.style.filter = shadow > 0
    ? `drop-shadow(${shadow}px ${shadow}px 0 ${style.backColor})` : '';
  element.style.letterSpacing = `${spacing}px`;
  element.style.lineHeight = 'normal';
}

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

function applyAssSubtitlePreview({ tMs, segment, extension, overlay, overlaySegments, mainColorName, speakerLabelVisible }) {
  const library = window.AsrEditorUtils.normalizeAssStyleLibrary(ASS_STYLE_LIBRARY);
  const profile = window.AsrEditorUtils.assProfileForId(
    library,
    library.assignments?.assExportProfileId || 'ass',
  );
  const baseStyle = window.AsrEditorUtils.assStyleForId(library, profile.styleId);
  const metrics = assPreviewMetrics();
  const alignment = assPreviewAlignment(baseStyle.alignment);
  const margins = {
    left: Math.max(0, Number(baseStyle.marginL) || 0) * metrics.scaleX,
    right: Math.max(0, Number(baseStyle.marginR) || 0) * metrics.scaleX,
    vertical: Math.max(0, Number(baseStyle.marginV) || 0) * metrics.scaleY,
  };
  const appearance = MaweAppearance.getSubtitleAppearance();
  const extensionSegments = activeExtensionSegments();
  const mainStyle = assPreviewStyleVariant(baseStyle, segment, MaweBoot.DATA.segments, appearance);
  // 副字幕使用样式库「副字幕样式」槽位的独立样式（副字幕不支持颜色分组，
  // 不做调色板变体），对齐与边距完全由该样式决定。
  const extensionStyleBase = window.AsrEditorUtils.assStyleForId(
    library, library.assignments?.assExtensionStyleId || 'ass-extension',
  );
  const extensionAlignment = assPreviewAlignment(extensionStyleBase.alignment);
  const extensionMargins = {
    left: Math.max(0, Number(extensionStyleBase.marginL) || 0) * metrics.scaleX,
    right: Math.max(0, Number(extensionStyleBase.marginR) || 0) * metrics.scaleX,
    vertical: Math.max(0, Number(extensionStyleBase.marginV) || 0) * metrics.scaleY,
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
    },
  );
  const animationGroup = profile.animations || {};
  const withMove = (style, state) => ({
    ...assPreviewAnimatedStyle(style, profile, state),
    __assMove: animationGroup.move?.enabled ? { x: state.moveX, y: state.moveY } : null,
  });
  const animatedMainStyle = withMove(mainStyle, mainAnimation);
  // 副字幕与叠加轨不跟随 \move（绝对 PlayRes 坐标只属于主字幕）；
  // fad/fade/t 与位置无关，预览与导出保持一致。
  const animatedExtensionStyle = assPreviewAnimatedStyle(extensionStyleBase, profile, extensionAnimation);
  const animatedOverlayTrackStyle = assPreviewAnimatedStyle(overlayTrackStyle, profile, overlayAnimation);
  // 叠加轨锚定 = 下方最近一层的边距 + 1.2 × 该层字号（与导出的固化
  // 公式一致）：有副字幕时叠在副字幕上方，否则叠在主字幕上方。偏移按
  // 动画前的基础字号计算——导出侧 MarginV 固化在样式里，\t(\fs) 只改
  // 变字形大小，不改变锚定边距。
  const extensionTrackActive = extensionSegments
    .some((cue) => cue && cue.disabled !== true);
  const mainPreviewFontSize = assPreviewFontSize(baseStyle, metrics);
  const extensionPreviewFontSize = assPreviewFontSize(extensionStyleBase, metrics);
  const overlayOffsetPx = extensionTrackActive
    ? extensionMargins.vertical + 1.2 * extensionPreviewFontSize
    : margins.vertical + 1.2 * mainPreviewFontSize;

  MaweDom.overlayEl.dataset.assMode = 'true';
  MaweDom.overlayEl.classList.add('ass-preview-active');
  // ASS 的坐标系覆盖整个 PlayRes 画布；旧版 CSS 预览保存的自定义字幕盒
  // 只在 CSS 模式下生效，否则会把 Alignment / Margin 的语义再次套一层。
  MaweDom.overlayEl.style.left = '0';
  MaweDom.overlayEl.style.top = '0';
  MaweDom.overlayEl.style.right = 'auto';
  MaweDom.overlayEl.style.bottom = 'auto';
  MaweDom.overlayEl.style.width = '100%';
  MaweDom.overlayEl.style.height = '100%';
  MaweDom.overlayEl.style.alignItems = alignment.alignItems;
  MaweDom.overlayEl.style.justifyContent = alignment.justifyContent;
  MaweDom.overlayEl.style.textAlign = alignment.textAlign;
  MaweDom.overlayEl.style.boxSizing = 'border-box';
  MaweDom.overlayEl.style.padding = `${margins.vertical}px ${margins.right}px ${margins.vertical}px ${margins.left}px`;
  applyAssPreviewElement(MaweDom.overlayTextEl, animatedMainStyle, mainAnimation, metrics, alignment, margins);
  applyAssAnchoredPreviewElement(
    MaweDom.overlayExtensionTextEl, animatedExtensionStyle, extensionAnimation, metrics,
    extensionAlignment, extensionMargins, extensionMargins.vertical,
  );

  if (speakerLabelVisible) {
    applyAssPreviewSpeakerLabel(MaweDom.overlayMainSpeakerLabelEl, animatedMainStyle, metrics);
    // 与导出 assEventText 一致：text / speaker 模式标签跟随调色板颜色，其余保持基础色。
    const paletteColor = MaweColors.COLOR_BY_NAME[mainColorName]?.value;
    const assColorStyle = appearance.ass_color_style || DEFAULT_ASS_COLOR_STYLE;
    const labelColor = assColorStyle === 'text' || assColorStyle === 'speaker'
      ? paletteColor || animatedMainStyle.primaryColor
      : animatedMainStyle.primaryColor;
    MaweDom.overlayMainSpeakerLabelEl.style.color = labelColor;
    MaweDom.overlayMainSpeakerLabelEl.style.webkitTextStroke = animatedMainStyle.outline > 0
      ? `${animatedMainStyle.outline * metrics.scaleY}px ${animatedMainStyle.outlineColor}` : '';
    MaweDom.overlayMainSpeakerLabelEl.style.paintOrder = animatedMainStyle.outline > 0 ? 'stroke fill' : '';
    MaweDom.overlayMainSpeakerLabelEl.style.textDecorationColor = labelColor;
  } else {
    clearAssPreviewSpeakerLabelStyle(MaweDom.overlayMainSpeakerLabelEl);
  }
  // 链在副字幕上方时，叠加元素沿用副字幕样式的对齐与边距（与导出侧
  // Overlay 样式继承锚定层坐标系保持一致）。
  applyAssAnchoredPreviewElement(
    overlayTrackTextEl, animatedOverlayTrackStyle, overlayAnimation, metrics,
    extensionTrackActive ? extensionAlignment : alignment,
    extensionTrackActive ? extensionMargins : margins,
    overlayOffsetPx,
  );
}

// 锚定渲染：副字幕/叠加轨不参与容器的 flex 布局（CSS 模式下叠加文字
// 悬浮在预览框上沿之外，而 ASS 模式 overlayEl 已铺满整个舞台，那套
// 定位会把文字推出画面），改为按各自样式的对齐与边距绝对定位。垂直
// 偏移由调用方给出，替代样式的 marginV：副字幕直接用自己的边距，叠加
// 轨用链式锚定结果。中列/中行以 50% + 锚定平移居中，锚定平移作为前缀
// 并入 applyAssPreviewElement 的 scale/rotate 变换。
function applyAssAnchoredPreviewElement(element, style, animationState, metrics, alignment, margins, verticalOffsetPx) {
  if (!element) return;
  const anchorTranslate = `translate(${alignment.x === 0.5 ? '-50%' : '0%'}, ${alignment.y === 0.5 ? '-50%' : '0%'})`;
  applyAssPreviewElement(element, style, animationState, metrics, alignment, margins, anchorTranslate);
  // 定位须在 applyAssPreviewElement 之后写入：其无 \move 分支会清空
  // position/left/top，先写会被抹掉。
  element.style.position = 'absolute';
  if (alignment.x === 0.5) {
    element.style.left = '50%';
    element.style.right = 'auto';
  } else if (alignment.x === 1) {
    element.style.left = 'auto';
    element.style.right = `${Math.max(0, Math.round(margins.right))}px`;
  } else {
    element.style.left = `${Math.max(0, Math.round(margins.left))}px`;
    element.style.right = 'auto';
  }
  if (alignment.y === 0.5) {
    element.style.top = '50%';
    element.style.bottom = 'auto';
  } else if (alignment.y === 0) {
    // ASS 7-9 顶行：锚定边距从画面顶部算起。
    element.style.top = `${Math.max(0, Math.ceil(verticalOffsetPx))}px`;
    element.style.bottom = 'auto';
  } else {
    // ASS 1-3 底行：锚定边距从画面底部算起。
    element.style.top = 'auto';
    element.style.bottom = `${Math.max(0, Math.ceil(verticalOffsetPx))}px`;
  }
  element.style.whiteSpace = 'pre';
  element.style.wordBreak = 'normal';
  element.style.textAlign = alignment.textAlign;
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





// 列表重绘或属性批量变更后的 update() 只刷新时间码与激活态，不触发播放跟随滚动。
// renderAll 刚重建列表时，content-visibility 让视口外的行仍处于估算占位
// 高度，updateActiveCue 量到的瞬态几何会把「活动行不在视口」误判成真，
// 再用被污染的 offsetTop 算出错误目标平滑滚走（页面放大倍率越高、真实
// 行高与估算差异越大越容易触发）。这些操作是否滚动、滚到哪里都应由
// 调用方显式决定（例如拆分按来源保持原位或居中新右半段）。
