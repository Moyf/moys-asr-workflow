# ASS 界面反馈（2026-10-01）

用户要求在 `feat/ass-frame-preview` 上继续：先检查并提交已有工作，再逐项修复以下反馈。附件只作为阴影字段布局的视觉参考，不扩大操作范围。已有工作已核对并提交为 `33f021f`；基线验证见 `TEST_FEEDBACK_ASS_PREVIEW_FIDELITY.md`。

| 状态 | 类型 | 反馈 | 决定 / 涉及文件 / 验证 |
| --- | --- | --- | --- |
| 已修复 | 修改 | 字体缺字提示重复，缺少实际字符预览 | `maw/postprocess_ffmpeg.py` 按字体与归一化码点去重，`serve.py` 显示 `U+1F914（🤔）`；前端也去重重复响应。Python `test_render_ass_frame_png_builds_burn_style_command` 1/1 通过，覆盖重复与前导零码点。浏览器验证待最终联合执行。 |
| 已修复 | 修改 | 自动渲染在左，开启后才显示右边的暂停叠加开关 | 模板、CSS、实际帧接线改为左右布局，关闭自动渲染隐藏右侧选项并停止舞台叠加，保留其已保存偏好。Chromium `stage overlay defaults` 1/1 通过，实测左右坐标/同排及关闭、手动渲染、恢复行为。 |
| 已修复 | 修改 | 阴影距离与不透明度同排；边框样式联动文字；基础样式文案与分组 | 模板、CSS、样式管理接线和翻译已更新。Chromium `style form groups` 1/1 通过：阴影两字段同排、与描边字段同宽、水平/字体区间距 ≥8px，底框/描边切换三标签联动。基础样式截图已自查。 |
| 已修复 | 修改 | ASS 预览下增加实际画面入口 | 模板与实际帧模块增加同窗口入口，遵循服务器与 ASS 模式可用性。Chromium `style preview opens` 1/1 通过：点击打开窗口、缺字响应去重显示 emoji、入口与上方预览卡间距 ≥8px；窗口与入口截图已自查。最后补齐按钮外观后专项重跑 1/1 通过。 |
| 已修复 | 修改 | 特殊符号规则默认单双皆可 | 设置默认值、归一化回退、模板默认选项与翻译更新为 both/「单双皆可」，已保存规则继续保留。Node 348/348、含默认值/示例/导出回归的 Chromium 联合 34/34 通过；手动空白 Server 页面确认默认选中「单双皆可」。 |

## 验证边界

本轮不生成 `blank-editor.html`，内联副本待发布前统一重生成。不推送或发布。语法/单元、服务器契约、浏览器交互与截图间距检查分层记录；最终验证完成后更新实际结果。

阶段汇总：缺字警告与开关依赖两项已完成专项验证；继续整理样式表单。

第二阶段：样式布局/文字和新窗口入口均已通过浏览器专项，继续默认符号规则与联合验证。

## 最终验证

- 已修复 5 项，无仅说明项，无待处理、进行中或阻塞项。
- Node：348/348 通过，覆盖语法、脚本顺序、utils、波形与设置/符号解析契约。
- Python：全量 1754 项，1746 通过、8 跳过。重复码点与 emoji 警告专项通过；全量未设置临时 FFMPEG_PATH，以免污染 GUI 环境隔离测试。
- Chromium：实际帧、ASS 导出、说话人和预览几何联合 34/34 通过，使用带 libass 的 FFmpeg；最终按钮 CSS 调整后入口专项再跑 1/1 通过。新增入口、开关、基础样式截图均已自查，临时产物不入库。实测字体区、阴影字段、入口间距均 ≥8px。
- 手动启动空白 Server，仅监听 `127.0.0.1`；在应用内浏览器检查特殊符号默认选择与真实用户级样式表单，背景底框标签/阴影并排正确。检查后关闭临时页面与服务器，未保存样式库。
- Ruff、TypeScript 与 `git diff --check` 通过。初次 Node 验证发现新增「字幕颜色」翻译覆盖既有菜单键，已删除重复键并重跑 348/348 通过。
- 边界：未对用户原媒体复现缺字像素、未验证 Windows/Linux 字体回退；本轮无打包、CI 或发布验证。缺字提示是预警，不会为字体补充字形。8 项 Python 跳过未冒充通过。内联副本待发布前统一重生成。

实际命令：

