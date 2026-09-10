// 编辑器设置：键名、默认值、localStorage 读写与 EDITOR_SETTINGS 中心可变对象。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSettings 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweSettings(global) {
  'use strict';


  const EDITOR_SETTINGS_KEY = 'moy.asr.editor.settings.v1';


  const GAP_REMOVE_SCHEMA = window.AsrGapRemoveCore.GAP_REMOVE_SCHEMA;


  const MEDIA_SEEK_STEP_MIN_MS = 10;


  const MEDIA_SEEK_STEP_MAX_MS = 60000;


  const MEDIA_SEEK_STEP_FINE_THRESHOLD_MS = 100;


  const MEDIA_SEEK_STEP_FINE_MS = 10;


  const MEDIA_SEEK_STEP_COARSE_MS = 100;


  const DEFAULT_MEDIA_SEEK_STEP_MS = 1000;


  const CUE_MOVE_STEP_MIN_MS = 10;


  const CUE_MOVE_STEP_MAX_MS = 2000;


  const DEFAULT_CUE_MOVE_STEP_MS = 50;


  function clampMediaSeekStepMs(value) {
    const rounded = Math.round(Number(value));
    return Math.min(
      MEDIA_SEEK_STEP_MAX_MS,
      Math.max(
        MEDIA_SEEK_STEP_MIN_MS,
        Number.isFinite(rounded) ? rounded : DEFAULT_MEDIA_SEEK_STEP_MS,
      ),
    );
  }



  function mediaSeekStepForValue(value) {
    return clampMediaSeekStepMs(value) <= MEDIA_SEEK_STEP_FINE_THRESHOLD_MS
      ? MEDIA_SEEK_STEP_FINE_MS
      : MEDIA_SEEK_STEP_COARSE_MS;
  }



  function nextMediaSeekStepValue(value, direction) {
    const current = clampMediaSeekStepMs(value);
    if (!direction) return current;
    const sign = direction < 0 ? -1 : 1;
    const step = sign < 0
      ? (current <= MEDIA_SEEK_STEP_FINE_THRESHOLD_MS
        ? MEDIA_SEEK_STEP_FINE_MS : MEDIA_SEEK_STEP_COARSE_MS)
      : (current < MEDIA_SEEK_STEP_FINE_THRESHOLD_MS
        ? MEDIA_SEEK_STEP_FINE_MS : MEDIA_SEEK_STEP_COARSE_MS);
    return clampMediaSeekStepMs(current + sign * step);
  }



  // 原生 number 输入框以 min=10、step=100 计算大于 100 的向下步进时，
  // 会把 200 算成 110。把这个浏览器步进结果还原为用户看到的 100ms 档位，
  // 同时保留 100ms 向下 90ms、向上 200ms 的边界行为。
  function normalizeNativeMediaSeekStepValue(value, previousValue) {
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric)) return null;
    const previous = clampMediaSeekStepMs(previousValue);
    const delta = numeric - previous;
    const step = mediaSeekStepForValue(previous);
    const nativeDownDelta = previous > MEDIA_SEEK_STEP_FINE_THRESHOLD_MS
      ? -(step - MEDIA_SEEK_STEP_MIN_MS)
      : -step;
    if (delta === step || delta === nativeDownDelta) {
      return nextMediaSeekStepValue(previous, delta < 0 ? -1 : 1);
    }
    return clampMediaSeekStepMs(numeric);
  }



  function clampCueMoveStepMs(value) {
    const rounded = Math.round(Number(value));
    return Math.min(
      CUE_MOVE_STEP_MAX_MS,
      Math.max(CUE_MOVE_STEP_MIN_MS, Number.isFinite(rounded) ? rounded : DEFAULT_CUE_MOVE_STEP_MS),
    );
  }


  const DEFAULT_EDITOR_SETTINGS = {
    splitKey: 'enter',
    splitUseWordTimestamps: true,
    // 主字幕拆分类型手动指定偏好：word / continuous / null（跟随工程与检测）。
    mainSplitModeOverride: null,
    // 拆分弹窗中选完所有需要确认的断点后自动提交。
    splitAutoSubmit: true,
    overlayEnabled: true,
    // 多重字幕开启时，副字幕预览默认自动显示。
    extensionOverlayEnabled: true,
    // 多重字幕开启时使用的波形行高度；关闭多重字幕后恢复「配置」中的高度。
    multiSubtitleRowHeight: 168,
    exportStartAtZero: false,
    cueListShowIndex: true,
    cueListShowTime: true,
    cueListShowSticker: true,
    cueListShowCharcount: true,
    // 字幕列表普通点击是否把目标字幕滚动到列表中央。
    cueListAutoScrollOnClick: true,
    // “仅看超长”开启时，拆分结果是否暂时保留在列表中，直到焦点离开。
    cueListKeepSplitVisible: true,
    // 字幕列表是否隐藏禁用字幕。
    cueListHideDisabled: false,
    // “仅看超长”与字数标记使用的字符阈值。
    cueListCharcountThreshold: 16,
    cueEditorShowNavigation: false,
    cueEditorShowTimeActions: false,
    cueEditorShowSticker: false,
    // 当前字幕编辑区按 Esc 时，是否放弃文本改动并恢复编辑前内容。
    cueEditorCancelOnEscape: false,
    selectGroupMembers: false,
    // 合并字幕时各段文本之间插入的连接符（默认两个空格；留空则直接拼接）。
    mergeJoinText: '',
    // 拼合字幕：相邻间隔不超过该毫秒值时延长字幕时长并拼合（0 表示不处理间隔）。
    autoMergeGapMs: 200,
    // 拼合字幕：backward 向前拓展（默认，后方字幕起点前拓）/ forward 向后拓展（前方字幕终点后延）。
    autoMergeSnapDirection: 'backward',
    // 拼合字幕：中文少于 N 个字 / 英文少于 N 个词的字幕并入相邻字幕。
    autoMergeShortCount: 3,
    // 拼合字幕：是否吸收过短字幕（默认开启；关闭后只拼合间隔）。
    autoMergeAbsorbShort: true,
    // 拼合字幕：previous 向前吸收（默认，并入上一条）/ next 向后吸收（并入下一条）。
    autoMergeAbsorbDirection: 'previous',
    // 按颜色导出 SRT：统一导出先选择一个 SRT 文件名作为前缀。
    exportColorUnified: true,
    // 导出 SRT 时是否按字幕颜色附加说话人名称（仅本地偏好）。
    exportSpeakerLabels: false,
    // 按颜色导出 SRT 时是否优先使用颜色映射的说话人名称作为文件名后缀（仅本地偏好）。
    exportSpeakerNamesAsSuffix: false,
    // 自动保存仅对绑定工程的 localhost 服务器版生效。
    autoSaveProject: true,
    autoSaveIntervalSeconds: 30,
    projectBackupEnabled: true,
    projectBackupMinutes: 5,
    projectBackupLimit: 20,
    // 表情包预览：在视频画面内渲染当前时间的表情包（默认关闭）。
    stickerOverlayEnabled: false,
    // 表情包 OTIO：保留用户偏好的原始素材引用 / 便携文件夹模式。
    stickerOtioExportMode: 'original',
    // 时间线 OTIO / OTIOZ 导出选项：同时导出 SRT、合并表情包轨、写入字幕标记（默认全开）。
    otioExportIncludeSrt: true,
    otioExportIncludeStickers: true,
    otioExportIncludeMarkers: true,
    // 字幕单击行为：默认选中并跳转；select-and-play 额外在暂停时开始播放。
    clickBehavior: 'select-and-seek',
    // 波形字幕块的跳转目标，默认使用鼠标所在位置；字幕列表点击始终跳转到字幕开头。
    clickTarget: 'pointer',
    keyboardOperationReference: 'pointer',
    // J/K/L 播放控制：direction 为倒放/停止/正放，speed 保留旧的慢速/重置/倍速行为。
    jklPlaybackMode: 'direction',
    // 媒体控制按钮与无选中字幕时左右方向键的跳转幅度。
    mediaSeekStepMs: DEFAULT_MEDIA_SEEK_STEP_MS,
    mediaSeekStepFrames: 1,
    // 选中字幕后用方向键 / A-D 微调时间的幅度。
    cueMoveStepMs: DEFAULT_CUE_MOVE_STEP_MS,
    cueMoveStepFrames: 1,
    // 帧模式下是否让波形鼠标指针吸附到最近帧（默认开启）；时间码分隔符默认使用冒号。
    timelineSnapToFrame: true,
    timelineTimecodeSeparator: ':',
    // 鼠标位置自动预览：暂停时指针在波形上移动即把画面定位到指针时间（默认关闭）。
    hoverSeekPreview: false,
    // 是否默认让同轨相邻字幕随边界调整一起联动；Alt 始终临时反转该行为。
    autoSnapAdjacentCues: true,
    // 娱乐彩蛋：成功拆分时的音效与刀光反馈，并把分割工具图标换成 🔪。
    ninjaMode: false,
    // 字幕忍者的拆分音效开关；忍者开关开启后才在设置中显示。
    ninjaSound: true,
    // 字幕忍者的可选视觉反馈；忍者开关开启后才在设置中显示。
    ninjaSlashEffect: true,
    // 刀光长度：视口高度百分比（默认 80，范围 20–400）。
    ninjaSlashLengthPercent: 80,
    // 刀光随机旋转幅度：0 度完全垂直，N 度表示在 [-N, N] 内随机倾斜（默认 6，范围 0–60）。
    ninjaSlashRotateAmplitude: 6,
    // 多重字幕拖动时是否把另一条轨道的起止边界加入吸附目标。
    crossTrackSnap: true,
    // 选中主/副字幕时，是否同时选中绑定的另一条字幕。
    selectBoundSubtitlePair: true,
    // G 绑定后是否自动把副字幕时间范围同步到主字幕（等同随后按 H）。
    multiSubtitleAutoSyncDuration: true,
    // 多重字幕波形是否显示主/副轨道编号徽标。
    multiSubtitleShowTrackBadges: false,
    // 界面主题：dark（默认）/ light / system。写入 <html data-theme>，模板 <head> 内联脚本负责首帧预应用。
    theme: 'dark',
    // 界面强调色：blue（默认）/ red / orange / custom；自定义颜色单独保存为六位十六进制值。
    accentColor: 'blue',
    accentColorCustom: '#6ca5e8',
    // 波形形状来源：reapeaks（默认，有 .ReaPeaks 缓存时用其最细 wave 层，缺数据自动回退自研）/ self（自研 1000Hz 重采样缓存）。
    waveShapeSource: 'reapeaks',
  };


  const SUBTITLE_FONT_SIZE_MIN = 12;


  const SUBTITLE_FONT_SIZE_MAX = 96;


  const SUBTITLE_FONT_FAMILY_MAX_LENGTH = 128;


  const SUBTITLE_BACKGROUND_COLOR_DEFAULT = '#000000';


  const SUBTITLE_BACKGROUND_ALPHA_DEFAULT = 0.65;


  const SUBTITLE_BACKGROUND_ALPHA_MIN = 0;


  const SUBTITLE_BACKGROUND_ALPHA_MAX = 1;


  const SUBTITLE_DEFAULT_FONT_SIZE = 18;


  const EXTENSION_SUBTITLE_DEFAULT_FONT_SIZE = 16;


  const DEFAULT_SUBTITLE_COLOR = '#ffffff';


  const DEFAULT_EXTENSION_SUBTITLE_COLOR = '#ffd34d';


  const SUBTITLE_COLOR_STYLE_VALUES = Object.freeze(['underline', 'text', 'stroke']);


  const DEFAULT_SUBTITLE_COLOR_STYLE = 'underline';


  const SUBTITLE_FONT_FAMILY_CSS = Object.freeze({
    default: '',
    yahei: '"Microsoft YaHei", "PingFang SC", sans-serif',
    hei: '"SimHei", "Microsoft YaHei", sans-serif',
    song: '"SimSun", "Songti SC", serif',
    sans: 'Arial, "Segoe UI", sans-serif',
  });



  function readEditorSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || '{}'); } catch (_) { /* invalid storage */ }
    return window.AsrEditorUtils.normalizeEditorSettings({
      ...saved,
      cueListAutoScrollOnClick: saved.cueListAutoScrollOnClick !== false,
      cueListShowIndex: saved.cueListShowIndex !== false,
      cueListShowTime: saved.cueListShowTime !== false,
      cueListShowSticker: saved.cueListShowSticker !== false,
      cueListShowCharcount: saved.cueListShowCharcount !== false,
      cueEditorShowTimeActions: saved.cueEditorShowTimeActions === true,
      cueEditorShowNavigation: saved.cueEditorShowNavigation === true,
      cueEditorShowSticker: saved.cueEditorShowSticker === true,
      cueEditorCancelOnEscape: saved.cueEditorCancelOnEscape === true,
      autoSnapAdjacentCues: saved.autoSnapAdjacentCues !== false,
      stickerOtioExportMode: saved.stickerOtioExportMode === 'portable' ? 'portable' : 'original',
      otioExportIncludeSrt: saved.otioExportIncludeSrt !== false,
      otioExportIncludeStickers: saved.otioExportIncludeStickers !== false,
      otioExportIncludeMarkers: saved.otioExportIncludeMarkers !== false,
    });
  }



  const normalizeMultiSubtitleRowHeight = window.AsrEditorUtils.normalizeMultiSubtitleRowHeight;


  const normalizeClickBehavior = window.AsrEditorUtils.normalizeClickBehavior;


  const normalizeClickTarget = window.AsrEditorUtils.normalizeClickTarget;


  const normalizeKeyboardOperationReferenceMode = window.AsrEditorUtils.normalizeKeyboardOperationReferenceMode;


  const normalizeJklPlaybackMode = window.AsrEditorUtils.normalizeJklPlaybackMode;


  const normalizeEditorAccentColor = window.AsrEditorUtils.normalizeEditorAccentColor;


  const normalizeEditorAccentCustomColor = window.AsrEditorUtils.normalizeEditorAccentCustomColor;


  const clampAutoSaveInterval = window.AsrEditorUtils.clampAutoSaveInterval;


  const clampCharcountThreshold = window.AsrEditorUtils.clampCharcountThreshold;


  const clampNinjaSlashLength = window.AsrEditorUtils.clampNinjaSlashLength;


  const clampNinjaSlashRotateAmplitude = window.AsrEditorUtils.clampNinjaSlashRotateAmplitude;


  const clampAutoMergeGapMs = window.AsrEditorUtils.clampAutoMergeGapMs;


  const clampAutoMergeShortCount = window.AsrEditorUtils.clampAutoMergeShortCount;


  const clampGapRemoveMinimum = (value) => Math.min(60000, Math.max(100, Math.round(Number(value)) || 400));


  const clampGapRemoveThreshold = (value) => Math.min(0, Math.max(-96, Number.isFinite(Number(value)) ? Number(value) : -28));


  const clampGapRemoveHysteresis = (value) => Math.min(30, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 2));


  const clampGapRemoveLeadMs = (value, fallback) => Math.min(2000, Math.max(0, Math.round(Number(value)) || fallback));



  function saveEditorSettings(settings) {
    try {
      localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {
      // file:// 隐私模式可能拒绝 localStorage；本次页面仍保持可用。
    }
  }



  const EDITOR_SETTINGS = readEditorSettings();



  function updateEditorSettings(patch) {
    Object.assign(EDITOR_SETTINGS, patch);
    saveEditorSettings(EDITOR_SETTINGS);
  }

  global.MaweSettings = Object.freeze({
    EDITOR_SETTINGS_KEY,
    GAP_REMOVE_SCHEMA,
    MEDIA_SEEK_STEP_MIN_MS,
    MEDIA_SEEK_STEP_MAX_MS,
    MEDIA_SEEK_STEP_FINE_THRESHOLD_MS,
    MEDIA_SEEK_STEP_FINE_MS,
    MEDIA_SEEK_STEP_COARSE_MS,
    DEFAULT_MEDIA_SEEK_STEP_MS,
    CUE_MOVE_STEP_MIN_MS,
    CUE_MOVE_STEP_MAX_MS,
    DEFAULT_CUE_MOVE_STEP_MS,
    clampMediaSeekStepMs,
    mediaSeekStepForValue,
    nextMediaSeekStepValue,
    normalizeNativeMediaSeekStepValue,
    clampCueMoveStepMs,
    DEFAULT_EDITOR_SETTINGS,
    SUBTITLE_FONT_SIZE_MIN,
    SUBTITLE_FONT_SIZE_MAX,
    SUBTITLE_FONT_FAMILY_MAX_LENGTH,
    SUBTITLE_BACKGROUND_COLOR_DEFAULT,
    SUBTITLE_BACKGROUND_ALPHA_DEFAULT,
    SUBTITLE_BACKGROUND_ALPHA_MIN,
    SUBTITLE_BACKGROUND_ALPHA_MAX,
    SUBTITLE_DEFAULT_FONT_SIZE,
    EXTENSION_SUBTITLE_DEFAULT_FONT_SIZE,
    DEFAULT_SUBTITLE_COLOR,
    DEFAULT_EXTENSION_SUBTITLE_COLOR,
    SUBTITLE_COLOR_STYLE_VALUES,
    DEFAULT_SUBTITLE_COLOR_STYLE,
    SUBTITLE_FONT_FAMILY_CSS,
    readEditorSettings,
    normalizeMultiSubtitleRowHeight,
    normalizeClickBehavior,
    normalizeClickTarget,
    normalizeKeyboardOperationReferenceMode,
    normalizeJklPlaybackMode,
    normalizeEditorAccentColor,
    normalizeEditorAccentCustomColor,
    clampAutoSaveInterval,
    clampCharcountThreshold,
    clampNinjaSlashLength,
    clampNinjaSlashRotateAmplitude,
    clampAutoMergeGapMs,
    clampAutoMergeShortCount,
    clampGapRemoveMinimum,
    clampGapRemoveThreshold,
    clampGapRemoveHysteresis,
    clampGapRemoveLeadMs,
    saveEditorSettings,
    EDITOR_SETTINGS,
    updateEditorSettings
  });
})(typeof window !== 'undefined' ? window : globalThis);
