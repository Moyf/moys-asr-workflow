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
| Ctrl+单击字幕块定位下方录制 card | 已修复 | 时间轴块保留原有普通点击行为；按住 Ctrl 单击时跳过选择/禁用动作，滚动到对应的候选或 Extra card，并短暂高亮目标 | `server-align/index.html`、`server-align/README.md` | 内嵌 JavaScript 语法检查；静态交互契约检查 |

## 验证结果

- `uv run python -m unittest tests.test_script_alignment tests.test_server_align`：15 项通过。
- `node` `new Function(...)`：`server-align/index.html` 内嵌 JavaScript 语法通过。
- 示例工程 `MAW-1.4更新说明.bcut.mosp`：页面、状态接口和媒体 HEAD 请求均返回 200；媒体声明支持 `bytes` Range。
- `git diff --check`：通过；本次涉及文本文件均保持 LF 换行。

## 未验证

- 尚未在真实浏览器中完成多行视图切换、拖动播放头和播放过程的视觉回归；后续应重点检查不同窗口高度、短行高，以及 repetition 块跨行时的可读性。