```sh
UV_CACHE_DIR=/tmp/maw-uv-cache node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_waveform_js.mjs
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync python -m unittest discover -s tests -p 'test_*.py'
MAW_E2E_PYTHON=.venv/bin/python FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg node_modules/.bin/playwright test tests/e2e/ass-frame-preview.spec.mjs tests/e2e/ass-export.spec.mjs tests/e2e/speaker-labels.spec.mjs tests/e2e/subtitle-preview-geometry.spec.mjs --project=chromium --workers=1
node_modules/.bin/tsc -p tsconfig.typecheck.json
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync ruff check maw/postprocess_ffmpeg.py server-editor/serve.py tests/test_local_editor_server.py
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync python server-editor/serve.py --blank --no-open --no-waveform --port 0
git diff --check
```

## 预览入口续作（2026-10-02）

用户追加 UI 要求，截图只用于定位：样式库示例下方按钮改为提示文字 + 可点击蓝字；实际帧窗口尺寸信息右侧增加「编辑 ASS 字幕样式」蓝字，点击打开 ASS 样式库。本轮与空副轨续作一起提交、推送并创建 PR。

| 状态 | 问题 | 决定 / 验证 |
| --- | --- | --- |
| 已修复 | 样式库入口改为说明文字 + 蓝色链接 | 保留入口 ID 与可用性条件，使用按钮语义和蓝色下划线外观。模板、CSS 与翻译已更新；实际点击打开窗口、透明背景/无边框/下划线和上方间距 ≥8px 通过，截图已检查。 |
| 已修复 | 实际帧窗口增加样式库蓝色入口 | 放在帧时间/尺寸右侧，复用样式库窗口打开流程；点击、Enter 与关闭后重开均通过。左右同排、水平及上下间距 ≥8px，蓝色样式一致，截图已自查。 |

续作验证：实际帧 Chromium 12/12（真实 libass）通过，Node 全量 421/421，Python 编辑器资产 23/23，TypeScript 与 diff 检查通过；空副轨 / ASS 导出联合 107/107 见双语反馈记录。无功能待处理或阻塞项；提交 / PR 收尾见双语反馈记录。未生成仓库便携 HTML，无发布产物；Windows/Linux 字体及原截图媒体仍未复现。

用户追加实际帧窗口纵向缩放要求：继续拉高窗口时预览区域应随之拓展，避免只增加底部留白。

| 状态 | 问题 | 决定 / 验证 |
| --- | --- | --- |
| 已修复 | 拉高窗口后视频画面停止放大、底部留白增加 | 移除画面 52vh 上限，将可用高度分配给预览区域；保持宽高比例和原尺寸检查模式。实际拖动加高600px回归通过，画面容器增高≥500px、画面增高>300px且超出旧52vh限制，底部间距≤16px；原尺寸640×360与截图自查通过。 |

用户追加紧凑控制区：原尺寸按钮移至开关同一行右侧，移除底部说明与关闭按钮（保留右上关闭），确认 Esc 关闭。用户要求余下任务完成后集中测试，现停止逐项运行测试。

| 状态 | 问题 | 决定 / 验证 |
| --- | --- | --- |
| 已修复 | 控制区合并、移除重复关闭及说明 | 原尺寸与可选手动渲染按钮移入开关行，原尺寸靠右；旧底部关闭接线和说明样式移除。真实浏览器同排、右侧对齐、水平及垂直间距≥8px、无底部说明/关闭按钮验证通过，截图自查通过。 |
| 已修复 | Esc 关闭实际帧窗口 | 已有共享浮窗 Esc 接线，保留；实际按 Escape 关闭与重新打开验证通过，不改共享窗口关闭策略。 |

## 波形 hover 轮廓续作（2026-10-02）

用户要求检查字幕块 hover 的 brightness 滤镜导致 outline 不可见的问题。基线保留前述 ASS / 空副轨暂存和未暂存修改，不覆盖其他工作。

| 状态 | 问题 | 决定 / 验证 |
| --- | --- | --- |
| 已修复 | hover 后字幕块外轮廓消失 | 当前父块有 overflow:hidden，hover/dragging 对整个父块使用 filter，可能将盒外 outline 纳入滤镜合成并裁切；样式优先级本身没有移除 outline。将提亮改为块内不接受点击的覆盖层，保持底色/禁用条纹、文字/手柄/轮廓独立。Chromium 深浅主题×主副轨×选中/活动/禁用拖动共12组合的真实hover与盒外轮廓像素验证通过。旧滤镜仍绘制322个变色轮廓像素（并未在本机复现完全消失），原黄色像素0；修复后原黄色轮廓322像素。截图最终自查待同步主分支后检查。 |

## 副字幕 ASS 文字颜色（2026-10-02）

用户反馈 ASS 字幕模式下即时预览的副字幕没有遵循副字幕预设文本颜色；截图用于主/副预览与实际帧的颜色差异证据。

