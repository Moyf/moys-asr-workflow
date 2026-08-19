# v1.4.0-beta.7 测试反馈与处理记录

本文记录 beta7 专项测试中的反馈、处理决定和验证结果。截图中的说明性文字仅作为测试反馈来源；是否修改以本表的分类为准。

## 处理清单

| 编号 | 范围 | 反馈摘要 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 生成 / 缓存 | 测试模式下波形和频谱缓存只处理前 2 分钟；频谱生成需要明确进度提示 | 修改 | 已修复 |
| 2 | 生成 / 频谱 | 频谱颜色只影响显示；询问是否可以完全不生成频谱 | 说明 | 仅说明 |
| 3 | Launcher / OCR | 未安装 OCR 时不能显示“已就绪”；安装后刷新状态；刷新按钮不能被挤压；源码版与打包版提示区分；识别进度增加间距；当前产物自动高亮 | 修改 | 已修复 |
| 4 | 编辑器 / 工程 | 去重工程加载提示；OCR 后保留媒体路径；允许拖入 `.ReaPeaks`；无绑定工程的服务器提示改为导出后重新打开 | 修改 | 已修复 |
| 5 | 编辑器 / 设置 | 设置图标统一；全局按钮改为“⚙️ 全局设置”；增加全局“自动吸附调整相邻字幕”开关（默认关闭，Alt 临时反转）；current-cue-panel 的“操作”中增加可选“Esc 取消编辑”（默认关闭）；延长字幕默认值改为向前 120ms、向后 60ms | 修改 | 已修复 |
| 6 | 编辑器 / 多字幕 | 绑定同步支持撤销；“绑定/解绑”改为“批量对齐”；副字幕支持 B/Enter 拆分；主字幕合并同步副字幕；绑定时自动同步时长；多选副字幕按 H 批量对齐 | 修改 | 已修复 |
| 7 | 编辑器 / 切分 | 强制切分两侧至少保留 100ms；首次时长不足时保留编辑/弹窗，第二次按 B/Enter 强制钳制切点；撤销恢复切分前选中状态 | 修改 | 已修复 |
| 8 | 编辑器 / 播放 | 去掉播放器高度限制；Home/End 跳转首尾；字幕悬停显示 B 提示；最后一行波形按真实剩余时长缩短 | 修改 | 已修复 |
| 9 | Launcher / LLM | 保存 API Key 自动测试并在设置区反馈结果；整体字号放大；Qwen LLM 复用已填写的 `DASHSCOPE_API_KEY` | 修改 | 已修复 |
| 10 | 切分 | 没有字词时间码时已有按字符位置估算切点路径，本次只修复边界和最短时长 | 说明 | 仅说明 |
| 11 | 播放 / 波形 | 最后一行缩短只改变显示宽度，不会明显增加性能成本 | 说明 | 仅说明 |
| 12 | 播放器 | 当前源码、模板、`edit.py` 和便携版均未发现 `40vh` 播放器限制 | 说明 | 仅说明 |
| 13 | Launcher / 字幕编辑器启动 | 恢复大型最近工程时 5 秒内未响应，连续更换端口仍无法启动；启动不能等待波形，默认继续使用自研波形，`.ReaPeaks` 改为后台增强 | 修改 | 已修复 |
| 14 | Launcher / 错误提示 | URL 后的中文右括号及说明文字被一起放入链接，导致链接异常 | 修改 | 已修复 |
| 15 | 生成 / ReaPeaks 频谱 | 生成 ReaPeaks 时希望保留波形层、按开关决定是否计算频谱；没有频谱数据时编辑器禁用频谱颜色 | 修改 | 已修复 |
| 16 | 编辑器 / 长音轨提示 | 浏览器无法整段解码时仍提示用户运行 `edit.py`，应改为 GUI 入口 | 修改 | 已修复 |
| 17 | 波形缓存 / 重构询问 | 希望把 ReaPeaks 与自研波形封装为同一个独立缓存文件，拖入长视频时按媒体尝试复用 | 说明 | 仅说明 |
| 18 | Launcher / 自动后处理 | OCR 作为最后一步时自动后处理失败；从 SRT 或缺少媒体字段的工程进入翻译等步骤后，输出工程丢失 `media` | 修改 | 已修复 |
| 19 | 编辑器 / 多字幕快捷键 | 选中字幕时 `Shift+←/→` 应贴合前后字幕边界，但在多重字幕模式下不生效 | 修改 | 已修复 |
| 20 | 编辑器 / 边界拖动 | 独立拉开原本贴合的相邻字幕边界后，反向拖动会被当前边界错误限制，无法拖回 | 修改 | 已修复 |
| 21 | Launcher / 自动后处理 LLM | 勾选 LLM 相关自动处理步骤后弹出的配置中，高亮「测试连接」按钮；测试完成后取消引导 | 修改 | 已修复 |
| 22 | Launcher / 后处理工具箱 | 增强右上角关闭按钮；鼠标在工具箱内滚轮时不应滚动后面的 Launcher | 修改 | 已修复 |
| 23 | Launcher / 配置弹窗 | 配置顶部的标题和关闭按钮在内容滚动时应常驻，关闭按钮视觉增强 | 修改 | 已修复 |
| 24 | 编辑器 / 多字幕快捷键 | 波形区选中一个副字幕后按 `B`，应拆分选中的副字幕，不应因上方重叠主字幕而改拆主字幕 | 修改 | 已修复 |
| 26 | 编辑器 / 多字幕合并 | 开启「绑定时自动同步时长」后，多选主字幕按 `C` 合并所新建的绑定副字幕也应匹配合并后主字幕的时长 | 修改 | 已修复 |
| 27 | Launcher / 自动后处理 OCR | 首次安装 OCR 后状态和自动后处理没有同步，重新勾选 OCR 仍提示未安装依赖 | 修改 | 已修复 |
| 30 | 编辑器 / 波形性能 | 连续调节波形振幅、行高时反复重绘导致编辑器卡顿 | 修改 | 已修复 |
| 29 | 编辑器 / 波形快捷键 | 增加 `Z/X`，将单个字幕的起点/终点定位到鼠标位置；主字幕联动绑定副字幕，副字幕只调整自身，多选不生效；无选中时作用于鼠标命中的字幕 | 修改 | 已修复 |
| 32 | 编辑器 / 波形性能 | 频谱颜色切换重绘反馈延迟，用户可能误以为没有响应而重复点击 | 修改 | 已修复 |
| 33 | Premiere 交接 | 原生文字已成功写入；视频可自动识别并播放；图片不会弹出查找媒体但仍需手动重新链接；希望导出预览字幕字体，参考 `序列03-带字体.xml` 中的 FangSong | 修改 | 进行中 |

