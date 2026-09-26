// timed-text-edit: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-timed-text-edit', function createUtilsModule(dependencies) {
  'use strict';
  const { buildTimedTextBoundaryPlan, buildTimedTextDiff, buildTimedTextStructurePlan, cloneJsonValue, timedTextDiffOpcodes, timedTextItemCoverage, timedTextItemLayout, timedTextItemReuse, timedTextItemsSlice, timedTextNeutralInsertionItems, timedTextStructureRequested, timedTextTokens } = dependencies;


  function reconcileTimedTextItems(originalText, rawItems, newText) {
    if (!Array.isArray(rawItems) || !rawItems.length) {
      return { status: 'unavailable', items: null, preservedItems: 0, affectedItems: 0 };
    }
    const layout = timedTextItemLayout(originalText, rawItems);
    if (!layout) {
      const items = Array.isArray(rawItems) ? cloneJsonValue(rawItems) : [];
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }
    const { items, spans } = layout;
    if (originalText === newText) {
      return { status: 'full', items, preservedItems: items.length, affectedItems: 0 };
    }

    const originalTokens = timedTextTokens(originalText);
    const newTokens = timedTextTokens(newText);
    const neutralItems = timedTextNeutralInsertionItems(originalText, layout, newText);
    if (neutralItems) {
      return {
        status: 'partial',
        items: neutralItems,
        preservedItems: items.length,
        affectedItems: 0,
      };
    }
    // 等长改字是最可靠的错别字修正场景：按原 item 的字符长度重新分配文字，
    // 直接保留每个 item 的时间范围。
    if (originalTokens.length === newTokens.length) {
      let offset = 0;
      items.forEach((item, index) => {
        const length = spans[index].end - spans[index].start;
        item.text = newTokens.slice(offset, offset + length).join('');
        offset += length;
      });
      return { status: 'full', items, preservedItems: items.length, affectedItems: 0 };
    }

    const opcodes = timedTextDiffOpcodes(originalTokens, newTokens);
    if (!opcodes) {
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }
    const unchanged = opcodes.reduce((total, opcode) => (
      opcode.tag === 'equal' ? total + opcode.sourceEnd - opcode.sourceStart : total
    ), 0);
    const comparableLength = Math.max(1, Math.min(originalTokens.length, newTokens.length));
    const changedOriginal = originalTokens.length - unchanged;
    const changedTarget = newTokens.length - unchanged;
    const sourceFullyAnchored = unchanged === originalTokens.length;
    if (
      unchanged === 0
      || (!sourceFullyAnchored && unchanged < Math.max(1, Math.round(comparableLength * 0.25)))
      || (!sourceFullyAnchored && changedOriginal > originalTokens.length * 0.75)
      || (!sourceFullyAnchored && changedTarget > newTokens.length * 0.75)
    ) {
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }

    const affectedIndexes = new Set();
    const parentIndexes = Array.from({ length: items.length }, (_, index) => index);
    const findParent = (index) => {
      let root = index;
      while (parentIndexes[root] !== root) root = parentIndexes[root];
      while (parentIndexes[index] !== index) {
        const next = parentIndexes[index];
        parentIndexes[index] = root;
        index = next;
      }
      return root;
    };
    const unionItems = (left, right) => {
      const leftRoot = findParent(left);
      const rightRoot = findParent(right);
      if (leftRoot === rightRoot) return;
      parentIndexes[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
    };
    const indexesForSourceRange = (sourceStart, sourceEnd) => (
      sourceStart < sourceEnd
        ? spans
          .map((span, index) => ({ span, index }))
          .filter(({ span }) => span.end > sourceStart && span.start < sourceEnd)
          .map(({ index }) => index)
        : []
    );
    const insertionItemIndex = (position) => {
      if (position <= spans[0].start) return 0;
      const lastIndex = spans.length - 1;
      if (position >= spans[lastIndex].end) return lastIndex;
      for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index];
        if (span.start < position && position < span.end) return index;
        // 插入在 item 边界时归到前一个 item，避免无关的后一个 item 也被合并。
        if (position === span.start) return Math.max(0, index - 1);
      }
      return lastIndex;
    };
    opcodes.forEach((opcode) => {
      if (opcode.tag === 'equal') return;
      const indexes = indexesForSourceRange(opcode.sourceStart, opcode.sourceEnd);
      if (!indexes.length) {
        const index = insertionItemIndex(opcode.sourceStart);
        if (Number.isInteger(index)) indexes.push(index);
      }
      indexes.forEach((index) => affectedIndexes.add(index));
      for (let index = 1; index < indexes.length; index += 1) {
        unionItems(indexes[0], indexes[index]);
      }
    });
    if (!affectedIndexes.size) {
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }

    const componentsByRoot = new Map();
    affectedIndexes.forEach((index) => {
      const root = findParent(index);
      const component = componentsByRoot.get(root);
      if (component) {
        component.start = Math.min(component.start, index);
        component.end = Math.max(component.end, index);
      } else {
        componentsByRoot.set(root, { start: index, end: index });
      }
    });
    const components = [...componentsByRoot.values()];
    const componentIds = new Map();
    [...componentsByRoot.keys()].forEach((root, componentId) => {
      componentIds.set(root, componentId);
    });
    const itemOwnerKey = (index) => {
      const componentId = componentIds.get(findParent(index));
      return componentId === undefined ? `item:${index}` : `affected:${componentId}`;
    };

    const targetKeys = [];
    for (const opcode of opcodes) {
      if (opcode.tag === 'equal') {
        for (let sourceIndex = opcode.sourceStart; sourceIndex < opcode.sourceEnd; sourceIndex += 1) {
          const itemIndex = spans.findIndex((span) => span.start <= sourceIndex && sourceIndex < span.end);
          if (itemIndex < 0) {
            return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
          }
          targetKeys.push(itemOwnerKey(itemIndex));
        }
        continue;
      }
      if (opcode.targetStart >= opcode.targetEnd) continue;
      const indexes = indexesForSourceRange(opcode.sourceStart, opcode.sourceEnd);
      if (!indexes.length) {
        const index = insertionItemIndex(opcode.sourceStart);
        if (Number.isInteger(index)) indexes.push(index);
      }
      if (!indexes.length) {
        return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
      }
      const ownerKey = itemOwnerKey(indexes[0]);
      for (let targetIndex = opcode.targetStart; targetIndex < opcode.targetEnd; targetIndex += 1) {
        targetKeys.push(ownerKey);
      }
    }

    const runs = [];
    targetKeys.forEach((key, index) => {
      const previous = runs[runs.length - 1];
      if (previous?.key === key) previous.end = index + 1;
      else runs.push({ key, start: index, end: index + 1 });
    });
    const usedKeys = new Set();
    const reconciled = [];
    for (const run of runs) {
      if (usedKeys.has(run.key)) {
        return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
      }
      usedKeys.add(run.key);
      const text = newTokens.slice(run.start, run.end).join('');
      if (!text) continue;
      let item;
      if (run.key.startsWith('item:')) {
        item = cloneJsonValue(items[Number(run.key.slice(5))]);
      } else {
        const component = components[Number(run.key.slice(9))];
        item = cloneJsonValue(items[component.start]);
        item.start = items[component.start].start;
        item.end = items[component.end].end;
      }
      item.text = text;
      reconciled.push(item);
    }
    if (reconciled.length && reconciled.map((item) => item.text).join('') === newText) {
      return {
        status: 'partial',
        items: reconciled,
        preservedItems: reconciled.length,
        affectedItems: affectedIndexes.size,
      };
    }
    return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
  }


  function buildTimedTextEditReportFixed(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    const valid = source.length === texts.length;
    const boundaryPlan = buildTimedTextBoundaryPlan(source, texts);
    const rows = source.map((segment, index) => {
      const before = String(segment?.text == null ? '' : segment.text);
      const after = String(texts[index] == null ? '' : texts[index]);
      const diff = buildTimedTextDiff(before, after);
      const boundary = boundaryPlan.updates[index];
      const mapping = boundary
        ? {
          status: 'boundary',
          items: boundary.items,
          preservedItems: boundary.items.length,
          affectedItems: boundary.items.length,
        }
        : reconcileTimedTextItems(before, segment?.items, after);
      const afterStart = boundary ? boundary.start : Number(segment?.start);
      const afterEnd = boundary ? boundary.end : Number(segment?.end);
      const coverage = timedTextItemCoverage(after, mapping.items);
      const reuse = timedTextItemReuse(
        before, segment?.items, after, mapping.items, mapping.status,
      );
      return {
        index,
        before,
        after,
        changed: before !== after,
        deleted: Boolean(before.trim() && !after.trim()),
        diff,
        mappingStatus: mapping.status,
        beforeItemCount: Array.isArray(segment?.items) ? segment.items.length : 0,
        afterItemCount: mapping.items?.length || 0,
        preservedItems: mapping.preservedItems,
        affectedItems: mapping.affectedItems,
        items: mapping.items,
        itemCoverage: coverage.percent,
        itemCoverageData: coverage,
        itemReuse: reuse.percent,
        itemReuseData: reuse,
        beforeStart: Number(segment?.start),
        beforeEnd: Number(segment?.end),
        afterStart,
        afterEnd,
        timingChanged: afterStart !== Number(segment?.start) || afterEnd !== Number(segment?.end),
      };
    });
    const changedRows = rows.filter((row) => row.changed);
    const stats = {
      totalSegments: source.length,
      changedSegments: changedRows.length,
      unchangedSegments: rows.length - changedRows.length,
      beforeCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.before).length, 0),
      afterCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.after).length, 0),
      addedCharacters: changedRows.reduce((sum, row) => sum + row.diff.addedCharacters, 0),
      removedCharacters: changedRows.reduce((sum, row) => sum + row.diff.removedCharacters, 0),
      fullMappedCues: changedRows.filter((row) => row.mappingStatus === 'full').length,
      partialMappedCues: changedRows.filter((row) => row.mappingStatus === 'partial').length,
      lostMappedCues: changedRows.filter((row) => row.mappingStatus === 'lost').length,
      unavailableMappedCues: changedRows.filter((row) => row.mappingStatus === 'unavailable').length,
      boundaryMappedCues: changedRows.filter((row) => row.mappingStatus === 'boundary').length,
      boundaryMoves: boundaryPlan.transfers.length,
      timingChangedCues: rows.filter((row) => row.timingChanged).length,
      preservedItems: changedRows.reduce((sum, row) => sum + row.preservedItems, 0),
      affectedItems: changedRows.reduce((sum, row) => sum + row.affectedItems, 0),
    };
    return { valid, rows, changedRows, stats, boundaryMoves: boundaryPlan.transfers };
  }


  function timedTextStructureSourceSlice(source, range) {
    const sourceSegments = Array.isArray(source) ? source : [];
    const requestedStart = Math.max(0, Math.round(Number(range?.start) || 0));
    const requestedEnd = Math.max(requestedStart, Math.round(Number(range?.end) || 0));
    const textParts = [];
    const items = [];
    let offset = 0;
    sourceSegments.forEach((segment) => {
      const tokens = timedTextTokens(segment?.text);
      const sourceStart = offset;
      const sourceEnd = offset + tokens.length;
      offset = sourceEnd;
      const localStart = Math.max(0, requestedStart - sourceStart);
      const localEnd = Math.min(tokens.length, requestedEnd - sourceStart);
      if (localStart >= localEnd) return;
      textParts.push(tokens.slice(localStart, localEnd).join(''));
      const layout = timedTextItemLayout(segment?.text, segment?.items);
      if (layout) {
        const sliced = timedTextItemsSlice(layout, localStart, localEnd);
        if (sliced) items.push(...sliced);
      }
    });
    return { text: textParts.join(''), items };
  }


  function buildTimedTextStructureReport(source, texts, plan) {
    const outputRows = plan.segments.map((output, outputIndex) => {
      const meta = plan.outputMeta[outputIndex] || { sourceIndexes: [], range: null };
      const sourceSlice = timedTextStructureSourceSlice(source, meta.range);
      const sourceIndexes = Array.isArray(meta.sourceIndexes) ? meta.sourceIndexes : [];
      const structural = sourceIndexes.some((index) => plan.affectedSourceIndexes.includes(index))
        || sourceIndexes.length !== 1;
      // 结构拆分时，每个输出行只对应原字幕的一段时间范围，但“修改前”
      // 应该展示用户实际拆分的整条原字幕，而不是展示与“修改后”相同的切片。
      // 例如「超高速摄影机」拆成「超高速」/「摄影机」时，两行都以整句为 before。
      const fullSourceText = sourceIndexes
        .map((index) => String(source[index]?.text == null ? '' : source[index].text))
        .join('');
      const before = structural && fullSourceText ? fullSourceText : sourceSlice.text;
      const after = String(output?.text || '');
      const mappingStatus = structural
        ? 'structure'
        : reconcileTimedTextItems(before, sourceSlice.items, after).status;
      const coverage = timedTextItemCoverage(after, output?.items);
      const reuse = timedTextItemReuse(
        before,
        sourceSlice.items,
        after,
        output?.items,
        before === after ? 'full' : mappingStatus,
      );
      return {
        index: outputIndex,
        draftIndex: meta.draftIndex,
        sourceIndexes,
        before,
        after,
        changed: before !== after || structural,
        deleted: false,
        structureChanged: structural,
        diff: buildTimedTextDiff(before, after),
        mappingStatus,
        beforeItemCount: sourceSlice.items.length,
        afterItemCount: Array.isArray(output?.items) ? output.items.length : 0,
        preservedItems: Array.isArray(output?.items) ? output.items.length : 0,
        affectedItems: Array.isArray(output?.items) ? output.items.length : 0,
        items: output?.items,
        itemCoverage: coverage.percent,
        itemCoverageData: coverage,
        itemReuse: reuse.percent,
        itemReuseData: reuse,
        beforeStart: sourceSlice.items[0]?.start ?? Number(output?.start),
        beforeEnd: sourceSlice.items[sourceSlice.items.length - 1]?.end ?? Number(output?.end),
        afterStart: Number(output?.start),
        afterEnd: Number(output?.end),
        timingChanged: structural,
        timingEstimated: meta.timingEstimated === true,
      };
    });
    const rows = source.map((segment, index) => {
      const outputIndexes = plan.sourceOutputIndexes[index] || [];
      const outputs = outputIndexes.map((outputIndex) => plan.segments[outputIndex]).filter(Boolean);
      const before = String(segment?.text == null ? '' : segment.text);
      const after = outputs.map((output) => String(output?.text || '')).join('');
      const affected = plan.affectedSourceIndexes.includes(index);
      const diff = buildTimedTextDiff(before, after);
      const items = outputs.flatMap((output) => Array.isArray(output?.items) ? output.items : []);
      const mappingStatus = affected ? 'structure' : reconcileTimedTextItems(before, segment?.items, after).status;
      const coverage = timedTextItemCoverage(after, items);
      const reuse = timedTextItemReuse(
        before, segment?.items, after, items, mappingStatus,
      );
      const firstOutput = outputs[0];
      const lastOutput = outputs[outputs.length - 1];
      const afterStart = firstOutput ? Number(firstOutput.start) : Number(segment?.start);
      const afterEnd = lastOutput ? Number(lastOutput.end) : Number(segment?.end);
      return {
        index,
        before,
        after,
        displayAfter: outputs.map((output) => String(output?.text || '')).join('\n'),
        changed: before !== after || affected,
        deleted: Boolean(before.trim() && !after.trim()),
        structureChanged: affected,
        diff,
        mappingStatus,
        beforeItemCount: Array.isArray(segment?.items) ? segment.items.length : 0,
        afterItemCount: items.length,
        preservedItems: items.length,
        affectedItems: items.length,
        items,
        itemCoverage: coverage.percent,
        itemCoverageData: coverage,
        itemReuse: reuse.percent,
        itemReuseData: reuse,
        beforeStart: Number(segment?.start),
        beforeEnd: Number(segment?.end),
        afterStart,
        afterEnd,
        timingChanged: affected
          || afterStart !== Number(segment?.start) || afterEnd !== Number(segment?.end),
      };
    });
    const changedRows = rows.filter((row) => row.changed);
    const stats = {
      ...buildTimedTextEditReportFixed(source, source.map((segment) => segment?.text || '')).stats,
      totalSegments: source.length,
      changedSegments: changedRows.length,
      unchangedSegments: rows.length - changedRows.length,
      beforeCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.before).length, 0),
      afterCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.after).length, 0),
      addedCharacters: changedRows.reduce((sum, row) => sum + row.diff.addedCharacters, 0),
      removedCharacters: changedRows.reduce((sum, row) => sum + row.diff.removedCharacters, 0),
      fullMappedCues: changedRows.filter((row) => row.mappingStatus === 'full').length,
      partialMappedCues: changedRows.filter((row) => row.mappingStatus === 'partial').length,
      lostMappedCues: changedRows.filter((row) => row.mappingStatus === 'lost').length,
      unavailableMappedCues: changedRows.filter((row) => row.mappingStatus === 'unavailable').length,
      boundaryMappedCues: 0,
      boundaryMoves: 0,
      timingChangedCues: rows.filter((row) => row.timingChanged).length,
      preservedItems: changedRows.reduce((sum, row) => sum + row.preservedItems, 0),
      affectedItems: changedRows.reduce((sum, row) => sum + row.affectedItems, 0),
      structureMappedCues: changedRows.filter((row) => row.mappingStatus === 'structure').length,
      estimatedTimingCues: outputRows.filter((row) => row.timingEstimated).length,
    };
    return {
      valid: true,
      rows,
      changedRows,
      stats,
      boundaryMoves: [],
      structure: plan,
      previewSegments: plan.segments,
      outputRows,
    };
  }


  function buildTimedTextEditReport(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (timedTextStructureRequested(source, texts)) {
      const plan = buildTimedTextStructurePlan(source, texts);
      if (plan.valid) return buildTimedTextStructureReport(source, texts, plan);
      return {
        ...buildTimedTextEditReportFixed(source, texts),
        structure: plan,
        previewSegments: [],
      };
    }
    return buildTimedTextEditReportFixed(source, texts);
  }


  function timedTextEditComparableSegment(segment) {
    const comparable = cloneJsonValue(segment || {});
    if (comparable && typeof comparable === 'object') delete comparable._dirty;
    return comparable;
  }


  function timedTextEditSegmentsEquivalent(sourceSegment, outputSegment) {
    return JSON.stringify(timedTextEditComparableSegment(sourceSegment))
      === JSON.stringify(timedTextEditComparableSegment(outputSegment));
  }


  // 结构编辑会返回一组新的 segments，但不能因此把所有输出行都标成 dirty。
  // 只有内容/时间范围/结构确实发生变化的输出，或来自本来就 dirty 的来源行，
  // 才应继续显示 dirty；原样保留的一对一字幕沿用来源行的 dirty 状态。
  function timedTextEditDirtyFlags(sourceSegments, nextSegments, report) {
    const source = Array.isArray(sourceSegments) ? sourceSegments : [];
    const next = Array.isArray(nextSegments) ? nextSegments : [];
    const structure = report?.structure?.valid === true ? report.structure : null;
    if (!structure) {
      return next.map((segment, index) => {
        const sourceSegment = source[index];
        const row = report?.rows?.[index];
        if (!sourceSegment || row?.changed || row?.timingChanged) return true;
        return sourceSegment._dirty === true;
      });
    }

    const affectedSourceIndexes = new Set(structure.affectedSourceIndexes || []);
    const sourceOutputIndexes = Array.isArray(structure.sourceOutputIndexes)
      ? structure.sourceOutputIndexes : [];
    return next.map((segment, outputIndex) => {
      const meta = structure.outputMeta?.[outputIndex];
      const sourceIndexes = Array.isArray(meta?.sourceIndexes) ? meta.sourceIndexes : [];
      const sourceIndex = sourceIndexes.length === 1 ? sourceIndexes[0] : -1;
      const sourceSegment = sourceIndex >= 0 ? source[sourceIndex] : null;
      const outputIndexes = sourceIndex >= 0 ? sourceOutputIndexes[sourceIndex] || [] : [];
      const unchanged = Boolean(sourceSegment)
        && sourceIndexes.length === 1
        && outputIndexes.length === 1
        && outputIndexes[0] === outputIndex
        && !affectedSourceIndexes.has(sourceIndex)
        && timedTextEditSegmentsEquivalent(sourceSegment, segment);
      return unchanged ? sourceSegment._dirty === true : true;
    });
  }


  function applyTimedTextEdit(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (timedTextStructureRequested(source, texts)) {
      const structurePlan = buildTimedTextStructurePlan(source, texts);
      return structurePlan.valid ? cloneJsonValue(structurePlan.segments) : null;
    }
    if (source.length !== texts.length) return null;
    const boundaryPlan = buildTimedTextBoundaryPlan(source, texts);
    return source.flatMap((segment, index) => {
      const next = cloneJsonValue(segment || {});
      const before = String(next.text == null ? '' : next.text);
      const after = String(texts[index] == null ? '' : texts[index]);
      if (before === after) return next;
      if (!after) return [];
      const boundary = boundaryPlan.updates[index];
      if (boundary) {
        next.text = after;
        next.start = boundary.start;
        next.end = boundary.end;
        if (boundary.items.length) next.items = cloneJsonValue(boundary.items);
        else delete next.items;
        return next;
      }
      const mapping = reconcileTimedTextItems(before, next.items, after);
      next.text = after;
      if (mapping.status === 'full' || mapping.status === 'partial') next.items = mapping.items;
      else if (mapping.status === 'lost') delete next.items;
      return next;
    });
  }

  return Object.freeze({ applyTimedTextEdit, buildTimedTextEditReport, timedTextEditDirtyFlags });
});
