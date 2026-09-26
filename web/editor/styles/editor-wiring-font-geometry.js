
// === 字幕预览几何（preview.subtitle）===
// 归一化 {x,y,width,height} 存于 DATA.preview.subtitle。纯钳制/归一化逻辑在
// AsrEditorUtils（已单测）；这里只负责 DOM 应用、指针/键盘手势、每手势一条撤销、脏标记。


// 启动早期生成的自定义字体选项先用原始名称占位；共享工具层就绪后立即统一本地化。
MaweAppearance.relabelSubtitleFontFamilyOptions();




















// 字体 combobox：文本输入 + 可筛选下拉列表，交互对齐 Launcher「模型」输入框。
// getEntries() 返回 [{ value, label }]；选项点击或 Enter 写入 label 并派发 change，
// 由既有映射（subtitleFontFamilyInputToStored / assStyleForm change 委托）落库。
// 上下方向键在高亮项间移动（含首尾回绕前的边界钳制），输入仍可保留自定义值。
// 下拉面板打开时 portal 到 body 并按输入框矩形 fixed 定位：不参与设置面板的
// 滚动区（不撑高容器、不被面板边缘裁剪），宽度锁定与输入框同宽，贴底时上翻。
// 实例惰性创建：启动早期（relabelSubtitleFontFamilyOptions 于模块求值时被调用）
// 也可能触发重建，惰性创建避免引用后置声明造成暂时性死区。
function createFontFamilyCombobox({ input, toggle, options, getEntries }) {
  if (!input || !options) return { refresh() {}, setOpen() {} };
  let open = false;
  let entries = [];
  let activeIndex = -1;
  let blurTimer = 0;
  let reposition = null;
  const picker = options.parentElement;
  function optionId(index) {
    return options.id ? `${options.id}-option-${index}` : `font-combobox-option-${index}`;
  }
  function positionPanel() {
    const rect = input.getBoundingClientRect();
    const margin = 8;
    const viewportHeight = window.innerHeight;
    const cap = Math.max(120, Math.min(280, Math.round(viewportHeight * 0.4)));
    const spaceBelow = viewportHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openUp = spaceBelow < Math.min(cap, 140) && spaceAbove > spaceBelow;
    options.style.left = `${Math.round(rect.left)}px`;
    options.style.width = `${Math.round(rect.width)}px`;
    if (openUp) {
      options.style.top = 'auto';
      options.style.bottom = `${Math.round(viewportHeight - rect.top + 2)}px`;
      options.style.maxHeight = `${Math.max(120, Math.min(cap, spaceAbove))}px`;
    } else {
      options.style.bottom = 'auto';
      options.style.top = `${Math.round(rect.bottom + 2)}px`;
      options.style.maxHeight = `${Math.max(120, Math.min(cap, spaceBelow))}px`;
    }
  }
  function attachReposition() {
    reposition = () => positionPanel();
    window.addEventListener('resize', reposition);
    // capture 捕获任意祖先（设置面板体、模态框等）的滚动，浮层跟随输入框。
    document.addEventListener('scroll', reposition, true);
  }
  function detachReposition() {
    if (!reposition) return;
    window.removeEventListener('resize', reposition);
    document.removeEventListener('scroll', reposition, true);
    reposition = null;
  }
  function setActive(index, { scroll = false } = {}) {
    activeIndex = entries.length ? Math.max(0, Math.min(index, entries.length - 1)) : -1;
    Array.from(options.children).forEach((child, childIndex) => {
      child.classList?.toggle('active', childIndex === activeIndex);
    });
    if (activeIndex >= 0) {
      input.setAttribute('aria-activedescendant', optionId(activeIndex));
      if (scroll) options.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }
  function activeIndexOfValue() {
    const current = input.value.trim().toLocaleLowerCase();
    return entries.findIndex((entry) => entry.label.toLocaleLowerCase() === current);
  }
  function render(query = '') {
    entries = window.AsrEditorUtils.filterFontFamilyOptions(
      window.AsrEditorUtils.mergeFontFamilyOptions(getEntries()),
      query,
    );
    options.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('span');
      empty.className = 'font-combobox-empty';
      empty.textContent = '无匹配字体';
      options.append(empty);
    }
    entries.forEach((entry, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = optionId(index);
      option.className = 'font-combobox-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(entry.label === input.value.trim()));
      option.textContent = entry.label;
      option.addEventListener('click', () => selectEntry(index));
      options.append(option);
    });
    setActive(activeIndexOfValue());
  }
  function selectEntry(index) {
    const entry = entries[index];
    if (!entry) return;
    input.value = entry.label;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setOpen(false);
    input.focus();
  }
  function setOpen(next, query = '') {
    open = Boolean(next);
    input.setAttribute('aria-expanded', String(open));
    if (open) {
      render(query);
      // portal 到 body 脱离设置面板的滚动/裁剪上下文，先定位再显示避免闪跳。
      if (options.parentElement !== document.body) document.body.appendChild(options);
      positionPanel();
      attachReposition();
      options.hidden = false;
    } else {
      entries = [];
      setActive(-1);
      detachReposition();
      options.hidden = true;
      // 关闭后归还到 picker 内，保持模板 DOM 结构整洁。
      if (picker && options.parentElement !== picker) picker.appendChild(options);
      input.removeAttribute('aria-activedescendant');
    }
  }
  function moveActive(step) {
    if (!open) setOpen(true, input.value);
    if (!entries.length) return;
    setActive(activeIndex < 0 ? (step > 0 ? 0 : entries.length - 1) : activeIndex + step, { scroll: true });
  }
  function cancelPendingClose() {
    if (blurTimer) {
      window.clearTimeout(blurTimer);
      blurTimer = 0;
    }
  }
  // 失焦延迟关闭：选项与箭头 mousedown preventDefault 不夺焦点，.blur 只在真正
  // 离开组件（点击外部 / Tab）时触发；延迟窗口内重获焦点则取消关闭。
  input.addEventListener('focus', () => {
    cancelPendingClose();
    setOpen(true);
  });
  input.addEventListener('blur', () => {
    cancelPendingClose();
    blurTimer = window.setTimeout(() => {
      blurTimer = 0;
      if (open) setOpen(false);
    }, 120);
  });
  // 容器整体拦截 mousedown，点击面板空白处也不夺走输入框焦点。
  options.addEventListener('mousedown', (event) => event.preventDefault());
  input.addEventListener('input', () => setOpen(true, input.value));
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      if (activeIndex >= 0) selectEntry(activeIndex);
      else setOpen(false);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  });
  if (toggle) {
    toggle.addEventListener('mousedown', (event) => event.preventDefault());
    toggle.addEventListener('click', () => {
      cancelPendingClose();
      setOpen(!open, input.value);
    });
  }
  return {
    refresh() {
      if (open) render(input.value);
    },
    setOpen,
  };
}
function subtitleFontFamilyComboboxEntries() {
  const entries = window.AsrEditorUtils.SUBTITLE_FONT_FAMILY_PRESETS.map((preset) => {
    const label = MaweAppearance.subtitleFontFamilyPresetLabel(preset);
    return { value: label, label };
  });
  MaweAppearance.subtitleLocalFontFamilies.forEach((family) => {
    const label = MaweAppearance.subtitleFontFamilyDisplayName(family);
    entries.push({ value: label, label });
  });
  return entries;
}
function assFontNameComboboxEntries() {
  const entries = ASS_BUILTIN_FONT_SUGGESTIONS.map((name) => ({ value: name, label: name }));
  MaweAppearance.subtitleLocalFontFamilies.forEach((family) => {
    entries.push({ value: family, label: family });
  });
  return entries;
}
function getSubtitleFontFamilyCombobox() {
  if (!subtitleFontFamilyCombobox) {
    subtitleFontFamilyCombobox = createFontFamilyCombobox({
      input: subtitleFontFamilyInput,
      toggle: subtitleFontFamilyToggle,
      options: subtitleFontFamilyOptions,
      getEntries: subtitleFontFamilyComboboxEntries,
    });
  }
  return subtitleFontFamilyCombobox;
}
function getAssFontNameCombobox() {
  if (!assFontNameCombobox) {
    const assStyleFontNameInput = document.getElementById('ass-style-font-name');
    // 占位符跟随按操作系统选择的 ASS 默认字体，不再固定 Arial。
    if (assStyleFontNameInput) {
      const assDefaultFontName = window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE?.fontName;
      if (assDefaultFontName) assStyleFontNameInput.placeholder = assDefaultFontName;
    }
    assFontNameCombobox = createFontFamilyCombobox({
      input: assStyleFontNameInput,
      toggle: assStyleFontToggle,
      options: assStyleFontOptions,
      getEntries: assFontNameComboboxEntries,
    });
  }
  return assFontNameCombobox;
}
function rebuildSubtitleFontFamilyOptions() {
  getSubtitleFontFamilyCombobox().refresh();
}
function rebuildAssFontNameOptions() {
  getAssFontNameCombobox().refresh();
}