## 增量记录（任务 33：Premiere XML 文字、视频、图片与字体反馈）

- 已验证：原生 GraphicAndType 文字已经成功写入 Premiere；视频媒体可以自动识别并播放。
- 当前问题：图片文件不会弹出“查找媒体”，但导入后仍需要手动重新链接，说明 XML 已建立图片剪辑但图片文件引用或文件媒体描述仍不满足 Premiere 的自动解析条件。
- 参考资料：`examples/序列03-带字体.xml` 的 GraphicAndType payload 中，预览字幕字体位于 Base64 + UTF-16LE JSON 的 `mTextParam.mStyleSheet.mFontName.mParamValues[0][1]`，示例值为 `FangSong`。
- 本轮处理：修正图片文件 URL 的 Windows drive-letter 编码，并让导出 payload 从工程 `preview.subtitle.font_family` 读取字体；内置 `song` 映射为 Premiere 字体名 `FangSong`。
- 当前能力：编辑器已有“读取本机字体”功能，会通过 `queryLocalFonts()` 将本机字体 family 加入主/副字幕字体下拉框；用户选择后直接保存 family 名称。导出层继续将该 family 原样写入 Premiere payload；浏览器预览和 Premiere 显示都要求目标电脑已安装同名字体。
- 未验证边界：仍需在 Premiere 实机打开包含 GIF/JPG 表情包的 XML，确认图片免手动重链以及字体在目标机器已安装时的实际显示效果。

已验证：`node --test tests\\test_editor_utils.mjs`（111/111）；`node --check web\\editor-utils.js`、`node --check web\\editor.js`；`uv run python edit.py --blank`；`git diff --check`。Premiere 图片自动重链和真实字体显示仍需用户实机确认。

## 修复与验证记录

