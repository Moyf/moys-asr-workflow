# v1.4.0-beta.7 测试反馈与处理记录

本文记录 beta7 专项测试中的反馈、处理决定和验证结果。截图中的说明性文字仅作为测试反馈来源；是否修改以本表的分类为准。

## 处理清单

| 编号 | 范围 | 反馈摘要 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 生成 / 缓存 | 测试模式下波形和频谱缓存只处理前 2 分钟；频谱生成需要明确进度提示 | 修改 | 已修复 |
| 2 | 生成 / 频谱 | 频谱颜色只影响显示；询问是否可以完全不生成频谱 | 说明 | 仅说明 |
| 3 | Launcher / OCR | 未安装 OCR 时不能显示“已就绪”；安装后刷新状态；刷新按钮不能被挤压；源码版与打包版提示区分；识别进度增加间距；当前产物自动高亮 | 修改 | 已修复 |
| 4 | 编辑器 / 工程 | 去重工程加载提示；OCR 后保留媒体路径；允许拖入 `.ReaPeaks`；无绑定工程的服务器提示改为导出后重新打开 | 修改 | 已修复 |
| 5 | 编辑器 / 设置 | 设置图标统一；全局按钮改为“⚙️ 全局设置”；增加全局 Alt 吸附反转和 ESC 行为设置；波形设置增加“操作”分类；延长字幕默认值改为向前 120ms、向后 60ms | 修改 | 已修复 |
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

## 修复与验证记录

| 编号 | 处理结果 | 验证证据 |
| --- | --- | --- |
| 1 | 已修复 | `.venv\\Scripts\\python.exe -m unittest tests.test_media_cache`（3/3 通过，含“测试模式使用限长缓存但保留原始媒体签名”）；`media_cache.py` 输出频谱生成进度，并在缓存旁路缺失时保留工程已有缓存。 |
| 3 | 已修复 | `.venv\\Scripts\\python.exe -m unittest tests.test_gui_web tests.test_ocr_runtime tests.test_postprocess_ocr`（相关测试包含在 210/210 通过批次）；`node --check web\\launcher\\launcher.js`; `node --check web\\launcher\\postprocess.js`; `git diff --check` 均通过。 |
| 4 | 已修复 | `node --check web\\editor.js`; `.venv\\Scripts\\python.exe -m unittest tests.test_waveform`（13/13 通过）；`.venv\\Scripts\\python.exe edit.py --blank`; `blank-editor.html` 已扫描确认 ReaPeaks 解析/拖入入口，以及无绑定服务器提示“导出 .mosp，再重新打开该文件”；`git diff --check` 通过。 |
| 5 | 已修复 | `node --check web\\editor.js`; `node --check web\\waveform.js`; `node --check web\\editor-i18n.js`; `node --test tests\\test_waveform_js.mjs tests\\test_editor_utils.mjs`（113/113 通过）；`.venv\\Scripts\\python.exe edit.py --blank`; `.venv\\Scripts\\python.exe -m unittest tests.test_waveform`（13/13 通过）；`git diff --check` 通过。 |
| 6 | 已修复 | `npx playwright test tests/e2e/multi-subtitle.spec.mjs --grep "aligns multiple selected extension cues" --project=chromium`（1/1 通过）；`npx playwright test tests/e2e/multi-subtitle.spec.mjs --grep "auto-synced binding|merges selected extension|选中的主字幕与绑定副字幕|拼合主字幕" --project=chromium`（4/4 通过）；`node --check web\\editor.js`; `node --check web\\editor-i18n.js`; 源码与便携版已同步。 |
| 7 | 已修复 | `node --check web\\editor.js`; `node --check web\\editor-i18n.js`; `npx playwright test tests/e2e/waveform-history.spec.mjs --grep \"retries an inline split with B or Enter|requires a second B\" --project=chromium`（2/2 通过，内联路径明确验证第二次 Enter）；`npx playwright test tests/e2e/multi-subtitle.spec.mjs --grep \"uses B on a single selected extension|uses the linked split dialog|retries a short linked split|imports an extension SRT\" --project=chromium`（4/4 通过）；`.venv\\Scripts\\python.exe edit.py --blank`; `git diff --check`。 |
| 8 | 已修复 | `node --check web\\editor.js`; `node --check web\\waveform.js`; `npx playwright test tests/e2e/waveform-history.spec.mjs --grep \"B splits the selected subtitle under|retries an inline split with B or Enter|Home and End|hovering a selected subtitle|last multi-row waveform|requires a second B\" --project=chromium`（6/6 通过）；`node --test tests\\test_editor_utils.mjs tests\\test_waveform_js.mjs`（113/113 通过）；`.venv\\Scripts\\python.exe edit.py --blank`; `python -m py_compile edit.py`; `git diff --check`。 |
| 9 | 已修复 | Qwen 复用 `DASHSCOPE_API_KEY`、保存后的测试连接提示、保存新 Key 自动测试和 Launcher 字号调整均已完成；`.venv\\Scripts\\python.exe -m unittest tests.test_gui_web tests.test_postprocess_pipeline`（160/160 通过），Launcher JS 语法、Python 编译和 `git diff --check` 通过。 |
| 13 | 已修复 | 服务器启动路径同步读取自研波形，跳过启动阶段的 `.ReaPeaks` 解析；服务器开始提供请求后由后台线程加载频谱和 ReaPeaks 波形，并通过 `/api/waveform` 返回 `loading` / `ready` 状态，编辑器轮询后动态增强显示。`.venv\\Scripts\\python.exe -m unittest tests.test_local_editor_server`（17/17 通过，其中新增阻塞后台解析时首页仍返回 200、状态最终变为 `ready` 的回归）；`.venv\\Scripts\\python.exe -m unittest tests.test_waveform`（14/14）；`.venv\\Scripts\\python.exe edit.py --blank`；`node --check web\\editor.js`、`node --check web\\waveform.js`、`node --check web\\editor-i18n.js` 通过。 |
| 14 | 已修复 | Launcher 消息中的 URL 正则在中文右括号、书名号、引号及常见句末标点前停止，不再把后续说明文字并入链接；`.venv\\Scripts\\python.exe -m unittest tests.test_gui_web.LauncherAssetContractTests.test_launcher_message_url_stops_before_closing_punctuation`（1/1）；`node --check web\\launcher\\launcher.js` 通过。 |
| 15 | 已修复 | `--with-waveform` / Launcher 默认生成并嵌入 ReaPeaks wave 层，`--with-spectral` 或勾选“生成 ReaPeaks 频谱数据”才执行 FFT 并嵌入 spectral；只有波形层时编辑器自动取消并禁用频谱颜色，后台补齐频谱后恢复可用。`.venv\\Scripts\\python.exe -m unittest tests.test_reapeaks tests.test_media_cache tests.test_cli tests.test_gui_workflow tests.test_gui_web tests.test_local_asr`（250/250）；`node --test tests\\test_waveform_js.mjs tests\\test_editor_utils.mjs`（114/114）；相关 Python/JS 语法检查、`.venv\\Scripts\\python.exe edit.py --blank`、`git diff --check` 均通过。 |

