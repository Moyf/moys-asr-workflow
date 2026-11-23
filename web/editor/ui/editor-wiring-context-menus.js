export function initMaweContextMenusWiring() {
// 使用捕获阶段的 pointerdown：波形空白区自己的 pointerdown 可能阻止后续
// click 事件，不能再依赖 mouseup 后才触发的 document.click 来关闭菜单。
document.addEventListener('pointerdown', MaweContextMenus.closeContextMenuOnOutsidePointerDown, true);
// 保留键盘触发 click 的关闭路径；真实鼠标/触控操作已经在 pointerdown 阶段关闭。
document.addEventListener('click', (e) => {
  if (e.detail === 0) MaweContextMenus.closeContextMenuOnOutsidePointerDown(e);
});
document.addEventListener('contextmenu', (e) => {
  // 非 cue 上的右键关闭菜单
  if (!e.target.closest('.cue') && !e.target.closest('.waveform-cue-block')) {
    MaweDom.ctxmenu.classList.remove('show');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && MaweDom.ctxmenu.classList.contains('show')) {
    MaweDom.ctxmenu.classList.remove('show');
  }
});

}