| 编号 | 处理结果 | 验证证据 |
| --- | --- | --- |
| 1 | 已修复 | `.venv\\Scripts\\python.exe -m unittest tests.test_media_cache`（3/3 通过，含“测试模式使用限长缓存但保留原始媒体签名”）；`media_cache.py` 输出频谱生成进度，并在缓存旁路缺失时保留工程已有缓存。 |
| 3 | 已修复 | `.venv\\Scripts\\python.exe -m unittest tests.test_gui_web tests.test_ocr_runtime tests.test_postprocess_ocr`（相关测试包含在 210/210 通过批次）；`node --check web\\launcher\\launcher.js`; `node --check web\\launcher\\postprocess.js`; `git diff --check` 均通过。 |
| 4 | 已修复 | `node --check web\\editor.js`; `.venv\\Scripts\\python.exe -m unittest tests.test_waveform`（13/13 通过）；`.venv\\Scripts\\python.exe edit.py --blank`; `blank-editor.html` 已扫描确认 ReaPeaks 解析/拖入入口，以及无绑定服务器提示“导出 .mosp，再重新打开该文件”；`git diff --check` 通过。 |
| 5 | 已修复 | `node --check web\\editor.js`; `node --check web\\waveform.js`; `node --check web\\editor-i18n.js`; `node --test tests\\test_waveform_js.mjs tests\\test_editor_utils.mjs`（当前批次 119/119 通过）；current-cue-panel Esc 回归 1/1；自动吸附/键盘回归 5/5；`.venv\\Scripts\\python.exe edit.py --blank`; `.venv\\Scripts\\python.exe -m unittest tests.test_waveform`（15/15 通过）；`git diff --check` 通过。 |
| 6 | 已修复 | `npx playwright test tests/e2e/multi-subtitle.spec.mjs --grep "aligns multiple selected extension cues" --project=chromium`（1/1 通过）；`npx playwright test tests/e2e/multi-subtitle.spec.mjs --grep "auto-synced binding|merges selected extension|选中的主字幕与绑定副字幕|拼合主字幕" --project=chromium`（4/4 通过）；`node --check web\\editor.js`; `node --check web\\editor-i18n.js`; 源码与便携版已同步。 |
| 7 | 已修复 | `node --check web\\editor.js`; `node --check web\\editor-i18n.js`; `npx playwright test tests/e2e/waveform-history.spec.mjs --grep \"retries an inline split with B or Enter|requires a second B\" --project=chromium`（2/2 通过，内联路径明确验证第二次 Enter）；`npx playwright test tests/e2e/multi-subtitle.spec.mjs --grep \"uses B on a single selected extension|uses the linked split dialog|retries a short linked split|imports an extension SRT\" --project=chromium`（4/4 通过）；`.venv\\Scripts\\python.exe edit.py --blank`; `git diff --check`。 |
| 8 | 已修复 | `node --check web\\editor.js`; `node --check web\\waveform.js`; `npx playwright test tests/e2e/waveform-history.spec.mjs --grep \"B splits the selected subtitle under|retries an inline split with B or Enter|Home and End|hovering a selected subtitle|last multi-row waveform|requires a second B\" --project=chromium`（6/6 通过）；`node --test tests\\test_editor_utils.mjs tests\\test_waveform_js.mjs`（113/113 通过）；`.venv\\Scripts\\python.exe edit.py --blank`; `python -m py_compile edit.py`; `git diff --check`。 |
| 9 | 已修复 | Qwen 复用 `DASHSCOPE_API_KEY`、保存后的测试连接提示、保存新 Key 自动测试和 Launcher 字号调整均已完成；`.venv\\Scripts\\python.exe -m unittest tests.test_gui_web tests.test_postprocess_pipeline`（160/160 通过），Launcher JS 语法、Python 编译和 `git diff --check` 通过。 |
| 13 | 已修复 | 服务器启动路径同步读取自研波形，跳过启动阶段的 `.ReaPeaks` 解析；服务器开始提供请求后由后台线程加载频谱和 ReaPeaks 波形，并通过 `/api/waveform` 返回 `loading` / `ready` 状态，编辑器轮询后动态增强显示。`.venv\\Scripts\\python.exe -m unittest tests.test_local_editor_server`（17/17 通过，其中新增阻塞后台解析时首页仍返回 200、状态最终变为 `ready` 的回归）；`.venv\\Scripts\\python.exe -m unittest tests.test_waveform`（14/14）；`.venv\\Scripts\\python.exe edit.py --blank`；`node --check web\\editor.js`、`node --check web\\waveform.js`、`node --check web\\editor-i18n.js` 通过。 |
| 14 | 已修复 | Launcher 消息中的 URL 正则在中文右括号、书名号、引号及常见句末标点前停止，不再把后续说明文字并入链接；`.venv\\Scripts\\python.exe -m unittest tests.test_gui_web.LauncherAssetContractTests.test_launcher_message_url_stops_before_closing_punctuation`（1/1）；`node --check web\\launcher\\launcher.js` 通过。 |
| 15 | 已修复 | `--with-waveform` / Launcher 默认生成并嵌入 ReaPeaks wave 层，`--with-spectral` 或勾选“生成 ReaPeaks 频谱数据”才执行 FFT 并嵌入 spectral；只有波形层时编辑器自动取消并禁用频谱颜色，后台补齐频谱后恢复可用。`.venv\\Scripts\\python.exe -m unittest tests.test_reapeaks tests.test_media_cache tests.test_cli tests.test_gui_workflow tests.test_gui_web tests.test_local_asr`（250/250）；`node --test tests\\test_waveform_js.mjs tests\\test_editor_utils.mjs`（114/114）；相关 Python/JS 语法检查、`.venv\\Scripts\\python.exe edit.py --blank`、`git diff --check` 均通过。 |
| 19 | 已修复 | `npx playwright test tests/e2e/multi-subtitle.spec.mjs --grep "Shift\\+arrow snaps selected main and secondary cues" --project=chromium`（1/1）；同时覆盖主字幕 `Shift+←`、副字幕 `Shift+→` 的贴合，并确认 current-cue-panel 的轨道目标正确。 |
| 20 | 已修复 | `npx playwright test tests/e2e/keyboard-timing.spec.mjs --grep "independent shared-boundary drag can reverse before release" --project=chromium`（1/1）；`node --test tests\\test_waveform_js.mjs`（40/40）；覆盖共享边界独立拉开后反向拖回，以及起点/终点两种方向。 |
| 21 | 已修复 | `openAutoStep()` 仅在自动步骤勾选触发配置弹窗时为「测试连接」增加 attention 引导；测试成功、失败、保存前置失败和异常均在一次测试尝试结束后清除；Launcher 静态契约测试 38/38 通过。 |
| 22 | 已修复 | 工具箱关闭按钮使用更高对比度的固定图标按钮；工具箱 wheel 事件隔离背景滚动，内容区保留自身滚动；Launcher 静态契约测试 38/38 通过。 |
| 23 | 已修复 | 配置弹窗改为固定顶部操作区和独立设置滚动区，标题/关闭按钮不会随设置内容离开顶部；Launcher 静态契约测试 38/38 通过。 |
| 24 | 已修复 | 新增绑定和未绑定、且与主字幕时间重叠的波形区回归；`B` 均打开「选择副字幕拆分点」，主字幕时间不变。相关 Playwright 回归 4/4 通过；`node --check`、Node 119/119、便携版生成和 `git diff --check` 通过。 |
| 26 | 已修复 | `C` 合并后新建的绑定副字幕在开关开启时同步到合并后的主字幕范围，并重算绑定 offset；关闭开关时保留原副字幕范围。相关 Playwright 回归 3/3 通过；`node --check web\\editor.js`、便携版生成和 `git diff --check` 通过。 |
| 27 | 已修复 | 自动后处理 OCR 改为复用已安装的 managed runtime，并把运行结果转换回流水线产物契约；安装完成事件同时刷新 OCR 控件和自动步骤状态，自动步骤可在运行时状态就绪后恢复。OCR runtime / OCR 后处理 / 自动后处理 / Launcher GUI 回归分别纳入 64/64 和 154/154 通过批次；相关 MAW Python 模块、Launcher JS 和编辑器 JS 语法检查，以及 `git diff --check` 通过。 |

