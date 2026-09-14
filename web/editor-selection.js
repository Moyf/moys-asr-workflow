// 选择状态：主/副选中集、点击锚点与多选类刷新。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSelection 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweSelection(global) {
  'use strict';



  //   1) sticker.rel + STICKER_ROOT  - 拼出服务器或 file:// URL
  //   2) sticker.path  - 兼容老版工程
  function stickerUrl(sticker) {
    if (!sticker) return '';
    if (sticker.rel) {
      if (MaweBoot.STICKER_URL_PREFIX) {
        const url = `${MaweBoot.STICKER_URL_PREFIX.replace(/\/$/, '')}/${sticker.rel.split('/').map(encodeURIComponent).join('/')}`;
        return MaweStickerOverlay.stickerAssetRevision ? `${url}?root=${MaweStickerOverlay.stickerAssetRevision}` : url;
      }
      if (!MaweBoot.STICKER_ROOT) return sticker.rel;
      let root = MaweBoot.STICKER_ROOT;
      if (root.startsWith('file://')) return root.replace(/\/+$/, '') + '/' + sticker.rel;
      let prefix = root.startsWith('/') ? 'file://' : 'file:///';
      return prefix + root.replace(/\/+$/, '') + '/' + sticker.rel;
    }
    if (sticker.path) return sticker.path;
    return '';
  }



  // 合成表情包文件的操作系统绝对路径（用于导出表情包 OTIO）。
  function stickerAbsPath(sticker) {
    if (!sticker) return '';
    if (sticker.rel && MaweBoot.STICKER_ROOT) {
      // 去掉可能的 file:// 前缀，保留纯 OS 路径
      let root = MaweBoot.STICKER_ROOT.replace(/^file:\/+/, '');
      // POSIX: 重新加上前导 /
      if (MaweBoot.STICKER_ROOT.startsWith('file:///') && !root.startsWith('/') && !/^[A-Za-z]:/.test(root)) {
        root = '/' + root;
      }
      return root.replace(/\/+$/, '') + '/' + sticker.rel;
    }
    return sticker.path || '';
  }


  const selectedIdxs = new Set();


  const selectedExtensionIdxs = new Set();


  let lastClickedIdx = -1;

    // 用于 Shift+click 范围选
  let lastClickedExtensionIdx = -1;


  // “仅看超长”开启时，刚拆出的字幕临时绕过字数过滤；使用稳定 ID，避免 splice 后下标错位。
  const temporaryVisibleSplitCueKeys = new Set();


  // 右键选择「绑定到主字幕」后的等待状态。使用稳定 ID 而不是数组下标，
  // 这样等待期间即使列表重绘，也不会把另一条副字幕误绑定过去。
  let pendingExtensionBinding = null;


  // 隐藏开关开启时，禁用项视为"不可选"（Shift 范围选 / Ctrl 切换都跳过）
  function isHiddenDisabled(idx, track = 'main') {
    const segments = track === 'extension'
      ? (MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [])
      : (track?.segments || MaweBoot.DATA.segments);
    return MaweDom.hideDisabled && !!(segments[idx] && segments[idx].disabled);
  }



  function cancelPendingExtensionBinding(message = '已取消绑定副字幕') {
    if (!pendingExtensionBinding) return false;
    pendingExtensionBinding = null;
    MaweHint.flashHint(message);
    return true;
  }



  function clearSelection({ silent = false, commitCuePanel = true } = {}) {
    MaweNavPreview.hideCueSplitPreview();
    cancelPendingExtensionBinding();
    selectedIdxs.forEach(i => {
      const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
      if (el) el.classList.remove('selected');
    });
    selectedIdxs.clear();
    selectedExtensionIdxs.forEach((index) => {
      MaweCoreState.container.querySelectorAll(`.multi-cue[data-ext-idx="${index}"], .multi-dual-cue[data-ext-idx="${index}"]`)
        .forEach((el) => el.classList.remove('selected'));
    });
    selectedExtensionIdxs.clear();
    MaweDom.selCountEl.textContent = '0';
    if (silent) {
      // 结构编辑会马上 renderAll() 并重新选中目标；此时不必先刷新旧波形
      // 覆盖层和空面板，避免同一次操作产生两轮视觉更新。
      MaweCuePanelState.currentCuePanelIdx = -1;
      MaweCuePanelState.resetCuePanelEditState();
      return;
    }
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
    if (commitCuePanel) {
      MaweCuePanel.setCurrentCuePanelIndex(-1);
    } else {
      MaweCuePanelState.currentCuePanelKind = 'main';
      MaweCuePanelState.currentCuePanelIdx = -1;
      MaweCuePanelState.currentCuePanelTrackId = null;
      MaweCuePanelState.resetCuePanelEditState();
      MaweCuePanel.renderCurrentCuePanel();
    }
  }



  function updateMultiSelectionClasses() {
    MaweCoreState.container.querySelectorAll('.multi-cue').forEach((element) => {
      const mainIndex = element.dataset.mainIdx == null ? -1 : Number(element.dataset.mainIdx);
      const extensionIndex = element.dataset.extIdx == null ? -1 : Number(element.dataset.extIdx);
      const selected = (Number.isInteger(mainIndex) && selectedIdxs.has(mainIndex))
        || (Number.isInteger(extensionIndex) && selectedExtensionIdxs.has(extensionIndex));
      element.classList.toggle('selected', selected);
    });
  }



  function addMainIndexToSelection(index) {
    if (!Number.isInteger(index) || !MaweBoot.DATA.segments[index] || isHiddenDisabled(index)) return;
    selectedIdxs.add(index);
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`);
    if (el) el.classList.add('selected');
  }



  function addExtensionIndexToSelection(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
    selectedExtensionIdxs.add(index);
  }



  // 联动选中只补充另一轨的选中集合，不切换当前字幕编辑区；编辑区焦点仍由用户最后点击的字幕决定。
  function syncBoundSelection(kind, index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    if (!MaweSettings.EDITOR_SETTINGS.selectBoundSubtitlePair || !MaweMultiSubtitleCore.multiSubtitleVisible()) return;
    if (kind === 'main') {
      const binding = MaweMultiSubtitleCore.bindingForMainIndex(index);
      const activeTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
      const bindingTrack = binding ? (MaweMultiSubtitleCore.getExtensionTrack(binding.track_id) || activeTrack) : null;
      if (!binding || !activeTrack || bindingTrack?.id !== activeTrack.id) return;
      (binding.extension_segment_ids || []).forEach((id) => {
        const extensionIndex = activeTrack.segments.findIndex((segment) => segment?.id === id);
        if (extensionIndex >= 0) addExtensionIndexToSelection(extensionIndex, activeTrack);
      });
      return;
    }
    const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(index, track);
    if (!binding) return;
    (binding.main_segment_ids || []).forEach((id) => {
      const mainIndex = MaweBoot.DATA.segments.findIndex((segment) => segment?.id === id);
      if (mainIndex >= 0) addMainIndexToSelection(mainIndex);
    });
  }



  function selectOnlyExtension(
    index,
    track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
    syncPair = true,
    preserveMainSelection = false,
  ) {
    if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
    MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
    if (
      pendingExtensionBinding
      && track?.id === pendingExtensionBinding.trackId
      && track.segments?.[index]?.id !== pendingExtensionBinding.extensionId
    ) {
      cancelPendingExtensionBinding();
    }
    if (!preserveMainSelection) {
      // 普通点击副字幕后，最后点击的轨道成为当前绑定/编辑对象；
      // 不保留旧主字幕选区，避免 G 被误解为“替换旧主字幕的绑定”。
      MaweCuePanel.commitCuePanelEdit();
      selectedIdxs.clear();
      lastClickedIdx = -1;
    }
    selectedExtensionIdxs.clear();
    selectedExtensionIdxs.add(index);
    if (syncPair) syncBoundSelection('extension', index, track);
    updateMultiSelectionClasses();
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    lastClickedExtensionIdx = index;
    MaweCoreState.waveformEditor?.updateSelection();
    MaweCuePanel.setCurrentCuePanelExtensionIndex(index, track);
  }



  function toggleExtensionSelection(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
    MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
    if (selectedExtensionIdxs.has(index)) selectedExtensionIdxs.delete(index);
    else {
      selectedExtensionIdxs.add(index);
      syncBoundSelection('extension', index, track);
    }
    updateMultiSelectionClasses();
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    lastClickedExtensionIdx = index;
    MaweCoreState.waveformEditor?.updateSelection();
    MaweCuePanel.setCurrentCuePanelExtensionIndex(index, track);
  }



  function selectExtensionRange(a, b) {
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    if (!track) return;
    MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('extension', b, track);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    selectedExtensionIdxs.clear();
    let lastSelected = -1;
    for (let index = lo; index <= hi; index++) {
      if (!track.segments[index] || isHiddenDisabled(index, track)) continue;
      selectedExtensionIdxs.add(index);
      syncBoundSelection('extension', index, track);
      lastSelected = index;
    }
    updateMultiSelectionClasses();
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    if (lastSelected < 0) return;
    lastClickedExtensionIdx = lastSelected;
    MaweCoreState.waveformEditor?.updateSelection();
    MaweCuePanel.setCurrentCuePanelExtensionIndex(lastSelected, track);
  }


  function toggleSel(idx) {
    if (isHiddenDisabled(idx)) return;  // 隐藏禁用项不参与选择
    MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', idx);
    MaweNavPreview.hideCueSplitPreview();
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (selectedIdxs.has(idx)) {
      selectedIdxs.delete(idx);
      if (el) el.classList.remove('selected');
    } else {
      selectedIdxs.add(idx);
      if (el) el.classList.add('selected');
      syncBoundSelection('main', idx);
    }
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
    updateMultiSelectionClasses();
    MaweCuePanel.setCurrentCuePanelIndex(selectedIdxs.has(idx) ? idx : (selectedIdxs.values().next().value ?? -1));
  }


  function selectRange(a, b) {
    MaweNavPreview.hideCueSplitPreview();
    MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', b);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) {
      if (isHiddenDisabled(i)) continue;  // 跳过隐藏禁用项
      if (!selectedIdxs.has(i)) {
        selectedIdxs.add(i);
        const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
        if (el) el.classList.add('selected');
      }
      syncBoundSelection('main', i);
    }
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
    updateMultiSelectionClasses();
    MaweCuePanel.setCurrentCuePanelIndex(selectedIdxs.has(b) ? b : (selectedIdxs.values().next().value ?? -1));
  }


  function selectOnly(idx, syncPair = true) {
    MaweNavPreview.hideCueSplitPreview();
    MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', idx);
    // 这是键盘导航的热路径：clearSelection() 会先把面板切到空状态，
    // 再由下面的 setCurrentCuePanelIndex() 切回目标，导致一次按键触发
    // 两次面板刷新和两次波形选区刷新。先提交一次待编辑内容，再批量
    // 更新选区与面板，保持行为不变但只做一次视觉刷新。
    MaweCuePanel.commitCuePanelEdit();
    clearSelection({ silent: true });
    lastClickedExtensionIdx = -1;
    selectedIdxs.add(idx);
    if (syncPair) syncBoundSelection('main', idx);
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (el) el.classList.add('selected');
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
    updateMultiSelectionClasses();
    MaweCuePanel.setCurrentCuePanelIndex(idx);
  }


  function addToSelection(idx) {
    if (isHiddenDisabled(idx) || selectedIdxs.has(idx)) return;
    MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('main', idx);
    MaweNavPreview.hideCueSplitPreview();
    selectedIdxs.add(idx);
    syncBoundSelection('main', idx);
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (el) el.classList.add('selected');
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
    MaweCuePanel.setCurrentCuePanelIndex(idx);
  }


  function addExtensionToSelection(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    if (!track?.segments?.[index] || isHiddenDisabled(index, track) || selectedExtensionIdxs.has(index)) return;
    MaweCueElements.releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
    selectedExtensionIdxs.add(index);
    syncBoundSelection('extension', index, track);
    updateMultiSelectionClasses();
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    MaweCoreState.waveformEditor?.updateSelection();
    MaweCuePanel.setCurrentCuePanelExtensionIndex(index, track);
  }


  // 选中全部字幕（跳过「隐藏禁用项」开启时的禁用条目，与其它选择逻辑一致）。
  function selectAll() {
    MaweCuePanel.commitCuePanelEdit();
    clearSelection({ silent: true });
    MaweBoot.DATA.segments.forEach((_, idx) => {
      if (isHiddenDisabled(idx)) return;
      selectedIdxs.add(idx);
      syncBoundSelection('main', idx);
      const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
      if (el) el.classList.add('selected');
    });
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    extensionTrack?.segments.forEach((_, idx) => {
      if (isHiddenDisabled(idx, extensionTrack)) return;
      selectedExtensionIdxs.add(idx);
      syncBoundSelection('extension', idx, extensionTrack);
    });
    updateMultiSelectionClasses();
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
    const last = MaweBoot.DATA.segments.length - 1;
    if (last >= 0 && selectedIdxs.has(last)) {
      MaweCuePanel.setCurrentCuePanelIndex(last);
      return;
    }
    const firstMain = selectedIdxs.values().next().value;
    if (firstMain !== undefined) {
      MaweCuePanel.setCurrentCuePanelIndex(firstMain);
      return;
    }
    if (!extensionTrack) {
      MaweCuePanel.setCurrentCuePanelIndex(-1);
      return;
    }
    const lastExtension = extensionTrack.segments.length - 1;
    if (lastExtension >= 0 && selectedExtensionIdxs.has(lastExtension)) {
      MaweCuePanel.setCurrentCuePanelExtensionIndex(lastExtension, extensionTrack);
      return;
    }
    const firstExtension = selectedExtensionIdxs.values().next().value;
    MaweCuePanel.setCurrentCuePanelExtensionIndex(firstExtension ?? -1, extensionTrack);
  }

  global.MaweSelection = Object.freeze({
    stickerUrl,
    stickerAbsPath,
    selectedIdxs,
    selectedExtensionIdxs,
    get lastClickedIdx() { return lastClickedIdx; },
    set lastClickedIdx(v) { lastClickedIdx = v; },
    get lastClickedExtensionIdx() { return lastClickedExtensionIdx; },
    set lastClickedExtensionIdx(v) { lastClickedExtensionIdx = v; },
    temporaryVisibleSplitCueKeys,
    get pendingExtensionBinding() { return pendingExtensionBinding; },
    set pendingExtensionBinding(v) { pendingExtensionBinding = v; },
    isHiddenDisabled,
    cancelPendingExtensionBinding,
    clearSelection,
    updateMultiSelectionClasses,
    addMainIndexToSelection,
    addExtensionIndexToSelection,
    syncBoundSelection,
    selectOnlyExtension,
    toggleExtensionSelection,
    selectExtensionRange,
    toggleSel,
    selectRange,
    selectOnly,
    addToSelection,
    addExtensionToSelection,
    selectAll
  });
})(typeof window !== 'undefined' ? window : globalThis);
