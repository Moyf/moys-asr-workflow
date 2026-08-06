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
    '加载媒体': 'Load media', '加载字幕': 'Load subtitles', '保存工程': 'Save project', '另存为…': 'Save as…', '保存': 'Save', '保存成功！': 'Saved!',
    '📥 松开以加载文件（视频 / 音频 / JSON / SRT）': '📥 Drop to load files (video / audio / JSON / SRT)',
    '自动保存': 'Auto-save', '自动保存间隔（秒）': 'Auto-save interval (seconds)',
    '导出字幕': 'Export subtitles', '导出字幕 ▾': 'Export subtitles ▾',
    '导出完整字幕': 'Export full subtitles', '导出完整字幕（SRT）': 'Export full subtitles (SRT)',
    '按颜色导出字幕': 'Export by color', '按颜色导出字幕（SRT）': 'Export by color (SRT)',
    '导出纯文本（TXT）': 'Export plain text (TXT)',
    '导出工程': 'Export project', '导出去空隙版本 ▾': 'Export gap-removed version ▾',
    '字幕 SRT': 'Subtitle SRT', '时间线 OTIO 工程': 'Timeline OTIO project',
    'FFconcat 文件': 'FFconcat file', '保留区域 JSON': 'Kept-regions JSON',
    '表情包 OTIO': 'Sticker OTIO', '导出表情包时间线 ▾': 'Export sticker timeline ▾',
    '下载 Resolve JSON': 'Download Resolve JSON',
    '下载表情包 OTIO 工程': 'Download sticker OTIO project',
    '字幕': 'Subtitles', '字幕预览': 'Subtitle preview', '表情包预览': 'Sticker preview', '字幕列表和编辑区': 'Subtitle list & editor',
    '字体大小': 'Font size', '字幕大小': 'Font size', '自动（响应式）': 'Auto (responsive)', '字体': 'Font', '默认无衬线': 'Default sans-serif',
    '微软雅黑 / 苹方': 'Microsoft YaHei / PingFang', '黑体': 'SimHei', '宋体': 'SimSun', 'Arial / Segoe UI': 'Arial / Segoe UI',
    '样式会保存到工程的 preview.subtitle；旧工程默认使用原来的响应式字号。': 'Styles are saved in preview.subtitle; legacy projects keep the original responsive font size.',
    '媒体': 'Media', '预览字幕': 'Subtitle preview', '预览表情包': 'Sticker preview', '媒体播放控制': 'Media playback controls',
    '播放': 'Play', '暂停': 'Pause', '后退 5 秒': 'Back 5 seconds', '前进 5 秒': 'Forward 5 seconds',
    '媒体进度': 'Media progress', '音量': 'Volume', '速度': 'Speed', '播放速度': 'Playback speed',
    '全屏': 'Fullscreen', '退出全屏': 'Exit fullscreen',
    '显示': 'Showing', '隐藏禁用': 'Hide disabled', '批量替换…': 'Batch replace…',
    '字数阈值': 'Character threshold', '仅看超长': 'Long only',
    '当前': 'Current', '已选': 'Selected', '波形': 'Waveform', '音频波形区': 'Audio waveform',
    '多行': 'Multi-row', '基础': 'Basic', '隐藏': 'Hidden',
    '选择': 'Select', '分割': 'Razor', '移除静音空隙': 'Remove silent gaps',
    '跳过空隙': 'Skip gaps', '播放时跳过空隙': 'Skip gaps during playback', '未扫描空隙': 'Gaps not scanned', '工作区': 'Workspace',
    '拼合字幕': 'Snap subtitles', '拼合参数': 'Snap parameters',
    '直接修改字幕时间轴，整个操作一次撤销': 'Edits the subtitle timeline directly; the whole run is one undo step',
    '间隔阈值': 'Interval threshold', '拓展方向': 'Snap direction',
    '向前拓展': 'Extend earlier', '向后拓展': 'Extend later',
    '吸收过短字幕': 'Absorb short subtitles', '短字幕阈值': 'Short-subtitle threshold', '吸收方向': 'Absorb direction',
    '向前吸收': 'Into previous', '向后吸收': 'Into next',
    '相邻字幕间隔小于此值时，拓展字幕长度把它们拼在一起；0 表示不处理':
      'When the interval between adjacent subtitles is below this value, extend their lengths to snap them together; 0 disables it',
    '向前：后方字幕的起点前拓；向后：前方字幕的终点后延':
      'Earlier: the later subtitle extends its start backward; Later: the earlier subtitle extends its end forward',
    '中文少于 N 个字 / 英文少于 N 个词即视为过短字幕':
      'Fewer than N Chinese characters or N English words counts as a short subtitle',
    '向前：过短字幕并入上一条；向后：并入下一条':
      'Into previous: a short subtitle merges into the previous one; Into next: into the next one',
    '过短的字幕直接并入相邻字幕；关闭后只拼合间隔':
      'Short subtitles merge into a neighbor; when off, only intervals are snapped',
    '按当前参数处理整段工程': 'Process the whole project with these parameters',
    '没有需要拼合的间隔或过短字幕': 'No intervals or short subtitles to snap',
    '字幕时长不足 200ms，无法拆分': 'Subtitles shorter than 200 ms cannot be split',
    '字幕列表编辑': 'Subtitle list editor', '右侧整列波形': 'Waveform column right',
    '传统字幕编辑器': 'Traditional subtitle editor',
    '编辑布局': 'Edit layout', '完成布局': 'Done editing', '重置工作区': 'Reset workspace',
    '已保存工作区': 'Saved workspaces',
    '保存工作区': 'Save workspace', '另存为工作区': 'Save workspace as', '删除工作区': 'Delete workspace',
    '工作区配置 ▾': 'Workspace configuration ▾', '导出工作区配置': 'Export workspace configuration', '导入工作区配置': 'Import workspace configuration',
    '🔧 设置': '🔧 Settings', '🤔 帮助': '🤔 Help',
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
    '关闭后，通过字幕列表点击字幕时不会自动滚动列表': 'When disabled, clicking a subtitle in the list will not scroll the list',
    '字幕编辑显示': 'Subtitle editor', '跳转按钮': 'Navigation buttons', '前后跳转': 'Navigation buttons', '时间操作': 'Time actions',
    '操作': 'Behavior', '通用操作': 'General', '单击行为': 'Click behavior', '点击字幕块时': 'Click subtitle behavior', '仅选中（不跳转）': 'Select only (do not seek)', '选中并跳转（自动播放）': 'Select and seek (autoplay)',
    '选中并跳转': 'Select and seek', '跳转目标': 'Seek target', '字幕开头': 'Subtitle start', '鼠标所在位置': 'Pointer position',
    '暂停时只跳转，不自动播放；播放中跳转后继续播放。': 'When paused, seek without starting playback; while playing, keep playing after seeking.',
    '跳转到字幕起点，并在暂停时自动开始播放。': 'Seek to the subtitle start and start playback when paused.',
    '只选中，不改变播放位置；可用 F 或右键菜单跳转并播放。': 'Select only without changing the playhead; use F or the context menu to seek and play.',
    '字幕列表点击始终跳转到字幕开头；此设置只影响波形区点击字幕块': 'Subtitle-list clicks always seek to the subtitle start; this setting only affects waveform subtitle clicks',
    '合并字幕时插入字符': 'Merge separator', '留空则直接拼接': 'Leave blank to join directly',
    '合并两条字幕时，中间插入的字符（如果不需要可以留空）': 'Characters inserted between merged subtitles (leave blank to join directly)',
    '字幕编辑拆分按键': 'Subtitle split key', '字幕（编辑状态下）拆分按键': 'Subtitle split key (while editing)',
    '同时选中分组内项目': 'Select all group members', '或': 'or',
    '显示窗口': 'Visible window', '振幅': 'Amplitude',
    '5 秒': '5 sec', '10 秒': '10 sec', '20 秒': '20 sec', '30 秒': '30 sec',
    '每行长度': 'Seconds per row', '每行高度': 'Row height',
    '空隙区段操作方式': 'Gap region operation', 'Alt+点击': 'Alt+click',
    '中键拖动': 'Middle-button drag', '显示分组标记': 'Show group markers', '允许拖动指针': 'Drag to move playhead',
    '彩色字幕统一导出': 'Export colored subtitles together',
    '选中时，会将所有不同颜色的字幕按「文件名_颜色」格式统一导出；否则每个颜色都会弹出单独的保存框。': 'When enabled, export all color groups as filename_color; otherwise each color opens its own save dialog.',
    'Oi！检测到你添加了表情包，是否需要帮你打开「设置」中的字幕列表/编辑区的表情包显示开关？   ヾ(´･ω･｀)ﾉ': 'Oi! You added a sticker. Would you like to enable sticker display in the subtitle list and editor under Settings?   ヾ(´･ω･｀)ﾉ',
    'SRT 首条从 0 开始': 'Start first SRT cue at 0',
    '菜单': 'Menu', '显示菜单': 'Show menu', '单击': 'Click',
    'Shift+点击': 'Shift+click', 'Ctrl+点击': 'Ctrl+click',
    'Shift+拖拽空白处': 'Shift+drag blank area', '框选字幕': 'Box-select subtitles',
    'Shift+滚轮': 'Shift+wheel', 'Ctrl+滚轮': 'Ctrl+wheel',
    'Ctrl+Shift+滚轮': 'Ctrl+Shift+wheel',
    '（编辑字幕文本时）在文字光标处拆分': 'Split at the text cursor (while editing)',
    '静音空隙': 'Silent gaps', 'Alt+点击静音空隙区段': 'Alt+click a silent-gap region',
    'Alt+中键拖动': 'Alt+middle-button drag',
    '选中': 'Select', '双击': 'Double-click', '编辑': 'Edit',
    '进入字幕编辑区（仅单选时）': 'Focus subtitle editor (single selection only)', '退出字幕编辑区（文本编辑时）': 'Exit subtitle editor (while editing)', '清除字幕选择（非编辑状态）': 'Clear subtitle selection (when not editing)',
    '选中所有字幕': 'Select all subtitles', '选中所有字幕（非编辑状态）': 'Select all subtitles (when not editing)',
    '右键': 'Right-click', '字幕操作': 'Subtitle actions',
    '多选': 'Multi-select', '连选': 'Range select',
    '切换字幕禁用': 'Toggle subtitle disabled', '删除所选字幕': 'Delete selected subtitles',
    '合并所选字幕': 'Merge selected subtitles',
    '播放与编辑': 'Playback and editing', '空格': 'Space',
    '播放/暂停': 'Play/pause', '前后跳转 5 秒': 'Seek back/forward 5 sec',
    '上一条字幕': 'Previous subtitle', '下一条字幕': 'Next subtitle',
    '向前多选': 'Extend selection backward', '向后多选': 'Extend selection forward',
    '在红色播放指针处拆分字幕': 'Split subtitle at the red playhead',
    '跳转并播放选中字幕': 'Seek to and play selected subtitle',
    '倍速 ×0.5/重置/×2': 'Speed ×0.5/reset/×2',
    '双击波形': 'Double-click waveform', '右键波形背景': 'Right-click waveform background',
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
    '在光标处拆分': 'Split at cursor', '范围：全部字幕': 'Scope: all subtitles',
    '查找': 'Find', '替换为': 'Replace with', '批量替换': 'Batch replace',
    '区分大小写': 'Case sensitive',
    '正则表达式': 'Regular expression',
    '输入查找内容查看预览': 'Enter text to preview replacements',
    '取消': 'Cancel', '替换全部': 'Replace all', '分配表情包': 'Assign sticker',
    '清除当前': 'Clear current', '替换': 'Replace', '删除': 'Delete', '关闭': 'Close',
    '设置表情包根目录': 'Set sticker root folder',
    '仅服务器版编辑器可将改动保存回当前工程文件': 'Only the server editor can save changes back to the current project file',
    '所有表情包路径都基于此根目录。修改后页面所有缩略图会立刻按新路径加载。': 'All sticker paths are relative to this root. Thumbnails update immediately after it changes.',
    '支持 OS 路径（D:/foo/bar）或 file:// URL。手动改路径只替换前缀；点 📁 浏览选本地文件夹会重新扫描表情包。': 'Supports OS paths (D:/foo/bar) and file:// URLs. Editing the path only changes the prefix; Browse rescans the folder.',
    '当前根目录（绝对路径）': 'Current root folder (absolute path)',
    '📁 浏览…': '📁 Browse…', '应用': 'Apply',
    '选择关联媒体': 'Choose related media',
    '浏览器无法自动读取工程所在目录的关联媒体。': 'The browser cannot automatically read media from the project folder.',
    '现在选择一次，或稍后点击“加载媒体”。': 'Choose it once now, or click “Load media” later.',
    '选择媒体': 'Choose media', '稍后加载': 'Load later',
    '📥 松开以加载文件（视频 / 音频 / JSON）': '📥 Drop to load files (video / audio / JSON)',
    '本机工程': 'Local projects', '时长': 'Duration', '总长度': 'Total length',
    '字/秒': 'chars/s', '无': 'None', '开始': 'Start', '导出': 'Export',
    '跳转并播放': 'Seek and play', '按音频位置拆分': 'Split at audio position',
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
    '过滤字幕…': 'Filter subtitles…', '清空': 'Clear',
    '只显示超过阈值的字幕（再次点击关闭）': 'Show only subtitles over the threshold (click again to turn off)',
    '查看鼠标操作与键盘快捷键': 'View mouse and keyboard shortcuts',
    '展开字幕、波形与导出设置': 'Open subtitle, waveform, and export settings',
    '关闭（Esc）': 'Close (Esc)',
    '关闭帮助窗口': 'Close the help window',
    '关闭移除静音空隙工具窗': 'Close the silent-gap tool',
    '放大时间轴': 'Zoom in', '缩小时间轴': 'Zoom out',
    '增大波形振幅': 'Increase waveform amplitude',
    '减小波形振幅': 'Decrease waveform amplitude',
    '选择一条字幕开始编辑…': 'Select a subtitle to start editing…',
    '要查找的内容': 'Text to find', '替换后的内容': 'Replacement text',
    '按文件名过滤...': 'Filter by filename…',
    '浏览本地文件夹（同时会重新扫描表情包列表）': 'Browse a local folder and rescan stickers',
    '如 D:/AI/AI音频转录/表情包': 'e.g. D:/Media/Stickers',
    '下次不带 JSON 路径启动服务器时，自动恢复上次打开的工程': 'Automatically restore the last project when the server starts without a JSON path',
    '只影响导出的 SRT，不改动工程或 OTIO 的时间轴': 'Only affects exported SRT; project and OTIO timelines are unchanged',
    'MAWE 设置': 'MAWE settings', '操作帮助': 'Controls help',
    '编辑器工具': 'Editor tools', '波形工具': 'Waveform tools',
    '波形模式': 'Waveform mode', '音频波形': 'Audio waveform',
    '点击替换；右键删除': 'Click to replace; right-click to delete'
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
    '在视频画面右上角预览当前时间的表情包': 'Preview stickers at the current time over the video',
    '选择工具（V，默认）：点击选中、拖动移动、拖动边界调整；Ctrl(Cmd)/Shift 多选，Shift+空白拖拽框选，Alt 切换禁用，Alt 拖共享边界只动一侧': 'Select tool (V, default): click to select, drag to move, drag edges to trim; Ctrl(Cmd)/Shift multi-select, Shift+drag on blank area to box-select, Alt toggles disabled, Alt-drag changes one shared edge',
    '分割工具（R）：点击字幕块在指针位置安全拆分（按词/字级时间码对齐，拒绝 100ms 以内的边缘拆分）；Esc 切回选择': 'Razor tool (R): click a subtitle block to split at the pointer using word/character timing; splits within 100 ms of an edge are rejected; Esc returns to Select',
    '打开可拖动的移除静音空隙工具窗': 'Open the draggable silent-gap tool',
    '打开可拖动的拼合字幕工具窗': 'Open the draggable snap-subtitles tool',
    '关闭拼合字幕工具窗': 'Close the snap-subtitles tool',
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
    '#media-name', '#json-name', '#sticker-grid', 'script', 'style'
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
    let     match = /^生成时间\s+(.+)$/.exec(text);
    if (match) return `Generated ${match[1]}`;
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
    match = /^合并\s+(\d+)\s+条字幕$/.exec(text);
    if (match) return `Merge ${match[1]} subtitles`;
    // flashHint：已拼合字幕：拼合 2 处间隔，吸收 1 条短字幕
    match = /^已拼合字幕：(.+)$/.exec(text);
    if (match) {
      const parts = match[1].split('，').map((part) => {
        let inner = /^拼合\s*(\d+)\s*处间隔$/.exec(part);
        if (inner) return `snapped ${inner[1]} intervals`;
        inner = /^吸收\s*(\d+)\s*条短字幕$/.exec(part);
        if (inner) return `absorbed ${inner[1]} short subtitles`;
        return translateText(part, EN);
      });
      return `Snap subtitles: ${parts.join(', ')}`;
    }
    // flashHint：已自动修复 2 处 0 长时间码（保底 100ms）
    match = /^已自动修复\s*(\d+)\s*处\s*0\s*长时间码（保底\s*100ms）$/.exec(text);
    if (match) return `Auto-repaired ${match[1]} zero-length timings (100 ms minimum)`;
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
  };

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(window);
