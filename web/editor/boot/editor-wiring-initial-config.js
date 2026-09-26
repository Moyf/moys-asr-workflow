












// 把用户配置的拆分移除符号同步给共享工具层；设置面板修改时也会同步。
MULTI_SUBTITLE_UTILS.setSplitTrimSymbols(MaweSettings.EDITOR_SETTINGS.splitTrimSymbols);







































MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase?.unit === 'frames' });

// 标记颜色：5 种基础色，用于给字幕分组着色。
// 数据模型与表情包同构：head 持完整 color {name, value, start, end}，后续 ref 持 color_ref {name, headIdx}
// 调色板数值唯一来源于 maw/colors.py（渲染时注入 window.ASR_EDITOR_PALETTE）；
// 这里只补充编辑器 UI 用的中文标签。

if (!Array.isArray(window.ASR_EDITOR_PALETTE) || !window.ASR_EDITOR_PALETTE.length) {
  throw new Error('调色板未注入：缺少 window.ASR_EDITOR_PALETTE（检查 edit.py / serve.py 渲染管线）');
}





window.AsrWaveform?.setColorPalette?.(MaweColors.COLOR_PALETTE);




const ASS_PREVIEW_REFERENCE_HEIGHT = Number(window.AsrEditorUtils.ASS_REFERENCE_PLAY_RES_Y) || 1080;

































  // 可被「加载媒体」替换为新 <video>/<audio>







// 工程内波形是可直接使用的缓存；加载关联媒体时不要因为媒体签名不同而覆盖它。
// 媒体生成的波形则不属于工程缓存，切换媒体时仍应重新分析。





// === 统一撤销/重做 ===
// 四种记录 kind 共享一个历史栈：
//   segments   —— 字幕增删改、拆分合并、表情包/颜色、批量替换等
//   layout     —— 布局导入/重置/拖动停靠
//   gap_remove —— 静音空隙扫描与人工修正
//   preview    —— 字幕预览（overlay）开关
// 栈深上限 100；新动作清空 redo；Ctrl(Cmd)+Z 撤销、Ctrl(Cmd)+Shift+Z 重做。
// 编辑文本输入框或 modal 打开时让原生行为优先（见 keydown 守卫）。











// 按记录 kind 拍下当前状态，作为对端栈的镜像（label 沿用原记录）





// modal 或文本输入聚焦时不触发全局撤销/重做（让浏览器/输入框自己处理）




if (MaweHistory.undoBtn) MaweHistory.undoBtn.addEventListener('click', () => MaweHistory.performUndo());
if (MaweHistory.redoBtn) MaweHistory.redoBtn.addEventListener('click', () => MaweHistory.performRedo());
MaweHistory.updateUndoRedoButtons();
