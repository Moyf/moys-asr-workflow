# Changelog

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 的记录方式。

## [Unreleased]

### Added

- 新增 Soniox STT 供应商（`generate_subtitle_soniox_api.py`）：异步文件转写、token 级毫秒时间戳、自动语言识别；转写完成后自动清理云端文件与转写记录。
- Soniox 可选说话人分离：`--speaker` 把供应商 opaque speaker 标签写入工程 JSON（`segments[*].speaker` / `items[*].speaker`）；`--speaker-colors` 进一步把说话人一次性映射为 5 种字幕颜色快照（超过 5 人循环复用并警告），之后仍可在编辑器自由修改。
- 工程 JSON 新增可选 `speaker` 字段（segments/items 两级）；带 speaker 的工程在说话人变化时必须切分字幕段。
- 工程 JSON 新增可选 `preview.sticker` 归一化几何；编辑器新增「表情包预览」开关，可在视频画面内按时间预览当前表情包，并像字幕预览一样点击后拖动/八方向缩放调整位置（旧工程缺少该字段时使用默认右上角位置）。
- 编辑器：按 `F` 跳转并播放选中字幕（多选跳第一条，任意单击行为下生效）；右键菜单新增「跳转并播放」（仅「仅选中」单击行为下显示）。
- 波形多行模式新增「每行高度」设置（默认 120px）与 `Ctrl+Shift+滚轮` 直接调节；波形中成组字幕显示队长 👑 与组内序号徽章（如 1/3、2/3）。
- 按颜色导出 SRT 新增「彩色字幕统一导出」（默认勾选）：一次选择导出文件夹，按「文件名_颜色」批量保存；取消勾选则回到逐个选择保存位置。
- 编辑器右上角提示改为卡片堆栈：最多同时 3 条、新提示在下方、带淡入淡出动画。
- MAWE 网页编辑器新增中文 / English 界面切换并记住语言；工具栏、设置、帮助、弹窗、动态右键菜单与保存提示均随语言切换，字幕工程正文保持原样。
- GUI 启动器支持选择 Soniox STT 供应商：按供应商加载/保存 API Key（`SONIOX_API_KEY`），无地域要求的供应商自动隐藏地域与工作空间字段，SRT 默认输出名按供应商区分（`.soniox.srt`）；冻结包通过 `--transcribe-soniox` 分发。tkinter 旧版界面保持 Qwen 专用。
- 支持说话人分离的供应商在「高级选项」显示「给不同说话人分配颜色」开关（默认选中，最多 5 色循环复用）。
- GUI 语言选择对齐两家官方文档能力：Qwen 单选（自动识别 + 27 语种，文档明确"只能指定一个语种"），Soniox 多选 `language_hints`（60 语种，不选即自动识别，仅偏向不限制）。
- GUI 表单校验失败时自动平滑滚动到对应输入框。
- GUI 新增「显示相对小众的语言」开关（配置弹窗，持久化到 `MAW_GUI_SHOW_RARE_LANGS`）：Qwen / Soniox 默认都只显示 8 种常用语言，开启后显示供应商支持的全部语言；Soniox 多选列表另有「重置（自动识别）」按钮。
- Qwen/Soniox CLI 新增 `--with-waveform`，可在转写生成工程 JSON 时内嵌波形峰值；GUI 转写默认开启，避免首次打开编辑器时生成 `<媒体名>.waveform.json` sidecar。

### Changed