function normalizeAssColorStyleValue(value) {
  return typeof value === 'string' && ASS_COLOR_STYLE_VALUES.includes(value)
    ? value : null;
}


















MaweColors.subtitleColorPaletteNames.forEach((name) => {
  const colorInput = MaweColors.subtitleColorPaletteColorInputs[name];
  const hexInput = MaweColors.subtitleColorPaletteHexInputs[name];
  colorInput?.addEventListener('change', () => {
    MaweColors.setSubtitleColorPaletteValue(name, colorInput.value);
  });
  hexInput?.addEventListener('input', () => {
    if (/^#[0-9a-f]{6}$/iu.test(hexInput.value.trim())) {
      MaweColors.setSubtitleColorPaletteValue(name, hexInput.value);
    }
  });
  hexInput?.addEventListener('change', () => {
    MaweColors.setSubtitleColorPaletteValue(name, hexInput.value);
  });
});

MaweColors.subtitleColorPaletteResetButton?.addEventListener('click', () => {
  MaweSettings.updateEditorSettings({ subtitleColorPalette: { ...MaweColors.COLOR_PALETTE_DEFAULTS } });
  MaweColors.syncSubtitleColorPaletteControls();
  MaweColors.refreshSubtitleColorPalettePresentation();
  MaweHint.flashHint('已恢复内置字幕颜色', 'success');
});












