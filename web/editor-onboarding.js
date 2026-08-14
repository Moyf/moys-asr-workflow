(() => {
const helpOnboardingButton = document.getElementById('help-onboarding');
const onboardingLayer = document.getElementById('onboarding-layer');
const onboardingSpotlight = document.getElementById('onboarding-spotlight');
const onboardingCard = document.getElementById('onboarding-card');
const onboardingStepCount = document.getElementById('onboarding-step-count');
const onboardingGlyph = document.getElementById('onboarding-glyph');
const onboardingEyebrow = document.getElementById('onboarding-eyebrow');
const onboardingTitle = document.getElementById('onboarding-title');
const onboardingDescription = document.getElementById('onboarding-description');
const onboardingDescriptionNote = document.getElementById('onboarding-description-note');
const onboardingDemo = document.getElementById('onboarding-demo');
const onboardingStatus = document.getElementById('onboarding-status');
const onboardingFootnote = document.getElementById('onboarding-footnote');
const onboardingSkip = document.getElementById('onboarding-skip');
const onboardingSecondary = document.getElementById('onboarding-secondary');
const onboardingPrimary = document.getElementById('onboarding-primary');
const onboardingHelp = document.getElementById('onboarding-help');
const ONBOARDING_STORAGE_KEY = 'moy.asr.editor.onboarding.v1';
const ONBOARDING_STEP_COUNT = 3;
  const editor = window.MAWE_EDITOR_BRIDGE;
  const {
    data: DATA,
    selectedIdxs,
    container,
    projectMediaModal,
    selectOnly,
    performUndo,
    flashHint,
    scrollCueToCenter,
    setEditorSettingsPanelOpen,
    modKeyLabel,
    splitKeyLabel,
  } = editor;
// === 首次打开快速上手 ===
// 快速上手分成三段：WASD 移动 3 次 → Shift+WASD、C、撤销分阶段练习 → 拆分。
// 前两段直接复用编辑器真实选择/历史逻辑；拆分直接引导用户在实际字幕上完成操作。
const onboardingState = {
  open: false,
  mode: 'tour', // 'tour' | 'empty'
  step: 0,
  phase: 'idle', // idle | navigation | navigation-complete | merge-armed | merge-ready | await-undo | merge-complete | split-demo | split-live | complete
  started: false,
  moves: 0,
  lastCueIdx: -1,
  lastMoveKey: '',
  shiftUsed: false,
  mergeBeforeCount: 0,
  mergeSelectedCount: 0,
  splitBeforeCount: 0,
  splitTargetIdx: -1,
};
let onboardingPositionFrame = 0;
let onboardingAdvanceTimer = 0;

function readOnboardingStatus() {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

function saveOnboardingStatus(status) {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, status);
  } catch (_) {
    // file:// 隐私模式下可能拒绝 localStorage；本次页面仍可继续引导。
  }
}

function onboardingIsOpen() {
  return Boolean(onboardingLayer && !onboardingLayer.hidden && onboardingState.open);
}

function onboardingResetTransient() {
  onboardingState.open = false;
  onboardingState.mode = 'tour';
  onboardingState.step = 0;
  onboardingState.phase = 'idle';
  onboardingState.started = false;
  onboardingState.moves = 0;
  onboardingState.lastCueIdx = -1;
  onboardingState.lastMoveKey = '';
  onboardingState.shiftUsed = false;
  onboardingState.mergeBeforeCount = 0;
  onboardingState.mergeSelectedCount = 0;
  onboardingState.splitBeforeCount = 0;
  onboardingState.splitTargetIdx = -1;
  clearTimeout(onboardingAdvanceTimer);
}

function hideOnboarding() {
  if (!onboardingLayer) return;
  onboardingResetTransient();
  onboardingLayer.hidden = true;
  onboardingLayer.setAttribute('aria-hidden', 'true');
  onboardingSpotlight?.classList.remove('show');
  onboardingCard?.classList.remove('complete');
}

function onboardingGetTarget() {
  if (onboardingState.mode === 'empty') return document.getElementById('open-project');
  const selected = container?.querySelector('.cue.selected');
  if (selected) return selected;
  if (onboardingState.step === 2) return container;
  return container;
}

function positionOnboarding() {
  if (!onboardingIsOpen() || !onboardingSpotlight) return;
  const target = onboardingGetTarget();
  if (!target) {
    onboardingSpotlight.classList.remove('show');
    return;
  }
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    onboardingSpotlight.classList.remove('show');
    return;
  }
  const pad = 4;
  onboardingSpotlight.style.left = `${Math.round(rect.left - pad)}px`;
  onboardingSpotlight.style.top = `${Math.round(rect.top - pad)}px`;
  onboardingSpotlight.style.width = `${Math.round(rect.width + pad * 2)}px`;
  onboardingSpotlight.style.height = `${Math.round(rect.height + pad * 2)}px`;
  onboardingSpotlight.classList.add('show');
}

