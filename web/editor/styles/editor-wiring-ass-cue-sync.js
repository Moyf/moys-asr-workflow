// 单句 ASS 样式跟随样式库：样式库在本窗口被编辑时，工程里与库一致的句子
// 立即更新；历史恢复后已跟随过的句子重新对齐；样式库底部按钮一次更新所有
// 旧句子。存储仍是每句一份快照（不改工程格式），本模块只改写内存中的句子。
import { getAssStyleLibrary } from './editor-wiring-ass-storage.js';

export function initAssCueStyleSyncWiring() {
  // seen 记录本次会话里每个样式在库中出现过的内容键（不含 name）：
  // 撤销把句子恢复成更早的快照时，靠它判断该句子是否跟随过本次会话的修改。
  // 工程加载开始时清空：上一个工程的记录不能影响新工程。
  const seen = new Map();

  function recordChangedKeys(changed) {
    for (const [id, entry] of changed) {
      let keys = seen.get(id);
      if (!keys) { keys = new Set(); seen.set(id, keys); }
      keys.add(entry.beforeKey);
      keys.add(entry.afterKey);
    }
  }

  // 与 MaweCommands 的 publish 一致：字幕内容变了就记脏。invalidate=false
  // 供历史恢复路径使用，渲染由 applyHistoryRecord 后续的 renderAll/invalidate
  // 统一完成，这里不再各刷一遍。同一目标样式只 stringify 一次，几千句跟随
  // 时省掉逐句 stringify 的重复开销。
  function applyCueStyleUpdates(updates, { invalidate = true } = {}) {
    if (!updates.length) return 0;
    const rawByStyle = new Map();
    for (const { segment, style } of updates) {
      let raw = rawByStyle.get(style);
      if (raw === undefined) { raw = JSON.stringify(style); rawByStyle.set(style, raw); }
      segment.assStyle = JSON.parse(raw);
      segment._dirty = true;
    }
    MaweState.changes.projectImportDirty = true;
    if (invalidate) MaweViewUpdates.invalidate({ save: true, preview: 'update' });
    return updates.length;
  }

  // 样式库在本窗口被编辑后调用（editor-wiring-ass-manager.js）。
  // 无论有没有句子需要更新，都要把变化样式的改前键、改后键写入 seen：
  // 否则撤销恢复的旧快照在下一次库修改时不再跟随。不进撤销历史。
  function afterLibraryEdit(previousLibrary) {
    const utils = window.AsrEditorUtils;
    const cueGroups = utils.assStyleCueGroups(MaweBoot.DATA);
    const { updates, changed } = utils.planAssStyleCueSync(cueGroups, previousLibrary, getAssStyleLibrary(), seen);
    recordChangedKeys(changed);
    if (updates.length) {
      applyCueStyleUpdates(updates);
      // 单句面板的样式下拉可能在改库前显示 __snapshot，跟随后就地纠正。
      MaweCuePanel?.renderCurrentCuePanel?.();
    }
    return updates.length;
  }

  // 历史恢复（撤销、重做、命令取消）后调用：已跟随过的句子重新对齐到库的
  // 当前版本，撤销别的操作不会把句子悄悄退回旧样子。打开工程时就是旧版本
  // （不在 seen 里）的句子不动，由底部按钮处理。
  function reapply() {
    if (!seen.size) return 0;
    const utils = window.AsrEditorUtils;
    const cueGroups = utils.assStyleCueGroups(MaweBoot.DATA);
    const updates = utils.planAssStyleCueFollow(cueGroups, getAssStyleLibrary(), seen);
    return applyCueStyleUpdates(updates, { invalidate: false });
  }

  // 底部按钮：所有「样式 id 还在库里且内容不同」的句子一次更新，进撤销历史。
  function updateAll() {
    const utils = window.AsrEditorUtils;
    const cueGroups = utils.assStyleCueGroups(MaweBoot.DATA);
    const updates = utils.planAssStyleCueRefresh(cueGroups, getAssStyleLibrary());
    if (!updates.length) return 0;
    const rawByStyle = new Map();
    MaweCommands.run('用样式库更新单句样式', () => {
      for (const { segment, style } of updates) {
        let raw = rawByStyle.get(style);
        if (raw === undefined) { raw = JSON.stringify(style); rawByStyle.set(style, raw); }
        segment.assStyle = JSON.parse(raw);
        segment._dirty = true;
      }
    }, { invalidate: { cueList: true, waveform: 'overlay', preview: 'update' } });
    return updates.length;
  }

  // 提示计数：工程里「样式 id 还在库里且内容不同」的句子数量。库里已删除
  // 的样式不计入，句子保留自己的快照继续用。
  function outdatedCueCount() {
    const utils = window.AsrEditorUtils;
    const cueGroups = utils.assStyleCueGroups(MaweBoot.DATA);
    return utils.planAssStyleCueRefresh(cueGroups, getAssStyleLibrary()).length;
  }

  // 样式库被整体替换（导入、重新加载、恢复导入前副本）后调用：把内容发生
  // 变化的样式从 seen 里删掉。这些样式的旧内容键指向一个已被替换掉的库
  // 版本，撤销不再把它们重对齐到别人窗口的版本；内容没变的样式保留记录。
  // 保存回读（内容必然相同）不经过这里，撤销保证不受影响。
  function noteLibraryReplaced(previousLibrary, nextLibrary) {
    const utils = window.AsrEditorUtils;
    const previousById = new Map((previousLibrary?.styles || []).map((style) => [style.id, style]));
    for (const style of nextLibrary?.styles || []) {
      const before = previousById.get(style.id);
      if (!before) continue;
      if (utils.assStyleContentKey(before) !== utils.assStyleContentKey(style)) seen.delete(style.id);
    }
  }

  window.MaweState.observeProjectLoad(() => seen.clear());
  window.MaweAssCueStyleSync = Object.freeze({ afterLibraryEdit, reapply, updateAll, outdatedCueCount, noteLibraryReplaced });
}
