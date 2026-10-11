// ass-export: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';
  const { ASS_COLOR_STYLE_NAMES, ASS_DEFAULT_ASS_STYLE, ASS_DEFAULT_COLOR, ASS_DEFAULT_EXTENSION_STYLE, ASS_EVENT_FORMAT, ASS_FALLBACK_COLOR_PALETTE, ASS_REFERENCE_PLAY_RES_Y, ASS_STYLE_FORMAT, DEFAULT_SPEAKER_LABEL_SEPARATOR, assAnimationOverrideTags, assColorFromHex, assInlineStyleRuns, assOverrideColorFromHex, assSentenceFadeTags, assStyleLine, effectiveColorName, escapeAssText, formatAssTime, formatSpeakerLabelledText, getSrtExportFirstIndex, normalizeAssColorStyle, normalizeAssFontFamily, normalizeAssFontSize, normalizeAssLibraryColor, normalizeAssPlayResolution, normalizeAssProfile, normalizeAssStyle, normalizeAssTimeMs, normalizeSpeakerLabelSeparator, normalizeSpeakerLabels, resolveAssFontSize, speakerLabelForSegment } = dependencies;


  function normalizeAssHeaderValue(value, fallback = 'MAW') {
    const normalized = String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized || fallback;
  }


  function normalizeAssEventField(value) {
    return String(value ?? '')
      .replace(/[\r\n,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }


  function normalizeAssColorStyles(value) {
    const injected = Array.isArray(window.ASR_EDITOR_PALETTE)
      ? window.ASR_EDITOR_PALETTE : ASS_FALLBACK_COLOR_PALETTE;
    const source = Array.isArray(value) ? value : injected;
    const byName = new Map(source
      .filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => [entry.name, entry.value]));
    return ASS_COLOR_STYLE_NAMES.map((name) => {
      const fallback = ASS_FALLBACK_COLOR_PALETTE.find((item) => item.name === name)?.value
        || ASS_DEFAULT_COLOR;
      const value = normalizeAssLibraryColor(byName.get(name), fallback);
      return { name, value, assValue: assColorFromHex(value) };
    });
  }


  function assStyleFromAppearance(appearance, resolution) {
    return {
      ...ASS_DEFAULT_ASS_STYLE,
      fontName: normalizeAssFontFamily(appearance?.font_family),
      fontSize: resolveAssFontSize(appearance?.font_size, resolution?.height),
      primaryColor: /^#[0-9a-f]{6}$/iu.test(String(appearance?.color || ''))
        ? String(appearance.color).toLowerCase() : ASS_DEFAULT_COLOR,
    };
  }


  function assStyleVariant(style, paletteValue, colorStyle) {
    const variant = { ...style };
    if (colorStyle === 'stroke') {
      variant.outlineColor = paletteValue;
    } else if (colorStyle === 'text') {
      variant.primaryColor = paletteValue;
      variant.secondaryColor = paletteValue;
    }
    return variant;
  }

  function assEmphasizedText(text, style, fontSize, emphasisSyntax, inlineOptions) {
    const runs = assInlineStyleRuns(text, emphasisSyntax, inlineOptions);
    return runs.map((run) => {
      const content = escapeAssText(run.text);
      let startTags = '';
      let endTags = '';
      if (run.emphasized) {
        const tag = style.emphasisStyle === 'stroke' ? '3c' : '1c';
        const baseColor = style.emphasisStyle === 'stroke' ? style.outlineColor : style.primaryColor;
        startTags += `\\${tag}${assOverrideColorFromHex(style.emphasisColor)}`;
        endTags += `\\${tag}${assOverrideColorFromHex(baseColor)}`;
      }
      // 注释 run 的颜色/比例覆盖在强调之后写入：同一 run 同时命中时注释优先。
      if (run.comment) {
        const tag = style.commentStyle === 'stroke' ? '3c' : '1c';
        const baseColor = style.commentStyle === 'stroke' ? style.outlineColor : style.primaryColor;
        startTags += `\\${tag}${assOverrideColorFromHex(style.commentColor)}`;
        endTags += `\\${tag}${assOverrideColorFromHex(baseColor)}`;
      }
      const sizeScale = run.size === 'small' ? style.smallTextScale : run.size === 'large' ? style.largeTextScale : 1;
      const emphasisScale = run.emphasized ? style.emphasisScale : 1;
      const commentScale = run.comment ? (style.commentScale || 1) : 1;
      const scaledFontSize = Math.max(1, Math.round(fontSize * sizeScale * emphasisScale * commentScale));
      if (scaledFontSize !== fontSize) {
        startTags += `\\fs${scaledFontSize}`;
        endTags += `\\fs${fontSize}`;
      }
      if (run.struck && !style.strikeOut) {
        startTags += '\\s1';
        endTags += '\\s0';
      }
      if (run.underlined && !style.underline) {
        startTags += '\\u1';
        endTags += '\\u0';
      }
      return startTags ? `{${startTags}}${content}{${endTags}}` : content;
    }).join('');
  }


  function assEventText({ segment, text, speakerName, speakerLabelSeparator, colorName,
    colorStyles, style, fontSize, colorStyle, speakerLabels, assMode, emphasisSyntax, inlineOptions }) {
    const content = String(text ?? '');
    if (!speakerLabels || !speakerName) return assMode
      ? assEmphasizedText(content, style, fontSize, emphasisSyntax, inlineOptions) : escapeAssText(content);
    const paletteSpeakerColor = colorStyles.find((item) => item.name === colorName)?.value
      || style.primaryColor;
    // ASS can reproduce the existing text-colour mapping and stroke-colour
    // mapping, but a coloured underline is not representable without also
    // changing the glyph colour.  In stroke mode keep the speaker label in
    // the effective base colour so only the outline follows the palette.
    const speakerColor = colorStyle === 'text' || colorStyle === 'speaker'
      ? paletteSpeakerColor : style.primaryColor;
    // The event style already carries the effective ASS text colour.  Reusing
    // the speaker palette here would also colour the whole cue when the old
    // CSS colour preview is disabled, instead of limiting the override to the
    // speaker label.
    const eventTextColor = style.primaryColor;
    const label = `${speakerName}${speakerLabelSeparator}`;
    if (!assMode) return escapeAssText(`${label}${content}`);
    return `{\\c${assOverrideColorFromHex(speakerColor)}}${escapeAssText(label)}{\\c${assOverrideColorFromHex(eventTextColor)}}${assEmphasizedText(content, style, fontSize, emphasisSyntax, inlineOptions)}`;
  }


  function buildAssPayload(segments, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const appearance = options.appearance && typeof options.appearance === 'object'
      ? options.appearance : {};
    const fontFamily = normalizeAssFontFamily(
      appearance.font_family ?? options.fontFamily,
    );
    const mediaMetadata = options.mediaMetadata && typeof options.mediaMetadata === 'object'
      ? options.mediaMetadata : {};
    const resolution = normalizeAssPlayResolution(
      options.playResX ?? options.videoWidth ?? mediaMetadata.video_width,
      options.playResY ?? options.videoHeight ?? mediaMetadata.video_height,
    );
    const profile = options.assProfile && typeof options.assProfile === 'object'
      ? normalizeAssProfile(options.assProfile) : null;
    const baseStyle = profile
      ? normalizeAssStyle(options.assStyle, ASS_DEFAULT_ASS_STYLE, options.assStyle?.id || 'ass')
      : assStyleFromAppearance({
        ...appearance,
        font_family: appearance.font_family ?? options.fontFamily,
        font_size: appearance.font_size ?? options.fontSize,
        color: appearance.color ?? options.color,
      }, resolution);
    // A library style stores its font size against the shared 1080p reference
    // (the ASS preview scales by the same reference).  Export must rescale it
    // to the target PlayResY, or a 4K project renders subtitles half size.
    // The legacy appearance-based style below is already calibrated by
    // resolveAssFontSize and must not be scaled again.
    const fontSize = profile
      ? normalizeAssFontSize(baseStyle.fontSize * resolution.height / ASS_REFERENCE_PLAY_RES_Y)
      : normalizeAssFontSize(baseStyle.fontSize);
    const title = normalizeAssHeaderValue(options.title ?? options.projectName);
    const colorStyles = normalizeAssColorStyles(options.colorStyles);
    // ASS 的颜色映射只由 ass_color_style 驱动（text / speaker / stroke / none），与 CSS
    // 预览的 color_style（underline / text / stroke）和 color_underline 开关
    // 是两套语义；color_underline 只控制 CSS 预览，不参与 ASS 导出。
    const colorStyle = normalizeAssColorStyle(appearance.ass_color_style) || 'text';
    const assMode = Boolean(profile);
    const emphasisSyntax = options.assEmphasisSyntax === 'none' ? 'none' : 'both';
    const inlineOptions = options;
    const numericTimeOffset = Number(options.timeOffset);
    const timeOffset = Number.isFinite(numericTimeOffset)
      ? Math.max(0, Math.round(numericTimeOffset)) : 0;
    const mapTime = typeof options.mapTime === 'function'
      ? options.mapTime
      : (timeMs) => Math.max(0, Math.round(Number(timeMs) || 0) - timeOffset);
    const alignFirstStart = options.alignFirstStart === true;
    const firstEnabledIndex = Number.isInteger(options.firstEnabledIndex)
      ? options.firstEnabledIndex
      : getSrtExportFirstIndex(source, alignFirstStart);
    const speakerLabels = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabels(options.speakerLabels)
      : null;
    const speakerLabelSeparator = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabelSeparator(options.speakerLabelSeparator)
      : DEFAULT_SPEAKER_LABEL_SEPARATOR;
    const events = [];
    // 颜色样式只有在 ASS 能表达为整句样式（text / stroke）时才生成
    // 调色板样式；speaker 只给说话人前缀加局部颜色，none 回落 Default。
    const assColorGroupsSupported = colorStyle === 'text' || colorStyle === 'stroke';

    // 主轨事件：Layer 0，底部居中（Default 样式自带对齐）。
    source.forEach((segment, sourceIndex) => {
      if (!segment || segment.disabled === true) return;
      const rawStart = normalizeAssTimeMs(mapTime(segment.start));
      const rawEnd = normalizeAssTimeMs(mapTime(segment.end));
      const start = alignFirstStart && sourceIndex === firstEnabledIndex ? 0 : rawStart;
      // ASS only keeps centiseconds. Ensure a one-centisecond event even when
      // an imported/edited cue is shorter than that precision.
      const startCentiseconds = Math.max(0, Math.round(start / 10));
      const endCentiseconds = Math.max(startCentiseconds + 1, Math.round(rawEnd / 10));
      const speakerName = speakerLabels
        ? speakerLabelForSegment(segment, source, speakerLabels) : '';
      // 单句 `>>`/`<<` 渐入渐出标记只在 ASS 模式解析：先剥离行首行尾标记，
      // 再用剩余文本走强调/颜色管线，并用该句自身的 fad 覆盖全局动画。
      const sentenceFade = assMode
        ? assSentenceFadeTags(segment.text, profile, inlineOptions.assSpecialSymbolRule)
        : null;
      const segmentText = sentenceFade ? sentenceFade.text : String(segment.text ?? '');
      const text = speakerLabels
        ? formatSpeakerLabelledText(
          segmentText, segment, source, speakerLabels, speakerLabelSeparator,
        )
        : segmentText;
      const colorName = effectiveColorName(segment, source);
      const styleName = assColorGroupsSupported && ASS_COLOR_STYLE_NAMES.includes(colorName)
        ? colorName.toUpperCase() : 'Default';
      const styleForEvent = assMode && styleName !== 'Default'
        ? assStyleVariant(baseStyle, colorStyles.find((item) => item.name === colorName)?.value || '#ffffff', colorStyle)
        : baseStyle;
      const eventText = assEventText({
        segment,
        text: speakerLabels ? segmentText : text,
        speakerName,
        speakerLabelSeparator,
        colorName,
        colorStyles,
        style: styleForEvent,
        fontSize,
        colorStyle,
        speakerLabels,
        assMode,
        emphasisSyntax,
        inlineOptions,
      });
      const animationTags = assMode
        ? assAnimationOverrideTags(profile, { fad: sentenceFade?.fad || null }) : '';
      const decoratedText = animationTags ? `{${animationTags}}${eventText}` : eventText;
      events.push(
        `Dialogue: 0,${formatAssTime(startCentiseconds * 10)},${formatAssTime(endCentiseconds * 10)},${styleName},${normalizeAssEventField(speakerName)},0,0,0,,${decoratedText}`,
      );
    });

    // 副字幕轨（多重字幕）：所有副字幕共用一个样式（不支持颜色分组），
    // 事件引用独立 Extension 样式，边距/对齐完全由该样式决定。
    // \fad/\fade/\t 逐句应用；\move 的绝对坐标只属于主字幕。
    const extensionSource = Array.isArray(options.extensionSegments)
      ? options.extensionSegments : [];
    const hasExtensionCues = extensionSource.some((segment) => segment && segment.disabled !== true);
    const extensionStyle = assMode && options.assExtensionStyle && typeof options.assExtensionStyle === 'object'
      ? normalizeAssStyle(options.assExtensionStyle, ASS_DEFAULT_EXTENSION_STYLE, options.assExtensionStyle.id || 'ass-extension')
      : null;
    const extensionScaledFontSize = extensionStyle
      ? normalizeAssFontSize(extensionStyle.fontSize * resolution.height / ASS_REFERENCE_PLAY_RES_Y)
      : 0;
    // 副字幕锚定在主字幕上方：垂直边距固化为「主字幕 marginV + 1.2 × 主字号」，
    // 与预览的链式锚定一致；副字幕样式自身的 marginV 不再决定位置。
    // 事件行的第三个边距位覆盖 MarginV，其余仍取 Extension 样式值。
    const extensionAnchorMarginV = assMode && extensionStyle
      ? Math.max(0, Number(baseStyle.marginV) || 0) + Math.round(1.2 * fontSize)
      : Math.max(0, Number(extensionStyle?.marginV) || 0);
    if (assMode && extensionStyle) {
      extensionSource.forEach((segment) => {
        if (!segment || segment.disabled === true) return;
        const rawStart = normalizeAssTimeMs(mapTime(segment.start));
        const rawEnd = normalizeAssTimeMs(mapTime(segment.end));
        if (rawEnd <= rawStart) return;
        const startCentiseconds = Math.max(0, Math.round(rawStart / 10));
        const endCentiseconds = Math.max(startCentiseconds + 1, Math.round(rawEnd / 10));
        const extensionFade = assSentenceFadeTags(segment.text, profile, inlineOptions.assSpecialSymbolRule);
        const extensionAnimationTags = assAnimationOverrideTags(profile, { includeMove: false, fad: extensionFade.fad });
        // 说话人前缀与主字幕同规则：开启「字幕显示说话人前缀」时副字幕
        // 也按自身轨的颜色映射追加前缀（上下文用副字幕轨自身数组）。
        const extensionSpeakerName = speakerLabels
          ? speakerLabelForSegment(segment, extensionSource, speakerLabels) : '';
        const extensionContent = assEventText({
          segment,
          text: extensionFade.text,
          speakerName: extensionSpeakerName,
          speakerLabelSeparator,
          colorName: null,
          colorStyles,
          style: extensionStyle,
          fontSize: extensionScaledFontSize,
          colorStyle,
          speakerLabels,
          assMode,
          emphasisSyntax,
          inlineOptions,
        });
        const extensionText = extensionAnimationTags
          ? `{${extensionAnimationTags}}${extensionContent}` : extensionContent;
        events.push(
          `Dialogue: 1,${formatAssTime(startCentiseconds * 10)},${formatAssTime(endCentiseconds * 10)},Extension,,0,0,${extensionAnchorMarginV},,${extensionText}`,
        );
      });
    }

    // 叠加轨事件：引用独立的 Overlay 样式（字段与主字幕样式完全一致，
    // 仅把 MarginV 固化为算好的锚定结果），事件行不再携带边距覆盖。颜色
    // 映射与主字幕一致（none 模式一起回落）；\fad/\fade/\t 逐句应用，
    // \move 的绝对坐标只属于主字幕。锚定公式固定为「下方最近一层字幕的
    // 垂直边距 + 1.2 × 该层字号」：有副字幕时叠在副字幕上方，否则叠在主
    // 字幕上方（1.2 倍在两层文字之间留出空档）。ASS 模式下各层边距来自
    // 样式库（用户可改），legacy 模式主字幕固定 80。
    const overlaySource = Array.isArray(options.overlaySegments) ? options.overlaySegments : [];
    const hasOverlayCues = overlaySource.some((segment) => segment && segment.disabled !== true);
    const overlayMarginV = assMode
      ? (extensionStyle && hasExtensionCues
        ? extensionAnchorMarginV + Math.round(1.2 * extensionScaledFontSize)
        : Math.max(0, Number(baseStyle.marginV) || 0) + Math.round(1.2 * fontSize))
      : 80 + Math.round(1.2 * fontSize);
    // 链式锚定发生在哪一层的坐标系里，叠加样式就继承哪一层的对齐与水平
    // 边距：否则副字幕样式改成顶部/侧边对齐时，固化边距会按主样式的基准
    // 边解释，叠加轨落到画面另一侧。字体与颜色仍跟随主字幕样式。
    const overlayBaseStyle = assMode
      ? (extensionStyle && hasExtensionCues
        ? {
          ...baseStyle,
          alignment: extensionStyle.alignment,
          marginL: extensionStyle.marginL,
          marginR: extensionStyle.marginR,
        }
        : baseStyle)
      : {
        ...ASS_DEFAULT_ASS_STYLE,
        fontName: fontFamily,
        fontSize,
        primaryColor: appearance.color ?? options.color,
        outlineColor: '#000000',
        outline: 2,
        shadow: 0,
        alignment: 2,
        marginL: 10,
        marginR: 10,
      };
    const overlayStyleFor = (colorName) => {
      const variant = assColorGroupsSupported && ASS_COLOR_STYLE_NAMES.includes(colorName)
        ? assStyleVariant(overlayBaseStyle,
          colorStyles.find((item) => item.name === colorName)?.value || '#ffffff', colorStyle)
        : overlayBaseStyle;
      return { ...variant, marginV: overlayMarginV };
    };
    const overlayStyleNameFor = (colorName) => (
      assColorGroupsSupported && ASS_COLOR_STYLE_NAMES.includes(colorName)
        ? `Overlay ${colorName.toUpperCase()}` : 'Overlay'
    );
    overlaySource.forEach((segment) => {
      if (!segment || segment.disabled === true) return;
      const rawStart = normalizeAssTimeMs(mapTime(segment.start));
      const rawEnd = normalizeAssTimeMs(mapTime(segment.end));
      if (rawEnd <= rawStart) return;
      const startCentiseconds = Math.max(0, Math.round(rawStart / 10));
      const endCentiseconds = Math.max(startCentiseconds + 1, Math.round(rawEnd / 10));
      const overlayColorName = effectiveColorName(segment, overlaySource);
      const overlayFade = assMode
        ? assSentenceFadeTags(segment.text, profile, inlineOptions.assSpecialSymbolRule) : null;
      const overlayAnimationTags = assMode
        ? assAnimationOverrideTags(profile, { includeMove: false, fad: overlayFade.fad }) : '';
      // 叠加字幕同样跟随「字幕显示说话人前缀」：映射按叠加轨自身数组解析。
      const overlaySpeakerName = speakerLabels
        ? speakerLabelForSegment(segment, overlaySource, speakerLabels) : '';
      const overlayContent = assMode
        ? assEventText({
          segment,
          text: overlayFade.text,
          speakerName: overlaySpeakerName,
          speakerLabelSeparator,
          colorName: overlayColorName,
          colorStyles,
          style: overlayStyleFor(overlayColorName),
          fontSize,
          colorStyle,
          speakerLabels,
          assMode,
          emphasisSyntax,
          inlineOptions,
        })
        : escapeAssText(segment.text);
      const overlayText = overlayAnimationTags
        ? `{${overlayAnimationTags}}${overlayContent}` : overlayContent;
      events.push(
        `Dialogue: 2,${formatAssTime(startCentiseconds * 10)},${formatAssTime(endCentiseconds * 10)},${overlayStyleNameFor(overlayColorName)},,0,0,0,,${overlayText}`,
      );
    });

    return [
      '[Script Info]',
      '; Script generated by MAW',
      `Title: ${title}`,
      'ScriptType: v4.00+',
      `PlayResX: ${resolution.width}`,
      `PlayResY: ${resolution.height}`,
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      'YCbCr Matrix: None',
      '',
      '[V4+ Styles]',
      `Format: ${ASS_STYLE_FORMAT}`,
      ...(assMode
        ? [
          assStyleLine(baseStyle, 'Default', fontSize),
          ...(colorStyle === 'text' || colorStyle === 'stroke'
            ? colorStyles.map((color) => assStyleLine(
              assStyleVariant(baseStyle, color.value, colorStyle),
              color.name.toUpperCase(),
              fontSize,
            ))
            : []),
          // 副字幕：独立样式，边距/对齐/字号完全由该样式决定。
          ...(extensionStyle && hasExtensionCues
            ? [assStyleLine(extensionStyle, 'Extension', extensionScaledFontSize)]
            : []),
          // 叠加字幕：字段复用主字幕样式，MarginV 固化为链式锚定结果。
          ...(hasOverlayCues
            ? [
              assStyleLine(overlayStyleFor(null), 'Overlay', fontSize),
              ...(colorStyle === 'text' || colorStyle === 'stroke'
                ? colorStyles.map((color) => assStyleLine(
                  overlayStyleFor(color.name),
                  `Overlay ${color.name.toUpperCase()}`,
                  fontSize,
                ))
                : []),
            ]
            : []),
        ]
        : [
          `Style: Default,${fontFamily},${fontSize},${assColorFromHex(appearance.color ?? options.color)},${assColorFromHex(appearance.color ?? options.color)},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,80,1`,
          ...(colorStyle === 'text'
            ? colorStyles.map((style) => (
              `Style: ${style.name.toUpperCase()},${fontFamily},${fontSize},${style.assValue},${style.assValue},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,80,1`
            ))
            : colorStyle === 'stroke'
              ? colorStyles.map((style) => assStyleLine(
                assStyleVariant({
                  ...ASS_DEFAULT_ASS_STYLE,
                  fontName: fontFamily,
                  fontSize,
                  primaryColor: appearance.color ?? options.color,
                  outlineColor: '#000000',
                  outline: 2,
                  shadow: 0,
                  alignment: 2,
                  marginL: 10,
                  marginR: 10,
                  marginV: 80,
                }, style.value, colorStyle),
                style.name.toUpperCase(),
                fontSize,
              ))
              : []),
          // legacy 叠加样式：同样固化为算好的锚定边距（80 + 1.2 × 字号）。
          ...(hasOverlayCues
            ? [
              assStyleLine(overlayStyleFor(null), 'Overlay', fontSize),
              ...(colorStyle === 'text' || colorStyle === 'stroke'
                ? colorStyles.map((color) => assStyleLine(
                  overlayStyleFor(color.name),
                  `Overlay ${color.name.toUpperCase()}`,
                  fontSize,
                ))
                : []),
            ]
            : []),
        ]),
      '',
      '[Events]',
      `Format: ${ASS_EVENT_FORMAT}`,
      ...events,
      '',
    ].join('\n');
  }

  return Object.freeze({ assStyleVariant, buildAssPayload, normalizeAssHeaderValue });
}
