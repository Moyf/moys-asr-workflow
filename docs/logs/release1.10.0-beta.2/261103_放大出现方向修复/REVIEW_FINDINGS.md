# 放大出现方向修复：独立复核记录

审查方式：未参与实现的后台 subagent 通读全部未提交 diff（含新测试与文档），标准覆盖正确性、边界、异常与降级、回归风险、跨平台、测试有效性、仓库约定。结论：**无 blocker**，核心修复正确；4 条 finding 全部处置如下（2026-11-04）。

| 编号 | 级别 | 内容 | 处置 | 证据 |
| --- | --- | --- | --- | --- |
| F1 | major | 设置卡帮助文案与 i18n 仍是「缩小落定」旧语义，与新行为矛盾 | 已修复：模板 `<small>` 文案与 `editor-i18n.js` 键值成对更新（默认 0.8 从小放大，大于 1 从大缩小）；脚本核对键为模板子串、旧键已消失 | editor-template.html:1986、editor-i18n.js:861 |
| F2 | major | canvas-layout popPeak 改动无回归守卫；`min="0.3"` 无断言 | 已修复：新增 `sub-1 pop bounds still cover the settled size…` 用例（fromScale 0.8 + `\fscx50` 目标）；双向验证——临时回退 axisMax 门为旧 `popAtStart > 1` 时用例真红（比例 0.8 < 1），恢复后绿；`test_editor_assets.py` 补 `min="0.3"` 契约断言 | tests/test_ass_animation.mjs、tests/test_editor_assets.py |
| F3 | nit | 链值测试尾部两条断言只自检参考函数、不约束实现 | 已修复：改为对实现输出断言（250ms 前后连续、落定后停在 120）；重构时暴露自身测试 bug（采样数组漏 251 导致 undefined 比较恒假），已补 | tests/test_ass_animation.mjs 链值用例 |
| F4 | nit | `text-processing.js` 注释残留「从大缩小落定」 | 已修复：注释同步双语义（< 1 放大、> 1 缩小） | web/shared/utils/text-processing.js parseSentencePopMarkers |

接受的风险（不计 finding，审查确认）：`percent()` 的 toFixed 指数记号问题仅在绕过归一化传入超大 fromScale 时可达（生产路径全部先归一化 [0.3,10]），属既有行为；既有弱断言用例 `pop entrance reserves stack bounds…`（只断言 plan 携带参数）保留，其守卫职责已由两条更强的包围盒用例覆盖。

审查确认无问题的重点：fromScale 门与归一化一致性（NaN/±Inf/0/负值/=1 等价或更严，生产无绕过路径）；`assPreviewStyleAt` outerScale 对 popScale≥1、0/undefined 逐行为等价（数值复算 t=50ms 新公式 88.5 = libass 链值，旧钳制 86.1 偏离）；canvas-layout `popAtStart === 1` 三情形（无 pop / 已落定 / fromScale=1）逐行为等价，fromScale>1 峰值不变，<1 凸组合上界成立；CHANGELOG/docs/日志表述与实现一致，UTF-8/LF、无署名、bundle 与 blank-editor 处理、个人路径全部合规。
