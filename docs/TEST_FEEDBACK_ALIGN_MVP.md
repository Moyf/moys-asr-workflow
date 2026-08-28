# 文稿录制对齐 MVP 反馈记录

## 当前反馈

| 问题 | 状态 | 处理决定 | 涉及文件 | 验证 |
| --- | --- | --- | --- | --- |
| 播放头播放时一格一格跳动 | 已修复 | 参考 MAWE 的 `requestAnimationFrame` 播放刷新循环；`timeupdate` 继续处理媒体事件，播放中每帧更新播放头、自动滚动和 gap 跳过逻辑 | `server-align/index.html`、`server-align/README.md` | 内嵌 JavaScript 语法检查；示例 Server smoke check |
| 增加基础/多行波形视图 | 已修复 | 基础模式保留完整横向时间轴；多行模式按可调每行时长分行，支持行高设置、垂直滚动、同一时间码下的 take/gap/playhead/定位交互 | `server-align/index.html`、`server-align/README.md` | 内嵌 JavaScript 语法检查；页面内容契约检查；示例 Server smoke check |
| 不完整字幕块支持直接启用/禁用 | 已修复 | 时间轴上的 incomplete 块直接切换手动启用状态；未选中的块点击后会选中并启用，已启用的块再次点击会恢复自动禁用；候选列表原有按钮保持不变 | `server-align/index.html`、`server-align/README.md` | 内嵌 JavaScript 语法检查；静态事件绑定检查 |
| Extra 不应合并成很长的一整句 | 已修复 | 数据层按每个源字幕段或同一段内连续 item 区间拆分 true Extra；`skip-source` 失败/口吃/Alternative 仍保持原有候选范围 | `maw/script_alignment.py`、`server-align/README.md` | 对齐单元测试；真实示例 Extra 列表检查 |
| 紧邻完整重录的失败片段误判为 Extra | 已修复 | 选中的完整 take 前，对文本明显同源但未形成可靠候选的近邻片段做保守提升，标记为 `skip-source / incomplete` 并默认禁用；独立 Extra 仍默认保留 | `maw/script_alignment.py`、`server-align/README.md` | 对齐回归测试；合成重录样例检查 |
| 候选内、候选外的近似改口误判为 Extra | 已修复 | 相邻完整源片段满足长共同开头与明显停顿时，前段写入 `skip-source / repetition`，后段保留；同一规则同时覆盖候选内部的 `internalSkips` 和候选外的连续源片段 | `maw/script_alignment.py`、`tests/test_script_alignment.py`、`JSON_SCHEMA.md` | 对齐单元测试；真实示例候选与 Extra 检查 |
| Extra 卡片集中在同一处 | 已修复 | 文稿行继续按行号顺序排列；Extra 按 ASR 起始时间插入相邻文稿行之间，missing 行不再作为强制截断点；同一插入位置内继续保持 ASR 顺序 | `server-align/index.html` | Extra slot 排序检查；内嵌 JavaScript 语法检查 |
| 同分 Alternative 默认选了较早 take | 已修复 | 默认路径在同一组支持度相同时，从文稿后面的行向前比较起始时间，偏向较晚版本；同分时不会再被前面一行的较晚 take 抢走后面一行的选择 | `maw/script_alignment.py`、`tests/test_script_alignment.py` | 对齐回归测试通过；真实示例第 40 行默认选后一个候选 |
| 已采用 take 需要手动禁用 | 已修复 | 在已采用候选右侧增加与「手动启用」同位置、同样式的「手动禁用/取消手动禁用」；记录 `candidateActions`，导出时把手动禁用 take 转为 `gap_remove` 并禁用字幕 | `maw/script_alignment.py`、`server-align/index.html`、`server-align/README.md`、`JSON_SCHEMA.md`、`tests/test_script_alignment.py`、`tests/test_server_align.py` | 对齐/API 回归测试通过；内嵌 JavaScript 语法检查通过 |
| Ctrl+单击字幕块定位下方录制 card | 已修复 | 时间轴块保留原有普通点击行为；按住 Ctrl 单击时跳过选择/禁用动作，滚动到对应的候选或 Extra card，并短暂高亮目标 | `server-align/index.html`、`server-align/README.md` | 内嵌 JavaScript 语法检查；静态交互契约检查 |
| 基础波形滚轮横向滚动与空格键焦点 | 已修复 | 基础模式将滚轮映射为时间轴横向滚动，多行模式保留纵向滚动；点击波形块或 checkbox 等控件后释放焦点，使空格键继续控制播放/暂停，同时保留文本输入的正常焦点行为 | `server-align/index.html`、`server-align/README.md` | 内嵌 JavaScript 语法与交互契约检查；对齐专项测试；示例 Server smoke check |
| 播放默认跳过 gap，主动定位时临时试听 | 已修复 | 将 Align 的播放开关默认设为启用；播放头自然进入已移除 gap 时跳到后面，用户主动单击或拖动播放头进入 gap 时临时允许播放，离开范围后恢复自动跳过 | `server-align/index.html`、`server-align/README.md`、`tests/test_server_align.py` | 默认值断言；内嵌 JavaScript 语法与播放逻辑契约检查；示例 Server smoke check |
| 复刻 MAWE Gap 人工操作与配置 | 已修复 | 增加「无 / 拖动边界 / 中键拖动 / 边界与中键」配置；支持空白处 Alt+左键单击或拖动添加、已有 Gap Alt+左键切换、右键菜单、边界拖动、整体移动与 Ctrl/Cmd 复制；人工结果随预览和导出回传至 `gap_remove` | `server-align/index.html`、`server-align/serve.py`、`maw/script_alignment.py`、`tests/test_server_align.py`、`server-align/README.md` | Gap 状态预览/导出 API 回归测试；内嵌 JavaScript 语法与交互契约检查；示例 Server smoke check |
| Gap 来源需要可追溯且能分层重扫 | 已修复 | 抽出 `web/gap-remove-core.js` 作为 MAWE 与 Align 共用的纯 Gap 核心；`provenance` 保存 `script_alignment`、`audio_gate` 与 `manual` 来源层，并兼容读取 `legacy` 后迁移，最终 `gaps[*].source/origins` 作为派生字段；MAWE/Align 的扫描、手动操作、预览和导出均保留来源层 | `web/gap-remove-core.js`、`web/editor-utils.js`、`web/editor.js`、`server-align/index.html`、`maw/script_alignment.py`、`docs/GAP_PROVENANCE.md`、`JSON_SCHEMA.md` | Core provenance 测试、对齐输出/重扫保留测试、Align API 测试、MAWE 资产契约测试通过；浏览器手动交互待补充 |
| 旧工程来源未知的 Gap 应按静音 gate 处理 | 已修复 | 旧工程中没有来源层、或含兼容 `legacy` 的启用 Gap 默认迁移为 `audio_gate`，使用普通自动静音样式，并被重扫/收缩替换；旧的 `removed:false` 状态保留为手动恢复覆盖，避免改变已有播放结果 | `web/gap-remove-core.js`、`web/waveform.js`、`server-align/index.html`、`maw/script_alignment.py`、`tests/test_editor_utils.mjs`、`tests/test_script_alignment.py`、`tests/test_server_align.py`、`docs/GAP_PROVENANCE.md`、`JSON_SCHEMA.md` | 前端迁移/重扫回归、Align API 和对齐后端定向回归 22 项通过；合并 JS 202 项与资产 16 项通过；浏览器真实重扫待补充 |
| 恢复覆盖层暴露成重复/已恢复块，导致清理和边界拖动异常 | 已修复 | 最终 Gap 始终只显示一层：`removed:true` 是启用的空隙，`removed:false` 是保留可见但不生效的人工恢复空隙；相邻同状态区段合并，播放/导出/字幕禁用只消费 `removed:true`。清理操作从来源层删除选中范围，不新增恢复掩码，因此不会留下伪装成“已恢复”的记录 | `web/gap-remove-core.js`、`web/editor-utils.js`、`web/editor.js`、`web/waveform.js`、`server-align/index.html`、`docs/GAP_PROVENANCE.md` | 三状态投影、跨恢复段边界与清理来源记录 Core 回归测试通过；浏览器真实拖动待补充 |
| Gap 来源不同但界面应保持一种 Gap | 已修复 | 可见投影保留内部来源的临时类型；普通自动静音保持原样式，包含手工调整、台本对齐或多来源的区间使用轻量边框提示，并将悬浮标题简化为类型名称，不显示多层来源结构。旧工程启用 Gap 迁入 `audio_gate` 后不再有特殊样式 | `web/gap-remove-core.js`、`web/waveform.js`、`web/waveform.css`、`server-align/index.html`、`docs/GAP_PROVENANCE.md` | Core 类型/保护状态测试、Align 页面契约检查；浏览器视觉回归待补充 |
| 收缩空隙不应生成“已恢复”人工层 | 已修复 | 批量收缩直接缩短 `provenance.sources.audio_gate` 的区间并重建最终 Gap；不追加 `manual_overrides`，也不因此标记 `manual_corrections`，已有人工覆盖仍保留 | `web/editor.js`、`web/gap-remove-core.js`、`JSON_SCHEMA.md`、`docs/GAP_PROVENANCE.md` | Core 来源重建、MAWE 资产契约与全量 Python 测试通过；浏览器按钮交互待补充 |
| 重复拖动同一个 Gap 边界会堆积“已恢复”层 | 已修复 | 边界拖动改为共用核心的 `boundary_resize` 操作记录：最终 Gap 缩小时直接清除被缩掉的范围，恢复区段移动时调整同一条边界控制；再次拖动更新已有记录，不再为旧范围追加 `removed: false` 恢复覆盖，界面始终只显示一层 | `web/gap-remove-core.js`、`web/editor.js`、`tests/test_editor_utils.mjs`、`docs/GAP_PROVENANCE.md`、`JSON_SCHEMA.md` | Core 覆盖纯 Gap、重复拖动、跨人工恢复边界与重扫保留；浏览器真实拖动待补充 |
| 整体拖动 Gap 或【已恢复】会不断追加/扩大恢复范围 | 已修复 | 整体拖动改为共用核心的 `move` 操作记录：只移动当前可见状态，原位置不再写入 `removed:false`；重复拖动更新同一条记录，移动【已恢复】时清除原可见恢复范围，不补回底层自动移除，因此原位置不会留下【已移除】 | `web/gap-remove-core.js`、`web/editor.js`、`web/waveform.js`、`server-align/index.html`、`tests/test_editor_utils.mjs`、`docs/GAP_PROVENANCE.md`、`JSON_SCHEMA.md` | Core 覆盖启用 Gap、重复移动、【已恢复】移动与回到原位；浏览器真实拖动待补充 |
| 移动 Gap 覆盖已有 Gap 时出现重复层、旧 Gap 重新出现或带动相邻异状态 Gap | 已修复 | `move` 记录保留被清空的 base，只裁剪其当前目标区间（可拆成 `target_ranges`）；拖动中的 Gap 始终按原可见范围加 delta 保存精确目标，不从投影合并结果反推。同状态目标可被完整吸收，异状态目标仅裁掉重叠范围；相邻 inactive/active 保持两个独立拖动对象 | `web/gap-remove-core.js`、`tests/test_editor_utils.mjs`、`docs/GAP_PROVENANCE.md`、`JSON_SCHEMA.md` | Core 回归覆盖同状态目标重叠且长度固定、旧 restored move 的局部/完全覆盖、active/inactive 相邻拖动；202 项 JS 与 729 项 Python（跳过 4 项）通过；浏览器真实拖动待补充 |
| 边界拖动穿过现有 Gap 会被拦住，或回拖后露出被覆盖的旧 Gap | 已修复 | 边界只移动被点中的 Gap；向外扩张时，完全覆盖的可见 Gap 整段清理，部分覆盖的可见 Gap 只裁掉重叠部分。`boundary_resize.cleared_ranges` 持久记录已裁掉的部分，回拖后不会从来源层或旧操作记录中复活 | `web/gap-remove-core.js`、`tests/test_editor_utils.mjs`、`docs/GAP_PROVENANCE.md`、`JSON_SCHEMA.md` | Core 回归覆盖 active→restored 与 restored→active 的部分覆盖/回拖、完全覆盖删除、共享边界只移动命中对象；201 项 JS、16 项资产测试与 729 项 Python（跳过 4 项）通过；浏览器真实拖动待补充 |
| 缩小恢复 Gap 边界时凭空插入启用 Gap | 已修复 | 恢复 Gap 向内拖动边界时，只缩短当前 `removed:false` 区段；缩掉的范围从最终投影清除，不写入 `removed:true`，也不重新激活底层空隙 | `web/gap-remove-core.js`、`tests/test_editor_utils.mjs`、`docs/GAP_PROVENANCE.md`、`JSON_SCHEMA.md` | Core 回归覆盖左右边界缩小、带 `audio_gate` 底层时不插入启用 Gap、回拖到原边界；合并后 JS 242 项、Python 833 项（跳过 5 项）通过 |
| Gap 状态文案不清晰 | 已修复 | 启用的 Gap 显示为「空隙」，恢复但未生效的 Gap 显示为「空隙（未激活）」；MAWE 与 Align 保持一致 | `web/waveform.js`、`server-align/index.html`、`tests/test_editor_assets.py`、`tests/test_server_align.py` | MAWE/Align 静态文案契约通过；资产 17 项、Align 服务 5 项通过 |
| 手动拖动的视觉提示不够明确 | 已修复 | MAWE 与 Align 的 Gap 边界把手、整体/边界拖动预览统一为蓝色，建立“用户正在手动修改”的视觉映射；复制操作继续保留独立的虚线提示 | `web/waveform.css`、`server-align/index.html`、`tests/test_editor_assets.py` | 编辑器资产 CSS 契约 16 项通过；全量 Python 回归通过；浏览器视觉回归待补充 |
| 多行波形重复计算 Gap 投影 | 已修复 | 共享 core 按 Gap 数组身份缓存显示投影；MAWE 编辑器的 Gap getter 在同一状态版本内返回同一数组，多个波形行直接复用，不再逐行重复投影 | `web/gap-remove-core.js`、`web/editor.js`、`web/waveform.js`、`server-align/index.html`、`tests/test_editor_utils.mjs`、`docs/GAP_PROVENANCE.md` | 投影缓存身份测试、JS 语法与静态契约检查；浏览器性能 profile 待补充 |
| Editor 播放/交互卡顿 | 仅说明 | 代码审计与本地浏览器样例观察：播放 RAF 只更新播放头/字幕预览，不逐帧重绘 Canvas；基础模式跨出舒适区或时间窗边界时会调用 `renderBasic()` 重建当前行；Gap 显示投影现由 core 缓存，`appendGapBlocks()` 和多个波形行直接复用同一份数组，剩余热点主要是行切换时的布局/Canvas 重建。当前样例约 3,005 个 MAWE DOM 节点、10 个可视 Canvas、27–28 个 Gap block；播放采样中只在 gap 跳过和时间窗切换时出现时间/DOM 变化，未发现控制台错误。本轮只记录尚未确认的性能热点 | `web/editor.js`、`web/waveform.js`、`web/gap-remove-core.js` | 内置浏览器基础/多行播放采样；Node Gap 投影基准：178 个 Gap 热身后约 0.99ms/次，800→2400 个 Gap 单次约 13.15→60.63ms；未使用 DevTools profiler |