function requestOnboardingPosition() {
  cancelAnimationFrame(onboardingPositionFrame);
  onboardingPositionFrame = requestAnimationFrame(() => positionOnboarding());
}

function onboardingModKey() {
  return modKeyLabel();
}

function onboardingIsEnglish() {
  return window.MAWE_I18N?.language === 'en';
}

function onboardingSplitKey() {
  return splitKeyLabel();
}

function onboardingText(value) {
  const text = String(value ?? '');
  const translateText = window.MAWE_I18N?.translateText;
  return typeof translateText === 'function' ? translateText(text) : text;
}

function onboardingSentence(parts) {
  const separator = onboardingIsEnglish() ? ' ' : '';
  return parts.map((part) => onboardingText(part)).join(separator);
}

function onboardingSplitDescription() {
  const key = onboardingSplitKey().replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
  return onboardingText('双击字幕列表中的字幕，光标会自动放置在点击位置，按 {key} 即可拆分。')
    .replace('{key}', `<kbd>${key}</kbd>`);
}

function onboardingSettingsTip() {
  return onboardingText('编辑字幕时，也可以选择用 Enter 直接拆分——在【设置】中可修改按键')
    .replace('【设置】', `<button type="button" id="onboarding-split-settings">${onboardingText('设置')}</button>`);
}

function onboardingSetStatus(parts) {
  if (!onboardingStatus) return;
  if (Array.isArray(parts)) {
    onboardingStatus.innerHTML = parts.join('');
  } else {
    onboardingStatus.textContent = parts || '';
  }
}

function refreshOnboardingSplitKeyOptions() {
  const options = document.getElementById('onboarding-split-key-options');
  if (options) {
    options.textContent = `Enter / ${onboardingModKey()}+Enter`;
  }
}