## 询问项结论

- 任务 2：频谱颜色只影响显示；关于是否可以完全不生成频谱的询问已转为任务 15 的独立开关实现，结论见下方“频谱是否可以完全不生成”。
- 任务 15：将任务 2 的询问转为实际修改项，保留 ReaPeaks 波形层，频谱计算由独立开关控制；无频谱数据时编辑器不允许启用频谱颜色。
- 任务 10：没有字词时间码时仍允许按字符位置估算切点，本轮只补边界和最短时长。
- 任务 11：末行波形缩短只改变显示宽度，不增加音频解码或采样计算。
- 任务 12：当前源码、模板、`edit.py` 和便携版均未发现播放器 `40vh` 限制。

## 阶段汇总（设置、缓存、Launcher/OCR）

- 已完成第 1、3、5、8、9、19 项。第 1 项用限长缓存媒体生成波形/频谱，但写回原始媒体签名，并增加频谱生成提示；第 3 项收紧 OCR 就绪判断、安装后刷新、按钮布局、识别结果间距和产物高亮；第 5 项补齐全局自动吸附设置、current-cue-panel 的 Esc 操作设置和延长默认值；第 19 项补齐多重字幕主轨/副轨的 `Shift+←/→` 显式边界贴合；第 8、9 项的播放/波形与 Launcher/LLM 反馈也已完成。
- 已验证：编辑器/波形/i18n/Launcher/后处理脚本语法通过；当前编辑器 Node 回归 119/119 通过，`tests.test_waveform` 15/15 通过；便携版已重新生成。`uv run` 因本机 uv 缓存权限失败，使用仓库 `.venv` 完成 Python 验证。
- 当前剩余修改项：无。第 13、14、16、26、27 项已完成；第 2、10、11、12、17 项为说明项，无需修改。

## 增量记录（任务 13、14：启动解耦与链接范围）

- 默认波形形状来源已改回“自研波形”。`.ReaPeaks` 仍可在波形设置中主动切换，但不再作为首屏默认来源；已有用户明确保存的 `ReaPeaks` 选择继续保留。
- 工程加载阶段只同步准备自研波形；服务器进入请求循环后才启动 `.ReaPeaks` 后台读取。后台读取期间首页和 `/api/waveform` 不等待它，读取完成后编辑器再动态注入频谱和 ReaPeaks 波形层。
- 服务器构造与最近工程 / attach 工程路径都使用同一套延后策略；无波形模式不会启动后台任务。
- URL 解析在 `）】》」』` 及常见句末标点处截断，后面的说明文字保持普通文本。

已验证：服务器后台加载阻塞回归 1/1；本地服务器测试 17/17；波形资源测试 14/14；Launcher URL 契约 1/1；便携版重新生成；相关 JS 语法检查通过。

## 增量记录（工程加载）

- 第 4 项已完成：工程加载提示保持单一语义，OCR 后工程仍保留媒体路径；服务器与便携版均支持读取/拖入 `.ReaPeaks`，无绑定服务器保存时明确提示“先导出 `.mosp`，再重新打开该文件”。
- 已验证：源码语法、`tests.test_waveform`（13/13）、便携版生成和产物扫描均通过。

### 频谱是否可以完全不生成

可以。`--with-waveform` 默认只生成并嵌入 `.ReaPeaks` wave 层；只有额外使用 `--with-spectral`（Launcher 中勾选“生成 ReaPeaks 频谱数据”）才计算并写入 spectral mipmap。编辑器仍可选择 ReaPeaks 波形，但没有频谱数据时会自动关闭并禁用“频谱颜色”。

## 增量记录（任务 15：可选 ReaPeaks 频谱）

- 生成器新增 `include_spectral` 开关：wave-only 文件保留 wave + loudness 层并跳过 FFT；完整文件继续支持 wave + spectral + loudness。已有完整缓存不会被删除，勾选频谱时如果发现匹配的缓存只有 wave 层会自动重建。
- `media_cache`、四个 provider CLI、MAW CLI、Launcher 请求和本地 ASR 输出链路已贯通；默认 `generate_spectral=false`，显式 `--with-spectral` 必须同时使用 `--with-waveform`。
- 编辑器的“频谱颜色”在没有合法 spectral payload 时显示为未勾选且禁用；服务器后台补齐频谱后重新启用，并保留用户此前的显示偏好。默认波形形状仍是自研波形。
- 已重新生成 `blank-editor.html`，并同步更新 `JSON_SCHEMA.md`、`docs/WORKFLOW.md` 和 `CHANGELOG.md`。

已验证：Python 相关回归 250/250；排除只读 REAPER fixture 后全量 Python 回归 572/572；Node 波形与编辑器工具回归 114/114；`node --check web\\waveform.js`、`node --check web\\launcher\\launcher.js`、相关 Python `py_compile`、便携版生成和 `git diff --check` 均通过。5 秒 16kHz 单声道合成音频的本机短样本对照为 wave-only 0.124s、wave+spectral 0.198s，频谱额外约 0.074s（约 1.6 倍；仅作量级参考）。未执行真实 API、长媒体全量性能基准或桌面打包验证。

