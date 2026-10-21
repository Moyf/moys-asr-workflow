// ass-animation: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';
  const { ASS_DEFAULT_PLAY_RES_X, ASS_DEFAULT_PLAY_RES_Y, normalizeAssAnimations, parseSentenceFadeMarkers, parseSentencePopMarkers } = dependencies;


  // 单句渐入渐出 / 放大出现：取整行两端标记，返回剥离后的文本与该句自己的
  // 动画参数。fad 时长与 pop 倍率统一取自样式库 profile（即使未启用也取其
  // 参数，单句标记优先级高于全局动画开关）。
  function assSentenceAnimationTags(text, profile, rule) {
    const parsed = parseSentenceFadeMarkers(text, rule);
    const pop = parseSentencePopMarkers(parsed.text, rule);
    const animations = normalizeAssAnimations(profile?.animations);
    return {
      text: pop.text,
      fad: parsed.fadeIn || parsed.fadeOut
        ? { inMs: parsed.fadeIn ? animations.fad.inMs : 0, outMs: parsed.fadeOut ? animations.fad.outMs : 0 } : null,
      pop: pop.pop ? animations.pop : null,
    };
  }


  // 放大出现的标签片段：文字从 `fromScale × 样式缩放` 缩小落定到样式原值。
  // ASS 的 \t 从当前值渐变到目标值，因此先写显式 \fscx\fscy 设定起点帧，
  // 再由 \t 缓动落定；窗口结束后停在终点。offsetMs 是分片事件相对句首的
  // 偏移（震动拆分 / 排布分片）：负相对时钟让动画跨片连续，片起点已越过
  // 入场窗口时不再发射。百分比值不乘组缩放（\fscx 是已缩放字号的百分比）。
  function assPopTransformTag(pop, style, offsetMs = 0) {
    if (!pop || !(Number(pop.fromScale) > 1)) return '';
    const baseX = Number.isFinite(Number(style?.scaleX ?? 100)) ? Math.max(0, Number(style?.scaleX ?? 100)) : 100;
    const baseY = Number.isFinite(Number(style?.scaleY ?? 100)) ? Math.max(0, Number(style?.scaleY ?? 100)) : 100;
    const inMs = Math.max(0, Number(pop.inMs) || 0);
    if (offsetMs >= inMs) return '';
    const percent = value => Number(value.toFixed(2));
    const accel = Number(pop.accel) > 0 ? percent(Number(pop.accel)) : 1;
    return `\\fscx${percent(baseX * pop.fromScale)}\\fscy${percent(baseY * pop.fromScale)}`
      + `\\t(${Math.round(-offsetMs)},${Math.round(inMs - offsetMs)},${accel},`
      + `\\fscx${percent(baseX)}\\fscy${percent(baseY)})`;
  }


  function assAnimationOverrideTags(profile, { includeMove = true, fad = null, pop = null, style = null } = {}) {
    const animations = normalizeAssAnimations(profile?.animations);
    const tags = [];
    const popTag = assPopTransformTag(pop || (animations.pop.enabled ? animations.pop : null), style);
    if (popTag) tags.push(popTag);
    // libass/playback behaviour is undefined when both fade forms are present.
    // The more expressive form wins, while the simple fad remains the normal
    // one-click path in the style manager.
    if (fad) {
      // 单句 `>>`/`<<` 标记：覆盖全局 fade/fad，只保留该句的淡入淡出。
      tags.push(`\\fad(${fad.inMs},${fad.outMs})`);
    } else if (animations.fade.enabled) {
      const { alpha1, alpha2, alpha3, t1, t2, t3, t4 } = animations.fade;
      tags.push(`\\fade(${alpha1},${alpha2},${alpha3},${t1},${t2},${t3},${t4})`);
    } else if (animations.fad.enabled) {
      tags.push(`\\fad(${animations.fad.inMs},${animations.fad.outMs})`);
    }
    // Original move coordinates belong to the main cue. The shared stack plan
    // generates movement for the whole group and suppresses this original tag.
    if (includeMove && animations.move.enabled) {
      const { x1, y1, x2, y2, t1, t2 } = animations.move;
      tags.push(`\\move(${x1},${y1},${x2},${y2},${t1},${t2})`);
    }
    if (animations.t.enabled && animations.t.tags) {
      const { startMs, endMs, accel, tags: transformTags } = animations.t;
      tags.push(`\\t(${startMs},${endMs},${accel},${transformTags})`);
    }
    return tags.join('');
  }


  function assPreviewAnimationState(profile, elapsedMs, durationMs, {
    playResX = ASS_DEFAULT_PLAY_RES_X,
    playResY = ASS_DEFAULT_PLAY_RES_Y,
    stageWidth = 0,
    stageHeight = 0,
    fad = null,
    pop = null,
  } = {}) {
    const animations = normalizeAssAnimations(profile?.animations);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const duration = Math.max(1, Number(durationMs) || 1);
    let opacity = 1;
    const interpolate = (start, end, from, to) => {
      if (to <= from) return elapsed >= to ? end : start;
      const amount = Math.min(1, Math.max(0, (elapsed - from) / (to - from)));
      return start + (end - start) * amount;
    };
    if (fad) {
      // 单句 `>>`/`<<`：预览跟随该句自身的淡入淡出，忽略全局开关。
      const fadeIn = fad.inMs > 0 && elapsed < fad.inMs ? elapsed / fad.inMs : 1;
      const fadeOutStart = Math.max(0, duration - fad.outMs);
      const fadeOut = fad.outMs > 0 && elapsed > fadeOutStart
        ? Math.max(0, (duration - elapsed) / fad.outMs) : 1;
      opacity = Math.min(1, fadeIn, fadeOut);
    } else if (animations.fade.enabled) {
      const fade = animations.fade;
      let alpha = fade.alpha1;
      if (elapsed < fade.t1) alpha = fade.alpha1;
      else if (elapsed < fade.t2) alpha = interpolate(fade.alpha1, fade.alpha2, fade.t1, fade.t2);
      else if (elapsed < fade.t3) alpha = fade.alpha2;
      else if (elapsed < fade.t4) alpha = interpolate(fade.alpha2, fade.alpha3, fade.t3, fade.t4);
      else alpha = fade.alpha3;
      opacity = 1 - Math.min(255, Math.max(0, alpha)) / 255;
    } else if (animations.fad.enabled) {
      const fadeIn = animations.fad.inMs > 0 && elapsed < animations.fad.inMs
        ? elapsed / animations.fad.inMs : 1;
      const fadeOutStart = Math.max(0, duration - animations.fad.outMs);
      const fadeOut = animations.fad.outMs > 0 && elapsed > fadeOutStart
        ? Math.max(0, (duration - elapsed) / animations.fad.outMs) : 1;
      opacity = Math.min(1, fadeIn, fadeOut);
    }
    let moveX = 0;
    let moveY = 0;
    if (animations.move.enabled) {
      const move = animations.move;
      const amount = move.t2 <= move.t1
        ? (elapsed >= move.t2 ? 1 : 0)
        : Math.min(1, Math.max(0, (elapsed - move.t1) / (move.t2 - move.t1)));
      moveX = move.x1 + (move.x2 - move.x1) * amount;
      moveY = move.y1 + (move.y2 - move.y1) * amount;
    }
    let transformProgress = null;
    if (animations.t.enabled && animations.t.tags) {
      const start = animations.t.startMs;
      const end = animations.t.endMs;
      const linear = end <= start
        ? (elapsed >= end ? 1 : 0)
        : Math.min(1, Math.max(0, (elapsed - start) / (end - start)));
      transformProgress = Math.pow(linear, Math.max(0.01, animations.t.accel));
    }
    // 放大出现：与导出的 `\fscx…\t(…,\fscx终点)` 同一插值公式（线性进度取
    // accel 次幂），入场窗口结束或 fromScale ≤ 1 时恒为 1。
    const popAnimation = pop || (animations.pop.enabled ? animations.pop : null);
    let popScale = 1;
    if (popAnimation && Number(popAnimation.fromScale) > 1) {
      const inMs = Math.max(0, Number(popAnimation.inMs) || 0);
      const linear = inMs <= 0 ? 1 : Math.min(1, elapsed / inMs);
      const progress = Math.pow(linear, Math.max(0.01, Number(popAnimation.accel) || 1));
      popScale = popAnimation.fromScale + (1 - popAnimation.fromScale) * progress;
    }
    const safePlayResX = Math.max(1, Number(playResX) || ASS_DEFAULT_PLAY_RES_X);
    const safePlayResY = Math.max(1, Number(playResY) || ASS_DEFAULT_PLAY_RES_Y);
    return {
      opacity,
      popScale,
      moveX,
      moveY,
      moveOffsetX: animations.move.enabled
        ? (moveX - animations.move.x1) * (Number(stageWidth) || 0) / safePlayResX : 0,
      moveOffsetY: animations.move.enabled
        ? (moveY - animations.move.y1) * (Number(stageHeight) || 0) / safePlayResY : 0,
      transformProgress,
    };
  }

  // A split Dialogue starts a new libass clock. Negative relative times retain
  // the source cue's fade/transform clock (verified against real libass frames).
  function assAnimationSliceTags(profile, { offsetMs = 0, durationMs = 1, includeMove = true, fad = null, pop = null, scale = 1, style = null } = {}) {
    const animations = normalizeAssAnimations(profile?.animations);
    const tags = [];
    const popTag = assPopTransformTag(pop || (animations.pop.enabled ? animations.pop : null), style, offsetMs);
    if (popTag) tags.push(popTag);
    const simple = fad || (!animations.fade.enabled && animations.fad.enabled ? animations.fad : null);
    if (simple) {
      tags.push(`\\fade(255,0,255,${-offsetMs},${simple.inMs - offsetMs},${durationMs - simple.outMs - offsetMs},${durationMs - offsetMs})`);
    } else if (animations.fade.enabled) {
      const f = animations.fade;
      tags.push(`\\fade(${f.alpha1},${f.alpha2},${f.alpha3},${f.t1 - offsetMs},${f.t2 - offsetMs},${f.t3 - offsetMs},${f.t4 - offsetMs})`);
    }
    if (includeMove && animations.move.enabled) {
      const m = animations.move;
      const end = m.t1 === 0 && m.t2 === 0 ? durationMs : m.t2;
      const step = end === m.t1;
      if (step ? offsetMs > end : offsetMs >= end) {
        // libass clamps two negative move times to 0,0, restarting movement
        // over the sliced event. An already completed motion is a fixed pos.
        tags.push(`\\pos(${m.x2},${m.y2})`);
      } else {
        const relativeEnd = step && offsetMs === end ? 1 : end - offsetMs;
        tags.push(`\\move(${m.x1},${m.y1},${m.x2},${m.y2},${m.t1 - offsetMs},${relativeEnd})`);
      }
    }
    if (animations.t.enabled && animations.t.tags) {
      const t = animations.t;
      const end = t.startMs === 0 && t.endMs === 0 ? durationMs : t.endMs;
      const transformed = t.tags.replace(/\\(fs|fsp|bord|shad|xbord|ybord)(-?\d+(?:\.\d+)?)/giu,
        (_, name, value) => `\\${name}${Number((Number(value) * scale).toFixed(4))}`);
      tags.push(`\\t(${t.startMs - offsetMs},${end - offsetMs},${t.accel},${transformed})`);
    }
    return tags.join('');
  }

  function assStackAnimationState(profile, elapsedMs, durationMs, { fad = null, pop = null } = {}) {
    const state = assPreviewAnimationState(profile, elapsedMs, durationMs, { fad, pop });
    const animations = normalizeAssAnimations(profile?.animations);
    const simple = fad || (!animations.fade.enabled && animations.fad.enabled ? animations.fad : null);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    if (animations.t.enabled && animations.t.tags && animations.t.startMs === 0 && animations.t.endMs === 0) {
      state.transformProgress = Math.pow(Math.min(1, elapsed / Math.max(1, durationMs)), animations.t.accel);
    }
    if (simple) {
      // libass prioritises the fade-in phase when a short cue's fades overlap.
      state.opacity = elapsed < simple.inMs ? elapsed / simple.inMs
        : elapsed <= durationMs - simple.outMs ? 1
          : simple.outMs > 0 ? Math.max(0, (durationMs - elapsed) / simple.outMs) : 1;
    }
    if (animations.move.enabled) {
      const move = animations.move;
      const end = move.t1 === 0 && move.t2 === 0 ? durationMs : move.t2;
      const amount = end <= move.t1 ? (elapsed > end ? 1 : 0)
        : Math.min(1, Math.max(0, (elapsed - move.t1) / (end - move.t1)));
      state.moveX = move.x1 + (move.x2 - move.x1) * amount;
      state.moveY = move.y1 + (move.y2 - move.y1) * amount;
    }
    return state;
  }

  return Object.freeze({ assAnimationOverrideTags, assAnimationSliceTags, assStackAnimationState, assPreviewAnimationState, assSentenceAnimationTags });
}
