








MaweDom.overlayTextEl.append(MaweDom.overlayMainTextNode);

const overlayTrackTextEl = document.getElementById('overlay-track-text');
// 叠加轨预览的说话人标签：结构与主字幕预览一致（彩色标签 span + 文本节点）。
const overlayTrackSpeakerLabelEl = document.createElement('span');
overlayTrackSpeakerLabelEl.className = 'subtitle-speaker-label hidden';
const overlayTrackTextNode = document.createTextNode('');
overlayTrackTextEl?.append(overlayTrackSpeakerLabelEl, overlayTrackTextNode);





const subtitleFontFamilyInput = document.getElementById('subtitle-font-family');
const subtitleFontFamilyToggle = document.getElementById('subtitle-font-family-toggle');
const subtitleFontFamilyOptions = document.getElementById('subtitle-font-family-options');
// combobox 实例容器必须声明在启动早期的 relabelSubtitleFontFamilyOptions()
// 调用（模块求值 ~12000 行）之前，否则惰性创建赋值会踩暂时性死区。
let subtitleFontFamilyCombobox = null;
let assFontNameCombobox = null;







const subtitleColorAssModeHint = document.getElementById('subtitle-color-ass-mode-hint');
const subtitleColorAssModeHintLink = document.getElementById('ass-mode-hint-link');


const assColorStyleRow = document.getElementById('ass-color-style-row');
const assColorStyleSelect = document.getElementById('ass-color-style');
const assColorSpeakerHint = document.getElementById('ass-color-speaker-hint');
const assColorSpeakerExportLink = document.getElementById('ass-color-speaker-export-link');







const assModeToggle = document.getElementById('ass-mode-toggle');
const assStyleManagerOpenButton = document.getElementById('ass-style-manager-open');
const assStyleSummary = document.getElementById('ass-style-summary');





























// 预览层（字幕/表情包）的定位与几何测量都以 stage 为基准，不含顶部媒体工具栏。
















  // 「隐藏禁用项」开关状态




































const helpOpenEditorSettingsButtons = Array.from(document.querySelectorAll('[data-help-open-editor-settings]'));








const pauseOnMouseClickToggle = document.getElementById('pause-on-mouse-click');

































































const lottieExportCustomSize = document.getElementById('lottie-export-custom-size');
const lottieExportCustomWidth = document.getElementById('lottie-export-custom-width');
const lottieExportCustomHeight = document.getElementById('lottie-export-custom-height');








const ografExportCustomSize = document.getElementById('ograf-export-custom-size');
const ografExportCustomWidth = document.getElementById('ograf-export-custom-width');
const ografExportCustomHeight = document.getElementById('ograf-export-custom-height');





























const overlayTrackToggle = document.getElementById('overlay-track-toggle');
const overlayTrackSeparator = document.getElementById('overlay-track-separator');






// 已开启多重字幕但尚未加载第二条字幕时的开关右侧提示。


































const multiSubtitleSplitDuplicate = document.getElementById('multi-subtitle-split-duplicate');




























































