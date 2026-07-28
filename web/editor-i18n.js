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
    '加载媒体': 'Load media', '保存工程': 'Save project', '另存为…': 'Save as…',
    '导出字幕': 'Export subtitles', '导出字幕 ▾': 'Export subtitles ▾',
    '导出完整字幕': 'Export full subtitles', '按颜色导出字幕': 'Export by color',
    '导出工程': 'Export project', '导出去空隙版本 ▾': 'Export gap-removed version ▾',
    '字幕 SRT': 'Subtitle SRT', '时间线 OTIO 工程': 'Timeline OTIO project',
    'FFconcat 文件': 'FFconcat file', '保留区域 JSON': 'Kept-regions JSON',
    '表情包 OTIO': 'Sticker OTIO', '导出表情包时间线 ▾': 'Export sticker timeline ▾',
    '下载 Resolve JSON': 'Download Resolve JSON',
    '下载表情包 OTIO 工程': 'Download sticker OTIO project',
    '字幕': 'Subtitles', '字幕预览': 'Subtitle preview', '表情包预览': 'Sticker preview',
    '显示': 'Showing', '隐藏禁用': 'Hide disabled', '批量替换…': 'Batch replace…',
    '字数阈值': 'Character threshold', '仅看超长': 'Long only',
    '当前': 'Current', '已选': 'Selected', '波形': 'Waveform',
    '多行': 'Multi-row', '基础': 'Basic', '隐藏': 'Hidden',
    '选择': 'Select', '分割': 'Razor', '移除静音空隙': 'Remove silent gaps',
    '跳过空隙': 'Skip gaps', '未扫描空隙': 'Gaps not scanned', '布局': 'Layout',
    '标准堆叠': 'Classic stack', '右侧整列波形': 'Waveform column right',
    '波形在下方': 'Waveform below', '自定义停靠': 'Custom docking',
    '编辑布局': 'Edit layout', '重置布局': 'Reset layout',
    '导出布局': 'Export layout', '导入布局': 'Import layout',
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
    '全部恢复': 'Restore all', '字幕列表显示内容': 'Subtitle list fields',
    '序号': 'Index', '时间码': 'Timecode', '表情包': 'Stickers', '字数': 'Characters',
    '字幕编辑显示内容': 'Subtitle editor fields', '前后跳转': 'Previous/next navigation',
    '操作': 'Behavior', '单击行为': 'Click behavior', '仅选中': 'Select only',
    '选中并跳转': 'Select and seek',
    '「仅选中」时可以用F键功能来跳转并播放字幕': 'In “Select only” mode, press F to seek to and play the subtitle',
    '字幕编辑拆分按键': 'Subtitle split key',
    '同时选中分组内项目': 'Select all group members',
    '显示窗口': 'Visible window', '振幅': 'Amplitude',
    '5 秒': '5 sec', '10 秒': '10 sec', '20 秒': '20 sec', '30 秒': '30 sec',
    '每行长度': 'Seconds per row', '每行高度': 'Row height',
    '空隙操作': 'Gap action', 'Alt+点击': 'Alt+click',
    '中键拖动': 'Middle-button drag', '显示分组标记': 'Show group markers',
    '彩色字幕统一导出': 'Export colored subtitles together',
    'SRT 首条从 0 开始': 'Start first SRT cue at 0',
    '菜单': 'Menu', '显示菜单': 'Show menu', '单击': 'Click',
    'Shift+点击': 'Shift+click', 'Ctrl+点击': 'Ctrl+click',
    'Shift+滚轮': 'Shift+wheel', 'Ctrl+滚轮': 'Ctrl+wheel',
    'Ctrl+Shift+滚轮': 'Ctrl+Shift+wheel',
    '（编辑字幕文本时）在文字光标处拆分': 'Split at the text cursor (while editing)',
    '静音空隙': 'Silent gaps', 'Alt+点击静音空隙区段': 'Alt+click a silent-gap region',
    'Alt+中键拖动': 'Alt+middle-button drag',
    '选中': 'Select', '双击': 'Double-click', '编辑': 'Edit',
    '右键': 'Right-click', '字幕操作': 'Subtitle actions',
    '多选': 'Multi-select', '连选': 'Range select',
    '切换字幕禁用': 'Toggle subtitle disabled', '删除所选字幕': 'Delete selected subtitles',
    '播放与编辑': 'Playback and editing', '空格': 'Space',
    '播放/暂停': 'Play/pause',
    '上一条字幕': 'Previous subtitle', '下一条字幕': 'Next subtitle',
    '在红色播放指针处拆分字幕': 'Split subtitle at the red playhead',
    '跳转并播放选中字幕': 'Seek to and play selected subtitle',
    '倍速 ×0.5/重置/×2': 'Speed ×0.5/reset/×2',
    '双击波形': 'Double-click waveform', '右键波形背景': 'Right-click waveform background',
    '增加静音区段': 'Add silent region',
    '设置的空隙操作为「中键拖动」时：': 'When gap action is “Middle-button drag”:',
    '增加恢复区段': 'Add restored region', '切换移除/保留': 'Toggle removed/kept',
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
    '所有表情包路径都基于此根目录。修改后页面所有缩略图会立刻按新路径加载。': 'All sticker paths are relative to this root. Thumbnails update immediately after it changes.',
    '支持 OS 路径（D:/foo/bar）或 file:// URL。手动改路径只替换前缀；点 📁 浏览选本地文件夹会重新扫描表情包。': 'Supports OS paths (D:/foo/bar) and file:// URLs. Editing the path only changes the prefix; Browse rescans the folder.',
    '当前根目录（绝对路径）': 'Current root folder (absolute path)',
    '📁 浏览…': '📁 Browse…', '应用': 'Apply',
    '选择关联媒体': 'Choose related media',
    '是否同时选择该工程关联的媒体文件？': 'Would you also like to choose the media associated with this project?',
    '也可以稍后点击“加载媒体”。': 'You can also click “Load media” later.',
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
    '清除所有选中': 'Clear selection', '红': 'Red', '黄': 'Yellow',
    '蓝': 'Blue', '绿': 'Green', '紫': 'Purple'
  };

  const EN_ATTR = {
    '撤销 (Ctrl/Cmd+Z)': 'Undo (Ctrl/Cmd+Z)',
    '重做 (Ctrl/Cmd+Shift+Z)': 'Redo (Ctrl/Cmd+Shift+Z)',
    '撤销重做': 'Undo and redo',
    '打开本机最近使用的工程': 'Open a recently used local project',
    '保存回服务器启动时指定的工程 JSON': 'Save to the project JSON bound when the server started',
    '保存回当前工程 JSON（Ctrl/Cmd+S）': 'Save to the current project JSON (Ctrl/Cmd+S)',
    '另存为到当前工程目录': 'Save as in the current project folder',
    '另存为到当前工程目录（Ctrl/Cmd+Shift+S）': 'Save as in the current project folder (Ctrl/Cmd+Shift+S)',
    '选择本地媒体文件并加载到播放器': 'Choose a local media file and load it in the player',
    '可同选工程 JSON 与媒体；仅选 JSON 时会询问是否继续选择关联媒体': 'Choose project JSON and media together; choosing only JSON will prompt for related media',
    '设置表情包根目录': 'Set sticker root folder',
    '过滤字幕…': 'Filter subtitles…', '清空': 'Clear',
    '只显示超过阈值的字幕（再次点击关闭）': 'Show only subtitles over the threshold (click again to turn off)',
    '查看鼠标操作与键盘快捷键': 'View mouse and keyboard shortcuts',
    '展开字幕、波形与导出设置': 'Open subtitle, waveform, and export settings',
    '关闭（Esc）': 'Close (Esc)',
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
    '选择工具（默认）：点击选中、拖动移动、拖动边界调整；Ctrl/Shift 多选，Alt 切换禁用，Alt 拖共享边界只动一侧': 'Select tool (default): click to select, drag to move, drag edges to trim; Ctrl/Shift multi-select, Alt toggles disabled, Alt-drag changes one shared edge',
    '分割工具：点击字幕块在指针位置安全拆分（按词/字级时间码对齐，拒绝 100ms 以内的边缘拆分）；Esc 切回选择': 'Razor tool: click a subtitle block to split at the pointer using word/character timing; splits within 100 ms of an edge are rejected; Esc returns to Select',
    '打开可拖动的移除静音空隙工具窗': 'Open the draggable silent-gap tool',
    '播放时跳过已移除的静音空隙；左键定位到空隙内时可临时预览': 'Skip removed silent gaps during playback; clicking inside a gap previews it temporarily',
    '布局只控制面板摆放，不改变波形基础/多行模式': 'Layout only controls panel placement; it does not change waveform mode',
    '显示面板标题条和拖动预览': 'Show panel title bars and drag previews',
    '恢复默认的右侧整列波形布局': 'Restore the default right-column waveform layout',
    '导出当前布局 JSON': 'Export the current layout JSON',
    '导入布局 JSON': 'Import layout JSON',
    '字幕列表与波形字幕块的普通单击行为；双击编辑不受影响': 'Default click behavior for subtitle rows and waveform blocks; double-click editing is unchanged',
    '编辑字幕时，选择 Enter 或 Ctrl+Enter 在文字光标处拆分；另一个按键用于保存': 'While editing, choose Enter or Ctrl+Enter to split at the text cursor; the other key saves',
    '开启后，普通点击属于表情包或颜色分组的字幕时，会同时选中该分组的全部成员；关闭时只选中点击的那一条': 'When enabled, clicking a sticker/color group member selects the whole group; otherwise only that subtitle is selected',
    '多行波形每一行的高度；也可用 Ctrl+Shift+滚轮 在波形上直接调节': 'Height of each multi-row waveform row; Ctrl+Shift+wheel also adjusts it directly',
    '在多行波形中，为成组（颜色/表情包）字幕在块上方显示队长皇冠与组内序号': 'Show a leader crown and member index above grouped color/sticker subtitles in multi-row mode',
    '移除静音空隙的人工修正方式；Alt+左键始终切换整段；中键拖动默认增加静音，按住 Alt 才恢复声音，边界碰到另一空隙时会合并': 'Manual silent-gap correction mode; Alt+click toggles a full region; middle-drag adds silence, Alt restores audio, and touching regions merge',
    '勾选后按颜色导出时只选择一次导出文件夹，自动按「文件名_颜色」批量保存；取消勾选则逐个颜色弹出保存对话框': 'When enabled, choose one folder and save all color exports as filename_color; otherwise choose each file separately',
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
    '#cue-list', '#overlay', '#sticker-overlay-layer',
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
    let match = /^生成时间\s+(.+)$/.exec(text);
    if (match) return `Generated ${match[1]}`;
    match = /^上次打开：(.+)$/.exec(text);
    if (match) return `Last opened: ${match[1]}`;
    match = /^已保存工程：(.+?)（已备份为 (.+)）$/.exec(text);
    if (match) return `Project saved: ${match[1]} (backup: ${match[2]})`;
    match = /^已保存工程：(.+)$/.exec(text);
    if (match) return `Project saved: ${match[1]}`;
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
    match = /^删除\s+(\d+)\s+条字幕$/.exec(text);
    if (match) return `Delete ${match[1]} subtitles`;
    if (text === '无法连接本地编辑器服务器。是否改为导出工程 JSON，以免丢失改动？') {
      return 'The local editor server is unavailable. Export the project JSON instead so your changes are not lost?';
    }
    if (text === '服务器未连接；工程已另存为 JSON，请重新启动本地编辑器后继续') {
      return 'The server is disconnected. The project was saved as JSON; restart the local editor to continue.';
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
    button.textContent = language === ZH ? 'EN' : 'ZH';
    button.title = language === ZH ? 'Switch to English' : 'Switch to Chinese';
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