| 状态 | 问题 | 决定 / 验证 |
| --- | --- | --- |
| 已修复 | 副字幕特殊格式存在时普通片段变白 | ASS 预览已给外层设置副字幕 primaryColor；内部格式 span 被 `.subtitle-overlay span { color:#fff }` 覆盖，已有测试只看外层 color，漏掉实际文字。ASS 模式下格式容器/片段显式继承颜色，保留强调文字色 inline 覆盖，同样适用于主轨与叠加轨。真实浏览器验证主副轨、修改预设颜色、普通/强调/缩小/放大/下划线/删除线、导出色值及CSS模式切回均通过；实际文字颜色截图已自查。 |

## 跳转后的实际帧自动更新（2026-10-02）

用户反馈旧帧显示「画面已过期」后，点击跳转到新时间有时不触发自动渲染。

| 状态 | 问题 | 决定 / 验证 |
| --- | --- | --- |
| 已修复 | 持续预览刷新使跳转后的自动渲染停滞 | `syncPreview` 每次重置 200ms 定时器，密集刷新可能永久推迟渲染。改为一个计时窗口内合并最新状态但不重置截止时间；缓存命中也刷新窗口显示。快照仅在帧回调对应当前播放位置时使用 PTS，避免 currentTime 赋值早于 seeking 时沿用旧时间。40ms连续刷新时真实seek仍发起新时间请求、图片更新并消除过期提示；原有快速seek、错误恢复、重载、播放与小数帧测试均通过。 |

## 默认样式参数（2026-10-02）

用户要求读取当前用户 ASS 样式库，将字体以外的配置设为新的默认值，字体按系统选择；并完成整批验证、提交与 PR。已读取本机共享用户库：三个内置样式和一个默认输出方案，无自定义条目或其他槽位引用。

| 状态 | 问题 | 决定 / 验证 |
| --- | --- | --- |
| 已修复 | 用户配置作为新库默认参数 | JS / Python 同步 SRT 默认与 ASS 主样式 86/描边6/边距88/加粗；主样式强调色 #ffaa00、比例1.3、阴影色 #ff8647、不透明度60；副字幕64/描边2/边距36/黄色/强调色 #ffaa00；默认方案淡入淡出250ms开启。字体均按系统，用户已有显式值仍保留。本机用户库全部非字体字段/输出方案/槽位与新默认逐项比较完全一致；Node跨语言一致性、JS/Python已有显式旧值保留回归通过。旧库缺少透明度字段继续按100%处理。 |

## 整批集中验证（2026-10-02）

- Node全量422/422；Python全量1755项，1747通过、8跳过；TypeScript、Ruff和diff检查通过。
- Chromium六组联合154/157通过；三个失败均为测试配置/期望问题：新增副轨颜色用例需启用副轨预览，强调比例需计入原生字号取整，叠加轨边距需同步新默认值。修正后相关三个测试所在的实际帧/ASS导出/叠加轨联合53/53通过。其他104项已通过且期间未修改其代码。
- 首轮全量发现旧样式缺少透明度字段时被新默认60%改变，已修复为保留100%并通过两端回归；其余旧默认断言同步新参数，语法专用测试采用显式字号保持原测试契约。
- 最终窗口扩大、同排控制区、蓝字入口、基础样式、副轨实际文字颜色及导出菜单截图已自查；间距由浏览器实际坐标断言≥8px。
- 无功能待处理或阻塞项；本机未复现滤镜彻底裁掉outline，修复验证的是原轮廓颜色和盒外像素保留。未用原截图媒体、未验证Windows/Linux系统字体、未打包或发布；仓库便携HTML未重新生成，内联副本待发布前统一重生成。
- 接下来提交已验证修改并同步主分支，消除模板与文档冲突，最终代码再集中验证后推送和创建PR。

命令：

```sh
MAW_TEST_PYTHON=.venv/bin/python UV_CACHE_DIR=/tmp/maw-uv-cache node --test tests/test_*.mjs
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync python -m unittest discover -s tests -p 'test_*.py'
MAW_E2E_PYTHON=.venv/bin/python FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg node_modules/.bin/playwright test tests/e2e/multi-subtitle.spec.mjs tests/e2e/ass-export.spec.mjs tests/e2e/ass-frame-preview.spec.mjs tests/e2e/overlay-track.spec.mjs tests/e2e/speaker-labels.spec.mjs tests/e2e/subtitle-preview-geometry.spec.mjs --project=chromium
MAW_E2E_PYTHON=.venv/bin/python FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg node_modules/.bin/playwright test tests/e2e/ass-frame-preview.spec.mjs tests/e2e/ass-export.spec.mjs tests/e2e/overlay-track.spec.mjs --project=chromium
npm run typecheck
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync ruff check maw/ass_styles.py tests/test_ass_styles.py tests/test_editor_assets.py
git diff --check
```
