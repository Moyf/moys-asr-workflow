// ass-export: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';
  const { ASS_COLOR_STYLE_NAMES, ASS_DEFAULT_ASS_STYLE, ASS_DEFAULT_COLOR, ASS_DEFAULT_EXTENSION_STYLE, ASS_EVENT_FORMAT, ASS_FALLBACK_COLOR_PALETTE, ASS_REFERENCE_PLAY_RES_Y, ASS_STYLE_FORMAT, DEFAULT_SPEAKER_LABEL_SEPARATOR, assAnimationOverrideTags, assColorFromHex, assInlineStyleRuns, assOverrideColorFromHex, assSentenceAnimationTags, parseSentenceShakeMarkers, assStyleLine, effectiveColorName, escapeAssText, formatAssTime, formatSpeakerLabelledText, getSrtExportFirstIndex, getWordTimingEntries, normalizeAssColorStyle, normalizeAssFontFamily, normalizeAssFontSize, normalizeAssLibraryColor, normalizeAssPlayResolution, normalizeAssProfile, normalizeAssStyle, normalizeAssTimeMs, normalizeSpeakerLabelSeparator, normalizeSpeakerLabels, resolveAssFontSize, speakerLabelForSegment } = dependencies;


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


  // ASS 样式里的 Fontname 写出前经服务端字体别名表归一化：libass（Windows
  // directwrite/GDI）只按 nameID1 匹配，排版名（如 "Smiley Sans"）会被静默
  // 回退。表未加载（便携模式/旧服务器）时原样返回；替换记录由别名模块在
  // 导出入口的捕获窗口内收集。与 window.ASR_EDITOR_PALETTE 同一注入约定。
  function canonicalizeAssFontName(name) {
    const aliases = window.MaweAssFontAliases;
    if (!aliases || typeof aliases.canonicalFor !== 'function') return name;
    return aliases.canonicalFor(name) || name;
  }


  function assStyleVariant(style, paletteValue, colorStyle, keepSecondary = false) {
    const variant = { ...style };
    if (colorStyle === 'stroke') {
      variant.outlineColor = paletteValue;
    } else if (colorStyle === 'text') {
      variant.primaryColor = paletteValue;
      // 卡拉 OK 开启时次色是「未唱」颜色，不再跟随调色板同步（否则未唱色
      // 被主色覆盖，\k 完全不可见）。
      if (!keepSecondary) variant.secondaryColor = paletteValue;
    }
    return variant;
  }

  // One font-run plan feeds Canvas, downloaded ASS, frame preview and burn-in.
  // Portable/old servers retain the legacy path when coverage is unavailable.
  function resolveFontRuns(runs, style) {
    return globalThis.window?.MaweAssFontAliases?.resolveRuns?.(runs, style) || runs;
  }

  // KTV（\k 整词跳变）：把字词时间码映射为「已唱/未唱」翻转计划。libass
  // 语义已用像素 oracle 实证（见 docs/plans/ASS_KTV_KARAOKE.md）：翻转发生在
  // 音节窗口起点，词 i 的 \k 时长承载「本词翻转到下一词翻转」的间隔；首词
  // 前的空引导 {\kNN} 表达句首静默；首个 \k 之前的文本恒为主色。text 必须是
  // inline runs 看到的文本（MASS 标记已剥除）；任何失配都返回 null，该句
  // 静默回落普通输出。
  function assKaraokePlan(text, segment, options) {
    const source = String(text ?? '');
    if (!source || typeof getWordTimingEntries !== 'function') return null;
    let entries;
    try {
      // 在 runs 文本上重新分配字词归属：可听序列校验、标点/空白挂靠、
      // 部分覆盖保守投影都复用 word-timing 模块的既有规则。
      entries = getWordTimingEntries({ ...segment, text: source }, null);
    } catch (_) {
      return null;
    }
    if (!Array.isArray(entries) || !entries.length) return null;
    const eventStartMs = Number(options.eventStartMs) || 0;
    const eventEndMs = Math.max(eventStartMs + 1, Number(options.eventEndMs) || eventStartMs + 1);
    const mapTime = typeof options.mapTime === 'function' ? options.mapTime : value => value;
    const cueCs = Math.max(1, Math.round((eventEndMs - eventStartMs) / 10));
    // 逐码点归属：按顺序消费 entry.text；未被认领的字符是背景（部分匹配
    // 残留或前缀文本），渲染恒为主色；与已认领字符冲突视为失配。
    const chars = Array.from(source);
    const owners = new Array(chars.length).fill(-1);
    let cursor = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entryChars = Array.from(String(entries[index]?.text ?? ''));
      let matched = 0;
      while (cursor < chars.length && matched < entryChars.length) {
        if (chars[cursor] === entryChars[matched]) {
          owners[cursor] = index;
          cursor += 1;
          matched += 1;
        } else if (owners[cursor] === -1) {
          cursor += 1;
        } else {
          return null;
        }
      }
      if (matched < entryChars.length) return null;
    }
    // 翻转时刻（厘秒，相对事件起点）：绝对时间过同一 mapTime（去空隙导出
    // 同步压缩），先取整再作差，钳入事件范围并保持单调不减。
    const startCs = Math.round(eventStartMs / 10);
    const flips = entries.map((entry) => {
      const mapped = Number(mapTime(Number(entry?.start)));
      const value = (Number.isFinite(mapped) ? Math.round(mapped / 10) : startCs) - startCs;
      return Math.min(cueCs, Math.max(0, value));
    });
    for (let index = 1; index < flips.length; index += 1) {
      flips[index] = Math.max(flips[index], flips[index - 1]);
    }
    return { owners, flips, cueCs };
  }


  // 把 inline runs 按字词边界切开并挂翻转元数据。所有碎片携带词 id（word）
  // 与窗口；\k 的发射在 assEmphasizedText 里按「该词首个出现的碎片」去重——
  // 后续字体解析（resolveRuns）可能把碎片再按字素切分，任何碎片都可能成为
  // 顺序上的第一个，因此不能在切分时固化 head 标记。背景碎片（无词）跟随
  // 前一词的翻转时刻（首个词之前恒已唱），与导出语义一致。
  function assKaraokeSplitRuns(runs, plan) {
    const { owners, flips, cueCs } = plan;
    const entryMeta = flips.map((startCs, index) => ({
      word: index,
      startCs,
      nextCs: index + 1 < flips.length ? flips[index + 1] : Math.max(startCs + 1, cueCs),
      flipMs: startCs * 10,
      // 首词的句首静默：空引导时长挂在首词元数据上。
      ...(index === 0 ? { leadCs: flips[0] } : {}),
    }));
    const result = [];
    let previousFlipMs = -1;
    let consumed = 0;
    for (const run of Array.isArray(runs) ? runs : []) {
      const chars = Array.from(String(run?.text ?? ''));
      if (!chars.length) {
        result.push(run);
        continue;
      }
      let piece = '';
      let pieceOwner = null;
      const flush = () => {
        if (piece === '') return;
        if (pieceOwner === null || pieceOwner === -1) {
          result.push({ ...run, text: piece, karaoke: { flipMs: previousFlipMs } });
        } else {
          const meta = entryMeta[pieceOwner];
          previousFlipMs = meta.flipMs;
          result.push({ ...run, text: piece, karaoke: { ...meta } });
        }
        piece = '';
      };
      for (const ch of chars) {
        const owner = owners[consumed] ?? -1;
        consumed += 1;
        if (pieceOwner === null) pieceOwner = owner;
        if (owner !== pieceOwner) {
          flush();
          pieceOwner = owner;
        }
        piece += ch;
      }
      flush();
    }
    return result;
  }


  function assEmphasizedText(text, style, fontSize, emphasisSyntax, inlineOptions) {
    const sourceRuns = inlineOptions?.preparedRuns || assInlineStyleRuns(text, emphasisSyntax, inlineOptions);
    // libass applies an enabled t:\i target immediately. Use that baseline
    // when creating legacy originalText too, without rewriting its clocks.
    const italic = inlineOptions?.italicTransformTarget === undefined
      ? style.italic : Boolean(inlineOptions.italicTransformTarget);
    const runs = resolveFontRuns(sourceRuns, { ...style, italic });
    // KTV：每个词只在其顺序上首个碎片发射一次 \k（字体解析可能把同一词
    // 切成多个碎片，按 word id 去重）。时长按片偏移重定基：已唱为 0，未唱
    // 按差值，首词句首静默用空引导 \k 先行。\k 作为独立引导块放在 run 覆盖
    // 标签之前（分离块与同块混排均经像素 oracle 验证，见方案文档）。
    const karaokeWords = new Set();
    return runs.map((run) => {
      const content = escapeAssText(run.text);
      let startTags = '';
      let endTags = '';
      let karaokePrefix = '';
      const karaoke = run.karaoke;
      if (karaoke && karaoke.startCs !== undefined && !karaokeWords.has(karaoke.word)) {
        karaokeWords.add(karaoke.word);
        const offset = Math.max(0, Math.round(Number(inlineOptions?.karaokeOffsetCs) || 0));
        const start = Math.max(0, (Number(karaoke.startCs) || 0) - offset);
        const next = Math.max(0, (Number(karaoke.nextCs) || 0) - offset);
        const lead = Math.max(0, (Number(karaoke.leadCs) || 0) - offset);
        if (lead > 0) karaokePrefix += `{\\k${lead}}`;
        karaokePrefix += `{\\k${Math.max(0, next - start)}}`;
      }
      // Never use \r to restore a font: it would reset colour, size and animation.
      // Unsafe names cannot enter ASS override syntax (there is no fn escaping).
      const safeName = name => typeof name === 'string' && name && !/[{}\\\r\n]/u.test(name);
      if (run.fontName && run.fontName !== style.fontName
          && safeName(run.fontName) && safeName(style.fontName)) {
        startTags += `\\fn${run.fontName}`;
        endTags += `\\fn${style.fontName}`;
      }
      if (run.speakerColor) {
        startTags += `\\1c${assOverrideColorFromHex(run.speakerColor)}`;
        endTags += `\\1c${assOverrideColorFromHex(style.primaryColor)}`;
      }
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
      const runScale = sizeScale * emphasisScale * commentScale;
      const scaledFontSize = Math.max(1, Math.round(fontSize * runScale));
      if (runScale !== 1) {
        startTags += `\\fs${scaledFontSize}`;
        endTags += `\\fs${fontSize}`;
        const transform = inlineOptions?.fontTransform;
        if (transform) {
          const timing = `${transform.startMs},${transform.endMs},${transform.accel}`;
          startTags += `\\t(${timing},\\fs${Math.max(1, Number((transform.target * runScale).toFixed(4)))})`;
          endTags += `\\t(${timing},\\fs${transform.target})`;
        }
      }
      if (run.struck && !style.strikeOut) {
        startTags += '\\s1';
        endTags += '\\s0';
      }
      if (run.underlined && !style.underline) {
        startTags += '\\u1';
        endTags += '\\u0';
      }
      if (run.italic && !italic) {
        startTags += '\\i1';
        endTags += '\\i0';
      }
      return karaokePrefix + (startTags ? `{${startTags}}${content}{${endTags}}` : content);
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
    return `{\\c${assOverrideColorFromHex(speakerColor)}}${assEmphasizedText('', style, fontSize, emphasisSyntax, { ...inlineOptions, preparedRuns: [{ text: label }] })}{\\c${assOverrideColorFromHex(eventTextColor)}}${assEmphasizedText(content, style, fontSize, emphasisSyntax, inlineOptions)}`;
  }


  function buildAssPayload(segments, options = {}) {
    void globalThis.window?.MaweAssFontAliases?.ensureCoverage?.();
    // A Canvas-only diagnostic plan may render provisionally; never send an
    // ASS snapshot to libass/export while the font inventory is changing.
    if (!options.allowAssPlanDiagnostics && globalThis.window?.MaweAssFontAliases?.pending?.()) {
      throw new Error('本机字体信息仍在加载，请稍后重试 ASS 预览或导出。');
    }
    const source = Array.isArray(segments) ? segments : [];
    const appearance = options.appearance && typeof options.appearance === 'object'
      ? options.appearance : {};
    const fontFamily = canonicalizeAssFontName(normalizeAssFontFamily(
      appearance.font_family ?? options.fontFamily,
    ));
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
    baseStyle.fontName = canonicalizeAssFontName(baseStyle.fontName);
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
    // KTV 只在 ASS 模式 + 方案开关开启时参与；颜色变体不再同步次色（见
    // assStyleVariant），主轨字幕按句尝试注入 \k。
    const karaokeEnabled = assMode && profile.animations.karaoke.enabled === true;
    const keepSecondary = karaokeEnabled;
    const emphasisSyntax = options.assEmphasisSyntax === 'none' ? 'none' : 'both';
    /** @type {Record<string, any>} */
    const inlineOptions = { ...options, italicTransformTarget: profile?.animations.t.enabled
      ? dependencies.assTransformStyleTargets(profile.animations.t.tags).italic : undefined };
    const numericTimeOffset = Number(options.timeOffset);
    const timeOffset = Number.isFinite(numericTimeOffset)
      ? Math.max(0, Math.round(numericTimeOffset)) : 0;
    const mapTime = typeof options.mapTime === 'function'
      ? options.mapTime
      : (timeMs) => Math.max(0, Math.round(Number(timeMs) || 0) - timeOffset);
    const alignFirstStart = options.alignFirstStart === true;
    const requestedFirstIndex = Number.isInteger(options.firstEnabledIndex)
      ? options.firstEnabledIndex : getSrtExportFirstIndex(source, alignFirstStart);
    const firstEnabledIndex = alignFirstStart && (!source[requestedFirstIndex]
        || source[requestedFirstIndex].disabled === true || !String(source[requestedFirstIndex].text ?? '').trim())
      ? source.findIndex((segment) => segment && segment.disabled !== true && String(segment.text ?? '').trim())
      : requestedFirstIndex;
    const speakerLabels = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabels(options.speakerLabels)
      : null;
    const speakerLabelSeparator = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabelSeparator(options.speakerLabelSeparator)
      : DEFAULT_SPEAKER_LABEL_SEPARATOR;
    const events = [];
    const cueStyleLines = [];
    const cueStyleNames = new Map();
    const stackItems = [];
    const addStackItem = (role, segment, index, context, start, end, style, size, styleName, speakerName, fade, originalText, shake = false, karaoke = null) => {
      const colorName = effectiveColorName(segment, context);
      if (segment.assStyle && typeof segment.assStyle === 'object' && !Array.isArray(segment.assStyle)) {
        style = normalizeAssStyle(segment.assStyle, ASS_DEFAULT_ASS_STYLE, 'cue');
        style.fontName = canonicalizeAssFontName(style.fontName);
        if (assColorGroupsSupported && ASS_COLOR_STYLE_NAMES.includes(colorName)) {
          style = assStyleVariant(style, colorStyles.find(entry => entry.name === colorName)?.value || '#ffffff', colorStyle, keepSecondary);
        }
        size = normalizeAssFontSize(style.fontSize * resolution.height / ASS_REFERENCE_PLAY_RES_Y);
        const key = JSON.stringify([style, size]);
        styleName = cueStyleNames.get(key);
        if (!styleName) {
          styleName = `Cue_${cueStyleNames.size}`;
          cueStyleNames.set(key, styleName);
          cueStyleLines.push(assStyleLine(style, styleName, size));
        }
        originalText = assEventText({ segment, text: fade.text, speakerName, speakerLabelSeparator,
          colorName, colorStyles, style, fontSize: size, colorStyle, speakerLabels,
          assMode, emphasisSyntax, inlineOptions });
      }
      const speakerColor = colorStyle === 'text' || colorStyle === 'speaker'
        ? colorStyles.find(entry => entry.name === colorName)?.value || style.primaryColor : style.primaryColor;
      let runs = assInlineStyleRuns(fade.text, emphasisSyntax, inlineOptions);
      // KTV：先在 runs 实际携带的文本（MASS 标记已剥除）上求翻转计划，再按
      // 字词边界切 runs；计划失败（无字词时间码/文本失配）时该句静默回落。
      let karaokeApplied = false;
      if (karaoke) {
        const karaokeText = runs.map(run => String(run?.text ?? '')).join('');
        const karaokePlan = assKaraokePlan(karaokeText, karaoke.segment, {
          eventStartMs: start * 10, eventEndMs: end * 10, mapTime: karaoke.mapTime,
        });
        if (karaokePlan) {
          runs = assKaraokeSplitRuns(runs, karaokePlan);
          karaokeApplied = true;
        }
      }
      if (speakerName) runs.unshift({ text: `${speakerName}${speakerLabelSeparator}`, speakerColor });
      stackItems.push({ role, segment, index, start: start * 10, end: end * 10,
        style, fontSize: size, styleName, speakerName, runs: resolveFontRuns(runs, style),
        karaoke: karaokeApplied, fad: fade.fad, pop: fade.pop, originalText, shake });
    };
    // 颜色样式只有在 ASS 能表达为整句样式（text / stroke）时才生成
    // 调色板样式；speaker 只给说话人前缀加局部颜色，none 回落 Default。
    const assColorGroupsSupported = colorStyle === 'text' || colorStyle === 'stroke';

    // 主轨事件：Layer 0，底部居中（Default 样式自带对齐）。
    source.forEach((segment, sourceIndex) => {
      if (!segment || segment.disabled === true || !String(segment.text ?? '').trim()) return;
      const rawStart = normalizeAssTimeMs(mapTime(segment.start));
      const rawEnd = normalizeAssTimeMs(mapTime(segment.end));
      const start = alignFirstStart && sourceIndex === firstEnabledIndex ? 0 : rawStart;
      // ASS only keeps centiseconds. Ensure a one-centisecond event even when
      // an imported/edited cue is shorter than that precision.
      const startCentiseconds = Math.max(0, Math.round(start / 10));
      const endCentiseconds = Math.max(startCentiseconds + 1, Math.round(rawEnd / 10));
      const speakerName = speakerLabels
        ? speakerLabelForSegment(segment, source, speakerLabels) : '';
      // 单句 `>>`/`<<` 渐入渐出与 `{{`/`}}` 放大出现标记只在 ASS 模式解析：
      // 先剥除两端标记，再用剩余文本走强调/颜色管线；fad 时长与 pop 倍率取
      // 该句自己的样式库参数（不管全局开关），单句标记覆盖全局动画。
      const sentenceAnimation = assMode
        ? assSentenceAnimationTags(segment.text, profile, inlineOptions.assSpecialSymbolRule)
        : null;
      const segmentText = sentenceAnimation ? sentenceAnimation.text : String(segment.text ?? '');
      // 单句 `!!` 原地震动标记同样只在 ASS 模式解析：整句导出时拆分为多条
      // \pos 抖动事件，预览按同一模式偏移；普通预览与 SRT 不消费定位结果。
      const sentenceShake = assMode ? parseSentenceShakeMarkers(segmentText) : null;
      const shakeText = sentenceShake?.shake ? sentenceShake.text : segmentText;
      const text = speakerLabels
        ? formatSpeakerLabelledText(
          shakeText, segment, source, speakerLabels, speakerLabelSeparator,
        )
        : shakeText;
      const colorName = effectiveColorName(segment, source);
      const styleName = assColorGroupsSupported && ASS_COLOR_STYLE_NAMES.includes(colorName)
        ? colorName.toUpperCase() : 'Default';
      const styleForEvent = assMode && styleName !== 'Default'
        ? assStyleVariant(baseStyle, colorStyles.find((item) => item.name === colorName)?.value || '#ffffff', colorStyle, keepSecondary)
        : baseStyle;
      const eventText = assEventText({
        segment,
        text: speakerLabels ? shakeText : text,
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
        ? assAnimationOverrideTags(profile, { fad: sentenceAnimation?.fad || null, pop: sentenceAnimation?.pop || null, style: styleForEvent }) : '';
      // 计划条目的 runs/原文本都必须使用剥除 `!!` 后的文本；fad 时长与 pop
      // 倍率保持单句解析结果，两者合并成一个 fade 形参传入。KTV 描述符带
      // 映射后的时间上下文，逐句尝试；翻转时刻在 addStackItem 内相对事件
      // 起点量化（含 alignFirstStart 归零与去空隙压缩）。
      const stackFade = { text: shakeText, fad: sentenceAnimation?.fad || null, pop: sentenceAnimation?.pop || null };
      const karaokeDescriptor = karaokeEnabled
        ? { segment, mapTime } : null;
      if (assMode) addStackItem('main', segment, sourceIndex, source, startCentiseconds, endCentiseconds, styleForEvent, fontSize, styleName, speakerName, stackFade, eventText, sentenceShake?.shake === true, karaokeDescriptor);
      const decoratedText = animationTags ? `{${animationTags}}${eventText}` : eventText;
      events.push(
        `Dialogue: 0,${formatAssTime(startCentiseconds * 10)},${formatAssTime(endCentiseconds * 10)},${styleName},${normalizeAssEventField(speakerName)},0,0,0,,${decoratedText}`,
      );
    });

    // Prepare extension style/content. ASS events below are regenerated from
    // the shared active-cue plan, which supplies group positions and movement.
    const extensionSource = Array.isArray(options.extensionSegments)
      ? options.extensionSegments : [];
    const hasExtensionCues = extensionSource.some((segment) => segment && segment.disabled !== true && String(segment.text ?? '').trim());
    const extensionStyle = assMode && options.assExtensionStyle && typeof options.assExtensionStyle === 'object'
      ? normalizeAssStyle(options.assExtensionStyle, ASS_DEFAULT_EXTENSION_STYLE, options.assExtensionStyle.id || 'ass-extension')
      : null;
    if (extensionStyle) extensionStyle.fontName = canonicalizeAssFontName(extensionStyle.fontName);
    const extensionScaledFontSize = extensionStyle
      ? normalizeAssFontSize(extensionStyle.fontSize * resolution.height / ASS_REFERENCE_PLAY_RES_Y)
      : 0;
    // 副字幕位置由其样式预设（对齐 + MarginV）决定：排布计划把副字幕当作
    // 固定层（见 assCreateStackPlan），不再强制排在主字幕上方。
    if (assMode && extensionStyle) {
      extensionSource.forEach((segment, index) => {
        if (!segment || segment.disabled === true || !String(segment.text ?? '').trim()) return;
        const rawStart = normalizeAssTimeMs(mapTime(segment.start));
        const rawEnd = normalizeAssTimeMs(mapTime(segment.end));
        if (rawEnd <= rawStart) return;
        const startCentiseconds = Math.max(0, Math.round(rawStart / 10));
        const endCentiseconds = Math.max(startCentiseconds + 1, Math.round(rawEnd / 10));
        const extensionFade = assSentenceAnimationTags(segment.text, profile, inlineOptions.assSpecialSymbolRule);
        const extensionAnimationTags = assAnimationOverrideTags(profile, { includeMove: false, fad: extensionFade.fad, pop: extensionFade.pop, style: extensionStyle });
        // 说话人前缀与主字幕同规则：开启「字幕显示说话人前缀」时副字幕
        // 也按自身轨的颜色映射追加前缀（上下文用副字幕轨自身数组）。
        const extensionSpeakerName = speakerLabels
          ? speakerLabelForSegment(segment, extensionSource, speakerLabels) : '';
        const extensionContent = assEventText({
          segment,
          text: extensionFade.text,
          speakerName: extensionSpeakerName,
          speakerLabelSeparator,
          colorName: effectiveColorName(segment, extensionSource),
          colorStyles,
          style: extensionStyle,
          fontSize: extensionScaledFontSize,
          colorStyle,
          speakerLabels,
          assMode,
          emphasisSyntax,
          inlineOptions,
        });
        addStackItem('extension', segment, index, extensionSource, startCentiseconds, endCentiseconds, extensionStyle, extensionScaledFontSize, 'Extension', extensionSpeakerName, extensionFade);
        const extensionText = extensionAnimationTags
          ? `{${extensionAnimationTags}}${extensionContent}` : extensionContent;
        events.push(
          `Dialogue: 1,${formatAssTime(startCentiseconds * 10)},${formatAssTime(endCentiseconds * 10)},Extension,,0,0,0,,${extensionText}`,
        );
      });
    }

    // Overlay inherits main typography and the extension's horizontal style
    // when enabled. Active-event positions and motion come from the stack plan.
    const overlaySource = Array.isArray(options.overlaySegments) ? options.overlaySegments : [];
    const hasOverlayCues = overlaySource.some((segment) => segment && segment.disabled !== true && String(segment.text ?? '').trim());
    const overlayMarginV = assMode
      ? Math.max(0, Number(baseStyle.marginV) || 0) + Math.round(1.2 * fontSize)
      : 80 + Math.round(1.2 * fontSize);
    // 叠加字幕固定锚定在主字幕上方：对齐与水平边距完全来自主字幕样式；
    // 副字幕在主字幕下方（跟随其样式预设），与叠加字幕互不影响。
    const overlayBaseStyle = assMode
      ? baseStyle
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
          colorStyles.find((item) => item.name === colorName)?.value || '#ffffff', colorStyle, keepSecondary)
        : overlayBaseStyle;
      return { ...variant, marginV: overlayMarginV };
    };
    const overlayStyleNameFor = (colorName) => (
      assColorGroupsSupported && ASS_COLOR_STYLE_NAMES.includes(colorName)
        ? `Overlay ${colorName.toUpperCase()}` : 'Overlay'
    );
    overlaySource.forEach((segment, index) => {
      if (!segment || segment.disabled === true || !String(segment.text ?? '').trim()) return;
      const rawStart = normalizeAssTimeMs(mapTime(segment.start));
      const rawEnd = normalizeAssTimeMs(mapTime(segment.end));
      if (rawEnd <= rawStart) return;
      const startCentiseconds = Math.max(0, Math.round(rawStart / 10));
      const endCentiseconds = Math.max(startCentiseconds + 1, Math.round(rawEnd / 10));
      const overlayColorName = effectiveColorName(segment, overlaySource);
      const overlayFade = assMode
        ? assSentenceAnimationTags(segment.text, profile, inlineOptions.assSpecialSymbolRule) : null;
      const overlayAnimationTags = assMode
        ? assAnimationOverrideTags(profile, { includeMove: false, fad: overlayFade.fad, pop: overlayFade.pop, style: overlayStyleFor(overlayColorName) }) : '';
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
      if (assMode) addStackItem('overlay', segment, index, overlaySource, startCentiseconds, endCentiseconds, overlayStyleFor(overlayColorName), fontSize, overlayStyleNameFor(overlayColorName), overlaySpeakerName, overlayFade);
      const overlayText = overlayAnimationTags
        ? `{${overlayAnimationTags}}${overlayContent}` : overlayContent;
      events.push(
        `Dialogue: 2,${formatAssTime(startCentiseconds * 10)},${formatAssTime(endCentiseconds * 10)},${overlayStyleNameFor(overlayColorName)},,0,0,0,,${overlayText}`,
      );
    });

    if (assMode) {
      const plan = dependencies.assCreateStackPlan({ items: stackItems, profile,
        width: resolution.width, height: resolution.height, measure: options.measureAssRun });
      if (typeof options.onAssPlan === 'function') options.onAssPlan({ ...plan, profile });
      if (options.allowAssPlanDiagnostics) return '';
      if (!options.allowAssPlanDiagnostics && plan.diagnostics.length) throw new Error(plan.diagnostics[0].message);
      events.length = 0;
      const number = value => Number(value.toFixed(4));
      for (const slice of plan.slices) {
        if (slice.diagnostic) continue;
        for (const piece of slice.pieces) for (const item of slice.items) {
          // Fixed extensions keep their own scale in every override, including
          // inline font-size resets and animation targets.
          const groupScale = item.absolute ? 1 : slice.scale;
          const scale = groupScale * item.cueScale;
          const scaledStyle = { ...item.style, spacing: item.style.spacing * scale,
            outline: item.style.outline * scale, shadow: item.style.shadow * scale };
          const transformTargets = profile.animations.t.enabled
            ? dependencies.assTransformStyleTargets(profile.animations.t.tags) : {};
          const sharedDecorations = (!slice.legacy || item.sharedStackCue)
            && (transformTargets.underline !== undefined || transformTargets.strikeOut !== undefined
              || transformTargets.italic !== undefined);
          if (sharedDecorations) {
            // libass applies these discrete t targets at cue start. Inline
            // marker resets must restore that effective value, including off.
            for (const key of ['underline', 'strikeOut', 'italic']) {
              if (transformTargets[key] !== undefined) scaledStyle[key] = Boolean(transformTargets[key]);
            }
          }
          const size = Math.max(1, number(item.fontSize * scale));
          // 每条 Dialogue 的发射入口：非震动句只发一次（start/end 即分片
          // 边界，输出与拆分前逐字节一致）；震动句按固定间隔多次发射。
          const emitEvent = (start, end, position, { includeMove = slice.legacy && item.role === 'main' && !item.manual } = {}) => {
            const animation = start === item.start && end === item.end && scale === 1
              ? assAnimationOverrideTags(profile, { includeMove, fad: item.fad, pop: item.pop, style: item.style })
              : dependencies.assAnimationSliceTags(profile, { offsetMs: start - item.start,
                durationMs: item.end - item.start, includeMove, fad: item.fad, pop: item.pop, style: item.style, scale });
            const transformTarget = transformTargets.fontSize;
            // 固定层不参与组缩放：其 	 字号动画目标保持样式原值。
            const fontTransform = transformTarget === undefined ? null : {
              startMs: profile.animations.t.startMs - (start - item.start),
              endMs: (profile.animations.t.startMs === 0 && profile.animations.t.endMs === 0
                ? item.end - item.start : profile.animations.t.endMs) - (start - item.start),
              accel: profile.animations.t.accel, target: Number((transformTarget * scale).toFixed(4)),
            };
            // Legacy 震动句带预折行 runs 与 \q2，必须走 runs 渲染而不是原文。
            // KTV 句同理：originalText 不含 \k，且分片发射需按片偏移重定基
            //（已唱 \k0、未唱差值，见 assEmphasizedText）。
            const content = slice.legacy && !item.manual && !item.shake && !item.karaoke && item.cueScale === 1 && !(item.sharedStackCue && (fontTransform || sharedDecorations)) ? item.originalText : assEmphasizedText('', scaledStyle, size, emphasisSyntax,
              { ...inlineOptions, preparedRuns: item.runs, fontTransform, karaokeOffsetCs: item.karaoke ? (start - item.start) / 10 : 0 });
            const decorated = (position ? `{${position}}` : '') + (animation ? `{${animation}}` : '') + content;
            const eventName = options.pngEventNames ? `maw:${item.role}:${item.index}` : item.speakerName;
            events.push(`Dialogue: ${{ main: 0, extension: 1, overlay: 2 }[item.role]},${formatAssTime(start)},${formatAssTime(end)},${item.styleName},${normalizeAssEventField(eventName)},0,0,0,,${decorated}`);
          };
          if (item.shake) {
            // 原地震动：一条 ASS 事件只能有一个定位标签，导出时按固定间隔
            // 把该句拆成多条 \pos 事件。基准位置取各片起点（与预览逐帧偏移
            // 同一公式），方案移动/整组位移被逐片采样；淡入淡出与 \t 变换
            // 使用负相对时钟，跨片不重播、不闪烁。
            const amplitude = dependencies.assShakeAmplitude(slice.height) * scale;
            const interval = dependencies.ASS_SHAKE_INTERVAL_MS;
            for (let shakeStart = piece.start; shakeStart < piece.end;) {
              // Layout boundaries may fall inside a phase. Resume the cue's
              // centisecond-quantized clock instead of starting another 60ms.
              const nextPhase = item.start + (Math.floor((shakeStart - item.start) / interval) + 1) * interval;
              const shakeEnd = Math.min(piece.end, nextPhase);
              const offset = dependencies.assShakeOffsetFor(shakeStart - item.start, amplitude);
              let shakeBase;
              if (slice.legacy || item.manual) {
                const state = dependencies.assPreviewAnimationState(profile, shakeStart - item.start, item.end - item.start);
                const anchor = item.manual ? { x: item.offset.x, y: item.offset.y }
                  : dependencies.assCanvasAnchorPoint({ alignment: item.style.alignment,
                    margins: { left: item.style.marginL, right: item.style.marginR, vertical: item.style.marginV },
                    playResX: slice.width, playResY: slice.height,
                    move: profile.animations.move.enabled ? { x: state.moveX, y: state.moveY } : null });
                shakeBase = { x: anchor.x, y: anchor.y };
              } else {
                const root = dependencies.assStackPieceRootAt(piece, shakeStart);
                shakeBase = { x: root.x + item.offset.x * groupScale, y: root.y + item.offset.y * groupScale };
              }
              let shakePosition = `\\an${item.alignment}\\q2\\pos(${number(shakeBase.x + offset.x)},${number(shakeBase.y + offset.y)})`;
              // 堆叠组内非固定层句沿用既有内联字号/描边/阴影重置。
              if ((!slice.legacy && !item.absolute) || (item.role === 'main' && item.cueScale !== 1)) {
                shakePosition += `\\fs${size}\\fsp${number(scaledStyle.spacing)}\\bord${number(scaledStyle.outline)}\\shad${number(scaledStyle.shadow)}`;
              }
              emitEvent(shakeStart, shakeEnd, shakePosition, { includeMove: false });
              shakeStart = shakeEnd;
            }
            continue;
          }
          let position = '';
          if (item.manual) {
            position = `\\an${item.alignment}\\q2\\pos(${number(item.offset.x)},${number(item.offset.y)})`;
          } else if (!slice.legacy && item.absolute) {
            // 固定层（副字幕）：绝对 \\pos 定位在样式预设位置，无移动动画，
            // 也不参与整组缩放：字号与描边阴影保持样式原值。
            const fixedSize = Math.max(1, number(item.fontSize));
            const fixedStyle = { ...scaledStyle, spacing: item.style.spacing, outline: item.style.outline, shadow: item.style.shadow };
            position = `\\an${item.alignment}\\q2\\pos(${number(item.offset.x)},${number(item.offset.y)})`
              + `\\fs${fixedSize}\\fsp${number(fixedStyle.spacing)}\\bord${number(fixedStyle.outline)}\\shad${number(fixedStyle.shadow)}`;
          } else if (!slice.legacy) {
            const from = { x: number(piece.from.x + item.offset.x * groupScale), y: number(piece.from.y + item.offset.y * groupScale) };
            const to = { x: number(piece.to.x + item.offset.x * groupScale), y: number(piece.to.y + item.offset.y * groupScale) };
            const instant = piece.instant === null || piece.instant === undefined ? null : piece.instant - piece.start;
            const moveStart = instant === null ? 0 : instant;
            const moveEnd = instant === null ? piece.end - piece.start : instant === 0 ? 1 : instant;
            position = from.x === to.x && from.y === to.y ? `\\pos(${from.x},${from.y})`
              : `\\move(${from.x},${from.y},${to.x},${to.y},${moveStart},${moveEnd})`;
            position = `\\an${item.alignment}\\q2${position}\\fs${size}\\fsp${number(scaledStyle.spacing)}\\bord${number(scaledStyle.outline)}\\shad${number(scaledStyle.shadow)}`;
          }
          if (item.cueScale !== 1) position += `\\fs${size}\\fsp${number(scaledStyle.spacing)}\\bord${number(scaledStyle.outline)}\\shad${number(scaledStyle.shadow)}`;
          emitEvent(piece.start, piece.end, position);
        }
      }
    }

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
          ...cueStyleLines,
          ...(colorStyle === 'text' || colorStyle === 'stroke'
            ? colorStyles.map((color) => assStyleLine(
              assStyleVariant(baseStyle, color.value, colorStyle, keepSecondary),
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