function renderOnboardingDemo() {
  if (!onboardingDemo) return;
  if (onboardingState.mode === 'empty') {
    onboardingDemo.innerHTML = `<div class="onboarding-empty-demo">📂 <span>${onboardingText('打开一个工程后，这里会带你熟悉最常用的字幕操作。')}</span></div>`;
    return;
  }
  if (onboardingState.step === 0) {
    const activeKey = onboardingState.lastMoveKey || '';
    onboardingDemo.innerHTML = `
      <div class="onboarding-key-grid" aria-label="${onboardingText('WASD 键位示意')}">
        <span></span><span class="onboarding-key ${activeKey === 'w' ? 'active' : ''}">W</span><span></span><span></span>
        <span class="onboarding-key ${activeKey === 'a' ? 'active' : ''}">A</span>
        <span class="onboarding-key ${activeKey === 's' ? 'active' : ''}">S</span>
        <span class="onboarding-key ${activeKey === 'd' ? 'active' : ''}">D</span><span></span>
      </div>`;
    return;
  }
  if (onboardingState.step === 1) {
    if (onboardingState.phase === 'merge-complete') {
      onboardingDemo.innerHTML = `<div class="onboarding-undo-demo"><span>${onboardingText('已撤销')}</span><span class="mini-check">✓</span></div>`;
      return;
    }
    const merged = onboardingState.phase === 'await-undo';
    const selectedCount = Math.max(1, Math.min(3, selectedIdxs.size));
    onboardingDemo.innerHTML = merged
      ? `<div class="onboarding-mini-cues"><div class="onboarding-mini-cue merged"><b>01</b><span>${onboardingText('连续字幕已合并')}</span><span class="mini-check">✓</span></div></div>`
      : `<div class="onboarding-mini-cues">
          <div class="onboarding-mini-cue ${selectedCount >= 1 ? 'selected' : ''}"><b>01</b><span>${onboardingText('第一条字幕')}</span></div>
          <div class="onboarding-mini-cue ${selectedCount >= 2 ? 'selected' : ''}"><b>02</b><span>${onboardingText('第二条字幕')}</span></div>
          <div class="onboarding-mini-cue ${selectedCount >= 3 ? 'selected' : ''}"><b>03</b><span>${onboardingText('第三条字幕')}</span></div>
        </div>`;
    return;
  }
  if (onboardingState.phase === 'split-live') {
    onboardingDemo.innerHTML = `<div class="onboarding-undo-demo"><span>${onboardingText('高亮字幕')}</span><kbd>${onboardingSplitKey()}</kbd><span>${onboardingText('真实拆分')}</span></div>`;
    return;
  }
  if (onboardingState.phase === 'complete') {
    onboardingDemo.innerHTML = `
      <ul class="onboarding-extra-tips" id="onboarding-extra-tips">
        <li>${onboardingText('你也可以右键点击字幕后选择拆分')}</li>
        <li>${onboardingText('鼠标在波形区时，可以右键拆分，也可以按B在鼠标位置拆分')}</li>
        <li>${onboardingSettingsTip()}</li>
      </ul>`;
    return;
  }
  onboardingDemo.innerHTML = `<div class="onboarding-split-demo"><span class="onboarding-split-piece">${onboardingText('今天的天气很好')}</span><span class="onboarding-split-caret" aria-hidden="true"></span><span class="onboarding-split-piece right">${onboardingText('我们去散步吧')}</span></div>`;
}