## 增量记录（任务 7：二次按键强制拆分）

- 第一次按 B/Enter 如果当前切点会让任一侧短于 100ms，不再直接取消：主字幕内联编辑保持打开，拆分弹窗保持显示，并提示再次按 B/Enter。
- 第二次按 B/Enter 才执行强制拆分；切点钳制到原字幕（联动时为主/副字幕共同时间范围）内两侧各至少 100ms。原字幕总时长不足 200ms，或文字断点非法时，仍明确阻止并说明原因。
- 强制路径允许切点越过过短的单个字词 item 边界，同时保留 item 在对应字幕段内，不改变普通拆分的原有时间码策略。
- 已补充内联、波形弹窗、单独副字幕和联动主副字幕回归；撤销验证确认拆分前的选中项和字幕面板目标可恢复。

已验证：内联与波形弹窗回归 2/2 通过；多重字幕相关回归 4/4 通过；便携版已重新生成并包含二次按键逻辑。

## 增量记录（任务 6：多字幕批量操作）

- H 现在支持同时选中多条副字幕，按各自绑定关系批量对齐到主字幕时间范围，并只生成一条批量撤销记录；未绑定项会跳过并在提示中说明。
- 绑定自动同步时长、主字幕合并同步副字幕、扩展字幕合并/拆分及其撤销路径均已通过浏览器回归；批量对齐后的副字幕冲突会按现有规则挤压或删除无法保留 100ms 的冲突项，不反向改变主字幕时间范围。
- 已重新生成 `blank-editor.html`，模板中的“批量对齐”按钮、H 帮助文案和中英文映射与源码一致。

已验证：批量 H 与撤销 1/1 通过；绑定/合并/联动相关回归 4/4 通过。

## 增量记录（任务 9：LLM 配置与 Qwen 密钥复用）

- Qwen 后处理配置没有专用 Key 时，复用已有的 `DASHSCOPE_API_KEY`；Launcher 显示脱敏状态，测试连接和后处理管线读取同一有效 Key。
- 输入新 API Key 点击保存时自动执行测试连接，成功或失败结果显示在设置区的状态位；普通保存只显示短暂的保存成功反馈，不再重复提示点击测试连接，也不写入通用结果区。
- 已验证：`.venv\\Scripts\\python.exe -m unittest tests.test_gui_web tests.test_postprocess_pipeline`（163/163 通过）；`node --check web\\launcher\\postprocess.js`、`node --check web\\launcher\\launcher.js` 通过，保存成功不再提示点击测试连接，测试成功不改变当前窗口。
- 已完成字号核对：Launcher 原先 11px 的文本已提升到至少 12px，常规 12px 文本已提升到 13px；工具箱、设置弹窗、状态提示和日志均覆盖。
- 最终验证：`.venv\\Scripts\\python.exe -m unittest tests.test_gui_web tests.test_postprocess_pipeline`（163/163）；`node --check web\\launcher\\launcher.js`、`node --check web\\launcher\\postprocess.js`、`.venv\\Scripts\\python.exe -m py_compile maw\\gui_web.py tests\\test_gui_web.py`、`git diff --check` 均通过。

### 没有字词时间码时是否允许切分

现有代码已经有按字符位置估算切点的路径。本轮不改变该策略，只增加两侧最短时长和失败状态清理，避免切出过短字幕或留下编辑态。

### 末行波形缩短是否影响性能

只改变最后一行的显示宽度，不增加音频解码或采样计算，性能成本可忽略。

### 40vh 播放器限制

当前源码、模板、`edit.py` 和生成后的 `blank-editor.html` 中均未发现 `40vh` 播放器限制；无需修改播放器高度。

## 增量记录（任务 8：播放与波形）

- 已完成 Home/End 媒体首尾跳转；文本编辑、输入控件和模态窗口内不抢占原生行为。
- 字幕列表悬停到可拆分文字位置时，现显示带 `B` 的切分提示；最后一行多行波形只按媒体真实剩余时长显示宽度。
- 已重新生成 `blank-editor.html`，并确认源码、便携版与测试一致。

已验证：相关浏览器回归 6/6 通过；Node 113/113 通过；`edit.py` 编译通过；`git diff --check` 通过。

## 增量记录（任务 16、17：长音轨提示与波形缓存重构询问）

- 任务 16 已将浏览器无法整段解码、浏览器不支持 Web Audio、音轨解析失败等路径统一改为提示使用 MAW GUI 预生成波形；英文界面同步提供对应提示。`blank-editor.html` 由 `web/` 源码重新生成。
- 任务 17 当前只记录设计结论：统一媒体旁缓存是可行的，建议使用带媒体 `name / size / modified_ms` 签名的独立容器，内部放自研波形、ReaPeaks wave 层和可选 spectral 层；Server/桌面 GUI 可按媒体路径自动查找，单文件浏览器只能在用户同时提供缓存文件或工程内已有缓存时复用，不能绕过浏览器对相邻文件的访问限制。旧 `.ReaPeaks` 与 `.waveform.json` 应保留只读兼容后再迁移，避免一次性改写已有缓存协议。

已验证：`node --check web\\waveform.js`；`node --test tests\\test_waveform_js.mjs`（36/36）；`.venv\\Scripts\\python.exe -m unittest tests.test_waveform`（15/15）；`.venv\\Scripts\\python.exe edit.py --blank`；`git diff --check`。未实施任务 17 的缓存协议重构，因此没有宣称拖入长视频已支持自动读取统一缓存。