## 询问项结论

- 任务 2：频谱颜色只影响显示；关于是否可以完全不生成频谱的询问已转为任务 15 的独立开关实现，结论见下方“频谱是否可以完全不生成”。
- 任务 15：将任务 2 的询问转为实际修改项，保留 ReaPeaks 波形层，频谱计算由独立开关控制；无频谱数据时编辑器不允许启用频谱颜色。
- 任务 10：没有字词时间码时仍允许按字符位置估算切点，本轮只补边界和最短时长。
- 任务 11：末行波形缩短只改变显示宽度，不增加音频解码或采样计算。
- 任务 12：当前源码、模板、`edit.py` 和便携版均未发现播放器 `40vh` 限制。

## 阶段汇总（设置、缓存、Launcher/OCR）

- 已完成第 1、3、5、8、9 项。第 1 项用限长缓存媒体生成波形/频谱，但写回原始媒体签名，并增加频谱生成提示；第 3 项收紧 OCR 就绪判断、安装后刷新、按钮布局、识别结果间距和产物高亮；第 5 项补齐全局设置、Alt/ESC 行为、波形“操作”分类和延长默认值；第 8、9 项的播放/波形与 Launcher/LLM 反馈也已完成。
- 已验证：编辑器/波形/i18n/Launcher/后处理脚本语法通过；Node 113/113 通过；Python 相关批次 210/210 通过；便携版已重新生成。`uv run` 因本机 uv 缓存权限失败，使用仓库 `.venv` 完成 Python 验证。
- 当前剩余修改项：无。第 13、14、16 项已完成；第 2、10、11、12、17 项为说明项，无需修改。

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
