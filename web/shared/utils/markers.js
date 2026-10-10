// markers: 通用 Marker / Region 数据规范化与过滤；依赖由 editor-utils.js 注入。
// MOSP `markers` 契约见 JSON_SCHEMA.md：稳定 ID、原媒体整数毫秒 start、
// 可选 end（end > start 时为 Region，否则单点 Marker）、name、color、note，
// 以及可选的 review（AI 复核项：待复核／已确认 + 原因）。
export function createUtilsModule() {
  'use strict';

  const MARKERS_SCHEMA = 'moy.asr.markers.v1';
  const MARKER_NAME_MAX_LENGTH = 120;
  const MARKER_NOTE_MAX_LENGTH = 500;
  const MARKER_REVIEW_REASON_MAX_LENGTH = 300;
  const MARKER_DEFAULT_COLOR = '#3e63dd';
  // 预设色板（管理窗改色与 AI 复核默认色共用）：对齐达芬奇 Resolve 的 marker
  // 八种常用预设：蓝/青/绿/橘黄/红/粉/淡紫/白；其他 HEX 色值仍可自定义。
  // 默认色与 Resolve 的 Blue 对齐，OTIO 导出按最近色相归并。
  const MARKER_PRESET_COLORS = Object.freeze([
    '#3e63dd', '#00a2c7', '#46a758', '#f5b81b', '#e5484d', '#ef5da8', '#b18be8', '#ffffff',
  ]);
  // 预设色的中文显示名（过滤下拉 / 色板提示用）；非预设色返回空串，调用方回退显示色值。
  const MARKER_PRESET_COLOR_LABELS = Object.freeze({
    '#3e63dd': '蓝',
    '#00a2c7': '青',
    '#46a758': '绿',
    '#f5b81b': '黄',
    '#e5484d': '红',
    '#ef5da8': '粉',
    '#b18be8': '淡紫',
    '#ffffff': '白',
  });
  const MARKER_REVIEW_COLOR = '#f5a623';
  const MARKER_REVIEW_STATUSES = Object.freeze(['pending', 'confirmed']);
  const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

  function markerPresetColorLabel(value) {
    if (typeof value !== 'string') return '';
    return MARKER_PRESET_COLOR_LABELS[value.trim().toLowerCase()] || '';
  }

  // 复核三态循环：无（无 review 字段）→ 待复核 → 已确认 → 无。
  function nextMarkerReviewStatus(marker) {
    return marker?.review?.status === 'pending'
      ? 'confirmed'
      : marker?.review?.status === 'confirmed' ? null : 'pending';
  }

  function markerReviewStatusLabel(marker) {
    if (marker?.review?.status === 'pending') return '待复核';
    if (marker?.review?.status === 'confirmed') return '已确认';
    return '无';
  }

  function cloneMarkerValue(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value ?? null));
  }

  function normalizeMarkerColor(value, fallback = MARKER_DEFAULT_COLOR) {
    return typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim())
      ? value.trim().toLowerCase()
      : fallback;
  }

  // Region = 存在合法的 end > start；其余（包括非法 end）都是单点 Marker。
  function markerKind(marker) {
    const start = Number(marker?.start);
    const end = Number(marker?.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? 'region' : 'marker';
  }

  function isRegionMarker(marker) {
    return markerKind(marker) === 'region';
  }

  function isPendingReviewMarker(marker) {
    return marker?.review?.status === 'pending';
  }

  function countPendingReviewMarkers(markers) {
    return (Array.isArray(markers) ? markers : []).reduce(
      (count, marker) => count + (isPendingReviewMarker(marker) ? 1 : 0), 0,
    );
  }

  function normalizeReviewField(value) {
    if (!value || typeof value !== 'object') return null;
    const status = MARKER_REVIEW_STATUSES.includes(value.status) ? value.status : 'pending';
    const reason = typeof value.reason === 'string'
      ? normalizeMarkerText(value.reason, MARKER_REVIEW_REASON_MAX_LENGTH) : '';
    return { status, reason };
  }

  function normalizeMarkerText(value, maxLength) {
    if (typeof value !== 'string') return '';
    // 去掉控制字符后截断，保证 UI 与文件读写稳定。
    return value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, maxLength);
  }

  function normalizeIntMs(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
  }

  // 与字幕稳定 ID 同思路：缺失 / 重复 / 非法 ID 用 marker-001 起的确定性序号补齐。
  function nextMarkerId(markers) {
    const used = new Set((Array.isArray(markers) ? markers : [])
      .map((marker) => (typeof marker?.id === 'string' ? marker.id : '')).filter(Boolean));
    let index = 1;
    while (used.has(`marker-${String(index).padStart(3, '0')}`)) index += 1;
    return `marker-${String(index).padStart(3, '0')}`;
  }

  function normalizeMarkerItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const start = normalizeIntMs(raw.start);
    if (start === null) return null;
    const end = normalizeIntMs(raw.end);
    const marker = {
      // ID 合法性（缺失 / 重复）在 normalizeMarkers 统一按时间序处理。
      id: typeof raw.id === 'string' ? raw.id.trim() : '',
      start,
      name: normalizeMarkerText(raw.name, MARKER_NAME_MAX_LENGTH),
      color: normalizeMarkerColor(raw.color),
      note: normalizeMarkerText(raw.note, MARKER_NOTE_MAX_LENGTH),
    };
    if (end !== null && end > start) marker.end = end;
    const review = normalizeReviewField(raw.review);
    if (review) marker.review = review;
    return marker;
  }

  // 接受裸数组 / { items: [...] } / { markers: [...] }，统一返回规范化的数组。
  // 空输入返回 []；非法项直接丢弃，不抛错。
  function normalizeMarkers(value) {
    let items = null;
    if (Array.isArray(value)) items = value;
    else if (value && typeof value === 'object' && Array.isArray(value.items)) items = value.items;
    if (!items) return [];
    // 先按 start + 原 index 排成稳定时间序，再补齐 / 去重 ID：
    // marker-001 永远是时间上最早的标记，重排不改变 ID 归属。
    const markers = [];
    for (const raw of items) {
      const marker = normalizeMarkerItem(raw);
      if (marker) markers.push(marker);
    }
    markers.forEach((marker, index) => { marker._inputIndex = index; });
    markers.sort((a, b) => a.start - b.start || a._inputIndex - b._inputIndex);
    const usedIds = new Set();
    for (const marker of markers) {
      if (!marker.id || usedIds.has(marker.id)) {
        marker.id = nextMarkerId(markers);
      }
      usedIds.add(marker.id);
      delete marker._inputIndex;
    }
    return markers;
  }

  function markersToProjectField(markers) {
    const normalized = normalizeMarkers(markers);
    if (!normalized.length) return null;
    return { schema: MARKERS_SCHEMA, items: normalized };
  }

  // 管理窗过滤：query 匹配名称与备注（大小写不敏感）；
  // kind: all|marker|region；color: all|#hex；review: all|pending|confirmed|plain（普通标记）。
  function markerMatchesFilter(marker, filter = {}) {
    if (!marker) return false;
    const { query = '', kind = 'all', color = 'all', review = 'all' } = filter || {};
    if (kind !== 'all' && markerKind(marker) !== kind) return false;
    if (color !== 'all' && normalizeMarkerColor(marker.color) !== normalizeMarkerColor(color)) return false;
    if (review === 'pending' && marker.review?.status !== 'pending') return false;
    if (review === 'confirmed' && marker.review?.status !== 'confirmed') return false;
    if (review === 'plain' && marker.review) return false;
    if (query) {
      const haystack = `${marker.name || ''}\n${marker.note || ''}`.toLowerCase();
      if (!haystack.includes(query.toLowerCase())) return false;
    }
    return true;
  }

  function filterMarkers(markers, filter) {
    return (Array.isArray(markers) ? markers : []).filter((marker) => markerMatchesFilter(marker, filter));
  }

  function markerSummary(markers) {
    const list = Array.isArray(markers) ? markers : [];
    return {
      total: list.length,
      markers: list.filter((marker) => markerKind(marker) === 'marker').length,
      regions: list.filter((marker) => markerKind(marker) === 'region').length,
      pending: countPendingReviewMarkers(list),
    };
  }

  // 标记与某行 [rowStartMs, rowEndMs) 的可见交集；无交集返回 null。
  // 单点 Marker 呈现为从 start 起 1ms 的可见最小宽度由渲染层处理。
  function markerVisibleRange(marker, rowStartMs, rowEndMs) {
    const start = Number(marker?.start);
    if (!Number.isFinite(start)) return null;
    const isRegion = markerKind(marker) === 'region';
    const end = isRegion ? Number(marker.end) : Math.min(start + 1, rowEndMs);
    const visibleStart = Math.max(start, rowStartMs);
    const visibleEnd = Math.min(end, rowEndMs);
    if (visibleEnd <= visibleStart) return null;
    return { start: visibleStart, end: visibleEnd };
  }

  // 单点 / 区段在像素层保证的最小可见宽度百分比（避免高缩放下完全消失）；
  // 单点 Marker 更宽一些，便于点中查看。
  const MARKER_MIN_VISIBLE_PERCENT = 0.25;
  const MARKER_POINT_MIN_VISIBLE_PERCENT = 0.5;

  return Object.freeze({
    MARKERS_SCHEMA,
    MARKER_POINT_MIN_VISIBLE_PERCENT,
    MARKER_DEFAULT_COLOR,
    MARKER_PRESET_COLORS,
    MARKER_PRESET_COLOR_LABELS,
    MARKER_REVIEW_COLOR,
    MARKER_REVIEW_STATUSES,
    MARKER_NAME_MAX_LENGTH,
    MARKER_NOTE_MAX_LENGTH,
    MARKER_REVIEW_REASON_MAX_LENGTH,
    MARKER_MIN_VISIBLE_PERCENT,
    markerPresetColorLabel,
    markerReviewStatusLabel,
    nextMarkerReviewStatus,
    cloneMarkerValue,
    normalizeMarkerColor,
    normalizeMarkerItem,
    normalizeMarkers,
    markersToProjectField,
    nextMarkerId,
    markerKind,
    isRegionMarker,
    isPendingReviewMarker,
    countPendingReviewMarkers,
    markerMatchesFilter,
    filterMarkers,
    markerSummary,
    markerVisibleRange,
  });
}
