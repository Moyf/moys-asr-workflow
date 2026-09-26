

// === 右键菜单 ===



// 叠加字幕块的右键菜单：转为主字幕 / 删除。叠加轨不参与拆分合并与绑定。
function showOverlayContextMenu(x, y, index) {
  const overlay = getOverlayTrack();
  const segment = overlay?.segments?.[index];
  if (!segment) return;
  // 主轨同时间段已有字幕时，转回去会产生主轨重叠，置灰禁用；
  // 只把该条叠加段的时间范围与主轨比对，相邻贴合（端点相接）不算占用。
  const mainOccupied = MaweBoot.DATA.segments.some((main) =>
    Number(main?.start) < Number(segment?.end) && Number(main?.end) > Number(segment?.start));
  MaweDom.ctxmenu.innerHTML = '';
  const addItem = (label, fn, opts = {}) => {
    const it = document.createElement('div');
    it.className = 'item' + (opts.danger ? ' danger' : '') + (opts.disabled ? ' disabled' : '');
    const lbl = document.createElement('span');
    lbl.textContent = label;
    it.appendChild(lbl);
    // 与其他菜单的 addItem 一致：禁用项只置灰，不绑定点击行为。
    if (!opts.disabled) {
      it.addEventListener('click', () => { MaweDom.ctxmenu.classList.remove('show'); fn(); });
    }
    MaweDom.ctxmenu.appendChild(it);
  };
  const addSep = () => {
    const sep = document.createElement('div');
    sep.className = 'sep';
    MaweDom.ctxmenu.appendChild(sep);
  };
  addItem('编辑文本', () => {
    MaweCuePanel.setCuePanelTarget('overlay', index);
    MaweCuePanel.focusCuePanelText(index, 'overlay');
  });
  if (MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-only') {
    addItem('跳转并播放', () => {
      MaweTextCleanup.seekFromWaveform(segment.start / 1000);
      if (MaweCoreState.player.paused) MaweMediaPlayback.togglePlayback();
    });
  }
  addItem('拆分此叠加字幕', () => openOverlaySplitModal(index, null));
  addItem('转为主字幕', () => convertOverlayCueToMain(index), { disabled: mainOccupied });
  addSep();
  // 组 2：外观（表情包与颜色），交互与主字幕菜单对齐（1~5 快捷键同源）。
  addItem('分配表情包…', () => MaweStickerPicker.openStickerPicker([index], false, { overlay: true }));
  if (segment.sticker || segment.sticker_ref) {
    addItem('删除表情包', () => clearOverlaySticker(index));
  }
  const colorRow = document.createElement('div');
  colorRow.className = 'item';
  colorRow.style.cssText = 'cursor:default;display:block;';
  colorRow.addEventListener('click', (e) => e.stopPropagation());
  const colorHead = document.createElement('div');
  colorHead.style.cssText = 'display:flex;align-items:center;';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = '标记颜色';
  colorHead.appendChild(colorLabel);
  const colorRangeHint = document.createElement('kbd');
  colorRangeHint.textContent = '1~5';
  colorRangeHint.style.marginLeft = 'auto';
  colorHead.appendChild(colorRangeHint);
  colorRow.appendChild(colorHead);
  const swatches = document.createElement('div');
  swatches.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
  MaweColors.COLOR_PALETTE.forEach((c, colorIndex) => {
    const swatch = document.createElement('span');
    swatch.title = `${c.label}色（按 ${colorIndex + 1}）`;
    swatch.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c.value};border:1px solid rgba(255,255,255,.25);cursor:pointer;display:inline-block;box-sizing:border-box;flex:0 0 auto;`;
    swatch.addEventListener('mouseenter', () => swatch.style.transform = 'scale(1.15)');
    swatch.addEventListener('mouseleave', () => swatch.style.transform = '');
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      MaweDom.ctxmenu.classList.remove('show');
      assignOverlayColor([index], c.name);
    });
    swatches.appendChild(swatch);
  });
  colorRow.appendChild(swatches);
  MaweDom.ctxmenu.appendChild(colorRow);
  if (segment.color || segment.color_ref) {
    addItem('清除颜色', () => clearOverlayColorOnTargets([index]), { danger: true });
  }
  addSep();
  // 组 3：状态与删除（Alt+点击波形块亦可切换，此处为菜单入口）
  addItem(
    segment.disabled ? '启用此条' : '禁用此条',
    () => MaweStickerPicker.toggleDisabled([index], 'overlay'),
  );
  addSep();
  addItem('删除此叠加字幕', () => deleteOverlayCues([index]), { danger: true });
  MaweDom.ctxmenu.classList.add('show');
  const rect = MaweDom.ctxmenu.getBoundingClientRect();
  let nx = x, ny = y;
  if (x + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 4;
  MaweDom.ctxmenu.style.left = nx + 'px';
  MaweDom.ctxmenu.style.top = ny + 'px';
}






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
