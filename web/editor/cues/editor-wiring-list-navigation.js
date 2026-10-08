



// === 滚动 ===


// 三种滚动共用一个可取消的操作：布局恢复、主动导航、播放跟随。
// scroll 事件本身不表示用户输入，懒布局和浏览器边界限制也会触发它。









document.addEventListener('pointerdown', (event) => {
  MaweCueListAnchor.invalidateCueListVisualAnchorRestore({ preserveLayoutAnchor: true });
  // 直接按在容器空白/滚动条上可能开始拖动；普通行点击仍沿用点击设置。
  const rect = MaweCoreState.container.getBoundingClientRect();
  if (event.target === MaweCoreState.container || (MaweCoreState.container.contains(event.target)
      && event.clientX >= rect.right - 14)) {
    MaweCueListAnchor.cueListScroll.layoutAnchor = null;
    MaweCueListAnchor.setCueListFollowing(false);
  }
}, true);
MaweCoreState.container.addEventListener('wheel', MaweCueListAnchor.interruptCueListFollowing, { passive: true });
MaweCoreState.container.addEventListener('touchstart', MaweCueListAnchor.interruptCueListFollowing, { passive: true });
document.addEventListener('keydown', (event) => {
  MaweCueListAnchor.invalidateCueListVisualAnchorRestore({ preserveLayoutAnchor: true });
}, true);
// 等播放、弹窗及目标控件先处理输入；被消费的空格不再误归为列表滚动。
// 应用自己消费的列表导航在其导航入口交出跟随，其余原生滚动在冒泡时处理。
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState
      || MaweKeyboardTargets.isTextEditingTarget(event) || MaweKeyboardTargets.isNativeKeyboardControl(event) || MaweKeyboardTargets.isPlayerKeyboardTarget(event)) return;
  if (document.querySelector('.modal-mask.show, #ctxmenu.show')
      || event.target?.closest?.('[role="dialog"], [role="menu"]')) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (!(MaweCoreState.container.contains(event.target) || MaweNavPreview.navigationOwner === 'cue-list')) return;
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
    MaweCueListAnchor.interruptCueListFollowing();
  }
});



























MaweCueListAnchor.cueListFollowButton?.addEventListener('click', MaweCueListAnchor.resumeCueListFollowing);

// === seek ===




// 最后一次指针按下所在的编辑区域：cue-list / waveform。
// Enter（原地编辑 vs 聚焦字幕编辑区）据此分发；指针坐标由 cueListPointer /
// lastPointerPos 提供，两者独立更新、互不替代。







// 等待绑定时，点击主/副字幕本身交给各自的选择事件处理；其它空白或
// 非字幕区域视为取消，避免用户进入等待状态后无从退出。
document.addEventListener('pointerdown', (event) => {
  if (!MaweSelection.pendingExtensionBinding) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.cue, .waveform-cue-block, #ctxmenu')) return;
  MaweSelection.cancelPendingExtensionBinding();
}, true);

document.addEventListener('pointerdown', (e) => {
  if (e.target instanceof Element && e.target.closest('.cue')) MaweNavPreview.lastEditRegion = 'cue-list';
  else if (e.target instanceof Element && e.target.closest('#waveform-pane')) MaweNavPreview.lastEditRegion = 'waveform';
}, true);


document.addEventListener('pointerdown', MaweNavPreview.updateNavigationOwner, true);
document.addEventListener('focusin', MaweNavPreview.updateNavigationOwner, true);
document.addEventListener('pointermove', (e) => {
  MaweNavPreview.lastPointerPos = { x: e.clientX, y: e.clientY };
}, true);









// Z/X 只接受一个“逻辑字幕”作为目标：点击主字幕时，绑定副字幕是它的
// 联动对象；点击副字幕时，即使界面同时选中了主字幕，也仍只改副字幕。
// 其它多选或来自不同绑定组的混合选择直接不处理。


// Z：起点定位；X：终点定位。无选中时使用波形指针命中的字幕；有选中时
// 只允许一个逻辑字幕，避免把多选误当成批量边界调整。


document.addEventListener('keydown', (event) => MaweNavPreview.handlePointerBoundaryShortcut(event, 'start'));
document.addEventListener('keydown', (event) => MaweNavPreview.handlePointerBoundaryShortcut(event, 'end'));



// === 单击/双击/Shift/Ctrl ===