function renderOnboarding() {
  if (!onboardingLayer) return;
  onboardingLayer.hidden = !onboardingState.open;
  onboardingLayer.setAttribute('aria-hidden', String(!onboardingState.open));
  if (!onboardingState.open) return;

  onboardingCard?.classList.toggle('complete', onboardingState.phase === 'complete');
  onboardingStepCount.textContent = onboardingState.mode === 'empty'
    ? '' : `${onboardingState.step + 1} / ${ONBOARDING_STEP_COUNT}`;
  onboardingFootnote.hidden = onboardingState.mode === 'empty' || onboardingState.phase === 'complete';
  onboardingSecondary.hidden = true;
  onboardingPrimary.disabled = false;
  onboardingPrimary.hidden = false;
  if (onboardingDescriptionNote) onboardingDescriptionNote.hidden = true;
  refreshOnboardingSplitKeyOptions();

  if (onboardingState.mode === 'empty') {
    onboardingGlyph.textContent = '↗';
    onboardingEyebrow.textContent = onboardingText('快速上手');
    onboardingTitle.textContent = onboardingText('打开工程后开始快速上手');
    onboardingDescription.textContent = onboardingText('先打开一个包含字幕的工程；编辑器会用 3 个短练习带你熟悉最常用的操作。');
    onboardingSetStatus('');
    onboardingPrimary.textContent = onboardingText('打开工程');
    onboardingSecondary.textContent = onboardingText('稍后再试');
    onboardingSecondary.hidden = false;
    renderOnboardingDemo();
    requestOnboardingPosition();
    return;
  }

  if (onboardingState.phase === 'complete') {
    onboardingGlyph.textContent = '✓';
    onboardingEyebrow.textContent = onboardingText('快速上手完成');
    onboardingTitle.textContent = onboardingText('完成！');
    onboardingDescription.textContent = onboardingSentence([
      '已掌握基础操作。',
      '可以在右上角的【🤔 帮助】中随时查看。',
    ]);
    onboardingSetStatus('');
    onboardingPrimary.textContent = onboardingText('打开完整帮助');
    onboardingSecondary.textContent = onboardingText('结束引导');
    onboardingSecondary.hidden = false;
    renderOnboardingDemo();
    requestOnboardingPosition();
    return;
  }

  if (onboardingState.step === 0) {
    onboardingGlyph.textContent = 'W';
    onboardingEyebrow.textContent = onboardingText('像玩游戏一样编辑');
    onboardingTitle.textContent = onboardingText('使用 WASD 选择前后字幕——就像游戏一样！');
    onboardingDescription.textContent = onboardingText('先选中任意一条字幕，然后用 WASD 在前后字幕之间移动。移动 3 次后点击下一步。');
    if (onboardingDescriptionNote) {
      onboardingDescriptionNote.textContent = onboardingText('在字幕列表，用 W 和 S 「上下」选择字幕，在波形区，用 A 和 D 「左右」选择字幕——取决于你观看的视角 😏');
      onboardingDescriptionNote.hidden = false;
    }
    const navigationComplete = onboardingState.phase === 'navigation-complete';
    onboardingSetStatus(navigationComplete
      ? ['<span>', onboardingText('已选择'), '</span> <b>', String(onboardingState.moves), '</b> / 3 <span>', onboardingText('次'), '</span> · ', onboardingText('已完成，点击下一步')]
      : ['<span>', onboardingText('已选择'), '</span> <b>', String(onboardingState.moves), '</b> / 3 <span>', onboardingText('次'), '</span>']);
    onboardingPrimary.hidden = !navigationComplete;
    onboardingPrimary.textContent = onboardingText('下一步');
    onboardingPrimary.disabled = false;
  } else if (onboardingState.step === 1) {
    onboardingGlyph.textContent = 'C';
    onboardingEyebrow.textContent = onboardingText('常见操作');
    onboardingPrimary.hidden = true;
    if (onboardingState.phase === 'merge-complete') {
      onboardingTitle.textContent = onboardingText('合并已撤销');
      onboardingDescription.textContent = onboardingText('操作已恢复，点击下一步进入拆分。');
      onboardingSetStatus(onboardingText('已完成，点击下一步'));
      onboardingPrimary.hidden = false;
      onboardingPrimary.textContent = onboardingText('下一步');
    } else if (onboardingState.phase === 'await-undo') {
      const titleSeparator = onboardingIsEnglish() ? ': ' : '：';
      onboardingTitle.textContent = `${onboardingModKey()}+Z${titleSeparator}${onboardingText('撤销刚才的合并')}`;
      onboardingDescription.textContent = onboardingSentence([
        '已合并。现在按', `${onboardingModKey()}+Z`, '撤销刚才的合并。',
      ]);
      onboardingSetStatus([
        '<span>', onboardingText('已合并'), '</span> <b>', String(onboardingState.mergeSelectedCount), '</b> <span>',
        onboardingText('条'), ' · ', onboardingText('请按'), '</span> <b>', onboardingModKey(), '+Z</b>',
      ]);
      onboardingPrimary.textContent = onboardingText('等待撤销');
      onboardingPrimary.disabled = true;
    } else if (onboardingState.phase === 'merge-ready') {
      onboardingTitle.textContent = onboardingText('按 C 合并字幕');
      onboardingDescription.textContent = onboardingText('已选中连续字幕，现在按 C 合并。');
      onboardingSetStatus([
        '<span>', onboardingText('已选'), '</span> <b>', String(onboardingState.mergeSelectedCount), '</b> <span>',
        onboardingText('条'), ' · ', onboardingText('请按'), '</span> <b>C</b>',
      ]);
    } else {
      onboardingTitle.textContent = onboardingText('Shift + WASD：扩展选择');
      onboardingDescription.textContent = onboardingText('按住 Shift，用 WASD 扩展选择，选中至少两条连续字幕。');
      onboardingSetStatus([
        '<span>', onboardingText('已选'), '</span> <b>', String(selectedIdxs.size), '</b> <span>', onboardingText('条'), '</span>',
      ]);
    }
  } else {
    onboardingGlyph.textContent = '↪';
    onboardingEyebrow.textContent = onboardingText('编辑时间线');
    onboardingTitle.textContent = onboardingText('最后：在光标处拆分字幕');
    if (onboardingState.phase === 'split-live') {
      onboardingDescription.innerHTML = onboardingSplitDescription();
      onboardingSetStatus(['<span>', onboardingText('请按'), '</span> <b>', onboardingSplitKey(), '</b> <span>', onboardingText('完成真实拆分'), '</span>']);
      onboardingPrimary.hidden = true;
      onboardingPrimary.disabled = true;
      onboardingSecondary.textContent = onboardingText('跳过实际拆分');
      onboardingSecondary.hidden = false;
    } else {
      onboardingDescription.innerHTML = onboardingSplitDescription();
      onboardingSetStatus('');
      onboardingPrimary.hidden = true;
      onboardingSecondary.textContent = onboardingText('跳过实际拆分');
      onboardingSecondary.hidden = false;
    }
  }
  renderOnboardingDemo();
  requestOnboardingPosition();
}