MaweAppearance.initializeSubtitleFontFamilyScanner();


// 写回 DATA.preview.subtitle 并刷新 DOM。markDirty=false 用于初次加载，不弄脏工程。


// === 表情包预览几何（preview.sticker）===
// 与字幕预览同一套归一化/钳制逻辑，仅默认值不同（右上角小图）。

// 写回 DATA.preview.sticker 并刷新 DOM。markDirty=false 用于初次加载，不弄脏工程。


// 只有当对应预览开关开启时才允许几何编辑（关闭时字幕盒完全隐藏、表情包盒不拦截指针）。


// --- 指针拖动 / 缩放（Pointer Events），字幕预览与表情包预览共用 ---
  // { pointerId, handle, target, startX, startY, startGeo, rect }









MawePreviewGeometry.bindPreviewBoxPointerEvents(MaweDom.overlayEl, 'subtitle');

// --- 键盘操作（聚焦时），字幕预览与表情包预览共用 ---
// 方向键移动 1%；Shift 加速到 10%；Alt+方向缩放；Enter 切换 editable；Esc 失焦。

MaweDom.overlayEl.addEventListener('keydown', (event) => MawePreviewGeometry.handlePreviewBoxKeydown(event, 'subtitle'));

// 点击预览框（字幕/表情包）以外的地方：失焦并退出控制点编辑态，调整框随之隐藏。
// 捕获阶段监听，避免其他组件 pointerdown 的 stopPropagation 跳过失焦。
document.addEventListener('pointerdown', (event) => {
  if (MawePreviewGeometry.previewGesture) return;
  [MaweDom.overlayEl, MaweStickerOverlay.stickerOverlayLayer].forEach((el) => {
    if (el.contains(event.target)) return;
    el.classList.remove('editable');
    if (document.activeElement === el) el.blur();
  });
}, true);

// 播放器缩放时几何以百分比表达，天然自适应；ResizeObserver 仅在盒子越界后回钳。
if (typeof ResizeObserver === 'function') {
  const previewResizeObserver = new ResizeObserver(() => {
    MawePreviewGeometry.applyPreviewGeometryToDom(MaweAppearance.getPreviewGeometry());
    scheduleAssSubtitlePreviewRefresh();
  });
  previewResizeObserver.observe(MaweDom.playerStage);
}
