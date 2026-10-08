// 通用 Marker / Region 编辑：全部数据变更收敛在这里。
// 波形轨道与「标记与区段」管理窗都只调用本模块；撤销/重做（markers 历史
// kind）、保存脏标记与视图刷新统一走 commitMarkerChange 一个入口，
// 保证拖动、面板编辑、撤销恢复三条路径行为一致。
(function initMaweMarkerEditing(global) {
  'use strict';



  function markerUtils() {
    return window.AsrEditorUtils;
  }

  // DATA.markers 始终是规范化数组；旧工程/异常输入也在这里兜底。
  function markerList() {
    if (!Array.isArray(MaweBoot.DATA.markers)) MaweBoot.DATA.markers = [];
    return MaweBoot.DATA.markers;
  }

  function getMarkers() {
    return Array.isArray(MaweBoot.DATA.markers) ? MaweBoot.DATA.markers : [];
  }

  function findMarker(markerId) {
    return getMarkers().find((marker) => marker?.id === markerId) || null;
  }

  function formatMarkerSeconds(ms) {
    return `${(Number(ms || 0) / 1000).toFixed(3)}s`;
  }

  function refreshWaveformMarkers() {
    MaweCoreState.waveformEditor?.refreshMarkerOverlay?.();
  }


  // 统一变更入口：克隆 → mutate → 规范化 → 推撤销（变更前快照）→ 标脏 → 刷新。
  // mutate 返回 false 表示放弃本次变更（不进历史、不标脏）。
  function commitMarkerChange(label, mutate) {
    const utils = markerUtils();
    const before = utils.cloneMarkerValue(markerList());
    const list = utils.cloneMarkerValue(before);
    if (mutate(list) === false) return null;
    MaweBoot.DATA.markers = utils.normalizeMarkers(list);
    MaweHistory.pushMarkersUndo(label, before);
    MaweState.changes.markersDirty = true;
    refreshWaveformMarkers();
    global.MaweMarkersPanel?.render?.();
    MaweViewUpdates.invalidate({ save: true });
    return getMarkers();
  }



  function addMarkerAt(startMs, { name = '', color = null } = {}) {
    const utils = markerUtils();
    const start = Math.max(0, Math.round(Number(startMs)));
    if (!Number.isFinite(start)) return null;
    commitMarkerChange('添加标记', (list) => {
      list.push({
        id: utils.nextMarkerId(list),
        start,
        name: typeof name === 'string' ? name : '',
        color: color || utils.MARKER_DEFAULT_COLOR,
        note: '',
      });
    });
    MaweHint.flashHint(`已在 ${formatMarkerSeconds(start)} 添加标记`, 'success');
    return getMarkers();
  }


  function addMarkerAtCurrentTime() {
    const player = MaweCoreState.player;
    const currentMs = Number(player?.currentTime) * 1000;
    if (!Number.isFinite(currentMs) || currentMs < 0) {
      MaweHint.flashHint('媒体尚未就绪，无法在播放头添加标记', 'warning');
      return null;
    }
    return addMarkerAt(currentMs);
  }


  function createMarkerRegion(startMs, endMs) {
    const utils = markerUtils();
    const start = Math.max(0, Math.round(Number(startMs)));
    const end = Math.round(Number(endMs));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end <= start) return addMarkerAt(start);
    commitMarkerChange('添加区段', (list) => {
      list.push({
        id: utils.nextMarkerId(list),
        start,
        end,
        name: '',
        color: utils.MARKER_DEFAULT_COLOR,
        note: '',
      });
    });
    MaweHint.flashHint(`已添加区段 ${formatMarkerSeconds(start)} → ${formatMarkerSeconds(end)}`, 'success');
    return getMarkers();
  }


  function moveMarker(markerId, deltaMs) {
    const marker = findMarker(markerId);
    const delta = Math.round(Number(deltaMs));
    if (!marker || !Number.isFinite(delta) || delta === 0) return null;
    const durationMs = MaweCoreState.waveformEditor?.durationMs || 0;
    const start = Math.max(0, Math.min(Math.round(marker.start) + delta, Math.max(0, Math.round(durationMs) - 1)));
    commitMarkerChange('移动标记', (list) => {
      const target = list.find((item) => item.id === markerId);
      if (!target) return false;
      target.start = start;
      if (target.end != null) target.end = start + (marker.end - marker.start);
    });
    return getMarkers();
  }


  function resizeMarker(markerId, edge, valueMs) {
    const marker = findMarker(markerId);
    const value = Math.max(0, Math.round(Number(valueMs)));
    if (!marker || (edge !== 'start' && edge !== 'end') || !Number.isFinite(value)) return null;
    commitMarkerChange('调整标记边界', (list) => {
      const target = list.find((item) => item.id === markerId);
      if (!target) return false;
      target[edge] = value;
      // end <= start 时由 normalizeMarkers 收敛为单点标记。
    });
    return getMarkers();
  }


  // 管理窗 / 波形浮层字段编辑：name/color/note/start/end/review 任意子集。
  // end 传 null 表示移除区段终点（退化为单点标记）；
  // review 传 null 表示清除复核状态（普通标记），'pending' / 'confirmed' 设置
  // 对应状态并保留原 reason（AI 复核原因不因切换状态而丢失）。
  function updateMarkerFields(markerId, fields = {}) {
    const marker = findMarker(markerId);
    if (!marker) return null;
    commitMarkerChange('编辑标记', (list) => {
      const target = list.find((item) => item.id === markerId);
      if (!target) return false;
      if (typeof fields.name === 'string') target.name = fields.name;
      if (typeof fields.note === 'string') target.note = fields.note;
      if (typeof fields.color === 'string') target.color = markerUtils().normalizeMarkerColor(fields.color);
      if (fields.start != null) {
        const start = Math.max(0, Math.round(Number(fields.start)));
        if (Number.isFinite(start)) target.start = start;
      }
      if (fields.end === null) {
        delete target.end;
      } else if (fields.end != null) {
        const end = Math.round(Number(fields.end));
        if (Number.isFinite(end) && end > 0) target.end = end;
      }
      if (fields.review !== undefined) {
        if (fields.review === null) {
          delete target.review;
        } else if (fields.review === 'pending' || fields.review === 'confirmed') {
          const reason = typeof target.review?.reason === 'string' ? target.review.reason : '';
          target.review = { status: fields.review, reason };
        }
      }
    });
    return getMarkers();
  }


  function deleteMarker(markerId) {
    const marker = findMarker(markerId);
    if (!marker) return null;
    commitMarkerChange('删除标记', (list) => {
      const index = list.findIndex((item) => item.id === markerId);
      if (index < 0) return false;
      list.splice(index, 1);
    });
    MaweHint.flashHint(`已删除${marker.end ? '区段' : '标记'}「${marker.name || marker.id}」`, 'success');
    return getMarkers();
  }


  function deleteMarkers(markerIds) {
    const ids = new Set(Array.isArray(markerIds) ? markerIds : []);
    const count = getMarkers().filter((marker) => ids.has(marker.id)).length;
    if (!count) return null;
    commitMarkerChange('批量删除标记与区段', (list) => {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (ids.has(list[index].id)) list.splice(index, 1);
      }
    });
    MaweHint.flashHint(`已删除 ${count} 项标记与区段`, 'success');
    return getMarkers();
  }


  // 定位：跳转播放头到标记位置（区段取起点），跟随播放逻辑滚动波形；
  // play: true 时跳转后立即播放（「定位试听」按钮），列表项 / 波形点击仍只跳转。
  function locateMarker(markerId, { play = false } = {}) {
    const marker = findMarker(markerId);
    if (!marker) return false;
    const player = MaweCoreState.player;
    if (player && Number.isFinite(Number(player.currentTime))) {
      player.currentTime = marker.start / 1000;
    }
    if (play && player?.paused) {
      const promise = player.play?.();
      promise?.catch?.(() => {});
    }
    MaweCoreState.waveformEditor?.updatePlayback?.();
    return true;
  }


  // 历史恢复 / 工程载入后的被动刷新：不推历史、不标脏。
  function afterExternalMarkersChange() {
    markerList();
    refreshWaveformMarkers();
    global.MaweMarkersPanel?.render?.();
  }


  function pendingReviewCount() {
    return markerUtils().countPendingReviewMarkers(getMarkers());
  }



  global.MaweMarkerEditing = Object.freeze({
    getMarkers,
    findMarker,
    addMarkerAt,
    addMarkerAtCurrentTime,
    createMarkerRegion,
    moveMarker,
    resizeMarker,
    updateMarkerFields,
    deleteMarker,
    deleteMarkers,
    locateMarker,
    afterExternalMarkersChange,
    pendingReviewCount,
  });
})(typeof window !== 'undefined' ? window : globalThis);