- `generate_subtitle_qwen_api.py` 的 `_parse_duration` 更名为 `parse_duration`（保留旧名别名，行为不变）。
- GUI「打开 html 版编辑器」更名为「打开 html 编辑器」；表情包根目录示例文案改为「大狗/、Nox/ 等」。
- GUI「给不同说话人分配颜色」更名为「给不同说话人分配字幕颜色」；高级选项对 Qwen 单选语言使用常规两列混排，对 Soniox 多选语言保留独立的右侧长列表。
- Soniox 切句改为按主导文字双轨：CJK 沿用原有静音/全角标点/字数逻辑；英文等空格语言改用独立逻辑——按句末强标点（.!?"）切出完整句子、过短句按词数合并（默认 <3 词）、超长句优先弱标点断句（默认 >13 词），不再出现整句被 21 字符上限切碎的情况。
- 字幕预览默认几何改为 65% 宽度居中；已存储几何的旧工程不受影响。
- 「空隙操作」从「移除静音空隙」弹窗移入「设置/波形」分组；「同时选中分组内项目」移入「设置/操作」分组。
- 表情包文件夹选择改用 `showDirectoryPicker`，不再出现浏览器「是否上传 N 个文件」提示。
- 「自动打开上次工程」从全局设置面板移到「最近工程」菜单并固定为第一项；最近工程列表仍按最近使用顺序排列。
- 工程保存快捷键统一为 `Ctrl/Cmd+S`「保存工程」、`Ctrl/Cmd+Shift+S`「另存为」。

### Fixed

- Qwen filetrans 偶发返回 `begin_time == end_time` 的词/句，独立切句后会触发 `$.segments[*].end: must be greater than start`；现在零/负时长片段会保留文字与字词时间戳并合并到相邻有效字幕。GUI 生成可选便携 HTML 失败时也只记警告，不再阻断已成功生成的 SRT/JSON 和 launcher 工程路径回填。
- Soniox 轮询遇到临时网络错误（如跨国 SSL 超时）会立即失败，且 `finally` 误删仍在云端运行的任务；现在轮询对连续网络错误重试（连续 5 次后放弃），且仅在任务成功或进入终态失败时才清理云端记录——本地中断时保留任务并提示 `transcription_id` 供手动清理。
- Soniox 英文 token 是 sub-word 片段（如 action → "ac"+"tion"、"wrong" → " w"+"r"+"ong,"），1:1 映射导致编辑器拆分时单词被腰斩；现在按实测契约（词首片段带前导空格）用 `merge_word_fragments()` 合并成词级 item 再切句，符合 JSON_SCHEMA 的「英文按词」约定，也顺带消除了切句落在单词中间的情况。CJK 保持逐字。
- localhost 保存端点断连时不再只显示 `Failed to fetch`：编辑器会明确提示服务器已断开，并允许立即把当前工程另存为 JSON，避免改动丢失。

## [1.1.0] - 2026-07-28

### Added

- 新增 Windows `tkinter + ttk` 图形界面，可选择媒体和输出路径、填写 Qwen Key、查看进度、取消任务并打开输出。
- 图形界面升级为 GUI v2：加入 `sv-ttk` 暗色主题、模型/地域/语言下拉框、按模型保存 API Key、中文/英文切换、本地编辑器服务器启动器与 EXE 图标。
- 新增 pywebview + HTML/JS 桌面启动器作为默认 GUI；旧版 tkinter 界面保留为 `--tk` fallback。
- pywebview 启动器支持媒体拖放、按语音 API 供应商组织设置、API Key 获取入口、折叠的 MAWE 服务器区和转写前内联校验。
- 新增 PyInstaller `onedir` Windows 构建脚本与 `v*` 标签触发的 GitHub Release 工作流；FFmpeg/ffprobe 继续保持外部依赖。
- 字幕画面预览支持鼠标拖动、八方向缩放、键盘调整、撤销/重做，以及 localhost 保存和便携 JSON 导出的持久化。

### Changed

- 工程 JSON 新增可选 `preview.subtitle` 归一化几何；旧工程缺少该字段时保持原有字幕位置。
- Qwen API CLI 新增 `--model` 参数；默认仍使用 `qwen3-asr-flash-filetrans`。

## [1.0.1] - 2026-07-26

### Added

- 从 ASR 字幕工作流中导出的独立、可公开分发的 API-first 最小版本。
- Qwen ASR API 转写、JSON/SRT 输出、波形字幕编辑器、便携 HTML 和 localhost 编辑器。
- 新用户工作流、维护说明、隐私说明与第三方组件说明。

### Changed

- 去除本地模型、多 ASR 引擎、模型对比、达芬奇脚本与个人资产，只保留一条完整可用链路。
- 音频输入的临时复制改用 Python 标准库，避免依赖 Unix `cp` 命令，保证 Windows PowerShell 环境可用。