function findOnboardingSplitTarget() {
  for (let i = 0; i < DATA.segments.length; i++) {
    const segment = DATA.segments[i];
    if (segment && segment.end - segment.start >= 200 && String(segment.text || '').trim().length >= 2) return i;
  }
  return -1;
}

function onboardingFocusCard() {
  onboardingCard?.focus({ preventScroll: true });
}

function openOnboarding({ force = false } = {}) {
  if (!onboardingLayer) return;
  if (!force && readOnboardingStatus()) return;
  if (!DATA.segments.length) {
    onboardingResetTransient();
    onboardingState.open = true;
    onboardingState.mode = 'empty';
    renderOnboarding();
    return;
  }
  onboardingResetTransient();
  onboardingState.open = true;
  onboardingState.mode = 'tour';
  onboardingState.step = 0;
  onboardingState.phase = 'navigation';
  startOnboardingNavigation();
}

function maybeStartOnboarding() {
  if (onboardingIsOpen()) {
    if (onboardingState.mode === 'empty' && DATA.segments.length) openOnboarding({ force: true });
    return;
  }
  if (readOnboardingStatus()) return;
  if (projectMediaModal?.classList.contains('show')) return;
  openOnboarding();
}

function finishOnboarding(status = 'completed') {
  // 引导中如果停在真实合并之后，跳过时先恢复工程，避免留下半完成的教学改动。
  if (onboardingState.phase === 'await-undo' && DATA.segments.length < onboardingState.mergeBeforeCount) {
    performUndo();
  }
  saveOnboardingStatus(status);
  hideOnboarding();
}

function advanceOnboardingStep(nextStep) {
  clearTimeout(onboardingAdvanceTimer);
  onboardingState.step = nextStep;
  if (nextStep === 1) {
    startOnboardingMerge();
    return;
  }
  if (nextStep === 2) {
    prepareOnboardingSplit();
    return;
  }
  onboardingState.phase = nextStep === 0 ? 'idle' : nextStep === 1 ? 'idle' : 'split-demo';
  onboardingState.started = false;
  onboardingState.shiftUsed = false;
  onboardingState.moves = nextStep === 0 ? onboardingState.moves : 0;
  renderOnboarding();
  onboardingFocusCard();
}

function startOnboardingNavigation() {
  onboardingState.started = true;
  onboardingState.phase = 'navigation';
  onboardingState.moves = 0;
  const startIdx = editor.currentCuePanelIdx >= 0 ? editor.currentCuePanelIdx : 0;
  selectOnly(Math.min(startIdx, DATA.segments.length - 1));
  onboardingState.lastCueIdx = editor.currentCuePanelIdx;
  renderOnboarding();
  onboardingFocusCard();
}