## 验证结果

- `node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs`：合并后 242 项通过。
- `uv run python -m unittest discover -s tests -p "test_editor_assets.py" -q`：17 项通过。
- `uv run python -m unittest tests.test_script_alignment tests.test_server_align -q`：22 项通过，覆盖旧 Gap 迁移后的对齐/Align API 输出。
- `uv run python -m unittest discover -s tests -p "test_*.py" -q`：再次同步 main 后 833 项通过，5 项跳过。
- `node` `new Function(...)`：`server-align/index.html` 内嵌 JavaScript 语法通过；滚轮横向滚动、控件释放焦点、Ctrl 定位 card、Gap 临时试听和人工操作契约检查通过。
- 示例工程 `MAW-1.4更新说明.bcut.mosp`：页面、状态接口和媒体 HEAD 请求均返回 200；媒体声明支持 `bytes` Range。
- 本次示例 Server smoke：`/` 与 `/api/state` 均返回 200，服务已正常停止。
- Codex 内置浏览器加载带媒体样例：MAWE 播放时基础/多行播放头连续推进，跨 gap 时按配置跳过；播放期间 DOM/Canvas 数量保持稳定，未记录控制台 warning/error。
- 性能基准：`getGapRemoveDisplayGaps()` 在 178 个 Gap 上热身后约 0.99ms/次；800、1200、1600、2400 个 Gap 单次约 13.15、23.82、30.74、60.63ms。
- `git diff --check`：通过；本次涉及文本文件均保持 LF 换行。

## 未验证

- 尚未在真实浏览器中完成拖动播放头、Gap 边界/整体拖动和性能 DevTools profile；后续应重点检查不同窗口高度、短行高，以及 repetition 块跨行时的可读性，并针对确认的热点做缓存/重绘优化。
- 旧工程的真实媒体场景尚未手动复测：打开后应显示为普通静音空隙，点击「收缩空隙」和重新扫描后应分别收缩/替换原有启用范围；旧恢复范围应继续显示为已恢复。
