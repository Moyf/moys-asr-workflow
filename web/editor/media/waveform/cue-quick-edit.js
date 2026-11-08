// cue-quick-edit: 波形字幕块 / 字词块双击弹出的原位快速编辑气泡。
// 结构与 waveform-markers 的 quick edit 浮层同款：浮层挂载在滚动内容层
//（随内容滚动），点击浮层以外或 Esc 关闭。通用壳（DOM / 定位 / 键盘 /
// 关闭提交路径）在这里统一实现，字幕与字词入口各自注入 commit / navigate：
// - 字幕文本提交经 options.onCueQuickEditText 进入命令层；
// - 字词文本提交 = 把句文本中该字词的字符区间替换为新文本，经 options.
//   onWordQuickEditText 走既有字词文本同步（时间不变，仍由手柄拖动调整）。
// 跨行字幕在每一行都有自己的可见片段，双击命中的是点击行的那个片段，
// 锚点即取该片段与指针 X：弹窗自然跟随鼠标点击的位置显示。
export function createWaveformModule(dependencies) {
  'use strict';
  const { clamp, formatCompact, localizedWaveformMessage } = dependencies;

  const QUICK_EDIT_MARGIN_PX = 4;
  const QUICK_EDIT_GAP_PX = 8;
  const QUICK_EDIT_ARROW_MIN_PX = 14;

  function cueTrackLabel(track) {
    if (track === 'extension') return localizedWaveformMessage('副字幕', 'Extension cue');
    if (track === 'overlay') return localizedWaveformMessage('叠加字幕', 'Overlay cue');
    return localizedWaveformMessage('字幕', 'Cue');
  }

  // 纯函数：锚点（内容坐标像素）+ 弹窗尺寸 + 可视视口（内容坐标）→ 定位。
  // anchor: {pointerX, blockTop, blockBottom}；viewLeft/viewTop 是滚动容器
  // 可视范围在内容坐标系的原点，viewWidth/viewHeight 是可视尺寸。水平以
  // 指针 X 居中并夹在可视区内；垂直优先在被点击片段上方——只有上方在
  // 可视区内放得下才算「上方」，否则翻到片段下方并钳在可视区内，避免
  // 滚动后贴近视口顶部的块把气泡顶进滚动容器的裁剪区；arrowX 是气泡
  // 三角相对弹窗左缘的位置，保持箭头指向指针点击处。
  function cueQuickEditLayout(anchor, popupWidth, popupHeight, viewLeft, viewTop, viewWidth, viewHeight) {
    const pointerX = Number.isFinite(anchor?.pointerX) ? anchor.pointerX : 0;
    const left = clamp(
      pointerX - popupWidth / 2,
      viewLeft + QUICK_EDIT_MARGIN_PX,
      Math.max(viewLeft + QUICK_EDIT_MARGIN_PX, viewLeft + viewWidth - popupWidth - QUICK_EDIT_MARGIN_PX),
    );
    const aboveTop = anchor.blockTop - popupHeight - QUICK_EDIT_GAP_PX;
    const placement = aboveTop >= viewTop + QUICK_EDIT_MARGIN_PX ? 'above' : 'below';
    const top = placement === 'above'
      ? aboveTop
      : clamp(
        anchor.blockBottom + QUICK_EDIT_GAP_PX,
        viewTop + QUICK_EDIT_MARGIN_PX,
        Math.max(viewTop + QUICK_EDIT_MARGIN_PX, viewTop + viewHeight - popupHeight - QUICK_EDIT_MARGIN_PX),
      );
    const arrowX = clamp(
      pointerX - left,
      QUICK_EDIT_ARROW_MIN_PX,
      Math.max(QUICK_EDIT_ARROW_MIN_PX, popupWidth - QUICK_EDIT_ARROW_MIN_PX),
    );
    return { left, top, arrowX, placement };
  }

  // 纯函数：把折叠文本里的字符偏移映射回原文偏移。
  // 字幕块标签文本由 original.replace(/\s+/g, ' ') 生成：原文的每个空白
  // run（换行、连续空格）折叠成一个空格。点击落在折叠空格上时映射到
  // run 之前（即上一行行尾）；字符意外不一致时返回已推进到的位置，
  // 由调用方兜底。字词标签不折叠空白，两者相同，调用方先走恒等捷径。
  function cueQuickEditOriginalOffset(originalText, collapsedText, collapsedOffset) {
    const original = String(originalText ?? '');
    const collapsed = String(collapsedText ?? '');
    const target = Math.max(0, Math.min(Number(collapsedOffset) || 0, collapsed.length));
    let originalIndex = 0;
    let collapsedIndex = 0;
    while (collapsedIndex < target && originalIndex < original.length) {
      const originalChar = original[originalIndex];
      const collapsedChar = collapsed[collapsedIndex];
      if (/\s/.test(originalChar)) {
        const runIsWhitespace = collapsedChar === ' ';
        while (originalIndex < original.length && /\s/.test(original[originalIndex])) originalIndex += 1;
        if (runIsWhitespace) collapsedIndex += 1;
        continue;
      }
      if (originalChar === collapsedChar) {
        originalIndex += 1;
        collapsedIndex += 1;
        continue;
      }
      return originalIndex;
    }
    return Math.min(originalIndex, original.length);
  }

  class WaveformMethods {

    // 通用弹窗壳。caret: 'click' = 光标定位到 event 命中的字符（解析
    // 失败放末尾）；'end' = 句尾/词尾；'select' = 全选。commit(state) 在
    // 关闭 / 失焦时调用（幂等由实现方保证），navigate(state, ±1) 响应
    // Tab / Shift+Tab。返回内部状态对象。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    _openQuickEditPopup({
      caption, value, rows = 2, ariaLabel,
      anchorElement, event, caret = 'click', commit, navigate = null, split = null,
    }) {
      this.closeCueQuickEdit();
      // 光标定位要在气泡挂载前完成：与字幕列表的行内编辑一致，把编辑
      // 光标放到鼠标双击的字符处；解析失败（点击不在文字上、标签被截断
      // 等）时光标放在末尾，不做全选。
      const caretCollapsed = caret === 'click' && anchorElement?.isConnected
        ? this.cueQuickEditCaretOffset(anchorElement, event.clientX, event.clientY)
        : null;

      const popup = document.createElement('div');
      popup.className = 'waveform-cue-quick-edit';
      const captionEl = document.createElement('div');
      captionEl.className = 'waveform-cue-quick-edit-caption';
      captionEl.textContent = caption;
      const header = document.createElement('div');
      header.className = 'waveform-cue-quick-edit-header';
      const help = document.createElement('button');
      help.type = 'button';
      help.className = 'waveform-cue-quick-edit-help';
      help.textContent = localizedWaveformMessage('操作说明', 'Help');
      help.addEventListener('click', () => /** @type {any} */ (window).MaweHelpPanel?.openHelpAtTab('quick-edit'));
      header.append(captionEl, help);

      const textarea = document.createElement('textarea');
      textarea.className = 'waveform-cue-quick-edit-text';
      textarea.rows = rows;
      textarea.spellcheck = false;
      textarea.value = value;
      textarea.setAttribute('aria-label', ariaLabel);

      popup.append(header, textarea);

      // 锚点坐标在打开时一次性换算成内容坐标：提交后字幕块覆盖层会整层
      // 重建（元素被替换），但文本编辑不移动块，几何位置不变。
      const contentRect = this.content.getBoundingClientRect();
      const anchorRect = anchorElement.getBoundingClientRect();
      const anchor = {
        pointerX: event.clientX - contentRect.left,
        blockTop: anchorRect.top - contentRect.top,
        blockBottom: anchorRect.bottom - contentRect.top,
      };
      const state = {
        element: popup,
        textarea,
        anchor,
        commit,
        navigate,
        resizeObserver: null,
      };
      const resizeObserver = new ResizeObserver(() => {
        if (this.cueQuickEdit?.element !== popup) return;
        if (popup.isConnected) this.positionCueQuickEdit();
        else this.closeCueQuickEdit();
      });
      state.resizeObserver = resizeObserver;
      this.cueQuickEdit = state;
      this.content.appendChild(popup);
      this.positionCueQuickEdit();
      resizeObserver.observe(popup);

      // 字幕的 Enter / Ctrl+Enter 按全局设置拆分或保存，Shift+Enter 换行；
      // 字词的 Enter 保存。Esc 关闭并保留修改，Tab / Shift+Tab 交给 navigate（到头保持不动，
      // 阻断原生焦点移动）。其余按键交给 textarea 原生行为，编辑器快捷键
      // 层已有输入目标守卫（isTextEditingTarget），不会误触发。
      textarea.addEventListener('keydown', (keyEvent) => {
        // 输入法组词期间（isComposing / keyCode 229）Enter 是确认候选词、
        // Esc 是取消组词：跳过气泡快捷键，交给输入法原生处理，避免确认
        // 候选词误关气泡或打断组词。
        if (keyEvent.isComposing || keyEvent.keyCode === 229) return;
        if (keyEvent.key === 'Enter' && !keyEvent.altKey && split) {
          const action = this.options.getQuickEditEnterAction?.(keyEvent);
          if (action === 'newline') return;
          if (action === 'split') {
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            const offset = textarea.selectionStart;
            this.commitCueQuickEdit();
            const savedCommit = state.commit;
            state.commit = null;
            const result = split(state, offset);
            if (result) this.closeCueQuickEdit();
            else state.commit = savedCommit;
            return;
          }
        }
        if (keyEvent.key === 'Enter' && !keyEvent.shiftKey && !keyEvent.altKey) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          this.closeCueQuickEdit();
          return;
        }
        if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          this.closeCueQuickEdit();
          return;
        }
        if (keyEvent.key === 'Tab' && !keyEvent.ctrlKey && !keyEvent.altKey && !keyEvent.metaKey) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          state.navigate?.(state, keyEvent.shiftKey ? -1 : 1);
        }
      });
      // 焦点离开输入框（如 Tab）：提交已输入文本，但保留气泡，回到输入框
      // 可继续编辑；关闭路径（Enter / Esc / 点击外部）会先清状态再移除
      // 元素，blur 重入时 cueQuickEdit 已为 null，不会重复提交。
      textarea.addEventListener('blur', () => {
        if (this.cueQuickEdit === state) this.commitCueQuickEdit();
      });
      // 滚轮停在气泡内（如滚动长文本）时不要平移/缩放底层波形。
      popup.addEventListener('wheel', (wheelEvent) => wheelEvent.stopPropagation());

      this._cueQuickEditOutside = (outsideEvent) => {
        if (popup.contains(outsideEvent.target)) return;
        this.closeCueQuickEdit();
      };
      this._cueQuickEditKey = (keyEvent) => {
        // 与气泡内快捷键一致：输入法组词期间的 Esc 是取消组词，不关气泡。
        if (keyEvent.isComposing || keyEvent.keyCode === 229) return;
        if (keyEvent.key === 'Escape') {
          keyEvent.stopPropagation();
          this.closeCueQuickEdit();
        }
      };
      document.addEventListener('pointerdown', this._cueQuickEditOutside, true);
      document.addEventListener('keydown', this._cueQuickEditKey, true);
      textarea.focus({ preventScroll: true });
      if (caret === 'select') {
        textarea.select();
        return state;
      }
      const text = textarea.value;
      const caretOffset = !caretCollapsed
        ? text.length
        : caretCollapsed.collapsed === text
          ? caretCollapsed.offset
          : cueQuickEditOriginalOffset(text, caretCollapsed.collapsed, caretCollapsed.offset);
      const bounded = Math.max(0, Math.min(caretOffset, text.length));
      textarea.setSelectionRange(bounded, bounded);
      return state;
    }


    // 双击字幕块：弹出字幕快速编辑气泡。anchorElement 是双击命中的字幕
    // 块片段（跨行字幕为点击行内的那个片段），event 的指针坐标用于水平
    // 锚定与编辑光标定位；caretAtEnd 跳过光标定位、直接放在句尾
    //（创建/导航入口使用）。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    openCueQuickEdit(track, index, anchorElement, event, { caretAtEnd = false } = {}) {
      const segments = this.options.getSegments(track);
      const segment = segments?.[index];
      if (!segment || !anchorElement?.isConnected) return;
      this._openQuickEditPopup({
        caption: `${cueTrackLabel(track)} #${index + 1}`
          + ` · ${formatCompact(Number(segment.start))} → ${formatCompact(Number(segment.end))}`,
        value: String(segment.text ?? ''),
        rows: 2,
        ariaLabel: localizedWaveformMessage('字幕文本', 'Cue text'),
        anchorElement,
        event,
        caret: caretAtEnd ? 'end' : 'click',
        commit: (state) => this._commitCueQuickEditState({ ...state, track, index, segmentId: segment.id || null }),
        navigate: (state, direction) => this.navigateCueQuickEdit({ ...state, track, index, segmentId: segment.id || null }, direction),
        split: (state, offset) => this.options.onCueQuickEditSplit?.(track, index, offset, state),
      });
    }


    // 双击字词块（字词时间码模式）：弹出字词快速编辑气泡，就地修改字词
    // 文本；时间仍由手柄拖动调整，标题行只读展示时间范围。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    openWordQuickEdit(segmentIndex, itemIndex, anchorElement, event) {
      const segment = this.options.getSegments('main')?.[segmentIndex];
      if (!segment || !anchorElement?.isConnected) return;
      const timing = this.cueTiming();
      const entries = window.AsrEditorUtils.getWordTimingEntries(segment, timing);
      const entry = entries.find((candidate) => candidate.index === itemIndex);
      if (!entry) return;
      this._openQuickEditPopup({
        caption: `${localizedWaveformMessage('字词', 'Word')} #${itemIndex + 1}`
          + ` · ${formatCompact(timing.toMs(entry.start))} → ${formatCompact(timing.toMs(entry.end))}`,
        value: String(entry.text ?? ''),
        rows: 1,
        ariaLabel: localizedWaveformMessage('字词文本', 'Word text'),
        anchorElement,
        event,
        caret: 'click',
        commit: (state) => {
          const text = state.textarea.value.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ');
          this.options.onWordQuickEditText?.(segmentIndex, itemIndex, text);
          return true;
        },
        navigate: (_state, direction) => this.navigateWordQuickEdit(segmentIndex, itemIndex, direction),
      });
    }


    // 创建空字幕后的统一入口：在新字幕块的上方弹出快速编辑气泡。块的
    // 渲染可能是异步的（虚拟行随 revealTime 滚动逐步补齐），用 rAF 重试；
    // 重试期间若打开了其他气泡或字幕已被撤销删除则静默放弃，彻底找不到
    // 时调用 onGiveUp（调用方回退到旧版聚焦字幕面板文本框）。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    openCueQuickEditAtIndex(track, index, onGiveUp = null) {
      const maxAttempts = 30;
      let attempts = 0;
      const attempt = () => {
        // 首次尝试允许接管既有气泡（与双击路径一致）；重试期间出现的
        // 其他气泡属于用户的新操作，不再抢占。
        if (attempts > 0 && this.cueQuickEdit) return;
        if (!this.options.getSegments(track)?.[index]) {
          onGiveUp?.();
          return;
        }
        const block = this.firstVisibleCueBlock(track, index);
        if (block) {
          const rect = block.getBoundingClientRect();
          this.openCueQuickEdit(track, index, block, {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }, { caretAtEnd: true });
          return;
        }
        attempts += 1;
        if (attempts >= maxAttempts) {
          onGiveUp?.();
          return;
        }
        requestAnimationFrame(attempt);
      };
      attempt();
    }


    // 字词的同类入口：在字词块上方弹出气泡（导航 / 外部调用使用）。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    openWordQuickEditAtIndex(segmentIndex, itemIndex, onGiveUp = null) {
      const maxAttempts = 30;
      let attempts = 0;
      const attempt = () => {
        if (attempts > 0 && this.cueQuickEdit) return;
        if (!this.options.getSegments('main')?.[segmentIndex]) {
          onGiveUp?.();
          return;
        }
        const block = this.firstVisibleWordBlock(segmentIndex, itemIndex);
        if (block) {
          const rect = block.getBoundingClientRect();
          this.openWordQuickEdit(segmentIndex, itemIndex, block, {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          });
          return;
        }
        attempts += 1;
        if (attempts >= maxAttempts) {
          onGiveUp?.();
          return;
        }
        requestAnimationFrame(attempt);
      };
      attempt();
    }


    // 找当前已渲染、且落在滚动视口内的块（同类多个片段时任取一个可见
    // 片段）。只渲染在视口外的缓冲行不算就绪：气泡锚在视口外的话用户
    // 看不到，宁可等 revealTime 把它滚进来。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    firstVisibleBlock(selector) {
      const blocks = [...(/** @type {NodeListOf<HTMLElement>} */ (this.content.querySelectorAll(selector)))]
        .filter((block) => block.isConnected && !block.hidden);
      if (!blocks.length) return null;
      const viewport = this.scroll.getBoundingClientRect();
      return blocks.find((block) => {
        const rect = block.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      }) || null;
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    firstVisibleCueBlock(track, index) {
      const selector = track === 'extension'
        ? `.waveform-cue-block[data-track="extension"][data-ext-idx="${index}"]`
        : track === 'overlay'
          ? `.waveform-cue-block[data-track="overlay"][data-overlay-idx="${index}"]`
          : `.waveform-cue-block[data-track="main"][data-idx="${index}"]`;
      return this.firstVisibleBlock(selector);
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    firstVisibleWordBlock(segmentIndex, itemIndex) {
      return this.firstVisibleBlock(
        `.waveform-word-block[data-segment-idx="${segmentIndex}"][data-item-idx="${itemIndex}"]`);
    }


    // 气泡内按 Tab / Shift+Tab：提交当前修改后切到同轨上一句/下一句字幕，
    // 选中（面板/列表联动与点击波形块同一路径）并在其块上方重新打开气
    // 泡，光标放句尾。目标字幕被隐藏（不渲染块）时跳过；到头/到尾保持
    // 当前气泡不动。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    navigateCueQuickEdit(state, direction) {
      const segments = this.options.getSegments(state.track) || [];
      const current = state.segmentId
        ? segments.findIndex((candidate) => candidate?.id === state.segmentId)
        : state.index;
      if (current < 0) return;
      let next = current + direction;
      while (next >= 0 && next < segments.length && this.isSegmentHiddenForDisplay(segments[next])) {
        next += direction;
      }
      if (next < 0 || next >= segments.length) return;
      const track = state.track;
      // 先提交并关闭当前气泡（提交幂等，与关闭路径不会产生双份撤销）。
      this.closeCueQuickEdit();
      if (track === 'extension') this.options.selectExtensionCue?.(next);
      else if (track === 'overlay') this.options.selectOverlayCue?.(next);
      else this.options.selectCue?.(next);
      const segment = this.options.getSegments(track)?.[next];
      if (segment) this.revealTime(Number(segment.start), true);
      this.openCueQuickEditAtIndex(track, next, null);
    }


    // 字词气泡内 Tab / Shift+Tab：在同句的上/下一个字词间切换（选中该
    // 字词并重新弹出气泡）。到句首/句尾弹 invalid 提示，保持当前气泡。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    navigateWordQuickEdit(segmentIndex, itemIndex, direction) {
      const segment = this.options.getSegments('main')?.[segmentIndex];
      if (!segment) return;
      const timing = this.cueTiming();
      const entries = window.AsrEditorUtils.getWordTimingEntries(segment, timing);
      const position = entries.findIndex((candidate) => candidate.index === itemIndex);
      if (position < 0) return;
      const next = position + direction;
      if (next < 0 || next >= entries.length) {
        window.MaweHint?.flashHint(localizedWaveformMessage(
          direction < 0
            ? '当前已经是第一个字词码，无法跳转'
            : '当前已经是最后一个字词码，无法跳转',
          direction < 0
            ? 'Already the first timed text block'
            : 'Already the last timed text block',
        ), 'invalid');
        return;
      }
      const target = entries[next];
      this.closeCueQuickEdit();
      // 选中目标字词（与点击字词块同一路径，面板/选区联动），滚动定位
      // 后重新弹出气泡。
      this.options.wordTiming?.select?.(segmentIndex, target.index);
      this.revealTime(timing.toMs(target.start), true);
      this.openWordQuickEditAtIndex(segmentIndex, target.index, null);
    }


    // 解析双击坐标在字幕块/字词块标签上的字符偏移（相对标签文本）。
    // 标签是 pointer-events:none，caretRangeFromPoint 的命中测试会穿到
    // 块之外，因此改用 Range 直接测量：先用 y 挑出命中的行盒，再在行内
    // 线性扫描最后一个 caret X 不超过点击 X 的偏移（O(n) 次 Range 测量，
    // 仅在打开气泡时执行一次）。标签被 ellipsis 截断时，x 钳制在可见
    // 右缘内，返回可见前缀内的偏移。解析失败返回 null。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    cueQuickEditCaretOffset(anchorElement, clientX, clientY) {
      const label = anchorElement?.querySelector?.('.waveform-cue-label, .waveform-word-label');
      const node = label?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return null;
      const collapsed = node.textContent || '';
      if (!collapsed) return null;
      const rect = label.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = clamp(clientX, rect.left, rect.right);
      const y = clamp(clientY, rect.top + 1, rect.bottom - 1);
      const full = document.createRange();
      full.selectNodeContents(node);
      const boxes = [...full.getClientRects()];
      if (!boxes.length) return null;
      // 用 y 挑选命中行盒（标签换行时只扫命中行；行间隙取最近行）。
      let line = null;
      let lineDistance = Infinity;
      for (const box of boxes) {
        if (y >= box.top && y <= box.bottom) { line = box; break; }
        const distance = y < box.top ? box.top - y : y - box.bottom;
        if (distance < lineDistance) { lineDistance = distance; line = box; }
      }
      if (!line) return null;
      let best = null;
      for (let offset = 0; offset <= collapsed.length; offset += 1) {
        const probe = document.createRange();
        probe.setStart(node, offset);
        probe.collapse(true);
        const box = probe.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        if (box.top > line.bottom + 1 || box.bottom < line.top - 1) continue;
        if (box.left <= x) best = offset;
        else break;
      }
      if (best === null) return null;
      return { collapsed, offset: best };
    }


    /** @this {import('./waveform-types.js').WaveformInstance} */
    positionCueQuickEdit() {
      const state = this.cueQuickEdit;
      if (!state?.element.isConnected) return;
      const popup = state.element;
      // 可视视口换算到内容坐标系：气泡是 content 的子元素、随内容滚动，
      // 翻转与钳制必须相对可视范围而不是整份内容，否则滚动后贴近视口
      // 顶部的块会把气泡顶进滚动容器的裁剪区。content 相对滚动容器有
      // 内部偏移（工具栏等），用实时 rect 差值求可视带在内容坐标系的原点。
      const contentRect = this.content.getBoundingClientRect();
      const scrollRect = this.scroll.getBoundingClientRect();
      const viewLeft = Math.round(scrollRect.left - contentRect.left);
      const viewTop = Math.round(scrollRect.top - contentRect.top);
      const layout = cueQuickEditLayout(
        state.anchor,
        popup.offsetWidth || 300,
        popup.offsetHeight || 120,
        viewLeft,
        viewTop,
        this.scroll.clientWidth,
        this.scroll.clientHeight,
      );
      popup.style.left = `${layout.left}px`;
      popup.style.top = `${layout.top}px`;
      popup.style.setProperty('--cue-quick-edit-arrow-x', `${layout.arrowX}px`);
      popup.classList.toggle('placement-below', layout.placement === 'below');
    }


    // 提交当前气泡文本（字幕与字词共用入口，实现方保证幂等：文本没变
    // 就不进命令层，因此 blur / 关闭双重触发也只会提交一次）。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    commitCueQuickEdit() {
      const state = this.cueQuickEdit;
      if (!state) return false;
      return Boolean(state.commit?.(state));
    }


    // 关闭气泡并提交未保存文本。状态先清空再移除元素，textarea 的 blur
    // 在元素移除后触发时不会再走进提交路径。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    closeCueQuickEdit() {
      const state = this.cueQuickEdit;
      if (!state) return;
      this.cueQuickEdit = null;
      if (this._cueQuickEditOutside) {
        document.removeEventListener('pointerdown', this._cueQuickEditOutside, true);
        this._cueQuickEditOutside = null;
      }
      if (this._cueQuickEditKey) {
        document.removeEventListener('keydown', this._cueQuickEditKey, true);
        this._cueQuickEditKey = null;
      }
      state.commit?.(state);
      state.resizeObserver?.disconnect();
      state.element.remove();
    }


    // 字幕气泡的提交实现：文本与目标字幕实时比对；字幕在打开期间被其他
    // 入口删除（按 id 找不到）时静默跳过，不把文本写到错位的下标上。
    /** @this {import('./waveform-types.js').WaveformInstance} */
    _commitCueQuickEditState(state) {
      if (!state) return false;
      const segments = this.options.getSegments(state.track) || [];
      const index = state.segmentId
        ? segments.findIndex((candidate) => candidate?.id === state.segmentId)
        : state.index;
      const segment = index >= 0 ? segments[index] : null;
      if (!segment) return false;
      const text = state.textarea.value.replace(/\r\n?/g, '\n');
      if (text === String(segment.text ?? '')) return false;
      this.options.onCueQuickEditText?.(state.track, index, text);
      return true;
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(WaveformMethods.prototype);
  delete descriptors.constructor;
  return Object.assign(descriptors, {
    cueQuickEditLayout: { value: cueQuickEditLayout },
    cueQuickEditOriginalOffset: { value: cueQuickEditOriginalOffset },
  });
}
