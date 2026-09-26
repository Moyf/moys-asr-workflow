// split-alignment: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-split-alignment', function createUtilsModule(dependencies) {
  'use strict';


  function timestampedSplitCandidates(segment) {
    const text = String(segment?.text || '');
    const codePoints = Array.from(text);
    if (codePoints.length < 2) return [];
    const hasContent = (value) => /[\p{L}\p{N}\p{S}]/u.test(value);

    const alignedItems = [];
    let searchFrom = 0;
    (Array.isArray(segment?.items) ? segment.items : []).forEach((item) => {
      const itemText = String(item?.text || '');
      if (!itemText) return;
      const start = text.indexOf(itemText, searchFrom);
      if (start < 0) return;
      alignedItems.push({ item, start, end: start + itemText.length });
      searchFrom = start + itemText.length;
    });

    const candidates = [];
    for (let index = 1; index < alignedItems.length; index++) {
      const left = alignedItems[index - 1];
      const right = alignedItems[index];
      const offset = right.start;
      if (offset <= 0 || offset >= text.length) continue;
      if (!hasContent(text.slice(0, offset)) || !hasContent(text.slice(offset))) continue;
      const leftEnd = Number(left.item.end);
      const rightStart = Number(right.item.start);
      const hasTimestamp = Number.isFinite(leftEnd) && Number.isFinite(rightStart);
      let boundaryTime = Number.isFinite(leftEnd) && Number.isFinite(rightStart)
        ? (leftEnd + rightStart) / 2
        : Number.isFinite(rightStart) ? rightStart : leftEnd;
      if (!Number.isFinite(boundaryTime)) {
        boundaryTime = Number(segment?.start)
          + ((Number(segment?.end) - Number(segment?.start)) * offset / text.length);
      }
      candidates.push({ offset, time: boundaryTime, hasTimestamp });
    }
    return candidates;
  }


  function hasUsableSplitTimestamps(segment) {
    return timestampedSplitCandidates(segment).some((candidate) => candidate.hasTimestamp);
  }


  function splitCharOffsetAtTime(segment, timeMs) {
    const text = String(segment?.text || '');
    const codePoints = Array.from(text);
    if (codePoints.length < 2) return null;
    const hasContent = (value) => /[\p{L}\p{N}\p{S}]/u.test(value);
    const targetTime = Number(timeMs);
    const candidates = timestampedSplitCandidates(segment);
    if (candidates.length && Number.isFinite(targetTime)) {
      return candidates.reduce((nearest, candidate) => (
        Math.abs(candidate.time - targetTime) < Math.abs(nearest.time - targetTime)
          ? candidate : nearest
      )).offset;
    }

    const offsets = [];
    let utf16Offset = 0;
    codePoints.forEach((character, index) => {
      utf16Offset += character.length;
      if (index < codePoints.length - 1
          && hasContent(text.slice(0, utf16Offset))
          && hasContent(text.slice(utf16Offset))) {
        offsets.push(utf16Offset);
      }
    });
    if (!offsets.length) return null;
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const ratio = Number.isFinite(targetTime) && Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.max(0, Math.min(1, (targetTime - start) / (end - start)))
      : 0.5;
    const index = Math.max(0, Math.min(offsets.length - 1, Math.round(ratio * codePoints.length) - 1));
    return offsets[index] ?? null;
  }


  // 字幕文本与 items 的顺序保持对齐：每个词在原文的所有出现位置中，选
  // 「位置递增且对齐词数最多」的组合（小规模 DP）。不能用贪心 indexOf：
  // 一处失配就整体作废会让拆分切点随人工插入文本的长度漂移（如把 ASR 词
  // 「傲」改写成「Alt(noir)」后，剩下的同字词必须让位、各自落到真实位置）。
  // 返回与 items 等长的数组，对齐成功的元素为
  // { item, itemText, textStart, textEnd }，空文本或找不到的词为 null。
  function alignItemsToText(text, items) {
    const value = String(text || '');
    const list = Array.isArray(items) ? items : [];
    const occurrences = list.map((item) => {
      const itemText = String(item?.text || '');
      const found = [];
      if (itemText) {
        let pos = value.indexOf(itemText);
        while (pos >= 0) {
          found.push(pos);
          pos = value.indexOf(itemText, pos + 1);
        }
      }
      return found;
    });
    // 对齐在拆分时同步执行：超大输入（超长粘贴段 × 高频重复短词）直接放弃
    // 对齐、返回全失配，让拆分走时间/词序落边回退，而不是冻结编辑器。
    // （常规字幕行远低于该阈值；失配回退本身已有词序映射与漂移提示兜底。）
    if (list.length === 0
        || list.length * (value.length + 2) > 2_000_000
        || occurrences.reduce((sum, occ) => sum + occ.length, 0) > 2_000_000) {
      return new Array(list.length).fill(null);
    }
    const memo = new Map();
    const bestFrom = (index, minStart) => {
      if (index >= list.length) return 0;
      const key = `${index}:${minStart}`;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      let best = bestFrom(index + 1, minStart);
      const itemText = String(list[index]?.text || '');
      const occ = occurrences[index];
      // bestFrom(i+1, ·) 随 minStart 单调不增，所以最优转移必然是首个
      // >= minStart 的出现位置，二分即可；逐个扫描会让重复短词的 DP
      // 退化为近似立方复杂度。
      let lo = 0;
      let hi = occ.length - 1;
      let pick = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (occ[mid] >= minStart) {
          pick = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      if (pick >= 0) {
        best = Math.max(best, 1 + bestFrom(index + 1, occ[pick] + itemText.length));
      }
      memo.set(key, best);
      return best;
    };
    const result = new Array(list.length).fill(null);
    let minStart = 0;
    for (let index = 0; index < list.length; index++) {
      const itemText = String(list[index]?.text || '');
      if (!itemText) continue;
      const optimum = bestFrom(index, minStart);
      let chosen = -1;
      for (const pos of occurrences[index]) {
        if (pos >= minStart && 1 + bestFrom(index + 1, pos + itemText.length) >= optimum) {
          chosen = pos;
          break;
        }
      }
      if (chosen >= 0) {
        result[index] = { item: list[index], itemText, textStart: chosen, textEnd: chosen + itemText.length };
        minStart = chosen + itemText.length;
      }
    }
    return result;
  }


  // 拆分时在原文里找不到的 item（人工改写过的词）没有可靠的文本位置：
  // 调用方可通过 item.side 显式定侧（结合相邻对齐锚点的文字空位与刀点
  // 相对位置算出），否则按自身时间与切点比较——完全在切点左侧归左、
  // 右侧归右、跨切点归更近的一侧。bounds 给出两侧当前边界时，边界先扩
  // 到包住本侧失配词（如「傲」的语音正是右段文本 Alt(noir) 的发音：右
  // 段起点必须前移到它的 start，否则词会先于段起点、保存时被时间码兜底
  // 二次改写），失配词再钳进最终边界，钳后为空的丢弃（与对齐词的处理
  // 一致）。返回值带调整后的 bounds；未传 bounds 时保持旧行为（只落边
  // 不钳制）。
  function placeUnalignedSplitItems(leftItems, rightItems, items, splitMs, bounds = null) {
    const left = [...(Array.isArray(leftItems) ? leftItems : [])];
    const right = [...(Array.isArray(rightItems) ? rightItems : [])];
    const cut = Number(splitMs);
    if (!Number.isFinite(cut)) {
      return { leftItems: left, rightItems: right, bounds: null };
    }
    const originalLeftEnd = Number(bounds?.leftEndMs);
    const originalRightStart = Number(bounds?.rightStartMs);
    const hasBounds = Number.isFinite(originalLeftEnd) && Number.isFinite(originalRightStart);
    const pending = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (item?.start == null || item?.end == null) return;
      const start = Number(item.start);
      const end = Number(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      const toLeft = item.side === 'left' ? true
        : item.side === 'right' ? false
        : end <= cut ? true
        : start >= cut ? false
        : cut - start < end - cut;
      // side 只参与落边决策，不能带进工程 JSON。
      const { side: _side, ...itemData } = item;
      pending.push({ item: { ...itemData, start, end }, toLeft });
    });
    let leftEnd = originalLeftEnd;
    let rightStart = originalRightStart;
    if (hasBounds && pending.length) {
      for (const entry of pending) {
        if (entry.toLeft) leftEnd = Math.max(leftEnd, entry.item.end);
        else rightStart = Math.min(rightStart, entry.item.start);
      }
      // 病态时间码可能让扩展后的两侧交叉：放弃扩展，保持原边界。
      if (rightStart < leftEnd) {
        leftEnd = originalLeftEnd;
        rightStart = originalRightStart;
      }
    }
    pending.forEach(({ item, toLeft }) => {
      let { start, end } = item;
      if (hasBounds) {
        if (toLeft) end = Math.min(end, leftEnd);
        else start = Math.max(start, rightStart);
        if (end <= start) return;
      }
      const target = toLeft ? left : right;
      let at = target.length;
      while (at > 0 && Number(target[at - 1].start) > start) at -= 1;
      target.splice(at, 0, { ...item, start, end });
    });
    return {
      leftItems: left,
      rightItems: right,
      bounds: hasBounds ? { leftEndMs: leftEnd, rightStartMs: rightStart } : null,
    };
  }


  // 用户下刀时间与拆分边界的偏差：边界包住下刀（落在两侧词的真实静音
  // 空隙内）记 0，空隙再宽也不算漂移；否则取到最近边界的距离。
  // 注意 Number(null) === 0，缺参必须先按 null 拦下，不能只靠 isFinite。
  function splitAlignmentDriftMs(leftEndMs, rightStartMs, requestedCutMs) {
    if (requestedCutMs == null || leftEndMs == null || rightStartMs == null) return null;
    const requested = Number(requestedCutMs);
    const leftEnd = Number(leftEndMs);
    const rightStart = Number(rightStartMs);
    if (!Number.isFinite(requested) || !Number.isFinite(leftEnd) || !Number.isFinite(rightStart)) return null;
    if (requested >= leftEnd && requested <= rightStart) return 0;
    return Math.round(Math.min(Math.abs(requested - leftEnd), Math.abs(requested - rightStart)));
  }

  return Object.freeze({ alignItemsToText, hasUsableSplitTimestamps, placeUnalignedSplitItems, splitAlignmentDriftMs, splitCharOffsetAtTime });
});