## 增量记录（任务 18：自动后处理产物契约与媒体路径）

- 原因：`run_postprocess_pipeline()` 每完成一步都会读取 `artifact.translated_srt_path`，但 OCR 返回的 `OcrDedupArtifact` 没有这个可选字段，因此 OCR 作为最后一步或中间一步都会在 OCR 写出后失败；这不是 OCR 识别失败。
- 修复：OCR 产物补齐 `translated_srt_path=None`；后处理写出统一接收当前 `media_path`，仅在输入工程缺少 `media` 时补写绝对路径，并贯通翻译、固定替换、文稿匹配、OCR 和独立 OCR runtime。工具箱从 SRT 输入时也把当前媒体传给后端。
- 已修复项没有覆盖已有工程的 `media`：如果工程已有媒体字段，即使 Launcher 表单中残留另一条媒体路径，也不会覆盖它。

已验证：`.venv\\Scripts\\python.exe -m unittest tests.test_postprocess tests.test_postprocess_match tests.test_postprocess_ocr tests.test_postprocess_pipeline tests.test_gui_web tests.test_ocr_runtime`（214/214）；`node --check web\\launcher\\postprocess.js`；`git diff --check`。全量 Python 共 580 个测试，其中 4 个既有 ReaPeaks fixture 用例因 `tests\\test_data` 写入权限失败，其余通过。

## 增量记录（任务 5、19：时间调整快捷键与编辑 Esc）

- 全局设置现在只提供「自动吸附调整相邻字幕」，默认关闭；关闭时普通移动、边界微调和共享边界拖动默认独立，按住 `Alt` 临时联动；开启时默认联动，按住 `Alt` 临时独立。`Alt` 始终是临时反转操作，不再单独配置 Alt 功能。
- `Esc` 设置已从全局设置和波形拖动移除，放入 `current-cue-panel` 齿轮的「操作」类别；「Esc 取消编辑」默认关闭。关闭时 `Esc` 提交文本改动并退出，开启时恢复进入编辑前的文本。
- `Shift+←/→` 是显式的直接边界贴合操作，不受自动吸附开关影响；多重字幕模式下根据当前字幕面板目标分别操作主轨或副轨，左/右方向分别贴合前一条结尾或后一条开头，不移动邻居。

已验证：`node --test tests\\test_waveform_js.mjs tests\\test_editor_utils.mjs`（119/119）；`.venv\\Scripts\\python.exe -m unittest tests.test_waveform`（15/15）；自动吸附与键盘回归 5/5；current-cue-panel Esc 回归 1/1；多重字幕 `Shift+←/→` 主轨/副轨回归 1/1；`npm run sync:docs` 已同步网站文档；`git diff --check` 通过。网站 `npm run check` 因本机 `website/node_modules` 缺少 `astro` 未能执行，文档类型检查未验证。

## 增量记录（任务 20：独立共享边界反向拖动）

- 修复独立拖动共享边界时的钳制逻辑：左字幕终点以右字幕起点为固定上限，右字幕起点以左字幕终点为固定下限，不再把已移动的当前边界当成单向限制。
- 现在相邻字幕从贴合状态拉开后，可以在同一次拖动中反向拖回，也支持之后继续双向调整；邻字幕仍保持不动，最小时长和不重叠限制不变。
- 已重新生成 `blank-editor.html`，源码与便携版共用同一修复。

已验证：边界反向拖动浏览器回归 1/1；波形 Node 回归 40/40；`node --check web\\waveform.js` 通过。

## 增量记录（任务 21-23：Launcher LLM 引导与固定操作区）

- 自动勾选 `proofread`、`resegment` 或 `translate` 且 LLM 配置未就绪时，打开 `llmSettingsSection` 并高亮「测试连接」；手动点击「配置」或普通打开设置不会额外触发高亮。测试连接的成功、失败、保存前置失败和异常路径统一清除高亮。
- 后处理工具箱关闭按钮改为更高对比度的方形图标按钮；工具箱 `wheel` 事件不再冒泡到 Launcher，标题/底部区域拦截背景滚动，内容滚动区保留滚动并用 `overscroll-behavior: contain` 防止滚动链穿透。
- 配置弹窗使用固定标题操作区和独立 `.settings-scroll` 内容区，配置标题与关闭按钮在内容滚动时保持顶部可见；设置滚动区纳入滚动条提示逻辑。
- 本次只涉及 `web/launcher` 资源，不会被 `edit.py --blank` 内联到 `blank-editor.html`；共享工作区已有的编辑器与便携版 WIP 保持原样，未覆盖生成。

已验证：`node --check web\\launcher\\launcher.js`、`node --check web\\launcher\\postprocess.js`、`python -m py_compile tests\\test_gui_web.py`；`.venv\\Scripts\\python.exe -m unittest tests.test_gui_web.LauncherAssetContractTests`（38/38）；相关后处理桥接与预检测试（5/5）；`git diff --check` 通过。完整 `tests.test_gui_web tests.test_postprocess_pipeline` 共 166 个测试，其中 4 个错误来自共享工作区并行修改的 `maw/postprocess.py`（缺少 `_reconcile_fixed_replacements`、`_protocol_prompt()` 参数不匹配），本次未修改该文件。未完成浏览器级截图/滚轮实测：本机 `agent-browser` 报告未找到 Chrome/Chromium，未下载安装浏览器运行时。