function startOnboardingMerge() {
  onboardingState.started = true;
  onboardingState.phase = 'merge-armed';
  onboardingState.shiftUsed = false;
  onboardingState.mergeBeforeCount = DATA.segments.length;
  onboardingState.mergeSelectedCount = 0;
  if (selectedIdxs.size !== 1) selectOnly(editor.currentCuePanelIdx >= 0 ? editor.currentCuePanelIdx : 0);
  renderOnboarding();
  onboardingFocusCard();
}

function prepareOnboardingSplit() {
  const targetIdx = findOnboardingSplitTarget();
  if (targetIdx < 0) {
    flashHint(onboardingText('当前工程没有足够长的字幕可用于拆分练习'), 'invalid');
    finishOnboarding('completed');
    return;
  }
  onboardingState.phase = 'split-demo';
  onboardingState.started = true;
  onboardingState.splitBeforeCount = DATA.segments.length;
  onboardingState.splitTargetIdx = targetIdx;
  selectOnly(targetIdx);
  const target = container.querySelector(`.cue[data-idx="${targetIdx}"]`);
  if (target) {
    scrollCueToCenter(target);
    // 教学中的真实拆分需要一个可直接双击的字幕；原有舒适区逻辑可能认为
    // 目标已在列表内，却刚好落在 sticky 工具栏后面，这里用一次即时居中兜底。
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  }
  renderOnboarding();
  onboardingFocusCard();
}

function beginOnboardingRealSplit(idx) {
  if (onboardingState.step !== 2 || onboardingState.phase !== 'split-demo'
      || idx !== onboardingState.splitTargetIdx) return;
  onboardingState.phase = 'split-live';
  onboardingState.started = true;
  renderOnboarding();
  onboardingFocusCard();
}

function onboardingObserveRender() {
  if (!onboardingIsOpen() || onboardingState.mode !== 'tour') return;
  if (onboardingState.step === 1 && (onboardingState.phase === 'merge-armed' || onboardingState.phase === 'merge-ready')
      && DATA.segments.length < onboardingState.mergeBeforeCount) {
    onboardingState.phase = 'await-undo';
    onboardingState.started = true;
    onboardingState.mergeSelectedCount = Math.max(2, onboardingState.mergeSelectedCount || 2);
    renderOnboarding();
    flashHint(onboardingIsEnglish()
      ? `Merged ${onboardingState.mergeSelectedCount} subtitles; now press ${onboardingModKey()}+Z to undo.`
      : `已合并 ${onboardingState.mergeSelectedCount} 条；现在按 ${onboardingModKey()}+Z 撤销`, 'success');
    return;
  }
  if (onboardingState.step === 1 && onboardingState.phase === 'await-undo'
      && DATA.segments.length === onboardingState.mergeBeforeCount) {
    flashHint(onboardingText('已撤销这次体验，请点击下一步学习拆分'), 'success');
    onboardingState.phase = 'merge-complete';
    onboardingState.started = false;
    renderOnboarding();
    onboardingFocusCard();
    return;
  }
  if (onboardingState.step === 2 && (onboardingState.phase === 'split-demo' || onboardingState.phase === 'split-live')
      && DATA.segments.length > onboardingState.splitBeforeCount) {
    onboardingState.phase = 'complete';
    onboardingState.started = false;
    saveOnboardingStatus('completed');
    renderOnboarding();
    flashHint(onboardingText('拆分已完成；需要回退时可以使用撤销'), 'success');
  }
}

function closeOnboardingAndOpenHelp() {
  finishOnboarding('completed');
  editor.openHelp();
}

