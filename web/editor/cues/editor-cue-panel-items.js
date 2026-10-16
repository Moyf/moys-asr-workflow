// 纯字幕词块时间映射：编辑时间跨度时按比例映射词块，并保持边界合法。
// 独立于 cue panel UI，供面板编辑与多字幕核心共同使用。
export function remapPanelItems(items, oldStart, oldEnd, newStart, newEnd) {
  if (!Array.isArray(items) || !items.length) return items;
  const oldDuration = Math.max(1, oldEnd - oldStart);
  const newDuration = Math.max(1, newEnd - newStart);
  return items.map((item) => {
    // 等比缩放后钳回段内，并保证 end > start（防止取整后出现 0 长词块）。
    const mappedStart = Math.round(newStart + ((item.start - oldStart) / oldDuration) * newDuration);
    const mappedEnd = Math.round(newStart + ((item.end - oldStart) / oldDuration) * newDuration);
    let start = Math.min(Math.max(mappedStart, newStart), newEnd);
    const end = Math.min(Math.max(mappedEnd, start + 1), newEnd);
    if (end <= start) start = Math.max(newStart, end - 1);
    return { ...item, start, end };
  });
}