## 增量记录（任务 24：波形副字幕 B 拆分目标）

- 波形区单击副字幕块后，若当前面板仍指向这条单选副字幕，即使绑定关系同时选中了主字幕，也按副字幕目标处理 `B`；同时覆盖未绑定但与主字幕重叠的副字幕。
- 只有主字幕面板明确处于当前目标时，绑定副字幕仍保留原有联动拆分弹窗；列表区单选副字幕的文字位置拆分路径不变。

已验证：`npx playwright test --grep "waveform-selected.*extension cue|uses B on a single selected extension|uses the linked split dialog" --project=chromium`（4/4）；`node --check web\\editor.js`、`node --check web\\waveform.js`、`node --check web\\editor-i18n.js`；`node --test tests\\test_waveform_js.mjs tests\\test_editor_utils.mjs`（119/119）；`.venv\\Scripts\\python.exe edit.py --blank`；`git diff --check`。

同批次单独重跑既有「从波形右键菜单打开副字幕拆分并撤销」用例时，点击首个拆分间隙后弹窗未自动关闭（重复失败 1/1）；该路径不经过本次 `B` 快捷键分发，未将其归因于任务 24。

## 增量记录（任务 26：C 合并后的绑定副字幕自动同步时长）

- `mergeContiguousIndices()` 创建新的合并副字幕并建立绑定后，复用「绑定时自动同步时长」开关；开启时将副字幕范围调整为合并后主字幕的 `start/end`，并同步重算 `start_offset_ms/end_offset_ms`。
- 自动同步沿用副轨冲突整理逻辑；关闭开关时保留合并前副字幕范围。已有微小边界重叠用例显式关闭该开关，继续验证原有“忽略微小重叠”语义。

已验证：`npx playwright test --grep "选中的主字幕与绑定副字幕一起合并并支持撤销|ignores a tiny unbound extension overlap at the main merge boundary|拼合主字幕时同步延展绑定副字幕并支持撤销" --project=chromium`（3/3）；`node --check web\\editor.js`；`.venv\\Scripts\\python.exe edit.py --blank`；`git diff --check`。

## 增量记录（任务 27：自动后处理 OCR 运行环境与状态同步）

- 根因是手动 OCR 工具调用 `run_ocr_in_runtime`，而转写完成后的自动后处理仍直接调用主进程中的 `run_ocr_dedup`；打包版主环境没有 `rapidocr`，因此首次安装 managed OCR 后自动链路仍会提示“OCR 依赖未安装”。
- 自动后处理现在从 Launcher 传入当前 OCR runtime 路径，OCR 步骤通过 managed worker 执行，并把 worker 结果恢复为原有 `OcrDedupArtifact`；同时转发中间产物输出目录，避免第一步 OCR 将产物写回原始媒体目录。
- `ocrRuntimeReady` 事件触发后，Launcher 除了刷新 OCR 模型控件，也刷新自动后处理步骤状态并恢复等待配置的步骤；因此安装完成后无需重新加载 Launcher。

已验证：`.venv\\Scripts\\python.exe -m unittest tests.test_ocr_runtime tests.test_postprocess_ocr tests.test_postprocess_pipeline tests.test_gui_web.LauncherAssetContractTests`（64/64）；`.venv\\Scripts\\python.exe -m unittest tests.test_gui_web`（154/154）；`.venv\\Scripts\\python.exe -m py_compile maw\\gui_web.py maw\\ocr_runtime.py maw\\ocr_runtime_worker.py maw\\postprocess_pipeline.py`；`node --check web\\launcher\\launcher.js`、`node --check web\\launcher\\postprocess.js`、`node --check web\\editor.js`；`git diff --check`。一次合并式 `py_compile` 还尝试写入共享工作区的 `tests\\__pycache__`，因权限被拒绝，随后改为仅编译相关 MAW 模块并通过。

## 增量记录（任务 25：绑定自动同步时长的撤销显示）

- 原因：绑定时自动同步会改变副字幕的时间范围，但绑定、解绑及其撤销/重做使用 `renderAll({ waveform: 'none' })`，只重绘字幕列表，波形覆盖层仍保留旧的时间范围。
- 修复：绑定关系变化统一刷新波形覆盖层；撤销/重做恢复绑定快照后也刷新覆盖层。数据快照本身继续同时保存主字幕、副字幕和绑定关系。

已验证：绑定撤销浏览器回归同时检查 `DATA` 与波形块 `data-start/data-end`（1/1）；绑定相关多字幕回归 6/6；`node --test tests\\test_editor_utils.mjs tests\\test_waveform_js.mjs`（120/120）；`node --check web\\editor.js`；`.venv\\Scripts\\python.exe edit.py --blank`；`git diff --check` 通过。完整多字幕回归 71 个用例中 68 个通过，3 个既有拆分/跨轨吸附用例仍失败，未归因于本次修改。

## 增量记录（任务 29：Z/X 波形指针边界定位）

- 新增 `Z` / `X`：将单条字幕的起点 / 终点定位到当前波形鼠标位置；保留 100ms 最短时长和同轨不重叠边界约束。
- 当前面板为主字幕时，主字幕边界变化按原有绑定偏移联动副字幕；当前面板为副字幕时，只调整副字幕自身。主副绑定造成的成对选中按一个逻辑字幕处理，不同字幕的多选不执行。
- 没有选中字幕时，按波形指针所在轨道命中字幕并执行；指针在空白波形或无法确定唯一逻辑目标时不处理。帮助面板已补充快捷键说明，中英文资源与 `blank-editor.html` 已同步。