onboardingPrimary?.addEventListener('click', () => {
  if (onboardingState.mode === 'empty') {
    hideOnboarding();
    document.getElementById('open-project')?.click();
    return;
  }
  if (onboardingState.phase === 'complete') {
    closeOnboardingAndOpenHelp();
    return;
  }
  if (onboardingState.step === 0 && onboardingState.phase === 'navigation-complete') advanceOnboardingStep(1);
  else if (onboardingState.step === 1 && onboardingState.phase === 'merge-complete') advanceOnboardingStep(2);
});

onboardingSecondary?.addEventListener('click', () => {
  if (onboardingState.mode === 'empty') {
    finishOnboarding('skipped');
    return;
  }
  if (onboardingState.step === 2 && onboardingState.phase === 'split-demo') {
    finishOnboarding('completed');
    return;
  }
  if (onboardingState.step === 2 && onboardingState.phase === 'split-live') {
    finishOnboarding('skipped');
  } else if (onboardingState.phase === 'complete') {
    finishOnboarding('completed');
  }
});

onboardingSkip?.addEventListener('click', () => finishOnboarding('skipped'));
onboardingHelp?.addEventListener('click', () => closeOnboardingAndOpenHelp());
onboardingDemo?.addEventListener('click', (event) => {
  const target = event.target instanceof Element
    ? event.target.closest('#onboarding-split-settings')
    : null;
  if (!target) return;
  setEditorSettingsPanelOpen(true);
  target.blur();
});
helpOnboardingButton?.addEventListener('click', () => {
  editor.closeHelp();
  openOnboarding({ force: true });
});
document.addEventListener('mawe:languagechange', () => {
  if (onboardingIsOpen()) renderOnboarding();
});
window.addEventListener('resize', requestOnboardingPosition);
window.addEventListener('scroll', requestOnboardingPosition, true);

function scheduleOnboardingAfterRender() {
  requestAnimationFrame(() => {
    maybeStartOnboarding();
    onboardingObserveRender();
    requestOnboardingPosition();
  });
}
// 快速上手在打开时就接管自己的练习阶段；普通首次打开不会影响现有快捷键。
// 这个监听器放在 WASD / C 的真实快捷键之后，确保读取到已经更新的选区。
document.addEventListener('keydown', (event) => {
  if (!onboardingIsOpen()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    finishOnboarding('skipped');
    return;
  }
  if (onboardingState.mode !== 'tour' || !onboardingState.started) return;
  const key = event.key.toLowerCase();
  const wasd = key === 'w' || key === 'a' || key === 's' || key === 'd';
  if (onboardingState.step === 0 && onboardingState.phase === 'navigation'
      && wasd && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.repeat) {
    const nextIdx = editor.currentCuePanelIdx;
    if (nextIdx >= 0 && nextIdx !== onboardingState.lastCueIdx) {
      onboardingState.lastCueIdx = nextIdx;
      onboardingState.moves += 1;
      onboardingState.lastMoveKey = key;
      renderOnboarding();
      if (onboardingState.moves >= 3) {
        onboardingAdvanceTimer = setTimeout(() => {
          if (!onboardingIsOpen() || onboardingState.step !== 0 || onboardingState.moves < 3) return;
          onboardingState.phase = 'navigation-complete';
          onboardingState.started = false;
          renderOnboarding();
          onboardingFocusCard();
        }, 420);
      }
    }
    return;
  }
  if (onboardingState.step === 1 && onboardingState.phase === 'merge-armed'
      && wasd && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.repeat) {
    if (selectedIdxs.size > 1) {
      onboardingState.shiftUsed = true;
      onboardingState.mergeSelectedCount = selectedIdxs.size;
      onboardingState.phase = 'merge-ready';
      renderOnboarding();
    }
  }
});

  window.MAWE_ONBOARDING = Object.freeze({
    afterRender: scheduleOnboardingAfterRender,
    scheduleStart: scheduleOnboardingAfterRender,
    beginRealSplit: beginOnboardingRealSplit,
  });
  window.MAWE?.register('onboarding', () => window.MAWE_ONBOARDING);
  scheduleOnboardingAfterRender();
})();