const assStyleWindow = document.getElementById('ass-style-window');
const assStyleDragHandle = document.getElementById('ass-style-drag-handle');
const assStyleWindowClose = document.getElementById('ass-style-window-close');
const assStyleWindowCloseFooter = document.getElementById('ass-style-window-close-footer');
const assStyleLibraryStatus = document.getElementById('ass-style-library-status');
const assStyleLocalFontScanButton = document.getElementById('ass-style-local-font-scan');
const assStyleFontToggle = document.getElementById('ass-style-font-toggle');
const assStyleFontOptions = document.getElementById('ass-font-name-options');
const assStyleCount = document.getElementById('ass-style-count');
const assProfileCount = document.getElementById('ass-profile-count');
const assStyleList = document.getElementById('ass-style-list');
const assProfileList = document.getElementById('ass-profile-list');
const assStyleNewButton = document.getElementById('ass-style-new');
const assStyleDuplicateButton = document.getElementById('ass-style-duplicate');
const assProfileNewButton = document.getElementById('ass-profile-new');
const assSrtDefaultStyleSelect = document.getElementById('ass-srt-default-style');
const assDefaultProfileSelect = document.getElementById('ass-ass-default-profile');
const subtitleStyleAssModeHint = document.getElementById('subtitle-style-ass-mode-hint');
const mainSubtitleCssFields = document.getElementById('main-subtitle-css-fields');
const mainAssStyleFields = document.getElementById('main-ass-style-fields');
const mainAssStyleSelect = document.getElementById('main-ass-style-select');
const mainAssStyleEditButton = document.getElementById('main-ass-style-edit');
const extensionSubtitleCssFields = document.getElementById('extension-subtitle-css-fields');
const extensionAssStyleFields = document.getElementById('extension-ass-style-fields');
const extensionAssStyleSelect = document.getElementById('extension-ass-style-select');
const extensionAssStyleEditButton = document.getElementById('extension-ass-style-edit');
const assStyleForm = document.getElementById('ass-style-form');
const assProfileForm = document.getElementById('ass-profile-form');
const assProfileStyleSelect = document.getElementById('ass-profile-style-id');
const assProfileExtensionStyleField = document.getElementById('ass-profile-extension-style-field');
const assProfileExtensionStyleSelect = document.getElementById('ass-profile-extension-style');
const assStyleEditorEmpty = document.getElementById('ass-style-editor-empty');
const assStyleFormTitle = document.getElementById('ass-style-form-title');
const assProfileFormTitle = document.getElementById('ass-profile-form-title');
const assStyleSrtHint = document.getElementById('ass-style-srt-hint');
const assStylePreviewModeHint = document.getElementById('ass-style-preview-mode-hint');
const assStyleSettingsLink = document.getElementById('ass-style-settings-link');
const assStyleBuiltinBadge = document.getElementById('ass-style-builtin-badge');
const assProfileBuiltinBadge = document.getElementById('ass-profile-builtin-badge');
const assStyleDeleteSlot = document.getElementById('ass-style-delete-slot');
const assProfileDeleteSlot = document.getElementById('ass-profile-delete-slot');
const assStylePreviewSample = document.getElementById('ass-style-preview-sample');
const assProfilePreviewSummary = document.getElementById('ass-profile-preview-summary');
const assStyleSaveButton = document.getElementById('ass-style-save');
const assStyleDeleteButton = document.getElementById('ass-style-delete');
const assStyleLibraryPathHint = document.getElementById('ass-style-library-path-hint');





















// 先登记所有可独立激活的非模态浮层。嵌套在全局设置窗口里的齿轮弹窗会
// 自动归到全局设置窗口这一层，点击它们时也会把外层窗口带到最前面。
// 表情包根目录弹窗从全局设置窗口打开，同样入栈，打开时动态置顶盖住窗口
//（CSS 的 335 只是 JS 初始化前的静态兜底）。
[
  MaweDom.editorSettingsPanel,
  assStyleWindow,
  MaweDom.helpPanel,
  MaweDom.gapRemovePanel,
  MaweDom.autoMergePanel,
  MaweDom.subtitleExtendPanel,
  MaweDom.mergeJoinSettingsPanel,
  MaweDom.splitTrimSettingsPanel,
  MaweDom.cueListSettingsPanel,
  MaweDom.cueEditorSettingsPanel,
  MaweDom.waveformSettingsPanel,
  MaweDom.multiSubtitleSettingsDropdown,
  document.getElementById('sticker-root-modal'),
  ...document.querySelectorAll('.toolbar .dropdown'),
].forEach(MaweFloatingPanel.bindFloatingSurfaceActivation);






































// 全局设置窗口：复用 createFloatingPanel 获得拖动、位置持久化、Esc 关闭与按钮 active 态；
// 窗口内部用左侧垂直标签页切换不同分区，并记忆用户上次停留的分区。
