(function initMaweI18n(global) {
  'use strict';

  const STORAGE_KEY = 'mawe.language';
  const ZH = 'zh';
  const EN = 'en';
  const GENERATED_LANGUAGE = typeof __UI_LANGUAGE_JSON__ === 'undefined' ? null : __UI_LANGUAGE_JSON__;

  // The editor keeps one source template. Exact UI strings are translated at
  // the DOM boundary; project content is excluded from traversal below.
  const EN_TEXT = {
    '撤销': 'Undo', '重做': 'Redo', '↶ 撤销': '↶ Undo', '↷ 重做': '↷ Redo',
    '打开工程': 'Open project',
    '最近工程': 'Recent projects', '自动打开上次工程': 'Automatically open last project',
    '加载媒体': 'Load media', '加载字幕': 'Load subtitles', '保存工程': 'Save project', '另存为…': 'Save as…', '保存': 'Save', '保存成功！': 'Saved!', '保存失败': 'Save failed',
    'item 内容': 'Item content', '字幕内容': 'Subtitle content', '关闭提示': 'Dismiss notification',
    '📥 松开以加载文件（视频 / 音频 / JSON / SRT）': '📥 Drop to load files (video / audio / JSON / SRT)',
    '自动保存': 'Auto-save', '自动保存间隔': 'Auto-save interval', '秒': 'sec',
    '导出字幕': 'Export subtitles', '导出字幕 ▾': 'Export subtitles ▾',
    '导出完整字幕': 'Export full subtitles', '导出完整字幕（SRT）': 'Export full subtitles (SRT)',
    '导出扩展字幕': 'Export extension subtitles', '导出当前扩展字幕轨（SRT）': 'Export the current extension subtitle track (SRT)',
    '按颜色导出字幕': 'Export by color', '按颜色导出字幕（SRT）': 'Export by color (SRT)',
    '导出纯文本（TXT）': 'Export plain text (TXT)',
    '导出工程': 'Export project', '导出去空隙版本 ▾': 'Export gap-removed version ▾',
    '字幕 SRT': 'Subtitle SRT', '时间线 OTIO 工程': 'Timeline OTIO project',
    '导出时间线模式': 'Export timeline mode', '去空隙时间线': 'Gap-removed timeline', '原始时间线': 'Source timeline',
    '导出帧率': 'Export frame rate', '写入原生字幕文本对象': 'Write native subtitle text objects',
    '导出扩展字幕轨': 'Export extension subtitle track', '主轨字幕': 'Main-track subtitles',
    '主轨与扩展轨字幕': 'Main and extension subtitles', '导出文件名': 'Export filename',
    '导出媒体路径缺失': 'Export media path is missing', '导出媒体时长缺失': 'Export media duration is missing',
    '导出文件名无效': 'Export filename is invalid', '导出警告': 'Export warning',
    'Premiere FCP 7 XML（实验性）': 'Premiere FCP 7 XML (experimental)',
    '导出 FCP 7 XML 供 Premiere 交接。此交接尚未完成目标应用验证。': 'Export FCP 7 XML for Premiere handoff. This handoff has not completed target-application validation.',
    '原生文本仅作为可选交接数据，不承诺样式或位置还原；SRT 可通过独立按钮导出。': 'Native text is optional handoff data with no style or placement fidelity claim; export SRT with its separate button.',
    '导出 XML': 'Export XML',
    'FCP 7 XML 已保存，SRT 保存已取消': 'FCP 7 XML was saved; SRT save was cancelled',
    'FCP 7 XML 已保存，SRT 保存失败': 'FCP 7 XML was saved; SRT save failed',
    'FCP 7 XML 下载已发起，SRT 保存已取消': 'FCP 7 XML download was dispatched; SRT save was cancelled',
    'FCP 7 XML 下载已发起，SRT 保存失败': 'FCP 7 XML download was dispatched; SRT save failed',
    'FCP 7 XML 已保存': 'FCP 7 XML was saved',
    'FCP 7 XML 下载已发起': 'FCP 7 XML download was dispatched',
    'FCP 7 XML 保存已取消': 'FCP 7 XML save was cancelled',
    'FCP 7 XML 保存失败': 'FCP 7 XML save failed',
    'FCP 7 XML 导出失败': 'FCP 7 XML export failed',
    'FFconcat 文件': 'FFconcat file', '保留区域 JSON': 'Kept-regions JSON',
    '表情包 OTIO': 'Sticker OTIO', '导出表情包时间线 ▾': 'Export sticker timeline ▾',
    '下载 Resolve JSON': 'Download Resolve JSON',
    '下载表情包 OTIO 工程': 'Download sticker OTIO project',
    '字幕': 'Subtitles', '字幕预览': 'Subtitle preview', '表情包预览': 'Sticker preview', '字幕列表和编辑区': 'Subtitle list & editor', '字幕编辑区': 'Subtitle editor',
    '多重字幕': 'Multiple subtitles', '多重字幕设置': 'Multiple-subtitle settings', '主轨': 'Main track', '扩展轨': 'Extension track', '副轨': 'Secondary track', '双列': 'Two columns', '绑定字幕后自动把副字幕的起止时间同步到主字幕，相当于随后按一次 H': 'After binding, sync the secondary subtitle start and end to the main subtitle, equivalent to pressing H', '交换主字幕和副字幕的文本、时间与绑定关系': 'Swap the main and secondary subtitle text, timing, and bindings',
    '拆分与合并': 'Split and merge', '波形形状来源': 'Waveform shape source', '自研波形': 'Self-built waveform', 'ReaPeaks 波形层': 'ReaPeaks waveform layer',
    '显示方式': 'Display mode', '语言类型': 'Language type', '主字幕': 'Main subtitle', '副字幕': 'Secondary subtitle', '主字幕语言类型': 'Main subtitle language type', '副字幕语言类型': 'Secondary subtitle language type', '拓展字幕时波形高度': 'Waveform height with extension subtitles', '副字幕时波形高度': 'Waveform height with secondary subtitles', '跨轨道吸附': 'Cross-track snapping', '同时选中主副字幕': 'Select main and secondary subtitles together', '绑定时自动同步时长': 'Automatically sync duration when binding', '显示轨道徽标': 'Show track badges', '在多重字幕波形中显示主字幕和副字幕的轨道编号徽标': 'Show main and secondary track number badges in the multiple-subtitle waveform', '交换主副字幕': 'Swap main and secondary subtitles', '普通点击以最后点击的轨道为准；点击已绑定字幕时，仅补选它实际绑定的另一条字幕': 'Normal clicks follow the last clicked track; clicking a bound subtitle only adds the other subtitle actually bound to it',
    '开启后显示扩展字幕轨、双列列表和绑定操作；关闭只隐藏扩展数据，不删除': 'Show the extension track, two-column list, and binding actions; turning it off only hides extension data',
    '启用多重字幕时使用的波形行高度': 'Waveform row height used when multiple subtitles are enabled', '请拖入第二个 srt 字幕以开启多重字幕功能': 'Drop a second SRT subtitle to enable multiple subtitles', '是否选择导入第二条字幕以开启多重字幕模式？': 'Import a second subtitle to enable multiple-subtitle mode?', '当前工程如果有大于1条字幕，可以开启多重字幕模式，用于双语字幕编辑等。': 'When the current project has more than one subtitle, you can enable multiple-subtitle mode for bilingual subtitle editing and similar workflows.',
    '拖动多重字幕时，允许吸附到另一条字幕轨道的起点和终点': 'Snap multiple subtitles to the start and end boundaries of the other track while dragging',
    '点击主字幕或副字幕时，如果存在绑定字幕，同时选中对应字幕': 'When clicking a main or secondary subtitle, also select its bound counterpart if one exists',
    '交换主字幕和扩展字幕的文本、时间与绑定关系': 'Swap the text, timing, and bindings between the main and extension subtitles',
    '请先开启多重字幕': 'Enable multiple subtitles first',
    '当前只支持交换唯一的扩展字幕轨': 'Swapping is currently supported only with one extension track',
    '主字幕和扩展字幕都不能为空': 'The main and extension subtitles cannot be empty',
    '交换主副字幕失败': 'Could not swap the main and extension subtitles',
    '请点击一条主字幕完成绑定': 'Click a main subtitle to complete the binding',
    '已取消绑定扩展字幕': 'Extension subtitle binding cancelled',
    '请点击一条主字幕完成绑定；按 Esc 或点击空白处取消': 'Click a main subtitle to complete the binding, or press Esc or click blank space to cancel',
    '请先选中至少一条副字幕': 'Select at least one secondary subtitle first',
    '选中的副字幕中没有可对齐的绑定关系': 'None of the selected secondary subtitles has a binding to align',
    '选中的副字幕已经与各自主字幕时间范围一致': 'The selected secondary subtitles already match their main-subtitle ranges',
    '拆分后两侧都必须至少保留 100ms，已取消': 'A split must leave at least 100 ms on both sides; cancelled',
    '当前切点会产生不足 100ms 的一侧；请再次按 B 或 Enter 强制拆分，切点将调整为两侧各至少 100ms': 'The current cut would leave one side shorter than 100 ms; press B or Enter again to force the split, moving the cut so both sides are at least 100 ms',
    '字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms': 'The subtitle is shorter than 200 ms, so both split sides cannot be at least 100 ms',
    '当前服务器未绑定工程；请先导出 .mosp，再重新打开该文件': 'The current server has no bound project; export a .mosp file and reopen it',
    '重叠的主字幕已有绑定，请点击主字幕后替换绑定；按 Esc 取消': 'The overlapping main subtitle is already bound; click a main subtitle to replace it, or press Esc to cancel',
    '有多条主字幕与当前副字幕重叠，请点击要绑定的主字幕': 'Multiple main subtitles overlap this extension subtitle; click the one to bind',
    '未找到与当前副字幕时间重叠的主字幕，请手动选择': 'No main subtitle overlaps this extension subtitle; choose one manually',
    '字符型': 'Character-based', '单词型': 'Word-based', '绑定': 'Bind', '解绑': 'Unbind', '批量对齐': 'Batch align',
    '主字幕调整时副字幕只跟随；冲突时优先限制副字幕，必要时保留重叠，不会缩短主字幕': 'When the main subtitle changes, the secondary subtitle only follows; conflicts limit the secondary subtitle first without shortening the main subtitle',
    '主字幕调整时副字幕只跟随；冲突时优先限制副字幕，不会缩短主字幕': 'When the main subtitle changes, the secondary subtitle only follows; conflicts limit the secondary subtitle first without shortening the main subtitle',
    '副字幕调整时受主字幕轨道边界限制，主字幕没有可用空间时无法继续拖动': 'When the secondary subtitle changes, the main-track boundaries limit the operation; dragging stops when the main track has no room',
    '字体大小': 'Font size', '字幕大小': 'Font size', '主字幕大小': 'Main subtitle size', '拓展字幕大小': 'Extension subtitle size', '副字幕大小': 'Secondary subtitle size',
    '自动（响应式）': 'Auto (responsive)', '自动（比主字幕小一号）': 'Auto (two px smaller than main)', '字体': 'Font',
    '主字幕字体': 'Main subtitle font', '拓展字幕字体': 'Extension subtitle font', '副字幕字体': 'Secondary subtitle font', '默认无衬线': 'Default sans-serif',
    '主字幕颜色': 'Main subtitle color', '拓展字幕颜色': 'Extension subtitle color', '副字幕颜色': 'Secondary subtitle color',
    '微软雅黑 / 苹方': 'Microsoft YaHei / PingFang', '黑体': 'SimHei', '宋体': 'SimSun', 'Arial / Segoe UI': 'Arial / Segoe UI',
    '读取本机字体': 'Read local fonts', '点击读取本机字体（首次需要授权）': 'Click to read local fonts (permission required the first time)',
    '文字颜色': 'Text color', '背景颜色': 'Background color', '背景不透明度': 'Background opacity',
    '背景色': 'Background color', '不透明度': 'Opacity',
    '副字幕背景色': 'Secondary subtitle background color',
    '只影响播放器画面内的字幕预览，不改变字幕文本或时间': 'Only affects subtitle preview in the player; it does not change subtitle text or timing',
    '选择播放器画面内字幕预览使用的字体族': 'Choose the font family used by the subtitle preview in the player',
    '选择播放器画面内字幕预览的文字颜色': 'Choose the text color used by the subtitle preview in the player',
    '调整播放器画面内字幕预览的背景色': 'Adjust the background color used by the subtitle preview in the player',
    '调整播放器画面内字幕预览背景的不透明度，设为 0 时隐藏背景': 'Adjust the subtitle preview background opacity in the player; set it to 0 to hide the background',
    '只影响播放器画面内的副字幕预览': 'Only affects the secondary subtitle preview in the player',
    '选择播放器画面内副字幕预览使用的字体族': 'Choose the font family used by the secondary subtitle preview in the player',
    '选择播放器画面内副字幕预览的文字颜色': 'Choose the text color used by the secondary subtitle preview in the player',
    '调整播放器画面内副字幕预览的背景色': 'Adjust the background color used by the secondary subtitle preview in the player',
    '调整播放器画面内副字幕预览背景的不透明度，设为 0 时隐藏背景': 'Adjust the secondary subtitle preview background opacity in the player; set it to 0 to hide the background',
    '样式会保存到工程的 preview.subtitle；旧工程默认使用原来的响应式字号。': 'Styles are saved in preview.subtitle; legacy projects keep the original responsive font size.',
    '媒体': 'Media', '媒体设置': 'Media settings', '预览字幕': 'Subtitle preview', '预览字幕样式': 'Subtitle preview style', '预览拓展字幕': 'Extension subtitle preview', '预览副字幕': 'Secondary subtitle preview', '预览表情包': 'Sticker preview', '媒体播放控制': 'Media playback controls',
    '跳转时长': 'Seek duration', '每次跳转': 'Each jump', '媒体控制按钮和左右方向键每次跳转的毫秒数': 'Milliseconds to jump with the media controls and left/right arrow keys', '控制按钮和左右方向键的每次跳转时长（单位：ms）': 'Duration for each jump from the controls and left/right arrow keys (unit: ms)',
    '频谱颜色': 'Spectral colors', '正在应用频谱颜色…': 'Applying spectral colors…', '正在关闭频谱颜色…': 'Removing spectral colors…',
    '播放': 'Play', '暂停': 'Pause', '后退 1000ms': 'Back 1000ms', '前进 1000ms': 'Forward 1000ms',
    '媒体进度': 'Media progress', '音量': 'Volume', '速度': 'Speed', '播放速度': 'Playback speed',
    '全屏': 'Fullscreen', '退出全屏': 'Exit fullscreen',
    '显示': 'Display', '筛选': 'Filter', '隐藏禁用': 'Hide disabled', '隐藏禁用字幕': 'Hide disabled subtitles', '批量替换…': 'Batch replace…',
    '字数阈值': 'Character threshold', '仅看超长': 'Long only', '字幕列表设置': 'Subtitle list settings',
    '拆分后临时保留显示': 'Temporarily keep split results visible', '点击字幕后自动滚动': 'Auto-scroll after clicking a subtitle', '显示内容': 'Displayed content',
    '当前': 'Current', '已选': 'Selected', '波形': 'Waveform', '音频波形区': 'Audio waveform', '波形设置': 'Waveform settings', '波形轨道徽标（开启后）：': 'Waveform track badges (when enabled):', '使用频谱缓存按主频给波形着色；关闭时使用原来的纯色波形': 'Color the waveform using the spectral cache by dominant frequency; when disabled, use the original solid-color waveform',
    '多行': 'Multi-row', '基础': 'Basic', '隐藏': 'Hidden',
    '选择': 'Select', '分割': 'Razor', '移除静音空隙': 'Remove silent gaps',
    '跳过空隙': 'Skip gaps', '播放时跳过空隙': 'Skip gaps during playback', '未扫描空隙': 'Gaps not scanned', '工作区': 'Workspace',
    '拼合字幕': 'Snap subtitles', '拼合参数': 'Snap parameters',
    '拼接/合并字幕': 'Join / merge subtitles', '拼接/合并参数': 'Join / merge parameters',
    '延长字幕': 'Extend subtitles', '延长参数': 'Extension parameters',
    '直接修改字幕时间轴，整个操作一次撤销': 'Edits the subtitle timeline directly; the whole run is one undo step',
    '先向前、再向后；整个操作一次撤销': 'Extends earlier first, then later; the whole run is one undo step',
    '向前延长': 'Extend earlier', '向后延长': 'Extend later', '执行': 'Run',
    '向字幕起点前延长，不越过前一条字幕边界；0 表示不处理': 'Extend the subtitle start earlier without crossing the previous subtitle; 0 disables it',
    '向字幕终点后延长，不越过后一条字幕边界；0 表示不处理': 'Extend the subtitle end later without crossing the next subtitle; 0 disables it',
    '有选中字幕时只处理选中项，否则处理全部字幕': 'Process selected subtitles when any are selected; otherwise process all subtitles',
    '打开可拖动的延长字幕工具窗': 'Open the draggable subtitle-extension tool',
    '关闭延长字幕工具窗': 'Close the subtitle-extension tool',
    '向前延长时长必须是大于等于 0 的数字': 'The earlier-extension duration must be a number greater than or equal to 0',
    '向后延长时长必须是大于等于 0 的数字': 'The later-extension duration must be a number greater than or equal to 0',
    '间隔阈值': 'Interval threshold', '拓展方向': 'Snap direction', '吸附方向': 'Snap direction',
    '向前拓展': 'Extend earlier', '向后拓展': 'Extend later',
    '向前吸附': 'Snap earlier', '向后吸附': 'Snap later',
    '相邻字幕间隔在此范围内时，拓展字幕长度把它们拼在一起；0 表示不处理':
      'When adjacent subtitle intervals are within this threshold, extend their timing to snap them together; 0 disables it',
    '将间隔过短的前后字幕直接吸附在一起，去除中间的短暂空白；0 表示不处理':
      'Snap nearby subtitles together to remove the brief gap between them; 0 disables it',
    '吸收过短字幕': 'Absorb short subtitles', '短字幕阈值': 'Short-subtitle threshold', '吸收方向': 'Absorb direction',
    '向前吸收': 'Into previous', '向后吸收': 'Into next',
    '相邻字幕间隔小于此值时，拓展字幕长度把它们拼在一起；0 表示不处理':
      'When the interval between adjacent subtitles is below this value, extend their lengths to snap them together; 0 disables it',
    '向前：后方字幕的起点前拓；向后：前方字幕的终点后延':
      'Earlier: the later subtitle extends its start backward; Later: the earlier subtitle extends its end forward',
    '向前：后方字幕的起点吸附到前方字幕的终点；向后：前方字幕的终点吸附到后方字幕的起点':
      'Earlier: snap the later subtitle start to the earlier subtitle end; Later: snap the earlier subtitle end to the later subtitle start',
    '中文少于 N 个字 / 英文少于 N 个词即视为过短字幕':
      'Fewer than N Chinese characters or N English words counts as a short subtitle',
    '向前：过短字幕并入上一条；向后：并入下一条':
      'Into previous: a short subtitle merges into the previous one; Into next: into the next one',
    '过短的字幕直接并入相邻字幕；关闭后只拼合间隔':
      'Short subtitles merge into a neighbor; when off, only intervals are snapped',
    '过短字幕也必须与相邻字幕间隔在上方阈值内才会吸收；关闭后只吸附间隔':
      'Short subtitles are absorbed only when the adjacent interval is within the threshold above; when off, only intervals are snapped',
    '关闭后只吸附间隔，不合并任何字幕': 'When off, only intervals are snapped and no subtitles are merged',
    '按当前参数处理整段工程': 'Process the whole project with these parameters',
    '没有需要拼合的间隔或过短字幕': 'No intervals or short subtitles to snap',
    '没有需要拼接/合并的间隔或过短字幕': 'No intervals or short subtitles to join / merge',
    '字幕时长不足 200ms，无法拆分': 'Subtitles shorter than 200 ms cannot be split',
    '字幕列表编辑': 'Subtitle list editor', '右侧整列波形': 'Waveform column right',
    '三折叠布局': 'Three-fold layout', '大荧幕布局': 'Cinema screen layout',
    '编辑布局': 'Edit layout', '完成布局': 'Done editing', '重置工作区': 'Reset workspace',
    '已保存工作区': 'Saved workspaces',
    '保存工作区': 'Save workspace', '另存为工作区': 'Save workspace as', '删除工作区': 'Delete workspace',
    '工作区配置 ▾': 'Workspace configuration ▾', '导出工作区配置': 'Export workspace configuration', '导入工作区配置': 'Import workspace configuration',
    '🔧 设置': '🔧 Settings', '⚙️ 全局设置': '⚙️ Global settings', '字幕时间调整': 'Subtitle timing adjustment', '自动吸附调整相邻字幕': 'Automatically snap-adjust adjacent subtitles', '开启后，拖动或微调同轨相邻字幕时默认保持联动；按住 Alt 临时解除。关闭后默认独立调整；按住 Alt 临时联动': 'When enabled, dragging or fine-tuning adjacent cues on the same track links them by default; hold Alt to temporarily separate them. When disabled, they adjust independently by default; hold Alt to temporarily link them.', '关闭后默认独立调整相邻字幕；按住 Alt 临时反转为联动。开启后默认吸附联动；按住 Alt 临时解除。': 'When disabled, adjacent cues adjust independently by default; hold Alt to temporarily link them. When enabled, linking is the default; hold Alt to temporarily separate them.', '操作': 'Behavior', 'Esc 取消编辑': 'Esc cancels editing', '开启后，按 Esc 会恢复当前字幕编辑前的文本；关闭后按 Esc 保留文本改动并退出编辑': 'When enabled, Esc restores the text from before editing; when disabled, Esc keeps text changes and exits editing.', '关闭后按 Esc 保留文本改动；开启后恢复编辑前的文本。': 'When disabled, Esc keeps text changes; when enabled, it restores the text from before editing.', '🤔 帮助': '🤔 Help',
    '等待波形数据': 'Waiting for waveform data', '波形处理': 'Waveform processing',
    '扫描参数': 'Scan parameters',
    '按波形音量扫描内部空隙，不改写原时间轴': 'Scan internal gaps from waveform volume without changing the original timeline',
    '最小空隙': 'Minimum gap', '短于此值不处理': 'Ignore shorter gaps',
    '音量阈值': 'Volume threshold', '达到此音量才算有声': 'Audio is active at this level',
    '高级设置': 'Advanced settings', '预留量、滞回等检测细节': 'Padding, hysteresis, and detection details',
    '前端预留': 'Lead-in padding', '后端预留': 'Lead-out padding', '滞回': 'Hysteresis',
    '扫描并移除': 'Scan and remove',
    '根据当前参数重新分析整段波形': 'Analyze the full waveform with these settings',
    '尚未扫描空隙。': 'Gaps have not been scanned.',
    '尚未找到符合门限的音量空隙。': 'No volume gaps matched the current thresholds.',
    '每段空隙开头保留的静音，避免上一句收尾被切掉': 'Keep this much silence at each gap start to protect the previous ending',
    '每段空隙结尾保留的静音，避免下一句贴得太紧': 'Keep this much silence at each gap end so the next line is not too tight',
    '当音频判定为有声时，需要降低到比阈值更低 2 dB 的时候才视作恢复静音。建议 1–3 dB，过高会延迟回到静音': 'After audio becomes active, it must fall 2 dB below the threshold to become silent again. Recommended: 1–3 dB.',
    '滚轮可调数值 · Esc 关闭': 'Use the wheel to adjust values · Esc to close',
    '未加载媒体': 'No media loaded', '需重新扫描': 'Rescan needed', '人工修正': 'manually adjusted',
    '上次打开': 'Last opened', '已失效': 'Missing',
    '全部清理': 'Clear all', '字幕列表显示': 'Subtitle list',
    '序号': 'Index', '时间码': 'Timecode', '表情包': 'Stickers', '字数': 'Characters',
    '点击字幕列表时自动滚动': 'Auto-scroll when clicking the subtitle list',
    '仅影响“仅看超长”筛选和字幕字数标记': 'Only affects the “Long only” filter and subtitle character markers',
    '开启后，在“仅看超长”筛选中拆分出的字幕会暂时保留，直到点击其他字幕、波形或空白处': 'When enabled, split subtitles stay visible in the “Long only” filter until another subtitle, the waveform, or blank space is clicked',
    '关闭后，通过字幕列表点击字幕时不会自动滚动列表': 'When disabled, clicking a subtitle in the list will not scroll the list',
    '字幕编辑显示': 'Subtitle editor', '编辑': 'Edit', '编辑设置': 'Editor settings', '跳转按钮': 'Navigation buttons', '前后跳转': 'Navigation buttons', '时间操作': 'Time actions',
    '操作': 'Behavior', '通用操作': 'General', '按键调整字幕': 'Keyboard subtitle adjustment', '单击行为': 'Click behavior', '点击字幕块时': 'Click subtitle behavior', '仅选中（不跳转）': 'Select only (do not seek)', '选中并跳转（自动播放）': 'Select and seek (autoplay)', 'JKL 播放模式': 'JKL playback mode', '播放模式': 'Playback mode', '慢速和倍速': 'Slower and faster', '倒放和正放': 'Reverse and forward', '倒放/停止/正放': 'Reverse/stop/forward', '倒放/停止/1×播放': 'Reverse/stop/1× play', '选择 J/K/L 的播放控制方式': 'Choose how J/K/L control playback', 'J 倒放，K 停止（重置播放速度），K 播放。多次按 J/K 可以倍增速度。': 'J reverses; K stops (resetting playback speed), and K plays. Press J/K repeatedly to multiply the speed.',
    '字幕忍者': 'Subtitle Ninja', '开启后，分割工具改用 🔪 图标，并可启用拆分音效与刀光特效': 'When enabled, the Razor tool uses a 🔪 icon, and split sounds and slash effects become available', '播放音效': 'Play sound', '开启后，成功拆分时播放随机刀光音效': 'When enabled, successful splits play a random slash sound', '显示刀光特效': 'Show slash effect', '开启后，成功拆分时在屏幕上显示一道白色刀光': 'Show a white slash across the screen after a successful split', '刀光长度': 'Slash length', '刀光长度，按视口高度的百分比计算': 'Slash length as a percentage of the viewport height', '随机旋转幅度': 'Random rotation', '0 度为完全垂直；30 度表示在左右各 30 度范围内随机倾斜': '0° is fully vertical; 30° tilts randomly within ±30°', '打开字幕忍者模式，让拆分字幕变得更加有趣': 'Open Subtitle Ninja mode to make splitting subtitles more fun',
    '副字幕总时长不足 200ms，无法联动拆分': 'The extension subtitle is shorter than 200ms, so a linked split is impossible', '主字幕总时长不足 200ms，无法联动拆分': 'The main subtitle is shorter than 200ms, so a linked split is impossible', '主副字幕时间重叠不足，无法找到共同切点': 'The main and extension subtitles overlap too little to share a split point', '副字幕总时长不足 200ms，无法拆分': 'The extension subtitle is shorter than 200ms, so it cannot be split', '当前切点无法同时拆分主副字幕，请调整断点位置': 'This cut point cannot split both subtitles; adjust the break position', '当前断点无法把主副字幕文本各拆成两段': 'This break position cannot split both subtitle texts into two parts',
    '选中并跳转': 'Select and seek', '跳转目标': 'Seek target', '字幕开头': 'Subtitle start', '鼠标所在位置': 'Pointer position',
    '主字幕自动使用时间码拆分': 'Automatically split the main subtitle using timecodes',
    '已勾选“主字幕自动使用时间码拆分”，但当前主字幕没有可用的字词时间码，本次设置不生效，已改用拆分面板。': '“Automatically split the main subtitle using timecodes” is enabled, but this subtitle has no usable word timestamps, so the setting does not apply here. The split dialog is used instead.',
    '开启时，有可用字词时间码的主字幕会自动按时间码拆分；联动拆分时主字幕显示为不可交互的时间码锚点。关闭后主字幕也打开拆分弹窗，并默认定位到时间码对应位置': 'When enabled, main subtitles with usable word timestamps split automatically by timecode; in linked splits, the main subtitle appears as a non-interactive timecode anchor. When disabled, main subtitles also open the split dialog, initially positioned at the timecode location',
    '开启时，有可用字词时间码的主字幕会自动按时间码拆分；联动拆分时主字幕显示为不可交互的时间码锚点。关闭后主字幕也打开拆分弹窗，并默认定位到时间码对应位置。': 'When enabled, main subtitles with usable word timestamps split automatically by timecode; in linked splits, the main subtitle appears as a non-interactive timecode anchor. When disabled, main subtitles also open the split dialog, initially positioned at the timecode location.',
    '主字幕自动使用时间码拆分：单轨可直接拆分；联动弹窗中主轨显示为不可交互的时间码锚点': 'Automatically split the main subtitle using timecodes: single-track splits can be direct; linked dialogs show the main track as a non-interactive timecode anchor',
    '启用后，可在右上角「🔧 设置 → 拆分与合并」中配置是否使用时间码拆分。': 'When enabled, configure whether to use timecode splitting from the top-right “🔧 Settings → Split and merge”.',
    '点击波形区 header 右侧的【⚙️】后，可调整【音频波形区】的具体参数': 'Click the 【⚙️】 on the right side of the waveform header to adjust the Audio waveform area parameters',
    '主字幕拆分使用字词时间码': 'Use word timestamps when splitting the main subtitle',
    '开启时，波形拆分优先使用主字幕的字词时间码；没有可用时间码时自动打开拆分弹窗；关闭后始终打开拆分弹窗。字幕列表拆分不受影响': 'When enabled, waveform splits prefer the main subtitle\'s word timestamps; when no usable timestamps exist, open the split dialog automatically; when disabled, always open the split dialog. Subtitle-list splits are unchanged',
    '暂停时只跳转，不自动播放；播放中跳转后继续播放。': 'When paused, seek without starting playback; while playing, keep playing after seeking.',
    '跳转到字幕起点，并在暂停时自动开始播放。': 'Seek to the subtitle start and start playback when paused.',
    '只选中，不改变播放位置；可用 F 或右键菜单跳转并播放。': 'Select only without changing the playhead; use F or the context menu to seek and play.',
    '字幕列表点击始终跳转到字幕开头；此设置只影响波形区点击字幕块': 'Subtitle-list clicks always seek to the subtitle start; this setting only affects waveform subtitle clicks',
    '开启后显示扩展字幕轨、双列列表和绑定操作；关闭只隐藏扩展数据，不删除': 'When enabled, show the extension track, two-column list, and binding controls; when disabled, hide extension data without deleting it',
    '多重字幕列表显示方式': 'Multiple-subtitle list display mode', '英文、西文等按空格拆分请选择「单词型」；中文、日文等按字符拆分请选择「字符型」。': 'Choose Word-based for English and other space-separated languages; choose Character-based for Chinese, Japanese, and other character-separated languages.',
    '单词型：英语、西文等按空格拆分': 'Word-based: English and other space-separated languages',
    '字符型：中文、日文等按字符拆分': 'Character-based: Chinese, Japanese, and other character-separated languages',
    '分别选中主轨和扩展轨字幕后建立绑定': 'Select one main-track and one extension-track subtitle to bind them',
    '移除当前选中字幕的绑定关系': 'Remove the binding for the selected subtitle',
    '批量对齐选中的副字幕到各自主字幕时间轴': 'Batch-align selected secondary subtitles to their main-subtitle timelines',
    '将当前选中的副字幕批量对齐到各自绑定的主字幕时间范围': 'Batch-align the selected secondary subtitles to their bound main-subtitle ranges',
    '合并字幕时插入字符': 'Merge separator', '留空则直接拼接': 'Leave blank to join directly',
    '合并两条字幕时，中间插入的字符（如果不需要可以留空）': 'Characters inserted between merged subtitles (leave blank to join directly)',
    '字幕编辑拆分按键': 'Subtitle split key', '字幕（编辑状态下）拆分按键': 'Subtitle split key (while editing)',
    '拆分': 'Split', '确认': 'Confirm', '退出编辑': 'Exit editing', '换行': 'Newline',
    '同时选中分组内项目': 'Select all group members', '选中字幕时，同时选中和它相同颜色/表情包的字幕': 'When a subtitle is selected, also select subtitles with the same color or sticker', '或': 'or',
    '显示窗口': 'Visible window', '振幅': 'Amplitude',
    '5 秒': '5 sec', '10 秒': '10 sec', '20 秒': '20 sec', '30 秒': '30 sec',
    '每行长度': 'Seconds per row', '每行高度': 'Row height', '静音空隙': 'Silent gaps',
    '空隙区段操作方式': 'Gap region operation', 'Alt+点击': 'Alt+click',
    '中键拖动': 'Middle-button drag', '显示分组标记': 'Show group markers', '允许拖动指针': 'Drag to move playhead',
    '彩色字幕统一导出': 'Export colored subtitles together',
    '选中时，会将所有不同颜色的字幕按「文件名_颜色」格式统一导出；否则每个颜色都会弹出单独的保存框。': 'When enabled, export all color groups as filename_color; otherwise each color opens its own save dialog.',
    'Oi！检测到你添加了表情包，是否需要帮你打开「设置」中的字幕列表/编辑区的表情包显示开关？   ヾ(´･ω･｀)ﾉ': 'Oi! You added a sticker. Would you like to enable sticker display in the subtitle list and editor under Settings?   ヾ(´･ω･｀)ﾉ',
    'SRT 首条从 0 开始': 'Start the first SRT cue at 0',
    '只把第一条导出字幕的起点拉到 00:00，保留其结束时间和后续字幕时间码；不改动工程或 OTIO 的时间轴': 'Only move the first exported subtitle to 00:00; keep its end time and all later timecodes unchanged in the project and OTIO',
    '导入字幕': 'Import subtitles', '请选择你要执行的行为：': 'Choose what to do:',
    '替换当前字幕': 'Replace current subtitles', '作为多重字幕': 'Add as multiple subtitles', '导入': 'Import',
    '联动拆分扩展字幕': 'Split linked extension subtitle', '主字幕拆分': 'Main subtitle split', '副字幕拆分': 'Secondary subtitle split',
    '当前切分位置固定为波形指针位置': 'The split position is fixed to the waveform pointer', '当前切分位置由字词时间码推定': 'The split position is inferred from word timestamps', '默认位置参考主字幕字词时间码，可继续调整': 'The default position follows the main subtitle word timestamps and can be adjusted',
    '移动鼠标并点击选择拆分断点。': 'Move the mouse and click to choose a split boundary.',
    '字符型语言（中文等）按字符拆分。': 'Character-based languages such as Chinese split by character.',
    '单词型语言（英语等）只在空格处切分，确保不会拆碎单词；可在多重字幕 ⚙️ 设置中切换语言类型。': 'Word-based languages such as English split only at spaces so words stay intact; switch the language type in the multiple-subtitle ⚙️ settings.',
    '移动鼠标并点击选择的拆分断点；字符型语言（中文等）按字符拆分，单词型语言（英语等）只在空格处切分，确保不会拆碎单词。你可以在多重字幕设置中切换语言类型。': 'Move the mouse and click to choose a split boundary. Character-based languages such as Chinese split by character; word-based languages such as English split only at spaces so words stay intact. Change the language type in the multiple-subtitle settings.',
    '选择副字幕拆分点': 'Choose a secondary subtitle split point', '选择副字幕断点': 'Choose a secondary subtitle split point', '选择主字幕拆分点': 'Choose a main subtitle split point', '主字幕按时间码定位，选择副字幕拆分点': 'Main subtitle positioned by timecode; choose the secondary subtitle split point', '⌚️ 主字幕按时间码会拆在这里': '⌚️ The main subtitle will split here by timecode', '主字幕按时间码拆分位置，不可交互': 'Main subtitle timecode split position; not interactive', '主字幕按时间码拆分于此处，不可交互': 'The main subtitle splits here by timecode; not interactive',
    '在鼠标位置拆分': 'Split at pointer position', '拆分拓展字幕': 'Split extension subtitle',
    '取消（Esc）': 'Cancel (Esc)', '拆分（Enter / B）': 'Split (Enter / B)', '全部拆分后自动提交': 'Auto-submit after all split points are selected',
    '分割工具（R）：点击字幕块在指针位置安全拆分（默认按字词时间码对齐；没有可用字词时间码或关闭设置后打开拆分点弹窗，拒绝 100ms 以内的边缘拆分）；Esc 切回选择': 'Razor tool (R): click a subtitle block to safely split at the pointer (by default aligned to word timestamps; when no usable word timestamps exist or the setting is disabled, open the split-point dialog; reject splits within 100 ms of an edge); Esc returns to Select',
    '菜单': 'Menu', '显示菜单': 'Show menu', '单击': 'Click',
    'Shift+点击': 'Shift+click', 'Ctrl+点击': 'Ctrl+click',
    'Shift+拖拽空白处': 'Shift+drag blank area', '框选字幕': 'Box-select subtitles',
    'Shift+滚轮': 'Shift+wheel', 'Ctrl+滚轮': 'Ctrl+wheel',
    'Ctrl+Shift+滚轮': 'Ctrl+Shift+wheel',
    '（编辑字幕文本时）在文字光标处拆分': 'Split at the text cursor (while editing)',
    '静音空隙': 'Silent gaps', 'Alt+点击静音空隙区段': 'Alt+click a silent-gap region',
    'Alt+中键拖动': 'Alt+middle-button drag',
    '选中': 'Select', '双击': 'Double-click', '编辑': 'Edit',
    '原地编辑已选字幕（最后点击在列表）': 'Edit the selected subtitle in place (last click in the list)',
    '聚焦字幕编辑区（其它区域）': 'Focus the subtitle editor (other regions)',
    '在鼠标所指的已选字幕文字处拆分（列表内）': 'Split the selected subtitle text under the pointer (in the list)',
    '在鼠标所指的音频位置拆分（波形上；列表外按播放指针）': 'Split at the audio position under the pointer (on the waveform; elsewhere at the playhead)',
    '进入字幕编辑区（仅单选时）': 'Focus subtitle editor (single selection only)', '退出字幕编辑区（文本编辑时）': 'Exit subtitle editor (while editing)', '清除字幕选择（非编辑状态）': 'Clear subtitle selection (when not editing)',
    '选中所有字幕': 'Select all subtitles', '选中所有字幕（非编辑状态）': 'Select all subtitles (when not editing)',
    '右键': 'Right-click', '通用': 'General', '字幕操作': 'Subtitle actions', '波形区': 'Waveform area', '波形区字幕操作': 'Waveform subtitle actions',
    '鼠标操作': 'Mouse actions', '选择操作': 'Selection', '编辑操作': 'Editing actions', '快捷功能': 'Quick actions', '切换工具': 'Switch tools',
    '波形区操作': 'Waveform actions', '空白波形区': 'Blank waveform area', '波形外观调整': 'Waveform appearance', '静音空隙操作': 'Silent-gap operations', '字幕列表': 'Subtitle list',
    'WASD 方向键': 'WASD directional keys', '选择前/后字幕': 'Select previous/next subtitle', '连选前/后字幕': 'Extend selection backward/forward',
    '其实就是用 WASD 啦，从字幕列表看是上下跳，从波形区看是左右跳 : P': 'It is just WASD: jump up and down in the subtitle list, and left and right in the waveform area : P',
    '波形区显示': 'Waveform display', '显示调整': 'Display adjustments',
    '启用/禁用字幕': 'Enable/disable subtitle',
    '编辑选中字幕（根据最后点击区域）': 'Edit the selected subtitle (based on the last clicked area)',
    '编辑选中字幕（激活编辑区）': 'Edit the selected subtitle (activate the editor)', '按光标所在文字位置拆分字幕': 'Split the subtitle at the text cursor position', '拆分字幕（取决于鼠标位置）': 'Split the subtitle based on the mouse position', '切回选择工具': 'Return to the Select tool',
    '选择前后字幕': 'Select previous/next subtitles', '连续多选字幕': 'Select a continuous range',
    '点击【🔧 设置】后，可在【音频波形区】调整显示的具体参数': 'Click 🔧 Settings to adjust the display parameters in the Audio waveform area',
    '多选': 'Multi-select', '连选': 'Range select',
    '鼠标': 'Mouse', '编辑状态': 'Editing', '功能快捷键': 'Action shortcuts',
    '工具': 'Tools', '滚轮': 'Wheel', '字幕导航': 'Subtitle navigation',
    '切换字幕禁用': 'Toggle subtitle disabled', '删除所选字幕': 'Delete selected subtitles',
    '合并所选字幕': 'Merge selected subtitles', '合并副字幕块': 'Merge extension subtitle blocks',
    '按所在区域拆分字幕': 'Split a subtitle based on the pointer area',
    '单选副字幕后绑定到主字幕（唯一重叠时自动匹配）': 'With one extension subtitle selected, bind it to a main subtitle (auto-match the earliest unbound overlap)',
    '单选副字幕后绑定到主字幕（自动匹配时间最早的未绑定主字幕）': 'With one extension subtitle selected, bind it to a main subtitle (auto-match the earliest unbound overlap)',
    '语言类型提示': 'Language type hint',
    '解绑当前副字幕': 'Unbind the current extension subtitle',
    '对齐副字幕到主字幕时间轴': 'Align the extension subtitle to the main subtitle timeline',
    '单选副字幕后打开副字幕拆分': 'With one extension subtitle selected, open extension subtitle splitting',
    '波形标记：': 'Waveform labels:',
    '语言类型：单词型适合英语等空格语言，字符型适合中文/日文等': 'Language type: Word-based suits English and other space-separated languages; Character-based suits Chinese/Japanese and similar languages',
    '普通点击以最后点击的轨道为准；未绑定副字幕不会保留旧主字幕选区。开启「同时选中主副字幕」时，仅补选当前字幕实际绑定的另一条；编辑区仍以最后点击的字幕为准': 'Normal clicks follow the last clicked track; an unbound extension subtitle does not keep an old main selection. When “Select main and secondary subtitles together” is enabled, only the subtitle actually bound to the clicked cue is added; the editor still follows the last clicked subtitle',
    '播放与编辑': 'Playback and editing', '空格': 'Space',
    '选择工具': 'Select tool', '分割工具': 'Razor tool',
    '播放/暂停': 'Play/pause',
    '无选中时前后跳转': 'Seek back/forward with no selection',
    '提示：可在「媒体」设置中切换 J/K/L 的「慢放/快放」或「倒放/正放」，也可调整跳转时长。': 'Tip: In Media settings, switch J/K/L between “slow/fast” and “reverse/forward”, and adjust the seek duration.',
    '选中字幕时': 'With subtitles selected:', '选中字幕时：': 'With subtitles selected:',
    '按键微调字幕': 'Fine-tuning subtitles with keys', '选中字幕': 'With a subtitle selected',
    '微调移动字幕': 'Fine-tune subtitle movement', '将字幕起点/终点贴到前一条结尾/后一条开头': 'Snap the subtitle start/end to the previous end/next start',
    '将字幕起点/终点定位到鼠标位置': 'place the subtitle start/end at the pointer',
    '无选中时作用于鼠标所在字幕；主字幕会联动绑定副字幕，副字幕只调整自身；多选不生效': 'With no selection, operate on the subtitle under the pointer; main subtitles move their bound secondary subtitle, while secondary subtitles move alone; no effect on multi-selection',
    '微调字幕左边界（起点）': 'Fine-tune the subtitle left edge (start)',
    '微调字幕右边界（终点）': 'Fine-tune the subtitle right edge (end)',
    '按住字幕时': 'While holding a subtitle:', '按住字幕时：': 'While holding a subtitle:',
    '按住字幕': 'While holding a subtitle',
    '绑定到主副字幕（自动匹配）': 'Bind to a main/secondary subtitle pair (auto-match)',
    '移动鼠标点击，或用键盘选择拆分断点。': 'Click with the mouse, or use the keyboard to pick split points.',
    '拆分弹窗按键提示': 'Split modal keyboard hints',
    '方向键': 'arrow keys', '移动 ✂️': 'move ✂️', '锁定 / 解锁断点': 'lock / unlock breakpoint',
    '切换主/副字幕': 'switch main/secondary subtitle',
    '字幕编辑快捷键': 'Subtitle editing shortcuts',
    '向前/后微调移动字幕（按住': 'Fine-tune subtitle movement backward/forward (hold',
    '临时反转相邻字幕联动': 'temporarily reverse adjacent-cue linking',
    '临时反转相邻字幕联动）': 'to temporarily reverse adjacent-cue linking)',
    '将字幕起点贴到前一条结尾': 'Snap the subtitle start to the previous end',
    '将字幕终点贴到后一条开头': 'Snap the subtitle end to the next start',
    '注：微调幅度可在「设置->波形区」中调节，默认 50ms': 'Note: Adjust the fine-tuning amount in “Settings -> Waveform area”; the default is 50 ms',
    '其他': 'Other',
    '字幕按键微调幅度': 'Subtitle keyboard adjustment amount',
    '具体用法详见帮助的「按键调整」区': 'See the “Keyboard adjustment” section in Help for details',
    '上一条字幕': 'Previous subtitle', '下一条字幕': 'Next subtitle',
    '向前多选': 'Extend selection backward', '向后多选': 'Extend selection forward',
    '在红色播放指针处拆分字幕': 'Split subtitle at the red playhead',
    '跳转并播放选中字幕': 'Seek to and play selected subtitle',
    '倍速 ×0.5/重置/×2': 'Speed ×0.5/reset/×2',
    '双击波形': 'Double-click waveform', '右键波形背景': 'Right-click waveform background',
    '在鼠标位置创建字幕（仅波形）': 'Create a subtitle at the pointer (waveform only)',
    'Ctrl+拖拽空白处': 'Ctrl+drag blank area', '拖动创建指定时长字幕': 'Drag to create a subtitle with a specified duration',
    '创建字幕': 'Create subtitle', '新增字幕': 'Create subtitle',
    '该空白区域不足 100ms，无法新增字幕': 'The blank range is shorter than 100 ms; cannot create a subtitle',
    '这里没有足够的空白区域': 'There is not enough blank space here',
    '该位置已有字幕，无法新增字幕': 'A subtitle already exists at this position; cannot create another one',
    '拖动范围包含已有字幕，无法新增字幕': 'The dragged range contains an existing subtitle; cannot create a new one',
    '已取消新增字幕': 'Subtitle creation canceled',
    '选择工具': 'Select tool', '分割工具': 'Razor tool',
    '增加静音区段': 'Add silent region',
    '空隙区段操作方式设为「中键拖动」时：': 'When gap region operation is “Middle-button drag”:',
    '增加恢复区段': 'Add restored region', '切换移除/保留': 'Toggle removed/kept',
    '恢复区段': 'Restore region', '移除区段': 'Remove region', '清理该区段': 'Clear this region',
    '调整时间缩放/每行长度': 'Adjust zoom/seconds per row',
    '调整波形振幅': 'Adjust waveform amplitude',
    '调整每行高度': 'Adjust row height', '拖动边界': 'Drag boundary',
    '禁用波形': 'Disable waveform', '淡化': 'Dim', '完全隐藏': 'Hide completely',
    '当前字幕编辑区': 'Current subtitle editor',
    '⋮⋮ 视频': '⋮⋮ Video', '⋮⋮ 当前字幕': '⋮⋮ Current subtitle',
    '⋮⋮ 波形': '⋮⋮ Waveform', '⋮⋮ 字幕列表': '⋮⋮ Subtitle list',
    '未选择': 'Not selected',
    '加载工程后显示字幕列表': 'Subtitle list appears after loading a project',
    '加载媒体后显示视频': 'Video appears after loading media',
    '加载媒体后显示波形': 'Waveform appears after loading media',
    '‹ 前一条': '‹ Previous', '后一条 ›': 'Next ›', '＋ 表情包': '＋ Sticker',
    '在光标处拆分': 'Split at cursor', '在光标处拆分（': 'Split at cursor (', '范围：全部字幕': 'Scope: all subtitles',
    '查找': 'Find', '替换为': 'Replace with', '批量替换': 'Batch replace',
    '区分大小写': 'Case sensitive',
    '正则表达式': 'Regular expression',
    '输入查找内容查看预览': 'Enter text to preview replacements',
    '取消': 'Cancel', '替换全部': 'Replace all', '分配表情包': 'Assign sticker',
    '清除当前': 'Clear current', '替换': 'Replace', '删除': 'Delete', '关闭': 'Close',
    '设置表情包根目录': 'Set sticker root folder',
    '仅服务器版编辑器可将改动保存回当前工程文件': 'Only the server editor can save changes back to the current project file',
    '所有表情包路径都基于此根目录。修改后页面所有缩略图会立刻按新路径加载。': 'All sticker paths are relative to this root. Thumbnails update immediately after it changes.',
    '支持 OS 路径（D:/foo/bar 或 D:\\foo\\bar）或 file:// URL。点 📁 扫描只加载缩略图预览，不会自动填入导出路径。': 'Supports OS paths (D:/foo/bar or D:\\foo\\bar) and file:// URLs. 📁 Scan only loads thumbnail previews; it does not fill in the export path.',
    '当前根目录（绝对路径）': 'Current root folder (absolute path)',
    '📁 扫描': '📁 Scan', '应用': 'Apply',
    '⬆️ 当前是浏览器加载模式，请手动填写真实磁盘路径以导出 OTIO 工程': '⬆️ Browser mode is active. Manually enter the real disk path to export the OTIO project',
    '（或在启动器的 ⚙️ 设置中填写表情包路径后，重新启动服务器）': '(or set the sticker path in the Launcher ⚙️ settings and restart the server)',
    '选择关联媒体': 'Choose related media',
    '浏览器无法自动读取工程所在目录的关联媒体。': 'The browser cannot automatically read media from the project folder.',
    '现在选择一次，或稍后点击“加载媒体”。': 'Choose it once now, or click “Load media” later.',
    '选择媒体': 'Choose media', '稍后加载': 'Load later',
    '📥 松开以加载文件（视频 / 音频 / JSON）': '📥 Drop to load files (video / audio / JSON)',
    '本机工程': 'Local projects', '时长': 'Duration', '总长度': 'Total length',
    '字/秒': 'chars/s', '无': 'None', '开始': 'Start', '导出': 'Export',
    '跳转并播放': 'Seek and play', '按音频位置拆分': 'Split at audio position',
    '按音频位置拆分主字幕': 'Split main subtitle at audio position',
    '按音频位置拆分副字幕': 'Split secondary subtitle at audio position',
    '按文字位置拆分': 'Split at text position', '跳转到字幕并播放': 'Seek to subtitle and play',
    '分配表情包…': 'Assign sticker…', '删除表情包': 'Remove sticker',
    '标记颜色': 'Mark color', '清除颜色': 'Clear color',
    '启用此条': 'Enable this subtitle', '禁用此条': 'Disable this subtitle',
    '删除字幕': 'Delete subtitle', '拓展表情包时长': 'Extend sticker duration',
    '统一分配表情包…': 'Assign sticker to selection…',
    '批量替换选中字幕…': 'Batch replace selected subtitles…',
    '启用选中': 'Enable selection', '禁用选中': 'Disable selection',
    '清除所有选中': 'Clear selection', '取消选中': 'Deselect', '取消选择': 'Deselect', '请选择至少两个字幕块！': 'Select at least two subtitle blocks!',
    '红': 'Red', '黄': 'Yellow',
    '蓝': 'Blue', '绿': 'Green', '紫': 'Purple',
    '红色': 'red', '黄色': 'yellow', '蓝色': 'blue', '绿色': 'green', '紫色': 'purple'
  };

  const EN_ATTR = {
    '切换到亮色主题': 'Switch to light theme',
    '切换到暗色主题': 'Switch to dark theme',
    '保存工程的更多选项': 'More save options',
    '波形显示模式': 'Waveform display mode',
    '打开更多文件': 'Open more files',
    '导出或导入工作区配置': 'Export or import workspace configuration',
    '只影响播放器画面内的字幕预览，不改变字幕文本或时间': 'Only affects subtitle preview in the player; subtitle text and timing are unchanged',
    '选择播放器画面内字幕预览使用的字体族': 'Choose the font family used by the subtitle preview in the player',
    '读取本机已安装的字体': 'Read fonts installed on this computer',
    '调整播放器画面内字幕预览的背景色': 'Adjust the subtitle preview background color in the player',
    '字幕背景色': 'Subtitle background color',
    '调整播放器画面内字幕预览背景的不透明度，设为 0 时隐藏背景': 'Adjust the subtitle preview background opacity in the player; 0 hides the background',
    '字幕背景不透明度': 'Subtitle background opacity',
    '只影响播放器画面内的拓展字幕预览': 'Only affects extension subtitle preview in the player',
    '波形形状来源：默认使用自研 1000Hz 重采样缓存；需要时可切换到媒体旁 .ReaPeaks 的最细 wave 层': 'Waveform shape source: use the self-built 1000 Hz resampled cache by default; switch to the finest wave layer beside the media from .ReaPeaks when needed',
    '选择播放器画面内拓展字幕预览使用的字体族': 'Choose the font family used by the extension subtitle preview in the player',
    '选择播放器画面内副字幕预览使用的字体族': 'Choose the font family used by the secondary subtitle preview in the player',
    '选择播放器画面内主字幕预览的颜色': 'Choose the color of the main subtitle preview in the player',
    '选择播放器画面内拓展字幕预览的颜色': 'Choose the color of the extension subtitle preview in the player',
    '调整播放器画面内副字幕预览的背景色': 'Adjust the secondary subtitle preview background color in the player',
    '选择播放器画面内副字幕预览的颜色': 'Choose the color of the secondary subtitle preview in the player',
    '字幕预览设置': 'Subtitle preview settings',
    '点击复制工程文件名': 'Click to copy the project file name',
    '点击替换；右键删除': 'Click to replace; right-click to remove',
    '点击选择表情包；右键删除引用': 'Click to pick a sticker; right-click to remove the reference',
    '点击添加表情包': 'Click to add a sticker',
    '请用带工程文件路径的服务器命令启动，才能直接保存':
      'Start the server with a project file path to enable direct saving',
    'SRT 字幕只能通过导出下载保存为工程文件':
      'SRT subtitles can only be saved as a project file through export',
    '字幕预览位置。可拖动调整；方向键移动，按住 Shift 加速，按住 Alt 配合方向键调整大小，Enter 或空格显示控制点，Esc 退出。':
      'Subtitle preview position. Drag to adjust; arrow keys move, hold Shift to speed up, hold Alt with arrows to resize, Enter or Space shows handles, Esc exits.',
    '表情包预览位置。可拖动调整；方向键移动，按住 Shift 加速，按住 Alt 配合方向键调整大小，Enter 或空格显示控制点，Esc 退出。':
      'Sticker preview position. Drag to adjust; arrow keys move, hold Shift to speed up, hold Alt with arrows to resize, Enter or Space shows handles, Esc exits.',
    '撤销 (Ctrl(Cmd)+Z)': 'Undo (Ctrl(Cmd)+Z)',
    '重做 (Ctrl(Cmd)+Shift+Z)': 'Redo (Ctrl(Cmd)+Shift+Z)',
    '撤销重做': 'Undo and redo',
    '打开本机最近使用的工程': 'Open a recently used local project',
    '保存回服务器启动时指定的工程文件': 'Save to the project file bound when the server started',
    '保存回当前工程文件（Ctrl(Cmd)+S）': 'Save to the current project file (Ctrl(Cmd)+S)',
    '另存为到当前工程目录': 'Save as in the current project folder',
    '另存为工程文件（Ctrl(Cmd)+Shift+S）': 'Save as a project file (Ctrl(Cmd)+Shift+S)',
    '🦊 表情包': '🦊 Stickers',
    '另存为到当前工程目录（Ctrl(Cmd)+Shift+S）': 'Save as in the current project folder (Ctrl(Cmd)+Shift+S)',
    '选择本地媒体文件并加载到播放器': 'Choose a local media file and load it in the player',
    '单独打开工程；浏览器无法自动读取关联媒体时会提示选择': 'Open a project by itself; the browser will prompt when it cannot read related media automatically',
    '设置表情包根目录': 'Set sticker root folder',
    '过滤字幕…': 'Filter subtitles…', '清空': 'Clear', '正在加载…': 'Loading…',
    '只显示超过阈值的字幕（再次点击关闭）': 'Show only subtitles over the threshold (click again to turn off)',
    '查看鼠标操作与键盘快捷键': 'View mouse and keyboard shortcuts',
    '展开编辑器通用设置': 'Open editor general settings', '展开字幕、波形与导出设置': 'Open subtitle, waveform, and export settings',
    '选中字幕时，方向键和按住字幕块/边界时的 A/D 每次调整的毫秒数': 'Milliseconds adjusted per arrow-key press or A/D press while holding a subtitle block or edge',
    '关闭（Esc）': 'Close (Esc)',
    '关闭帮助窗口': 'Close the help window',
    '关闭移除静音空隙工具窗': 'Close the silent-gap tool',
    '放大时间轴': 'Zoom in', '缩小时间轴': 'Zoom out',
    '增大波形振幅': 'Increase waveform amplitude',
    '减小波形振幅': 'Decrease waveform amplitude',
    '选择一条字幕开始编辑…': 'Select a subtitle to start editing…',
    '要查找的内容': 'Text to find', '替换后的内容': 'Replacement text',
    '按文件名过滤...': 'Filter by filename…',
    '扫描本地文件夹以加载表情包缩略图（浏览器拿不到磁盘路径，需手动填写导出路径）': 'Scan a local folder to load sticker thumbnails (the browser cannot see the disk path; fill in the export path manually)',
    '如 D:/AI/AI音频转录/表情包': 'e.g. D:/Media/Stickers',
    '下次不带 JSON 路径启动服务器时，自动恢复上次打开的工程': 'Automatically restore the last project when the server starts without a JSON path',
    '只影响导出的 SRT，不改动工程或 OTIO 的时间轴': 'Only affects exported SRT; project and OTIO timelines are unchanged',
    '只把第一条导出字幕的起点拉到 00:00，保留其结束时间和后续字幕时间码；不改动工程或 OTIO 的时间轴': 'Move only the first exported subtitle start to 00:00; keep its end time and later subtitle timecodes; project and OTIO timelines are unchanged',
    'MAWE 设置': 'MAWE settings', '操作帮助': 'Controls help',
    '快速上手': 'Quick start', '重新查看快速上手': 'Replay quick start', '跳过': 'Skip', '跳过 (ESC)': 'Skip (ESC)',
    '帮助分类': 'Help categories',
    '打开工程后开始快速上手': 'Open a project to start the quick start guide',
    '先打开一个包含字幕的工程；编辑器会用 3 个短练习带你熟悉最常用的操作。': 'Open a project with subtitles first; the editor will use 3 short practices to teach the most common operations.',
    '打开一个工程后，这里会带你熟悉最常用的字幕操作。': 'Open a project and this space will guide you through the most common subtitle operations.',
    '像玩游戏一样编辑': 'Edit like a game',
    '使用 WASD 选择前后字幕——就像游戏一样！': 'Use WASD to move through subtitles — just like a game!',
    '先选中任意一条字幕，然后用 WASD 在前后字幕之间移动。移动 3 次后点击下一步。': 'Select any subtitle, then move through nearby subtitles with WASD. Move 3 times, then click Next.',
    '在字幕列表，用 W 和 S 「上下」选择字幕，在波形区，用 A 和 D 「左右」选择字幕——取决于你观看的视角 😏': 'In the subtitle list, use W and S to move “up and down”; in the waveform area, use A and D to move “left and right” — it depends on your point of view 😏',
    'WASD 键位示意': 'WASD key layout',
    '开始练习': 'Start practice', '下一步': 'Next', '稍后再试': 'Try later', '继续移动': 'Keep moving',
    '按住 Shift 选择': 'Hold Shift to select', '等待撤销': 'Waiting for undo', '等待拆分': 'Waiting for split',
    '已完成，点击下一步': 'Complete — click Next',
    '其余快捷键和波形操作，随时点击': 'For the remaining shortcuts and waveform controls, click', '查看。': 'to view them.',
    'Shift + WASD + C：连续多选并合并': 'Shift + WASD + C: select a range and merge it',
    'Shift + WASD：扩展选择': 'Shift + WASD: extend the selection',
    '按 C 合并字幕': 'Press C to merge subtitles',
    '按住 Shift，用 WASD 扩展选择，选中至少两条连续字幕。': 'Hold Shift and use WASD to select at least two adjacent subtitles.',
    '已选中连续字幕，现在按 C 合并。': 'Adjacent subtitles are selected. Now press C to merge.',
    '操作已恢复，点击下一步进入拆分。': 'The edit has been undone. Click Next to move on to splitting.',
    '选中至少两条后按 C': 'select at least two, then press C',
    '已合并。现在按': 'Merged. Now press', '撤销这次体验。': 'to undo this practice edit.', '撤销刚才的合并': 'undo the merge you just made',
    '撤销刚才的合并。': 'to undo the merge you just made.', '合并已撤销': 'Merge undone',
    '撤销后再进入拆分。': 'After undoing, we will move on to splitting.',
    '最后：在光标处拆分字幕': 'Finally: split a subtitle at the cursor',
    '快速上手完成': 'Quick start complete', '编辑时间线': 'Edit the timeline', '常见操作': 'Common operations',
    '可以在右上角的【🤔 帮助】中随时查看。': 'You can always check the “🤔 Help” button in the top right.',
    '双击字幕列表中的字幕，光标会自动放置在点击位置，按 {key} 即可拆分。': 'Double-click a subtitle in the subtitle list; the cursor is placed at the click position, then press {key} to split.',
    '开始实际拆分': 'Try a real split', '跳过实际拆分': 'Skip real split',
    '这次会修改当前字幕，但可以用': 'This will modify the current subtitle, but you can undo it with',
    '撤销。': 'Undo.', '双击高亮字幕，在文字中间放置光标，再按': 'Double-click the highlighted subtitle, place the cursor in the middle, then press',
    '拆分已完成。需要回退时按': 'The split is complete. To roll it back, press',
    '完成！': 'Done!', '已掌握基础操作。': 'You have learned the basics.',
    '打开完整帮助': 'Open full help', '结束引导': 'Finish guide',
    '连续字幕已合并': 'Adjacent subtitles merged', '第一条字幕': 'First subtitle', '第二条字幕': 'Second subtitle', '第三条字幕': 'Third subtitle',
    '拆分完成': 'Split complete',
    '高亮字幕': 'Highlighted subtitle', '真实拆分': 'Real split', '以后想回退？': 'Need to go back later?',
    '今天的天气很好': 'The weather is nice today', '我们去散步吧': 'Let’s go for a walk',
    '已选择': 'Selected', '次': 'times', '条': 'subtitles',
    '已合并': 'Merged', '已撤销': 'Undone', '演示不会修改工程': 'The demo does not modify the project',
    '请先点击“开始练习”': 'Click “Start practice” first', '请按': 'Press',
    '完成真实拆分': 'to complete the real split', '当前工程没有足够长的字幕可用于拆分练习': 'This project does not have a subtitle long enough for the split practice',
    '已撤销这次体验，接下来学习拆分': 'The practice edit was undone; next we will learn to split',
    '已撤销这次体验，请点击下一步学习拆分': 'The practice edit was undone; click Next to learn splitting',
    '拆分已完成；需要回退时可以使用撤销': 'Split complete; use Undo if you need to roll it back',
    '你可以点击': 'You can click', '设置': 'Settings', '来更改拆分按键': 'to change the split key',
    '编辑字幕时，也可以选择用 Enter 直接拆分——在【设置】中可修改按键': 'While editing subtitles, you can also split directly with Enter — you can change the key in 【设置】',
    '你也可以右键点击字幕后选择拆分': 'You can also right-click a subtitle and choose Split',
    '鼠标在波形区时，可以右键拆分，也可以按B在鼠标位置拆分': 'When the mouse is over the waveform, right-click to split, or press B to split at the mouse position',
    '也可以使用右键菜单拆分': 'You can also split from the right-click menu',
    '波形区同样支持拆分，详见帮助。': 'The waveform area also supports splitting; see Help for details.',
    '撤销这次合并': 'Undo this merge',
    '编辑器工具': 'Editor tools', '波形工具': 'Waveform tools',
    '波形模式': 'Waveform mode', '音频波形': 'Audio waveform',
    '点击替换；右键删除': 'Click to replace; right-click to delete', '暂无表情包': 'No stickers yet'
    ,
    '导出完整字幕或按颜色分别导出字幕': 'Export full subtitles or separate files by color',
    '导出应用当前空隙移除结果的字幕、时间线或保留区域计划': 'Export subtitles, timelines, or kept regions using the current gap-removal result',
    '按移除静音空隙后的时间轴导出字幕；原工程时间不变': 'Export subtitles on the gap-removed timeline; project timing stays unchanged',
    '按移除静音空隙后的时间轴，为每种已使用颜色分别导出一份字幕': 'Export one subtitle file per used color on the gap-removed timeline',
    '导出原视频/音频的去空隙 OTIO 时间线，供支持 OTIO 的剪辑工具或工作流使用': 'Export a gap-removed OTIO timeline for compatible editing tools',
    '导出 FFmpeg concat demuxer 可读取的保留区间；流复制的切点精度受关键帧和编码包限制': 'Export kept intervals for FFmpeg concat; stream-copy cut accuracy depends on keyframes and packets',
    '以毫秒为单位导出原媒体中的全部保留区域，供自定义脚本或工具读取': 'Export all kept source-media regions in milliseconds',
    '按移除静音空隙后的时间轴导出表情包图片轨道 OTIO；完全落在空隙内的表情包会被丢弃': 'Export sticker image tracks on the gap-removed OTIO timeline; stickers fully inside gaps are omitted',
    '导出表情包时间线': 'Export sticker timeline',
    '导出颜色与表情包的 Resolve JSON，供兼容执行脚本批量导入': 'Export color and sticker Resolve JSON for compatible import scripts',
    '导出只包含表情包图片轨道的 OTIO 工程': 'Export an OTIO project containing only sticker image tracks',
    '实验性 Premiere 交接：导出 FCP 7 XML': 'Experimental Premiere handoff: export FCP 7 XML',
    '在视频画面右上角预览当前时间的表情包': 'Preview stickers at the current time over the video',
    '选择工具（V，默认）：点击选中、拖动移动、拖动边界调整；Ctrl(Cmd)/Shift 多选，Shift+空白拖拽框选，Alt 临时反转相邻字幕联动，Alt+点击切换禁用': 'Select tool (V, default): click to select, drag to move, drag edges to trim; Ctrl(Cmd)/Shift multi-select, Shift+drag on blank area to box-select, Alt temporarily reverses adjacent-cue linking, Alt+click toggles disabled',
    '分割工具（R）：点击字幕块在指针位置安全拆分（按词/字级时间码对齐，拒绝 100ms 以内的边缘拆分）；Esc 切回选择': 'Razor tool (R): click a subtitle block to split at the pointer using word/character timing; splits within 100 ms of an edge are rejected; Esc returns to Select',
    '打开可拖动的移除静音空隙工具窗': 'Open the draggable silent-gap tool',
    '打开可拖动的拼合字幕工具窗': 'Open the draggable snap-subtitles tool',
    '关闭拼合字幕工具窗': 'Close the snap-subtitles tool',
    '将间隔过短的前后字幕直接吸附在一起，去除中间的短暂空白（可直接吸收短字幕）': 'Snap nearby subtitles together to remove the brief gap between them (short subtitles can also be absorbed)',
    '关闭拼接/合并字幕工具窗': 'Close the join / merge subtitles tool',
    '关闭后只拼合间隔，不合并任何字幕': 'When off, only intervals are snapped and no subtitles are merged',
    '播放时跳过已移除的静音空隙；左键定位到空隙内时可临时预览': 'Skip removed silent gaps during playback; clicking inside a gap previews it temporarily',
    '工作区：窗口布局与显示状态（列表显示项、波形模式等）': 'Workspace: window layout and display state (list fields, waveform mode, etc.)',
    '显示面板标题条和拖动预览': 'Show panel title bars and drag previews',
    '恢复当前内置工作区的默认状态': 'Restore the current built-in workspace to its default state',
    '保存到当前工作区': 'Save to the current workspace',
    '将当前工作区另存为新的工作区': 'Save the current workspace as a new workspace',
    '删除本机保存的工作区': 'Delete the workspace saved on this machine',
    '字幕列表与波形字幕块的普通单击行为；双击编辑不受影响': 'Default click behavior for subtitle rows and waveform blocks; double-click editing is unchanged',
    '编辑字幕时，选择 Enter 或 Ctrl(Cmd)+Enter 在文字光标处拆分；另一个按键用于保存': 'While editing, choose Enter or Ctrl(Cmd)+Enter to split at the text cursor; the other key saves',
    '开启后，普通点击属于表情包或颜色分组的字幕时，会同时选中该分组的全部成员；关闭时只选中点击的那一条': 'When enabled, clicking a sticker/color group member selects the whole group; otherwise only that subtitle is selected',
    '多行波形每一行的高度；也可用 Ctrl(Cmd)+Shift+滚轮 在波形上直接调节': 'Height of each multi-row waveform row; Ctrl(Cmd)+Shift+wheel also adjusts it directly',
    '在多行波形中，为成组（颜色/表情包）字幕在块上方显示队长皇冠与组内序号': 'Show a leader crown and member index above grouped color/sticker subtitles in multi-row mode',
    '启用后，在波形空白区域按住左键拖动时，播放指针会实时跟随鼠标位置': 'When enabled, dragging with the left button on empty waveform areas moves the playhead along with the mouse',
    '移除静音空隙的人工修正方式；Alt+左键始终切换整段；中键拖动默认增加静音，按住 Alt 才恢复声音，边界碰到另一空隙时会合并': 'Manual silent-gap correction mode; Alt+click toggles a full region; middle-drag adds silence, Alt restores audio, and touching regions merge',
    '勾选后按颜色导出会先选择一个 SRT 文件名作为前缀，再下载「前缀_颜色.srt」；取消勾选则逐个颜色弹出保存对话框': 'When enabled, choose an SRT filename as the prefix, then download prefix_color.srt files; otherwise choose each file separately',
    '拖动调整波形与字幕区域比例': 'Drag to resize waveform and subtitle areas',
    '拖动调整布局区域比例': 'Drag to resize layout areas',
    '拖动调整左右区域宽度': 'Drag to resize left and right areas',
    '拖动调整视频与当前字幕高度': 'Drag to resize video and current-subtitle heights',
    '拖动调整当前字幕与字幕列表高度': 'Drag to resize current-subtitle and subtitle-list heights'
  };

  const textOriginals = new WeakMap();
  const attributeOriginals = new WeakMap();
  const SKIP_SELECTOR = [
    '#cue-list', '#cue-panel-text', '#overlay', '#sticker-overlay-layer',
    '#media-name', '#json-name', '#sticker-grid', '.hint-project-preview-value', 'script', 'style'
  ].join(',');
  const ATTRIBUTE_SKIP_SELECTOR = [
    // .waveform-cue-block 的 title 是用户字幕原文，不能参与翻译
    '#cue-list', '#overlay', '#sticker-overlay-layer', '.waveform-cue-block',
    '#media-name', '#json-name', '#sticker-grid', 'script', 'style'
  ].join(',');

  function normalizeLanguage(value) {
    return String(value || '').toLowerCase().startsWith('en') ? EN : ZH;
  }

  function persistLanguage(nextLanguage) {
    try { global.localStorage?.setItem(STORAGE_KEY, nextLanguage); } catch (_) {}
  }

  function languageFromLaunchUrl() {
    try {
      const location = global.location;
      if (!location?.href) return null;
      const url = new URL(location.href);
      const requested = url.searchParams.get('lang');
      if (requested !== ZH && requested !== EN) return null;
      url.searchParams.delete('lang');
      if (global.history?.replaceState && /^https?:$/.test(url.protocol)) {
        global.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
      return requested;
    } catch (_) {
      return null;
    }
  }

  function readLanguage() {
    const launched = languageFromLaunchUrl();
    if (launched) {
      persistLanguage(launched);
      return launched;
    }
    if (GENERATED_LANGUAGE === ZH || GENERATED_LANGUAGE === EN) {
      persistLanguage(GENERATED_LANGUAGE);
      return GENERATED_LANGUAGE;
    }
    try {
      return normalizeLanguage(global.localStorage?.getItem(STORAGE_KEY) || ZH);
    } catch (_) {
      return ZH;
    }
  }

  let language = readLanguage();

  function translateText(value, lang = language) {
    const text = String(value ?? '');
    if (lang !== EN) return text;
    if (EN_TEXT[text]) return EN_TEXT[text];
    if (EN_ATTR[text]) return EN_ATTR[text];
    let match = /^(主字幕|副字幕)\s+(\d+)$/.exec(text);
    if (match) return `${translateText(match[1], EN)} ${match[2]}`;
    match = /^版本号\s+(.+)$/.exec(text);
    if (match) return `Version ${match[1]}`;
    // 动态 title / 徽标：带变量的属性文案
    match = /^颜色：(.+)$/.exec(text);
    if (match) {
      const name = translateText(match[1], EN);
      return `Color: ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    }
    match = /^↑\s*属于第\s*(\d+)\s*条的颜色（(.+)）$/.exec(text);
    if (match) return `↑ Inherits the color of subtitle ${match[1]} (${translateText(match[2], EN)})`;
    match = /^属于上方第\s*(\d+)\s*条的表情包$/.exec(text);
    if (match) return `Inherits the sticker of subtitle ${match[1]}`;
    match = /^工程路径失效：(.+)$/.exec(text);
    if (match) return `Project path is no longer valid: ${match[1]}`;
    match = /^点击复制工程文件名：(.+)$/.exec(text);
    if (match) return `Click to copy the project file name: ${match[1]}`;
    match = /^点击复制媒体名：(.+)$/.exec(text);
    if (match) return `Click to copy the media name: ${match[1]}`;
    match = /^工程关联媒体：(.+)$/.exec(text);
    if (match) return `Media linked to this project: ${match[1]}`;
    match = /^(.+)（按\s*(\d+)）$/.exec(text);
    if (match) return `${translateText(match[1], EN)} (press ${match[2]})`;
    // 时长片段（供下面各摘要规则递归调用，必须排在它们之前，且只匹配纯时长，
    //  不能吞掉前缀文字，否则会抢先匹配整句）：6秒 / 6秒（占比 2.1%） / 1分 6秒
    match = /^(\d+(?:\.\d+)?)\s*秒（占比\s+(.+?)）$/.exec(text);
    if (match) return `${match[1]}s (${match[2]} of media)`;
    match = /^(\d+)\s*分\s*(\d+(?:\.\d+)?)\s*秒（占比\s+(.+?)）$/.exec(text);
    if (match) return `${match[1]}m ${match[2]}s (${match[3]} of media)`;
    match = /^(\d+(?:\.\d+)?)\s*秒$/.exec(text);
    if (match) return `${match[1]}s`;
    match = /^(\d+)\s*分\s*(\d+(?:\.\d+)?)\s*秒$/.exec(text);
    if (match) return `${match[1]}m ${match[2]}s`;
    // 空隙摘要（工具栏紧凑版）：已移除 4/4 段 · 6秒（占比 2.1%）[ · 人工修正]
    // 先剥离可选的「· 人工修正」尾巴，再整体翻译中间的时长片段。
    {
      const manual = / ·\s*人工修正$/.test(text);
      const body = manual ? text.replace(/ ·\s*人工修正$/, '') : text;
      const m = /^已移除\s+(\d+)\/(\d+)\s+段\s+·\s+(.+)$/.exec(body);
      if (m) {
        return `${m[1]}/${m[2]} gaps removed · ${translateText(m[3], EN)}`
          + (manual ? ' · manually adjusted' : '');
      }
    }
    // 空隙摘要（工具窗完整版）
    match = /^已移除\s+(\d+)\/(\d+)\s+段，共\s+(.+)；左键空隙跳转播放头，Alt\+左键切换移除。$/.exec(text);
    if (match) {
      return `${match[1]}/${match[2]} gaps removed, ${translateText(match[3], EN)} total. `
        + 'Left-click a gap to move the playhead; Alt+left-click toggles removal.';
    }
    // flashHint：已移除 N 段音量空隙，共 6秒（占比 2.1%）
    match = /^已移除\s+(\d+)\s+段音量空隙，共\s+(.+)$/.exec(text);
    if (match) return `Removed ${match[1]} loudness gaps, ${translateText(match[2], EN)} total`;
    // 波形状态：12:34.567 · 缓存波形（未加载媒体）
    match = /^(.+?)\s+·\s+缓存波形（未加载媒体）$/.exec(text);
    if (match) return `${match[1]} · cached waveform (no media loaded)`;
    match = /^未扫描空隙(?:\s+·\s+人工修正)?$/.exec(text);
    if (match) return text.includes('人工修正') ? 'No gap scan yet · manually adjusted' : 'No gap scan yet';
    if (text === ' · 人工修正') return ' · manually adjusted';
    match = /^(.+?)\s+·\s+人工修正$/.exec(text);
    if (match) return `${translateText(match[1])} · manually adjusted`;
    match = /^上次打开：(.+)$/.exec(text);
    if (match) return `Last opened: ${match[1]}`;
    match = /^第\s*(\d+)\s*条字幕(?:\s*·\s*item\s*(\d+))?$/.exec(text);
    if (match) return match[2] ? `Subtitle ${match[1]} · item ${match[2]}` : `Subtitle ${match[1]}`;
    match = /^定位到第\s*(\d+)\s*条字幕$/.exec(text);
    if (match) return `Go to subtitle ${match[1]}`;
    match = /^保存失败：(.+)$/.exec(text);
    if (match) return `Save failed: ${match[1]}`;
    match = /^打开工程失败：(.+)$/.exec(text);
    if (match) return `Could not open project: ${match[1]}`;
    match = /^服务器返回\s+(.+)$/.exec(text);
    if (match) return `Server returned ${match[1]}`;
    match = /^已自动加载媒体：(.+)$/.exec(text);
    if (match) return `Media loaded automatically: ${match[1]}`;
    match = /^已复制：(.+)$/.exec(text);
    if (match) return `Copied: ${match[1]}`;
    match = /^已复制媒体名：(.+)$/.exec(text);
    if (match) return `Media name copied: ${match[1]}`;
    match = /^总长度\s+(.+)$/.exec(text);
    if (match) return `Total length ${match[1]}`;
    match = /^字\/秒\s+(.+)$/.exec(text);
    if (match) return `chars/s ${match[1]}`;
    match = /^已处理\s*(\d+)\s*个(选中字幕|字幕)：完整延长\s*(\d+)\s*条，部分延长\s*(\d+)\s*条，未延长\s*(\d+)\s*条$/.exec(text);
    if (match) {
      const target = match[2] === '选中字幕' ? 'selected subtitles' : 'subtitles';
      return `Processed ${match[1]} ${target}: ${match[3]} fully extended, ${match[4]} partially extended, ${match[5]} unchanged`;
    }
    match = /^合并\s+(\d+)\s+条字幕$/.exec(text);
    if (match) return `Merge ${match[1]} subtitles`;
    match = /^已合并\s+(\d+)\s+条扩展字幕(，原绑定已解除)?$/.exec(text);
    if (match) return `Merged ${match[1]} extension subtitle${match[1] === '1' ? '' : 's'}${match[2] ? '; previous bindings were removed' : ''}`;
    match = /^已绑定主字幕\s+(\d+)\s+与扩展字幕\s+(\d+)$/.exec(text);
    if (match) return `Bound main subtitle ${match[1]} to extension subtitle ${match[2]}`;
    match = /^已替换主字幕\s+(\d+)\s+的绑定，改为扩展字幕\s+(\d+)$/.exec(text);
    if (match) return `Replaced the binding for main subtitle ${match[1]} with extension subtitle ${match[2]}`;
    match = /^有多条主字幕与当前副字幕重叠，已自动绑定时间最早的未绑定主字幕（第\s*(\d+)\s*条）$/.exec(text);
    if (match) return `Multiple main subtitles overlap this extension subtitle; automatically bound the earliest unbound main subtitle (subtitle ${match[1]})`;
    match = /^已批量对齐\s*(\d+)\s*条副字幕(?:，跳过\s*(\d+)\s*条未绑定副字幕)?$/.exec(text);
    if (match) return `Batch-aligned ${match[1]} secondary subtitle${match[1] === '1' ? '' : 's'}${match[2] ? `; skipped ${match[2]} unbound` : ''}`;
    match = /^(已对齐到主字幕范围|副字幕发生冲突，已)(?:，)?(?:挤压\s*(\d+)\s*条副字幕)?(?:，删除\s*(\d+)\s*条副字幕)?(并解除绑定)?$/.exec(text);
    if (match && (match[2] || match[3])) {
      const parts = [];
      if (match[2]) parts.push(`squeezed ${match[2]} extension subtitle${match[2] === '1' ? '' : 's'}`);
      if (match[3]) parts.push(`deleted ${match[3]} extension subtitle${match[3] === '1' ? '' : 's'}`);
      if (match[4]) parts.push('and removed their bindings');
      return `${match[1] === '已对齐到主字幕范围' ? 'Aligned to the main subtitle range' : 'Extension subtitle conflict resolved'}: ${parts.join(', ')}`;
    }
    if (text === '副字幕已随主字幕联动调整') return 'Extension subtitle followed the main subtitle';
    match = /^已交换主副字幕：主轨\s+(\d+)\s+条，副轨\s+(\d+)\s+条$/.exec(text);
    if (match) return `Swapped main and extension subtitles: ${match[1]} main, ${match[2]} extension`;
    // flashHint：已拼接/合并字幕：吸附 2 处间隔，吸收 1 条短字幕
    match = /^(已拼接\/合并字幕|已拼合字幕)：(.+)$/.exec(text);
    if (match) {
      const parts = match[2].split('，').map((part) => {
        let inner = /^(吸附|拼合|拼接)\s*(\d+)\s*处间隔$/.exec(part);
        if (inner) return `snapped ${inner[2]} intervals`;
        inner = /^吸收\s*(\d+)\s*条短字幕$/.exec(part);
        if (inner) return `absorbed ${inner[1]} short subtitles`;
        return translateText(part, EN);
      });
      return `${match[1] === '已拼接/合并字幕' ? 'Join / merge subtitles' : 'Snap subtitles'}: ${parts.join(', ')}`;
    }
    // flashHint：已自动修复 2 处 0 长时间码（保底 100ms）
    match = /^已自动修复\s*(\d+)\s*处\s*0\s*长时间码（保底\s*100ms）$/.exec(text);
    if (match) return `Auto-repaired ${match[1]} zero-length timings (100 ms minimum)`;
    match = /^已新增第\s*(\d+)\s*条字幕$/.exec(text);
    if (match) return `Created subtitle ${match[1]}`;
    match = /^删除\s+(\d+)\s+条字幕$/.exec(text);
    if (match) return `Delete ${match[1]} subtitles`;
    match = /^已将关联字幕统一设为「(.+)」$/.exec(text);
    if (match) return `All linked subtitles set to ${translateText(match[1])}`;
    match = /^已将字幕设为「(.+)」$/.exec(text);
    if (match) return `Subtitle set to ${translateText(match[1])}`;
    if (text === '无法连接本地编辑器服务器。是否改为导出工程文件，以免丢失改动？') {
      return 'The local editor server is unavailable. Export the project file instead so your changes are not lost?';
    }
    if (text === '服务器未连接；工程已另存为工程文件，请重新启动本地编辑器后继续') {
      return 'The server is disconnected. The project was saved as a project file; restart the local editor to continue.';
    }
    if (text === '另存为到当前工程目录（仅文件名）：') {
      return 'Save as in the current project folder (filename only):';
    }
    if (text === '当前有未保存的改动，是否确定打开最近工程？将丢失未保存内容。') {
      return 'This project has unsaved changes. Open the recent project and discard them?';
    }
    return text;
  }

  function validateTranslationKeys(keys) {
    const values = Array.from(keys, (key) => String(key));
    return {
      zh: values.filter((key) => !(key in EN_TEXT) && !(key in EN_ATTR)),
      en: values.filter((key) => translateText(key, EN) === key),
    };
  }

  function translateTextNode(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP_SELECTOR)) return;
    if (!textOriginals.has(node)) textOriginals.set(node, node.nodeValue);
    const original = textOriginals.get(node);
    const leading = original.match(/^\s*/)?.[0] || '';
    const trailing = original.match(/\s*$/)?.[0] || '';
    const core = original.trim();
    if (core) node.nodeValue = leading + translateText(core) + trailing;
  }

  function translateAttributes(element) {
    if (element.closest?.(ATTRIBUTE_SKIP_SELECTOR)) return;
    if (!attributeOriginals.has(element)) attributeOriginals.set(element, {});
    const originals = attributeOriginals.get(element);
    ['title', 'placeholder', 'aria-label'].forEach((name) => {
      if (!element.hasAttribute?.(name)) return;
      const current = element.getAttribute(name);
      if (!(name in originals)) {
        originals[name] = current;
      } else {
        const original = originals[name];
        const translated = translateText(original, EN);
        if (current !== original && current !== translated) originals[name] = current;
      }
      const original = originals[name];
      const next = language === EN ? translateText(original, EN) : original;
      if (current !== next) element.setAttribute(name, next);
    });
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
      else translateAttributes(node);
    }
  }

  function refreshToggle() {
    const button = document.getElementById('language-toggle');
    if (!button) return;
    button.textContent = language === ZH ? '🌐English' : '🌐中文';
    button.title = language === ZH ? 'Switch to English' : '切换为中文';
    button.setAttribute('aria-label', button.title);
  }

  function applyLanguage(nextLanguage, persist = true) {
    language = normalizeLanguage(nextLanguage);
    if (persist) {
      persistLanguage(language);
    }
    document.documentElement.lang = language === EN ? 'en' : 'zh-CN';
    translateTree(document.body);
    refreshToggle();
    document.dispatchEvent(new CustomEvent('mawe:languagechange', { detail: { language } }));
  }

  function installDialogTranslation() {
    ['alert', 'confirm', 'prompt'].forEach((name) => {
      const original = global[name];
      if (typeof original !== 'function' || original.__maweLocalized) return;
      const wrapped = function localizedDialog(message, ...args) {
        return original.call(global, translateText(message), ...args);
      };
      wrapped.__maweLocalized = true;
      global[name] = wrapped;
    });
  }

  function start() {
    installDialogTranslation();
    applyLanguage(language, false);
    document.getElementById('language-toggle')?.addEventListener('click', () => {
      applyLanguage(language === ZH ? EN : ZH);
    });
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach(translateTree);
        if (record.type === 'attributes') translateAttributes(record.target);
      });
    });
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['title', 'placeholder', 'aria-label'],
    });
  }

  global.MAWE_I18N = {
    get language() { return language; },
    applyLanguage,
    start,
    translateText,
    validateTranslationKeys,
  };
  global.MAWE?.register('i18n', () => global.MAWE_I18N);

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(window);
