

// 导出文件名前缀会随媒体切换变化；ASS 的 Title 必须跟随当前工程文件名，
// 因此单独保留工程名，避免加载媒体或导入字幕时把 Title 改成媒体名。


  // 表情包根目录的绝对路径（无尾斜杠）




// 所有非模态浮层共用一个前置栈：最后点击、打开或获得焦点的浮层排在最上面。
// 起始值高于普通设置弹窗（420），但低于右键菜单（480）、hint（490）、
// 拖拽遮罩和加载层（500/510）。


















window.addEventListener('error', (event) => {
  const details = {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack || null,
  };
  window.MAWE_DEBUG_ERRORS = [...(window.MAWE_DEBUG_ERRORS || []), details];
  console.error('[MAWE][runtime] uncaught error', details);
});
window.addEventListener('unhandledrejection', (event) => {
  window.MAWE_DEBUG_ERRORS = [...(window.MAWE_DEBUG_ERRORS || []), {
    message: String(event.reason), stack: event.reason?.stack || null,
  }];
  console.error('[MAWE][runtime] unhandled rejection', event.reason);
});
if (!window.AsrEditorUtils) {
  console.error('[MAWE][boot] AsrEditorUtils is unavailable; editor scripts are incomplete or out of order');
}

const MULTI_SUBTITLE_UTILS = window.AsrEditorUtils;
const EDITOR_SETTINGS_UTILS = window.AsrEditorUtils;



// 拆分时「下刀时间 vs 实际切分边界」允许的最大偏差：超过说明字幕文本与
// 词时间戳已脱钩、切点落在了错误的词边界附近，此时提示而不是静默出错。
const SPLIT_ALIGNMENT_DRIFT_WARN_MS = 500;



MaweBoot.maweDomContractCheck();