已验证：`npx playwright test tests\\e2e\\keyboard-timing.spec.mjs --grep "Z/X place selected or pointer-hit subtitle boundaries" --project=chromium`（1/1）；`npx playwright test tests\\e2e\\multi-subtitle.spec.mjs --grep "Z/X adjust one main or extension cue" --project=chromium`（1/1）；`node --test tests\\test_editor_utils.mjs tests\\test_waveform_js.mjs`（121/121）；`node --check web\\editor.js`、`node --check web\\waveform.js`、`node --check web\\editor-i18n.js`、两个 E2E 测试文件；`python edit.py --blank`；`git diff --check` 均通过。

## 增量记录（任务 30：波形调节交互性能）

- 移除振幅/行高调节期间的 Canvas 位图变形预览，改为 160ms debounce：滚动期间只累计净步数，停止后一次性调整并只重绘一次。
- 每行缓存按当前像素宽度计算的 min/max peak 包络，后续振幅/行高重绘直接复用；Canvas 只有在物理尺寸确实变化时才更新 `width/height`，避免触发位图重新分配。
- 已增加包络单元测试和振幅/行高预览浏览器回归；`blank-editor.html` 已从 `web/` 源码重新生成。未执行用户长媒体的基准录制，真实测试工程仅完成页面、波形接口和媒体 Range smoke。

已验证：`node --check web\\waveform.js`；`node --test tests\\test_editor_utils.mjs tests\\test_waveform_js.mjs`（121/121）；`npx playwright test waveform-history.spec.mjs --grep "appearance wheel adjustments" --project=chromium`（1/1）；`.venv\\Scripts\\python.exe -m unittest tests.test_waveform`（14/15，剩余 1 个既有便携版资源字符串契约失败）；`.venv\\Scripts\\python.exe edit.py --blank`；`git diff --check`。

## 增量记录（任务 31：主副字幕波形边界联动方向）

- 根因是关闭「自动吸附调整相邻字幕」时，主字幕共享边界会走 `resize-boundary-independent`；该标记被错误地当成了“解除主副绑定”，所以绑定副字幕没有跟随主字幕边界。
- 主字幕拖动现在始终联动绑定副字幕；同轨相邻字幕仍按自动吸附设置独立或联动。副字幕拖动改为只调整副字幕自身，不再被主字幕轨道边界限制，也不再弹出“主字幕轨道已无可用空间，已限制副字幕拖动”的警告；绑定偏移会按新范围重算。
- 同轨相邻吸附与跨轨道吸附拆开处理：关闭前者时，副字幕移动仍可按「跨轨道吸附」设置贴合主字幕边界。已补充主字幕共享边界左右手柄、副字幕越过主轨边界和跨轨吸附回归。

已验证：主副字幕相关浏览器回归 3/3；自动吸附、独立共享边界和 Shift 贴合回归 4/4；`node --test tests\\test_editor_utils.mjs tests\\test_waveform_js.mjs`（121/121）；`node --check web\\editor.js`、`node --check web\\waveform.js`；`python edit.py --blank`；`git diff --check` 均通过。

## 增量记录（FCP7 Premiere 交接：任务 4、5）

- Premiere 实机反馈：通用 `generatoritem` 的 `Text` effect 在 `00:00:00:03` 与 `00:02:16`（video track 2）显示“未转换”，并以透明视频占位；Windows 媒体路径未自动识别；源媒体为 2 声道而 XML 声明 1 声道时链接媒体被拒绝。
- 处理：Windows drive path 改为 Premiere 常见的 `file://localhost/C:/path`，保留 UNC、POSIX 与 UTF-8 百分号编码；视频与音频 file media 均声明 `channelcount=2`，音频 clip 声明双声道 sourcetrack 并链接到视频 clip；原生文本改为 `clipitem` + `GraphicAndType` effect + parameter 1，移除通用 `generatoritem`。
- 结构证据仅来自 `examples/序列 01.xml` 的 GraphicAndType 层级；未复制其 opaque payload 或路径。
- 已验证：`node --test tests\test_editor_utils.mjs` 为 `151/151`，组合 `node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs` 为 `193/193`；FCP7 浏览器回归 `9/9`；XML 使用 Python `xml.etree.ElementTree` 解析；`node --check web/editor-utils.js` 与 `git diff --check` 通过。当前环境未重新运行 Premiere，因此目标应用最终转换仍为未验证，不宣称已完全兼容。
- 当前 SHA-256：`web/editor-utils.js` `5ff8a79c9c8366d2a750223f596697aadffa7e904c6a5521c2b026a9f542c239`；`tests/test_editor_utils.mjs` `4ccaef69c35e3781109c2cd86f81e629a4320608520fe9ec4cd9583dadf9efc0`；`tests/e2e/fcp7-export.spec.mjs` `56347702556ef1db0cf3886f2732f0b5f1f80f42e336e64065021fd4dbf62870`。`.debug-journal.md` 为临时文件，不纳入证据或发布产物。
- 后续复现发现：仓库参考 XML 同时存在 `file:///D:/...` 与 `file://localhost/D|/...` 两种历史写法；针对当前 Premiere“找不到媒体”反馈，序列化器改为 `file://localhost/D:/...`，并补充回归断言。Premiere 实机重新导入仍需用户在相同媒体路径上确认，当前不能宣称已完全兼容。
